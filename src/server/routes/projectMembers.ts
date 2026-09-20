import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { currentUser, normalizeEmail, requireUser } from "../auth.js";
import { upsertNuwaxUser } from "./auth.js";
import type { CollaborationService } from "../collaboration.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { apiError } from "../http.js";
import { NuwaxOAuthError, NuwaxOAuthService, type NuwaxProfile } from "../nuwaxOAuth.js";
import { accessibleProject } from "../projects.js";
import { activeShareLinkForToken, createShareLinkSecret, revealShareLinkSecret, shareLinkPath } from "../shareLinks.js";
import { basePathHref } from "../../shared/basePath.js";
import { now, touchProject } from "./projectShared.js";

interface ProjectMemberRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  nuwaxOAuth: NuwaxOAuthService;
}

/** Register project sharing, invitation, and member-permission routes. */
export function registerProjectMemberRoutes(app: FastifyInstance, context: ProjectMemberRouteContext): void {
  const { config, db, collaboration, nuwaxOAuth } = context;

  app.get("/share/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const link = await activeShareLinkForToken(db, token);
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
    if (!(await currentUser(request, db))) {
      return reply.redirect(`${basePathHref(config.basePath)}?return=${encodeURIComponent(destination)}`);
    }
    return reply.redirect(destination);
  });

  app.get("/api/invitations", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    return { invitations: await db.projectMembers.listInvitationsForUser(user.id, user.email ? normalizeEmail(user.email) : null) };
  });

  app.post("/api/invitations/:invitationId/accept", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { invitationId } = request.params as { invitationId: string };
    const invitation = await db.projectMembers.findInvitationForUser(
      invitationId,
      user.id,
      user.email ? normalizeEmail(user.email) : null
    );
    if (!invitation) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    const accepted = await db.projectMembers.acceptInvitation({
      invitationId: invitation.id,
      userId: user.id,
      email: user.email ? normalizeEmail(user.email) : null,
      respondedAt: now()
    });
    if (!accepted) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    // Accepting a membership invitation changes access only; it must not
    // attribute a document modification to the newly added collaborator.
    collaboration.notifyPermissionChanged(accepted.projectId, user.id, accepted.permission);
    return { ok: true, projectId: accepted.projectId };
  });

  app.post("/api/invitations/:invitationId/decline", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { invitationId } = request.params as { invitationId: string };
    const invitation = await db.projectMembers.findInvitationForUser(
      invitationId,
      user.id,
      user.email ? normalizeEmail(user.email) : null
    );
    if (!invitation) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    const declined = await db.projectMembers.declineInvitation({
      invitationId: invitation.id,
      userId: user.id,
      email: user.email ? normalizeEmail(user.email) : null,
      respondedAt: now()
    });
    if (!declined) return apiError(reply, 404, "INVITATION_NOT_FOUND");
    return { ok: true };
  });

  app.get("/api/projects/:id/members", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project) return apiError(reply, 404, "PROJECT_NOT_FOUND");
    // A share link grants document read access, not access to the project's
    // collaborator directory or the email addresses used for invitations.
    if (project.share_link_only) return apiError(reply, 403, "PROJECT_MEMBERS_FORBIDDEN");
    return { members: await db.projectMembers.listMembers(id) };
  });

  app.get("/api/projects/:id/invitations", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    return { invitations: await db.projectMembers.listPendingInvitations(id) };
  });

  app.post("/api/projects/:id/invitation-recipient", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const body = (request.body ?? {}) as { phone?: unknown };
    const phone = normalizePhone(body.phone);
    if (!phone) return apiError(reply, 400, "INVITATION_PHONE_INVALID");
    try {
      const profile = await nuwaxOAuth.searchByPhone(user.id, phone);
      if (!profile) return { user: null };
      // A successful directory hit becomes a local account immediately. The
      // later OAuth callback then finds the same row by the stable Nuwax sub.
      const target = await upsertNuwaxUser(db, profile);
      if (target.disabled) return { user: null };
      return { user: {
        id: target.id,
        username: target.username,
        displayName: target.display_name,
        avatarUrl: target.avatar_url
      } };
    } catch (error) {
      return handleNuwaxSearchError(reply, error);
    }
  });

  app.post("/api/projects/:id/invitations", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const body = (request.body ?? {}) as { phone?: unknown; permission?: unknown };
    const phone = normalizePhone(body.phone);
    if (!phone) return apiError(reply, 400, "INVITATION_PHONE_INVALID");
    let profile: NuwaxProfile | null;
    try {
      profile = await nuwaxOAuth.searchByPhone(user.id, phone);
    } catch (error) {
      return handleNuwaxSearchError(reply, error);
    }
    if (!profile) return apiError(reply, 404, "INVITATION_RECIPIENT_NOT_FOUND");
    const target = await upsertNuwaxUser(db, profile);
    if (target.disabled) return apiError(reply, 404, "INVITATION_RECIPIENT_NOT_FOUND");
    if (target.id === project.owner_id) return apiError(reply, 400, "INVITATION_OWNER_FORBIDDEN");
    // The phone is used only for this exact Nuwax lookup. The durable
    // invitation stores the returned TexLite user ID and never stores the phone.
    const recipientUserId = target.id;
    const email = target.email;
    const permission = body.permission === "edit" ? "edit" : "read";
    const createdAt = now();
    const invitation = await db.projectMembers.upsertInvitation({
      id: randomUUID(),
      projectId: id,
      recipientUserId,
      email,
      permission,
      invitedBy: user.id,
      createdAt
    });
    if (invitation.status === "member_exists") return apiError(reply, 409, "INVITATION_MEMBER_EXISTS");
    await touchProject(db, id, user.id);
    return reply.code(201).send({ invitation: {
      id: invitation.invitationId,
      email: email ?? null,
      permission,
      createdAt,
      recipientUsername: target?.username ?? null,
      recipientDisplayName: target.display_name ?? null
    } });
  });

  app.get("/api/projects/:id/share-links", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const rows = await db.shareLinks.listActiveForProject(id);
    return {
      links: rows.map((row) => ({
        id: row.id,
        permission: row.permission,
        createdAt: row.createdAt,
        url: shareLinkPath(config, revealShareLinkSecret(config, row.tokenCiphertext))
      }))
    };
  });

  app.post("/api/projects/:id/share-links", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id } = request.params as { id: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const body = (request.body ?? {}) as { permission?: unknown };
    if (body.permission !== undefined && body.permission !== "read") {
      return apiError(reply, 400, "SHARE_LINK_READ_ONLY");
    }
    const permission = "read" as const;
    const linkId = randomUUID();
    const createdAt = now();
    const secret = createShareLinkSecret(config);
    await db.shareLinks.create({
      id: linkId,
      projectId: id,
      tokenHash: secret.tokenHash,
      tokenCiphertext: secret.tokenCiphertext,
      createdBy: user.id,
      createdAt
    });
    await touchProject(db, id, user.id);
    return reply.code(201).send({ link: {
      id: linkId,
      permission,
      createdAt,
      url: shareLinkPath(config, secret.token)
    } });
  });

  app.delete("/api/projects/:id/share-links/:linkId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, linkId } = request.params as { id: string; linkId: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    if (!await db.shareLinks.revoke(id, linkId, now())) {
      return apiError(reply, 404, "SHARE_LINK_NOT_FOUND");
    }
    await touchProject(db, id, user.id);
    collaboration.disconnectShareLink(id, linkId);
    return { ok: true };
  });

  app.delete("/api/projects/:id/invitations/:invitationId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, invitationId } = request.params as { id: string; invitationId: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    if (!await db.projectMembers.revokeInvitation(id, invitationId, now())) {
      return apiError(reply, 404, "INVITATION_NOT_FOUND");
    }
    await touchProject(db, id, user.id);
    return { ok: true };
  });

  app.put("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    if (userId === project.owner_id) return apiError(reply, 400, "OWNER_MEMBER_FORBIDDEN");
    const target = await db.identity.findUserById(userId);
    if (!target || target.disabled) {
      return apiError(reply, 404, "USER_NOT_FOUND");
    }
    const body = request.body as { permission?: unknown };
    const permission = body.permission === "edit" ? "edit" : "read";
    const changedAt = now();
    const changed = await db.projectMembers.setMemberPermission({
      projectId: id,
      userId,
      permission,
      email: target.email,
      changedAt
    });
    if (!changed) return apiError(reply, 404, "PROJECT_MEMBER_NOT_FOUND");
    await touchProject(db, id, user.id);
    collaboration.notifyPermissionChanged(id, userId, permission);
    return { ok: true };
  });

  app.delete("/api/projects/:id/members/:userId", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id, userId } = request.params as { id: string; userId: string };
    const project = await accessibleProject(db, id, user);
    if (!project || project.permission !== "owner") return apiError(reply, 403, "MEMBERS_MANAGE_FORBIDDEN");
    const target = await db.identity.findUserById(userId);
    if (!target) return apiError(reply, 404, "PROJECT_MEMBER_NOT_FOUND");
    const changedAt = now();
    const removed = await db.projectMembers.removeMember({
      projectId: id,
      userId,
      email: target.email,
      changedAt
    });
    if (!removed) return apiError(reply, 404, "PROJECT_MEMBER_NOT_FOUND");
    await touchProject(db, id, user.id);
    collaboration.notifyPermissionChanged(id, userId, "revoked");
    return { ok: true };
  });
}

function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/[\s()-]/g, "");
  return /^\+?[0-9]{7,20}$/.test(compact) ? compact : null;
}

function handleNuwaxSearchError(reply: { code: (status: number) => { send: (payload: unknown) => unknown }; request?: { headers?: Record<string, string | string[] | undefined> } }, error: unknown): unknown {
  if (error instanceof NuwaxOAuthError) {
    if (error.failure === "reauth") return apiError(reply, 401, "NUWAX_SEARCH_REAUTH_REQUIRED");
    if (error.failure === "scope") return apiError(reply, 403, "NUWAX_SEARCH_SCOPE_REQUIRED");
    if (error.failure === "rate_limited") return apiError(reply, 429, "NUWAX_SEARCH_RATE_LIMITED");
  }
  return apiError(reply, 502, "NUWAX_SEARCH_FAILED");
}

function requestIsSecure(request: { protocol: string }): boolean {
  return request.protocol === "https";
}
