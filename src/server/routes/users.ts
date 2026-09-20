import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { normalizeEmail, publicUser, requireAdmin, requireUser } from "../auth.js";
import { isValidUsername, MAX_DISPLAY_NAME_LENGTH, MAX_USERNAME_LENGTH } from "./auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import {
  purgePersistedProjectDirectoryRemoval,
  restorePersistedProjectDirectoryRemoval,
  stagePersistedProjectDirectoryRemoval,
  type StagedProjectDirectoryRemoval
} from "../files.js";
import { apiError, httpError, ValidationError } from "../http.js";
import type { LatexCompletionService } from "../latexCompletion.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import type { ProjectOutlineService } from "../projectOutline.js";
import type { ProjectQuotaService } from "../projectQuota.js";
import { hashPassword } from "../security.js";

interface UserManagementRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
  latexCompletions: LatexCompletionService;
  projectOutlines: ProjectOutlineService;
  projectQuota: ProjectQuotaService;
}

const now = (): string => new Date().toISOString();

function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError();
  }
  return value.trim();
}

/** Register administrator-facing user management and exact active-user lookup. */
export function registerUserManagementRoutes(app: FastifyInstance, context: UserManagementRouteContext): void {
  const { config, db, collaboration, projectMutations, latexCompletions, projectOutlines, projectQuota } = context;

  app.get("/api/admin/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply, db))) return;
    const query = request.query as { page?: unknown; pageSize?: unknown; search?: unknown };
    const page = positivePage(query.page, 1);
    const pageSize = boundedPageSize(query.pageSize, 20);
    const search = typeof query.search === "string" ? query.search.trim().slice(0, 100) : "";
    const summary = await db.administrators.listUsers(1, 1, search);
    const total = summary.total;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const actualPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    const users = (await db.administrators.listUsers(actualPage, pageSize, search)).users;
    return {
      users: users.map((user) => ({ ...publicUser(user), ownedProjects: user.owned_projects })),
      pagination: { page: actualPage, pageSize, total, totalPages },
      search
    };
  });

  app.post("/api/admin/users", async (request, reply) => {
    if (!(await requireAdmin(request, reply, db))) return;
    const body = request.body as Record<string, unknown>;
    const username = typeof body?.username === "string" && body.username.length <= MAX_USERNAME_LENGTH
      ? body.username.trim()
      : "";
    if (!isValidUsername(username)) return apiError(reply, 400, "USERNAME_INVALID");
    const displayName = text(body?.displayName ?? username, MAX_DISPLAY_NAME_LENGTH);
    const password = typeof body?.password === "string" ? body.password : "";
    const role = body?.role === "admin" ? "admin" : "user";
    const user = await db.administrators.createUser({
      id: randomUUID(),
      username,
      displayName,
      passwordHash: await hashPassword(password),
      role,
      canCreateProjects: body?.canCreateProjects === true ? 1 : 0,
      createdAt: now()
    });
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.patch("/api/admin/users/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply, db);
    if (!admin) return;
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const passwordReset = typeof body.password === "string" && Boolean(body.password);
    const updated = await db.administrators.patchUser({
      id,
      ...(typeof body.displayName === "string" ? { displayName: text(body.displayName, MAX_DISPLAY_NAME_LENGTH) } : {}),
      ...(body.role === "admin" || body.role === "user" ? { role: body.role } : {}),
      ...(typeof body.disabled === "boolean" ? { disabled: Number(body.disabled) } : {}),
      ...(typeof body.canCreateProjects === "boolean" ? { canCreateProjects: Number(body.canCreateProjects) } : {}),
      ...(passwordReset ? { passwordHash: await hashPassword(body.password as string), mustChangePassword: 1 } : {})
    });
    if (updated.status === "not_found") return apiError(reply, 404, "USER_NOT_FOUND");
    if (updated.status === "last_admin") return apiError(reply, 400, "LAST_ADMIN");
    if (updated.status === "deletion_pending") return apiError(reply, 409, "USER_DELETION_PENDING");
    // A disabled account must not regain access by being re-enabled while an
    // old cookie is still within its normal lifetime. Password resets already
    // revoke sessions above; disabling does the same for every active token.
    if (body.disabled === true || passwordReset) {
      for (const sessionId of await db.identity.deleteAllSessions(id)) {
        collaboration.disconnectSession(sessionId, body.disabled === true ? "Administrator disabled account" : "Administrator reset password");
      }
    }
    if (body.disabled === true || passwordReset) {
      collaboration.disconnectUser(id, "user-disabled-or-reset");
    }
    return { user: publicUser(updated.user) };
  });

  app.delete("/api/admin/users/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply, db);
    if (!admin) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { deleteProjects?: boolean };
    const target = await db.identity.findUserById(id);
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND");
    if (target.id === admin.id) return apiError(reply, 400, "SELF_DELETE_FORBIDDEN");
    return await projectQuota.runForOwner(id, async () => {
      const owned = (await db.projects.listOwnedProjectIds(id)).map((projectId) => ({ id: projectId }));
      // Ownership transfer is intentionally not supported. An administrator
      // must explicitly choose project deletion before the account can go.
      if (owned.length > 0 && body.deleteProjects !== true) {
        return apiError(reply, 409, "USER_OWNS_PROJECTS");
      }
      const staged: StagedProjectDirectoryRemoval[] = [];
      let suspended = false;
      let committed = false;
      const restoreStagedDirectories = async (): Promise<unknown[]> => {
        const errors: unknown[] = [];
        for (const removal of [...staged].reverse()) {
          try { await restorePersistedProjectDirectoryRemoval(db, removal); }
          catch (error) {
            errors.push(error);
            request.log.error({ err: error, projectId: removal.projectId }, "Failed to restore staged project directory");
          }
        }
        return errors;
      };

      const suspension = await db.administrators.suspendUserForDeletion(id, now());
      if (suspension.status === "not_found") throw httpError(404, "USER_NOT_FOUND");
      if (suspension.status === "last_admin") throw httpError(400, "LAST_ADMIN");
      if (suspension.status === "deletion_pending") throw httpError(409, "USER_DELETION_PENDING");
      suspended = true;
      collaboration.disconnectUser(id, "user-deletion-pending");

      try {
        await withExclusiveProjectLocks(owned.map((project) => project.id), projectMutations, async () => {
          try {
            for (const project of owned) {
              const removal = await stagePersistedProjectDirectoryRemoval(config, db, project.id);
              if (removal) staged.push(removal);
            }
            if (!await db.administrators.finalizeUserDeletion(id)) throw httpError(404, "USER_NOT_FOUND");
            committed = true;
          } catch (error) {
            const restoreErrors = await restoreStagedDirectories();
            if (restoreErrors.length) {
              throw new AggregateError([error, ...restoreErrors], "Unable to restore staged project directories");
            }
            throw error;
          }
        });
      } catch (error) {
        if (!committed) {
          const restoreErrors = await restoreStagedDirectories();
          if (restoreErrors.length) {
            throw new AggregateError([error, ...restoreErrors], "Unable to restore staged project directories");
          }
          if (suspended) {
            await db.administrators.restoreStagedUserDeletion(id);
          }
        }
        throw error;
      }

      for (const removal of staged) {
        try { await purgePersistedProjectDirectoryRemoval(db, removal); }
        catch (error) { request.log.error({ err: error, projectId: removal.projectId }, "Failed to purge deleted project trash"); }
      }
      for (const project of owned) {
        latexCompletions.invalidate(project.id);
        projectOutlines.invalidate(project.id);
      }
      collaboration.disconnectUser(id, "user-deleted");
      return { ok: true, deletedProjects: owned.length };
    });
  });

  app.get("/api/users", async (request, reply) => {
    if (!(await requireUser(request, reply, db))) return;
    const query = request.query as { email?: unknown };
    if (typeof query.email !== "string" || !isEmail(query.email)) {
      return apiError(reply, 400, "USER_EMAIL_LOOKUP_INVALID");
    }
    const user = await db.identity.findActiveUserByEmail(normalizeEmail(query.email));
    return {
      user: user
        ? { id: user.id, username: user.username, displayName: user.display_name }
        : null
    };
  });
}

/**
 * Nest exclusive locks in a stable project-ID order. Existing project
 * operations lock only one project, so retaining earlier locks while acquiring
 * the next one cannot form a multi-project cycle and keeps all staged trees
 * unavailable until their corresponding database transaction commits.
 */
async function withExclusiveProjectLocks<T>(
  projectIds: readonly string[],
  projectMutations: ProjectMutationCoordinator,
  operation: () => Promise<T> | T,
  index = 0
): Promise<T> {
  const projectId = projectIds[index];
  if (!projectId) return await operation();
  return await projectMutations.runExclusive(projectId, "admin user deletion cleanup", async () => {
    return await withExclusiveProjectLocks(projectIds, projectMutations, operation, index + 1);
  });
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function positivePage(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  return Math.max(1, Math.min(100_000, Number.parseInt(value, 10) || fallback));
}

function boundedPageSize(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return [20, 50, 100].includes(parsed) ? parsed : fallback;
}
