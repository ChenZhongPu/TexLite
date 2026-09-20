import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { normalizeEmail, publicUser, requireAdmin, requireUser } from "../auth.js";
import { isValidUsername, MAX_DISPLAY_NAME_LENGTH, MAX_USERNAME_LENGTH } from "./auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import { activeAdminCount, type DatabaseConnection, type UserRow } from "../db.js";
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
    if (!requireAdmin(request, reply, db)) return;
    const query = request.query as { page?: unknown; pageSize?: unknown; search?: unknown };
    const page = positivePage(query.page, 1);
    const pageSize = boundedPageSize(query.pageSize, 20);
    const search = typeof query.search === "string" ? query.search.trim().slice(0, 100) : "";
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const where = search ? "WHERE u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR COALESCE(u.email, '') LIKE ? ESCAPE '\\'" : "";
    const countParams = search ? [pattern, pattern, pattern] : [];
    const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM users u ${where}`).get(...countParams) as { count: number };
    const total = Number(totalRow.count) || 0;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const actualPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    const users = db.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS owned_projects
      FROM users u ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?
    `).all(...countParams, pageSize, (actualPage - 1) * pageSize) as unknown as Array<UserRow & { owned_projects: number }>;
    return {
      users: users.map((user) => ({ ...publicUser(user), ownedProjects: user.owned_projects })),
      pagination: { page: actualPage, pageSize, total, totalPages },
      search
    };
  });

  app.post("/api/admin/users", async (request, reply) => {
    if (!requireAdmin(request, reply, db)) return;
    const body = request.body as Record<string, unknown>;
    const username = text(body?.username, MAX_USERNAME_LENGTH);
    if (!isValidUsername(username)) return apiError(reply, 400, "USERNAME_INVALID");
    const displayName = text(body?.displayName ?? username, MAX_DISPLAY_NAME_LENGTH);
    const password = typeof body?.password === "string" ? body.password : "";
    const role = body?.role === "admin" ? "admin" : "user";
    const user: UserRow = {
      id: randomUUID(), username, display_name: displayName,
      password_hash: await hashPassword(password), email: null, github_id: null, nuwax_subject: null, avatar_url: null, role, disabled: 0,
      must_change_password: 0, can_create_projects: body?.canCreateProjects === true ? 1 : 0, created_at: now()
    };
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, email, github_id, avatar_url, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, ?, ?)`)
      .run(user.id, user.username, user.display_name, user.password_hash, user.role, user.can_create_projects, user.created_at);
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.patch("/api/admin/users/:id", async (request, reply) => {
    const admin = requireAdmin(request, reply, db);
    if (!admin) return;
    const { id } = request.params as { id: string };
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND");
    const body = request.body as Record<string, unknown>;
    const role = body.role === "admin" ? "admin" : body.role === "user" ? "user" : target.role;
    const disabled = typeof body.disabled === "boolean" ? Number(body.disabled) : target.disabled;
    const canCreateProjects = typeof body.canCreateProjects === "boolean"
      ? Number(body.canCreateProjects) : target.can_create_projects;
    if (target.role === "admin" && (!role || role !== "admin" || disabled) && activeAdminCount(db) <= 1) {
      return apiError(reply, 400, "LAST_ADMIN");
    }
    const displayName = typeof body.displayName === "string" ? text(body.displayName, MAX_DISPLAY_NAME_LENGTH) : target.display_name;
    let passwordHash = target.password_hash;
    let mustChange = target.must_change_password;
    if (typeof body.password === "string" && body.password) {
      passwordHash = await hashPassword(body.password);
      mustChange = 1;
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    db.prepare(`UPDATE users SET display_name = ?, role = ?, disabled = ?, password_hash = ?, must_change_password = ?, can_create_projects = ? WHERE id = ?`)
      .run(displayName, role, disabled, passwordHash, mustChange, canCreateProjects, id);
    // A disabled account must not regain access by being re-enabled while an
    // old cookie is still within its normal lifetime. Password resets already
    // revoke sessions above; disabling does the same for every active token.
    if (disabled === 1) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    if (disabled === 1 || (typeof body.password === "string" && body.password)) {
      collaboration.disconnectUser(id, "user-disabled-or-reset");
    }
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow;
    return { user: publicUser(updated) };
  });

  app.delete("/api/admin/users/:id", async (request, reply) => {
    const admin = requireAdmin(request, reply, db);
    if (!admin) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { deleteProjects?: boolean };
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND");
    if (target.id === admin.id) return apiError(reply, 400, "SELF_DELETE_FORBIDDEN");
    if (target.role === "admin" && activeAdminCount(db) <= 1) {
      return apiError(reply, 400, "LAST_ADMIN");
    }
    return await projectQuota.runForOwner(id, async () => {
      let owned: Array<{ id: string }> = [];
      const staged: StagedProjectDirectoryRemoval[] = [];
      let suspended = false;
      let committed = false;
      let originalDisabled = target.disabled;
      const restoreStagedDirectories = (): unknown[] => {
        const errors: unknown[] = [];
        for (const removal of [...staged].reverse()) {
          try { restorePersistedProjectDirectoryRemoval(db, removal); }
          catch (error) {
            errors.push(error);
            request.log.error({ err: error, projectId: removal.projectId }, "Failed to restore staged project directory");
          }
        }
        return errors;
      };

      // Suspend the account before waiting on project locks. New requests can
      // no longer create a project between the owned-project snapshot and the
      // final transaction, while existing collaborators are stopped by each
      // exclusive project lock below. Keep existing session rows until the
      // actual deletion so a failed filesystem stage can safely re-enable the
      // account without manufacturing new credentials.
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentTarget = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
        if (!currentTarget) throw httpError(404, "USER_NOT_FOUND");
        if (currentTarget.role === "admin" && activeAdminCount(db) <= 1) {
          throw httpError(400, "LAST_ADMIN");
        }
        originalDisabled = currentTarget.disabled;
        db.prepare(`INSERT INTO user_deletion_staging (user_id, original_disabled, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET original_disabled = excluded.original_disabled, created_at = excluded.created_at`)
          .run(id, originalDisabled, now());
        db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(id);
        db.exec("COMMIT");
        suspended = true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      collaboration.disconnectUser(id, "user-deletion-pending");

      try {
        owned = db.prepare("SELECT id FROM projects WHERE owner_id = ? ORDER BY id").all(id) as Array<{ id: string }>;
        if (body.deleteProjects) {
          // Hold every owned project in maintenance until the database rows are
          // deleted. Moving each tree to trash first makes the filesystem step
          // reversible; if it fails, the account and all project rows remain.
          await withExclusiveProjectLocks(owned.map((project) => project.id), projectMutations, () => {
            try {
              for (const project of owned) {
                const removal = stagePersistedProjectDirectoryRemoval(config, db, project.id);
                if (removal) staged.push(removal);
              }
              db.exec("BEGIN IMMEDIATE");
              try {
                db.prepare("DELETE FROM projects WHERE owner_id = ?").run(id);
                db.prepare("DELETE FROM users WHERE id = ?").run(id);
                db.prepare("DELETE FROM user_deletion_staging WHERE user_id = ?").run(id);
                db.exec("COMMIT");
                committed = true;
              } catch (error) {
                db.exec("ROLLBACK");
                throw error;
              }
            } catch (error) {
              // Restore while every project lock is still held. Otherwise a
              // collaborator could observe a database row whose source tree
              // is temporarily in trash between the failed stage and restore.
              const restoreErrors = restoreStagedDirectories();
              if (restoreErrors.length) {
                throw new AggregateError([error, ...restoreErrors], "Unable to restore staged project directories");
              }
              throw error;
            }
          });
        } else {
          // Wait for every source operation, flush live drafts, then hold all
          // projects in maintenance while the old owner is removed. This keeps
          // a queued replacement from writing under a deleted user afterwards.
          await withExclusiveProjectLocks(owned.map((project) => project.id), projectMutations, () => {
            db.exec("BEGIN IMMEDIATE");
            try {
              const currentTarget = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
              if (!currentTarget) throw httpError(404, "USER_NOT_FOUND");
              db.prepare("DELETE FROM project_members WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE owner_id = ?)")
                .run(admin.id, id);
              // Ownership transfer is administrative metadata, not a document
              // edit. Leave another collaborator's last modifier intact; if
              // the removed owner was the modifier, the FK clears it.
              db.prepare("UPDATE projects SET owner_id = ?, updated_at = ? WHERE owner_id = ?")
                .run(admin.id, now(), id);
              db.prepare("DELETE FROM users WHERE id = ?").run(id);
              db.prepare("DELETE FROM user_deletion_staging WHERE user_id = ?").run(id);
              db.exec("COMMIT");
              committed = true;
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          });
        }
      } catch (error) {
        if (!committed) {
          const restoreErrors = restoreStagedDirectories();
          if (restoreErrors.length) {
            throw new AggregateError([error, ...restoreErrors], "Unable to restore staged project directories");
          }
          if (suspended) {
            db.transaction(() => {
              db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(originalDisabled, id);
              db.prepare("DELETE FROM user_deletion_staging WHERE user_id = ?").run(id);
            })();
          }
        }
        throw error;
      }

      // The database no longer exposes staged project trees. A failed purge is
      // therefore an operational cleanup issue rather than a reason to leave
      // a half-deleted user/project state; startup trash pruning will retry it.
      for (const removal of staged) {
        try { await purgePersistedProjectDirectoryRemoval(db, removal); }
        catch (error) { request.log.error({ err: error, projectId: removal.projectId }, "Failed to purge deleted project trash"); }
      }
      for (const project of owned) {
        latexCompletions.invalidate(project.id);
        projectOutlines.invalidate(project.id);
      }
      collaboration.disconnectUser(id, "user-deleted");
      return { ok: true, deletedProjects: body.deleteProjects ? owned.length : 0 };
    });
  });

  app.get("/api/users", async (request, reply) => {
    if (!requireUser(request, reply, db)) return;
    const query = request.query as { email?: unknown };
    if (typeof query.email !== "string" || !isEmail(query.email)) {
      return apiError(reply, 400, "USER_EMAIL_LOOKUP_INVALID");
    }
    const user = db.prepare(`SELECT id, username, display_name AS displayName
      FROM users WHERE email = ? COLLATE NOCASE AND disabled = 0`)
      .get(normalizeEmail(query.email)) as { id: string; username: string; displayName: string } | undefined;
    return { user: user ?? null };
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
