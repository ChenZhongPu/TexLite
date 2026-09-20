import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { currentUser, normalizeEmail, requireUser } from "../auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { apiError } from "../http.js";
import { accessibleProject } from "../projects.js";
import { activeShareLinkForToken, createShareLinkSecret, revealShareLinkSecret, shareLinkPath } from "../shareLinks.js";
import { basePathHref } from "../../shared/basePath.js";
import { now, touchProject } from "./projectShared.js";

interface ProjectMemberRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
}

interface InvitationRecipient {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
}

/** Register project sharing, invitation, and member-permission routes. */
export function registerProjectMemberRoutes(app: FastifyInstance, context: ProjectMemberRouteContext): void {
  const { config, db, collaboration } = context;

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
    const select = `SELECT invitation.id, invitation.project_id AS projectId,
        invitation.email, invitation.permission, invitation.created_at AS createdAt,
        recipient.username AS recipientUsername, recipient.display_name AS recipientDisplayName,
        project.name AS projectName, owner.display_name AS ownerDisplayName, owner.username AS ownerUsername
      FROM project_invitations invitation
      JOIN projects project ON project.id = invitation.project_id
      JOIN users owner ON owner.id = project.owner_id
      LEFT JOIN users recipient ON recipient.id = invitation.recipient_user_id AND recipient.disabled = 0`;
    // Account-bound invitations do not depend on an email at acceptance time.
    // Keep the email fallback only for legacy/external email invitations whose
    // recipient did not yet have a TexLite account when they were sent.
    const rows = user.email
      ? db.prepare(`${select}
          WHERE invitation.status = 'pending' AND (
            invitation.recipient_user_id = ?
            OR (invitation.recipient_user_id IS NULL AND invitation.email = ? COLLATE NOCASE)
          )
          ORDER BY invitation.created_at DESC`).all(user.id, normalizeEmail(user.email))
      : db.prepare(`${select}
          WHERE invitation.status = 'pending' AND invitation.recipient_user_id = ?
          ORDER BY invitation.created_at DESC`).all(user.id);
    return { invitations: rows };
  });

  app.post("/api/invitations/:invitationId/accept", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { invitationId } = request.params as { invitationId: string };
    const invitation = invitationForUser(db, invitationId, user.id, user.email) as {
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
      db.prepare(`UPDATE project_invitations
        SET status = 'accepted', responded_at = ?, recipient_user_id = ?
        WHERE id = ? AND status = 'pending'`)
        .run(changedAt, user.id, invitation.id);
      // A legacy external-email invitation and a later account-bound one can
      // coexist in databases created before identity normalization. Once an
      // account accepts, no alternate pending invitation may remain capable
      // of restoring its membership later.
      revokePendingInvitationsForUser(db, invitation.project_id, user.id, user.email, changedAt);
      // Accepting a membership invitation changes access only; it must not
      // attribute a document modification to the newly added collaborator.
    })();
    collaboration.notifyPermissionChanged(invitation.project_id, user.id, invitation.permission);
    return { ok: true, projectId: invitation.project_id };
  });

  app.post("/api/invitations/:invitationId/decline", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { invitationId } = request.params as { invitationId: string };
    const invitation = invitationForUser(db, invitationId, user.id, user.email) as { id: string; project_id: string } | undefined;
    if (!invitation) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    const changedAt = now();
    const declined = db.transaction(() => {
      const result = db.prepare(`UPDATE project_invitations
        SET status = 'declined', responded_at = ?, recipient_user_id = ?
        WHERE id = ? AND status = 'pending'`)
        .run(changedAt, user.id, invitation.id);
      if (!result.changes) return false;
      revokePendingInvitationsForUser(db, invitation.project_id, user.id, user.email, changedAt);
      return true;
    })();
    if (!declined) return apiError(reply, 404, "INVITATION_NOT_FOUND");
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
      LEFT JOIN users recipient ON recipient.id = invitation.recipient_user_id AND recipient.disabled = 0
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
    const target = activeInvitationRecipientByEmail(db, normalizeEmail(query.email));
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
    const target = activeInvitationRecipientByEmail(db, email);
    if (target && target.id === project.owner_id) return apiError(reply, 400, "INVITATION_OWNER_FORBIDDEN");
    if (target && db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").get(id, target.id)) {
      return apiError(reply, 409, "INVITATION_MEMBER_EXISTS");
    }
    // A matched email binds the invitation to the durable local user ID. An
    // unmatched (but valid) email remains a compatible external invitation
    // that can be accepted after its owner registers with that address.
    const recipientUserId = target?.id ?? null;
    const permission = body.permission === "edit" ? "edit" : "read";
    const createdAt = now();
    const invitationId = db.transaction(() => {
      // Prefer an already bound invitation when both paths exist. Updating an
      // older external row first could otherwise conflict with the partial
      // unique index on recipient_user_id.
      const pending = recipientUserId
        ? db.prepare(`SELECT id FROM project_invitations
            WHERE project_id = ? AND status = 'pending' AND (
              recipient_user_id = ?
              OR (recipient_user_id IS NULL AND email = ? COLLATE NOCASE)
            )
            ORDER BY CASE WHEN recipient_user_id = ? THEN 0 ELSE 1 END, created_at DESC, id DESC
            LIMIT 1`)
          .get(id, recipientUserId, email, recipientUserId) as { id: string } | undefined
        : db.prepare(`SELECT id FROM project_invitations
            WHERE project_id = ? AND recipient_user_id IS NULL AND email = ? COLLATE NOCASE AND status = 'pending'
            ORDER BY created_at DESC, id DESC LIMIT 1`)
          .get(id, email) as { id: string } | undefined;
      const selectedId = pending?.id ?? randomUUID();
      if (pending) {
        db.prepare(`UPDATE project_invitations
          SET recipient_user_id = ?, email = ?, permission = ?, invited_by = ?, created_at = ?, responded_at = NULL
          WHERE id = ?`)
          .run(recipientUserId, email, permission, user.id, createdAt, selectedId);
      } else {
        db.prepare(`INSERT INTO project_invitations
          (id, project_id, recipient_user_id, email, permission, invited_by, status, created_at, responded_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`)
          .run(selectedId, id, recipientUserId, email, permission, user.id, createdAt);
      }
      if (recipientUserId) {
        db.prepare(`UPDATE project_invitations SET status = 'revoked', responded_at = ?
          WHERE project_id = ? AND id != ? AND status = 'pending' AND (
            recipient_user_id = ?
            OR (recipient_user_id IS NULL AND email = ? COLLATE NOCASE)
          )`)
          .run(createdAt, id, selectedId, recipientUserId, email);
      }
      return selectedId;
    })();
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

  app.put("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    if (userId === project.owner_id) return apiError(reply, 400, "OWNER_MEMBER_FORBIDDEN");
    const target = db.prepare("SELECT email FROM users WHERE id = ? AND disabled = 0").get(userId) as { email: string | null } | undefined;
    if (!target) {
      return apiError(reply, 404, "USER_NOT_FOUND");
    }
    const body = request.body as { permission?: unknown };
    const permission = body.permission === "edit" ? "edit" : "read";
    const changedAt = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO project_members (project_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, user_id) DO UPDATE SET permission = excluded.permission`)
        .run(id, userId, permission, changedAt);
      revokePendingInvitationsForUser(db, id, userId, target.email, changedAt);
    })();
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
    const target = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string | null } | undefined;
    const changedAt = now();
    db.transaction(() => {
      db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").run(id, userId);
      // Removing a member is also an access revocation. Retire every pending
      // invitation matching that durable account (and its unique email) so a
      // forgotten legacy external invitation cannot immediately re-add them.
      revokePendingInvitationsForUser(db, id, userId, target?.email ?? null, changedAt);
    })();
    touchProject(db, id, user.id);
    collaboration.notifyPermissionChanged(id, userId, "revoked");
    return { ok: true };
  });
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function activeInvitationRecipientByEmail(db: DatabaseConnection, email: string): InvitationRecipient | undefined {
  return db.prepare(`SELECT id, username, display_name AS displayName, email
    FROM users WHERE email = ? COLLATE NOCASE AND disabled = 0`).get(email) as InvitationRecipient | undefined;
}

function invitationForUser(
  db: DatabaseConnection,
  invitationId: string,
  userId: string,
  email: string | null
): unknown {
  if (email) {
    return db.prepare(`SELECT * FROM project_invitations
      WHERE id = ? AND status = 'pending' AND (
        recipient_user_id = ?
        OR (recipient_user_id IS NULL AND email = ? COLLATE NOCASE)
      )`).get(invitationId, userId, normalizeEmail(email));
  }
  return db.prepare(`SELECT * FROM project_invitations
    WHERE id = ? AND status = 'pending' AND recipient_user_id = ?`).get(invitationId, userId);
}

/** Revoke all alternative pending invitation paths for the same account. */
function revokePendingInvitationsForUser(
  db: DatabaseConnection,
  projectId: string,
  userId: string,
  email: string | null,
  changedAt: string
): void {
  if (email) {
    db.prepare(`UPDATE project_invitations SET status = 'revoked', responded_at = ?
      WHERE project_id = ? AND status = 'pending' AND (
        recipient_user_id = ?
        OR (recipient_user_id IS NULL AND email = ? COLLATE NOCASE)
      )`)
      .run(changedAt, projectId, userId, normalizeEmail(email));
    return;
  }
  db.prepare(`UPDATE project_invitations SET status = 'revoked', responded_at = ?
    WHERE project_id = ? AND status = 'pending' AND recipient_user_id = ?`)
    .run(changedAt, projectId, userId);
}

function requestIsSecure(request: { protocol: string }): boolean {
  return request.protocol === "https";
}
