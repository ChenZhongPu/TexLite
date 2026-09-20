import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseConnection, UserRow } from "./db.js";
import { apiError } from "./http.js";
import { digestToken } from "./security.js";
import { activeShareLinkForToken } from "./shareLinks.js";

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  nuwaxConnected: boolean;
  role: "admin" | "user";
  disabled: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  canCreateProjects: boolean;
  createdAt: string;
}

export function publicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    email: user.email ?? null,
    avatarUrl: user.avatar_url ?? null,
    nuwaxConnected: Boolean(user.nuwax_subject),
    role: user.role,
    disabled: Boolean(user.disabled),
    mustChangePassword: Boolean(user.must_change_password),
    hasPassword: Boolean(user.password_hash),
    canCreateProjects: Boolean(user.can_create_projects) || user.role === "admin",
    createdAt: user.created_at
  };
}

/** Retained for legacy account metadata and invitation migrations. */
export function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

const requestUserCache = new WeakMap<FastifyRequest, UserRow | null>();

export function clearCurrentUserCache(request: FastifyRequest): void {
  requestUserCache.delete(request);
}

export async function currentUser(request: FastifyRequest, db: DatabaseConnection): Promise<UserRow | null> {
  if (requestUserCache.has(request)) {
    return requestUserCache.get(request) ?? null;
  }
  const token = request.cookies.texlite_session;
  if (!token) {
    requestUserCache.set(request, null);
    return null;
  }
  const row = await db.identity.findActiveSessionUser(digestToken(token), new Date().toISOString());
  const shareToken = request.cookies.texlite_share_token;
  const shareLink = shareToken ? await activeShareLinkForToken(db, shareToken) : null;
  // A share URL never authenticates an anonymous request by itself. Once a
  // normal account is signed in, the active link is carried as request-scoped
  // context so project authorization can grant only that link's project.
  const user = row && shareLink ? { ...row, share_link_id: shareLink.id } : row ?? null;
  requestUserCache.set(request, user);
  return user;
}

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabaseConnection
): Promise<UserRow | null> {
  const user = await currentUser(request, db);
  if (!user) {
    void apiError(reply, 401, "AUTH_REQUIRED");
    return null;
  }
  return user;
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabaseConnection
): Promise<UserRow | null> {
  const user = await requireUser(request, reply, db);
  if (!user) return null;
  if (user.role !== "admin") {
    void apiError(reply, 403, "ADMIN_REQUIRED");
    return null;
  }
  return user;
}
