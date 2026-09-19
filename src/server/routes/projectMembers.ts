import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { currentUser, normalizeEmail, requireUser } from "../auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { apiError, httpError } from "../http.js";
import type { ProjectMutationCoordinator } from "../projectMutations.js";
import { accessibleProject } from "../projects.js";
import { activeShareLinkForToken, createShareLinkSecret, revealShareLinkSecret, shareLinkPath } from "../shareLinks.js";
import { basePathHref } from "../../shared/basePath.js";
import {
  commentsSummaryForProject,
  now,
  projectJson,
  requireActualProjectOwner,
  tagsForProject,
  touchProject
} from "./projectShared.js";

interface ProjectMemberRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  projectMutations: ProjectMutationCoordinator;
}

/** Register project sharing, member permission, and ownership-transfer routes. */
export function registerProjectMemberRoutes(app: FastifyInstance, context: ProjectMemberRouteContext): void {
  const { config, db, collaboration, projectMutations } = context;

  app.get("/share/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const link = activeShareLinkForToken(db, token);
    if (!link) return apiError(reply, 404, "SHARE_LINK_NOT_FOUND");
    reply.setCookie("texlite_share_token", token, {
      path: basePathHref(config.basePath),
      httpOnly: true,
      sameSite: "lax",
      secure: requestIsSecure(request),
      maxAge: config.sessionDays * 86_400
    });
    const destination = `${basePathHref(config.basePath)}project/${encodeURIComponent(link.project_id)}`;
    // Links grant project access to an account, but are not anonymous
    // credentials. Preserve the link context through the normal login flow.
    if (!currentUser(request, db)) {
      return reply.redirect(`${basePathHref(config.basePath)}?return=${encodeURIComponent(destination)}`);
    }
    return reply.redirect(destination);
  });

  app.get("/api/invitations", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (!user.email) return { invitations: [] };
    const rows = db.prepare(`SELECT invitation.id, invitation.project_id AS projectId,
        invitation.email, invitation.permission, invitation.created_at AS createdAt,
        recipient.username AS recipientUsername, recipient.display_name AS recipientDisplayName,
        project.name AS projectName, owner.display_name AS ownerDisplayName, owner.username AS ownerUsername
      FROM project_invitations invitation
      JOIN projects project ON project.id = invitation.project_id
      JOIN users owner ON owner.id = project.owner_id
      LEFT JOIN users recipient ON recipient.email = invitation.email COLLATE NOCASE AND recipient.disabled = 0
      WHERE invitation.email = ? COLLATE NOCASE AND invitation.status = 'pending'
      ORDER BY invitation.created_at DESC`).all(normalizeEmail(user.email));
    return { invitations: rows };
  });

  app.post("/api/invitations/:invitationId/accept", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (!user.email) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    const { invitationId } = request.params as { invitationId: string };
    const invitation = db.prepare(`SELECT * FROM project_invitations
      WHERE id = ? AND status = 'pending' AND email = ? COLLATE NOCASE`).get(invitationId, normalizeEmail(user.email)) as {
      id: string; project_id: string; permission: "read" | "edit";
    } | undefined;
    if (!invitation) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    const project = db.prepare("SELECT owner_id FROM projects WHERE id = ?").get(invitation.project_id) as { owner_id: string } | undefined;
    if (!project || project.owner_id === user.id) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    const changedAt = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO project_members (project_id, user_id, permission, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET permission = excluded.permission`)
        .run(invitation.project_id, user.id, invitation.permission, changedAt);
      db.prepare("UPDATE project_invitations SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'")
        .run(changedAt, invitation.id);
      // Accepting a membership invitation changes access only; it must not
      // attribute a document modification to the newly added collaborator.
    })();
    collaboration.notifyPermissionChanged(invitation.project_id, user.id, invitation.permission);
    return { ok: true, projectId: invitation.project_id };
  });

  app.post("/api/invitations/:invitationId/decline", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    if (!user.email) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    const { invitationId } = request.params as { invitationId: string };
    const result = db.prepare(`UPDATE project_invitations SET status = 'declined', responded_at = ?
      WHERE id = ? AND status = 'pending' AND email = ? COLLATE NOCASE`)
      .run(now(), invitationId, normalizeEmail(user.email));
    if (!result.changes) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    return { ok: true };
  });

  app.get("/api/projects/:id/members", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    // A share link grants document read access, not access to the project's
    // collaborator directory or the email addresses used for invitations.
    if (project.share_link_only) return apiError(reply, 403, "PROJECT_MEMBERS_FORBIDDEN");
    const members = db.prepare(`SELECT pm.user_id AS id, u.username, u.email, u.display_name AS displayName, pm.permission
      FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.username`).all(id);
    return { members };
  });

  app.get("/api/projects/:id/invitations", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const invitations = db.prepare(`SELECT invitation.id, invitation.email, invitation.permission,
        invitation.created_at AS createdAt,
        recipient.username AS recipientUsername, recipient.display_name AS recipientDisplayName
      FROM project_invitations invitation
      LEFT JOIN users recipient ON recipient.email = invitation.email COLLATE NOCASE AND recipient.disabled = 0
      WHERE invitation.project_id = ? AND invitation.status = 'pending'
      ORDER BY invitation.created_at DESC`).all(id);
    return { invitations };
  });

  app.get("/api/projects/:id/invitation-recipient", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const query = request.query as { email?: unknown };
    if (typeof query.email !== "string" || !isEmail(query.email)) return { user: null };
    const email = normalizeEmail(query.email);
    const target = db.prepare(`SELECT id, username, display_name AS displayName, email
      FROM users WHERE email = ? COLLATE NOCASE AND disabled = 0`).get(email) as {
      id: string; username: string; displayName: string; email: string | null;
    } | undefined;
    return { user: target ?? null };
  });

  app.post("/api/projects/:id/invitations", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const body = (request.body ?? {}) as { email?: unknown; permission?: unknown };
    if (typeof body.email !== "string" || !isEmail(body.email)) return apiError(reply, 400, "INVITATION_EMAIL_INVALID");
    const email = normalizeEmail(body.email);
    if (user.email && normalizeEmail(user.email) === email) return apiError(reply, 400, "INVITATION_OWNER_FORBIDDEN");
    const target = db.prepare("SELECT id, username, display_name AS displayName, email FROM users WHERE email = ? COLLATE NOCASE AND disabled = 0").get(email) as {
      id: string; username: string; displayName: string; email: string | null;
    } | undefined;
    if (target && target.id === project.owner_id) return apiError(reply, 400, "INVITATION_OWNER_FORBIDDEN");
    if (target && db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(id, target.id)) {
      return apiError(reply, 409, "INVITATION_MEMBER_EXISTS");
    }
    const permission = body.permission === "edit" ? "edit" : "read";
    const createdAt = now();
    const pending = db.prepare("SELECT id FROM project_invitations WHERE project_id = ? AND email = ? AND status = 'pending'").get(id, email) as { id: string } | undefined;
    const invitationId = pending?.id ?? randomUUID();
    if (pending) {
      db.prepare("UPDATE project_invitations SET permission = ?, invited_by = ?, created_at = ?, responded_at = NULL WHERE id = ?")
        .run(permission, user.id, createdAt, invitationId);
    } else {
      db.prepare(`INSERT INTO project_invitations
        (id, project_id, email, permission, invited_by, status, created_at, responded_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`)
        .run(invitationId, id, email, permission, user.id, createdAt);
    }
    touchProject(db, id, user.id);
    return reply.code(201).send({ invitation: {
      id: invitationId,
      email,
      permission,
      createdAt,
      recipientUsername: target?.username ?? null,
      recipientDisplayName: target?.displayName ?? null
    } });
  });

  app.get("/api/projects/:id/share-links", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const rows = db.prepare(`SELECT id, permission, created_at AS createdAt, token_ciphertext
      FROM project_share_links WHERE project_id = ? AND permission = 'read' AND revoked_at IS NULL
      ORDER BY created_at DESC`).all(id) as Array<{
      id: string; permission: "read"; createdAt: string; token_ciphertext: string;
    }>;
    return {
      links: rows.map((row) => ({
        id: row.id,
        permission: row.permission,
        createdAt: row.createdAt,
        url: shareLinkPath(config, revealShareLinkSecret(config, row.token_ciphertext))
      }))
    };
  });

  app.post("/api/projects/:id/share-links", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const body = (request.body ?? {}) as { permission?: unknown };
    if (body.permission !== undefined && body.permission !== "read") {
      return apiError(reply, 400, "SHARE_LINK_READ_ONLY");
    }
    const permission = "read" as const;
    const linkId = randomUUID();
    const createdAt = now();
    const secret = createShareLinkSecret(config);
    db.transaction(() => {
      db.prepare(`INSERT INTO project_share_links
        (id, project_id, token_hash, token_ciphertext, permission, created_by, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(linkId, id, secret.tokenHash, secret.tokenCiphertext, permission, user.id, createdAt);
      touchProject(db, id, user.id);
    })();
    return reply.code(201).send({ link: {
      id: linkId,
      permission,
      createdAt,
      url: shareLinkPath(config, secret.token)
    } });
  });

  app.delete("/api/projects/:id/share-links/:linkId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, linkId } = request.params as { id: string; linkId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const result = db.prepare(`UPDATE project_share_links SET revoked_at = ?
      WHERE id = ? AND project_id = ? AND revoked_at IS NULL`).run(now(), linkId, id);
    if (!result.changes) return apiError(reply, 404, "SHARE_LINK_NOT_FOUND");
    touchProject(db, id, user.id);
    collaboration.disconnectShareLink(id, linkId);
    return { ok: true };
  });

  app.delete("/api/projects/:id/invitations/:invitationId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, invitationId } = request.params as { id: string; invitationId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const result = db.prepare("UPDATE project_invitations SET status = 'revoked', responded_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
      .run(now(), invitationId, id);
    if (!result.changes) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    touchProject(db, id, user.id);
    return { ok: true };
  });

  app.put("/api/projects/:id/owner", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.owner_id !== user.id) {
      return apiError(reply, 403, "PROJECT_TRANSFER_FORBIDDEN");
    }
    const body = (request.body ?? {}) as { userId?: unknown };
    if (typeof body.userId !== "string" || !body.userId) {
      return apiError(reply, 400, "PROJECT_TRANSFER_TARGET_INVALID");
    }
    if (body.userId === user.id) {
      return apiError(reply, 400, "PROJECT_TRANSFER_SELF");
    }
    const target = db.prepare("SELECT id FROM users WHERE id = ? AND disabled = 0").get(body.userId) as { id: string } | undefined;
    if (!target) return apiError(reply, 404, "USER_NOT_FOUND");

    return await projectMutations.runExclusive(id, "project transfer", () => {
      const currentTarget = db.prepare("SELECT id FROM users WHERE id = ? AND disabled = 0").get(body.userId) as { id: string } | undefined;
      // The synchronous preflight immediately precedes maintenance, so this
      // lookup cannot change before the operation starts.
      if (!currentTarget) throw httpError(404, "USER_NOT_FOUND");
      const changedAt = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        // The new owner may already be a shared member. The previous owner keeps
        // edit access so a transfer does not unexpectedly lock them out.
        db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, currentTarget.id);
        db.prepare(`INSERT INTO project_members (project_id, user_id, permission, created_at)
          VALUES (?, ?, 'edit', ?)
          ON CONFLICT(project_id, user_id) DO UPDATE SET permission = 'edit'`)
          .run(id, user.id, changedAt);
        db.prepare("UPDATE projects SET owner_id = ?, last_modified_by = ?, updated_at = ? WHERE id = ?")
          .run(currentTarget.id, user.id, changedAt, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return {
        project: projectJson(
          accessibleProject(db, id, user)!,
          tagsForProject(db, id, user.id),
          commentsSummaryForProject(db, id)
        )
      };
    }, { preflight: () => {
      requireActualProjectOwner(db, id, user);
      if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND disabled = 0").get(body.userId)) {
        throw httpError(404, "USER_NOT_FOUND");
      }
    } });
  });

  app.put("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    if (userId === project.owner_id) return apiError(reply, 400, "OWNER_MEMBER_FORBIDDEN");
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND disabled = 0").get(userId)) {
      return apiError(reply, 404, "USER_NOT_FOUND");
    }
    const body = request.body as { permission?: unknown };
    const permission = body.permission === "edit" ? "edit" : "read";
    db.prepare(`INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET permission = excluded.permission`)
      .run(id, userId, permission, now());
    touchProject(db, id, user.id);
    collaboration.notifyPermissionChanged(id, userId, permission);
    return { ok: true };
  });

  app.delete("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, userId);
    touchProject(db, id, user.id);
    collaboration.notifyPermissionChanged(id, userId, "revoked");
    return { ok: true };
  });
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function requestIsSecure(request: { protocol: string }): boolean {
  return request.protocol === "https";
}
