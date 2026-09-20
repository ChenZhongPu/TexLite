import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { DatabaseConnection, UserRow } from "../db.js";
import type { CollaborationService } from "../collaboration.js";
import { publicUser, requireUser } from "../auth.js";
import {
  createSessionToken,
  digestToken,
  hashPassword,
  LoginRateLimiter,
  verifyPassword
} from "../security.js";
import { apiError, ValidationError } from "../http.js";
import { basePathHref, withBasePath, withoutBasePath } from "../../shared/basePath.js";
import { NuwaxOAuthService, type NuwaxProfile } from "../nuwaxOAuth.js";

interface AuthRouteContext {
  config: Config;
  db: DatabaseConnection;
  collaboration: CollaborationService;
  loginLimiter: LoginRateLimiter;
  nuwaxOAuth: NuwaxOAuthService;
}

const now = (): string => new Date().toISOString();
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const NUWAX_ISSUER = "nuwax";
export const MAX_USERNAME_LENGTH = 50;
export const MAX_DISPLAY_NAME_LENGTH = 50;

function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError();
  }
  return value.trim();
}

/** Register local compatibility login, Nuwax OAuth, logout, and password routes. */
export function registerAuthRoutes(app: FastifyInstance, context: AuthRouteContext): void {
  const { config, db, collaboration, loginLimiter, nuwaxOAuth } = context;

  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown };
    const usernameInput = text(body?.username, MAX_USERNAME_LENGTH);
    const username = usernameInput.startsWith("@") ? usernameInput.slice(1) : usernameInput;
    const ip = request.ip || "127.0.0.1";
    const rateLimitKey = `${ip}:${username.toLowerCase()}`;
    if (loginLimiter.isLocked(rateLimitKey)) return apiError(reply, 429, "AUTH_RATE_LIMITED");
    const password = typeof body?.password === "string" ? body.password : "";
    const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
    if (!user || user.disabled || !(await verifyPassword(password, user.password_hash))) {
      const result = loginLimiter.recordFailure(rateLimitKey);
      if (result.locked) return apiError(reply, 429, "AUTH_RATE_LIMITED");
      return apiError(reply, 401, "AUTH_INVALID");
    }
    loginLimiter.reset(rateLimitKey);
    setSessionCookie(reply, request, config, db, user.id);
    return { user: publicUser(user) };
  });

  app.get("/api/auth/nuwax", async (request, reply) => {
    if (!nuwaxOAuth.enabled) return apiError(reply, 404, "OAUTH_NOT_CONFIGURED");
    const query = request.query as { return?: unknown };
    const returnPath = safeReturnPath(query.return, config.basePath);
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
    const redirectUri = config.oauth?.redirectUri;
    if (!redirectUri) return apiError(reply, 404, "OAUTH_NOT_CONFIGURED");
    db.prepare("INSERT INTO oauth_states (id, return_path, redirect_uri, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(digestToken(state), returnPath, redirectUri, expiresAt, now());
    reply.setCookie("texlite_oauth_state", state, {
      path: basePathHref(config.basePath),
      httpOnly: true,
      sameSite: "lax",
      secure: requestIsSecure(request),
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000)
    });
    return reply.redirect(nuwaxOAuth.authorizationUrl(state, redirectUri));
  });

  app.get("/auth/nuwax/callback", async (request, reply) => {
    if (!nuwaxOAuth.enabled) return apiError(reply, 404, "OAUTH_NOT_CONFIGURED");
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    if (query.error) return apiError(reply, 400, "OAUTH_ACCESS_DENIED");
    if (typeof query.code !== "string" || typeof query.state !== "string") {
      return apiError(reply, 400, "OAUTH_CALLBACK_INVALID");
    }
    const stateToken = query.state;
    const stateCookie = request.cookies.texlite_oauth_state;
    const state = db.prepare("SELECT * FROM oauth_states WHERE id = ? AND expires_at > ?")
      .get(digestToken(stateToken), now()) as { id: string; return_path: string; redirect_uri: string } | undefined;
    db.prepare("DELETE FROM oauth_states WHERE id = ?").run(digestToken(stateToken));
    reply.clearCookie("texlite_oauth_state", { path: basePathHref(config.basePath) });
    if (!state || !stateCookie || stateCookie !== stateToken) return apiError(reply, 400, "OAUTH_STATE_INVALID");
    try {
      const tokens = await nuwaxOAuth.exchangeAuthorizationCode(query.code, state.redirect_uri);
      const profile = await nuwaxOAuth.fetchProfile(tokens.accessToken);
      const user = upsertNuwaxUser(db, profile);
      if (user.disabled) return apiError(reply, 403, "AUTH_DISABLED");
      nuwaxOAuth.storeTokens(user.id, tokens);
      setSessionCookie(reply, request, config, db, user.id);
      return reply.redirect(withBasePath(config.basePath, state.return_path));
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      request.log.warn({ err: error }, "Nuwax OAuth sign-in failed");
      return apiError(reply, 502, "OAUTH_PROVIDER_FAILED");
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies.texlite_session;
    if (token) {
      const sessionId = digestToken(token);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      collaboration.disconnectSession(sessionId, "Signed out");
    }
    reply.clearCookie("texlite_session", { path: basePathHref(config.basePath) });
    reply.clearCookie("texlite_share_token", { path: basePathHref(config.basePath) });
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    return { user: publicUser(user) };
  });

  app.patch("/api/me", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { username?: unknown; displayName?: unknown };
    const username = body?.username === undefined ? user.username : text(body.username, MAX_USERNAME_LENGTH);
    if (!isValidUsername(username)) return apiError(reply, 400, "USERNAME_INVALID");
    const displayName = text(body?.displayName ?? user.display_name, MAX_DISPLAY_NAME_LENGTH);
    const existing = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?")
      .get(username, user.id) as { id: string } | undefined;
    if (existing) return apiError(reply, 409, "USERNAME_ALREADY_IN_USE");
    db.prepare("UPDATE users SET username = ?, display_name = ? WHERE id = ?")
      .run(username, displayName, user.id);
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
    return { user: publicUser(updated) };
  });

  app.put("/api/me/password", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    // Nuwax-only accounts have no local password yet. Their authenticated
    // session is sufficient to establish the first local password; existing
    // password accounts must still prove knowledge of the current password.
    if (user.password_hash && !(await verifyPassword(currentPassword, user.password_hash))) {
      return apiError(reply, 400, "CURRENT_PASSWORD_INVALID");
    }
    const passwordHash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(passwordHash, user.id);
    const retainedSessionId = user.session_id ?? digestToken(request.cookies.texlite_session ?? "");
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
      .run(user.id, retainedSessionId);
    collaboration.disconnectUserSessionsExcept(user.id, retainedSessionId, "Password changed");
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
    return { user: publicUser(updated) };
  });
}

/** Link an existing account found by Nuwax search, or provision a new one. */
export function upsertNuwaxUser(db: DatabaseConnection, profile: NuwaxProfile): UserRow {
  return db.transaction(() => {
    let user = db.prepare("SELECT * FROM users WHERE nuwax_subject = ?").get(profile.subject) as UserRow | undefined;
    if (!user) {
      // The subject column is the primary association key. The identity row
      // fallback also repairs a partially provisioned account atomically.
      user = db.prepare(`SELECT account.* FROM auth_identities identity
        JOIN users account ON account.id = identity.user_id
        WHERE identity.issuer = ? AND identity.subject = ?`).get(NUWAX_ISSUER, profile.subject) as UserRow | undefined;
    }
    const timestamp = now();
    if (user) {
      db.prepare("UPDATE users SET nuwax_subject = ?, avatar_url = ? WHERE id = ?")
        .run(profile.subject, profile.avatarUrl, user.id);
      upsertAuthIdentity(db, user.id, profile, timestamp);
      return db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
    }

    const id = randomUUID();
    const username = uniqueLocalUsername(db, initialNuwaxUsername(profile.subject));
    const displayName = profile.name ?? username;
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, email, github_id, nuwax_subject, avatar_url, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, '', NULL, NULL, ?, ?, 'user', 0, 0, 1, ?)`)
      .run(id, username, displayName, profile.subject, profile.avatarUrl, timestamp);
    upsertAuthIdentity(db, id, profile, timestamp);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  })();
}

function upsertAuthIdentity(db: DatabaseConnection, userId: string, profile: NuwaxProfile, timestamp: string): void {
  db.prepare(`
    INSERT INTO auth_identities
      (id, user_id, issuer, subject, provider_username, provider_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (issuer, subject) DO UPDATE SET
      user_id = excluded.user_id,
      provider_username = excluded.provider_username,
      provider_email = excluded.provider_email,
      updated_at = excluded.updated_at
  `).run(randomUUID(), userId, NUWAX_ISSUER, profile.subject, profile.name, null, timestamp, timestamp);
}

export function isValidUsername(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_USERNAME_LENGTH && /^[\p{L}\p{N}_.-]+$/u.test(value);
}

export function initialNuwaxUsername(subject: string): string {
  if (isValidUsername(subject)) return subject;
  return `nuwax-${createHash("sha256").update(subject).digest("hex").slice(0, 32)}`;
}

export function uniqueLocalUsername(db: DatabaseConnection, login: string): string {
  const base = login.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, MAX_USERNAME_LENGTH) || "nuwax-user";
  let username = base;
  let suffix = 2;
  while (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
    username = `${base.slice(0, Math.max(1, MAX_USERNAME_LENGTH - String(suffix).length - 1))}-${suffix}`;
    suffix += 1;
  }
  return username;
}

function setSessionCookie(
  reply: { setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown },
  request: { protocol: string; headers: Record<string, string | string[] | undefined> },
  config: Config,
  db: DatabaseConnection,
  userId: string
): void {
  const session = createSessionToken();
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(session.digest, userId, expires.toISOString(), now());
  reply.setCookie("texlite_session", session.token, {
    path: basePathHref(config.basePath),
    httpOnly: true,
    sameSite: "strict",
    secure: requestIsSecure(request),
    expires
  });
}

function requestIsSecure(request: { protocol: string }): boolean {
  return request.protocol === "https";
}

function safeReturnPath(value: unknown, basePath = "/"): string {
  if (typeof value !== "string" || !value.trim()) return "/";
  const candidate = value.trim();
  if (candidate.length > 2_048 || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\0")) return "/";
  return withoutBasePath(basePath, candidate) ?? "/";
}
