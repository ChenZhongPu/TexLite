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
import {
  isUsernameSyntaxValid,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH
} from "../../shared/userIdentity.js";
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
export { MAX_DISPLAY_NAME_LENGTH, MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH };

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
    const user = await db.identity.findUserByUsername(username);
    if (!user || user.disabled || !(await verifyPassword(password, user.password_hash))) {
      const result = loginLimiter.recordFailure(rateLimitKey);
      if (result.locked) return apiError(reply, 429, "AUTH_RATE_LIMITED");
      return apiError(reply, 401, "AUTH_INVALID");
    }
    loginLimiter.reset(rateLimitKey);
    await setSessionCookie(reply, request, config, db, user.id);
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
    await db.identity.createOAuthState({
      id: digestToken(state), returnPath, redirectUri, expiresAt, createdAt: now()
    });
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
    const state = await db.identity.consumeOAuthState(digestToken(stateToken), now());
    reply.clearCookie("texlite_oauth_state", { path: basePathHref(config.basePath) });
    if (!state || !stateCookie || stateCookie !== stateToken) return apiError(reply, 400, "OAUTH_STATE_INVALID");
    try {
      const tokens = await nuwaxOAuth.exchangeAuthorizationCode(query.code, state.redirectUri);
      const profile = await nuwaxOAuth.fetchProfile(tokens.accessToken);
      const user = await upsertNuwaxUser(db, profile);
      if (user.disabled) return apiError(reply, 403, "AUTH_DISABLED");
      await nuwaxOAuth.storeTokens(user.id, tokens);
      await setSessionCookie(reply, request, config, db, user.id);
      return reply.redirect(withBasePath(config.basePath, state.returnPath));
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
      if (await db.identity.deleteSession(sessionId)) {
        collaboration.disconnectSession(sessionId, "Signed out");
      }
    }
    reply.clearCookie("texlite_session", { path: basePathHref(config.basePath) });
    reply.clearCookie("texlite_share_token", { path: basePathHref(config.basePath) });
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    return { user: publicUser(user) };
  });

  app.patch("/api/me", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { username?: unknown; displayName?: unknown };
    const username = body?.username === undefined
      ? user.username
      : typeof body.username === "string" && body.username.length <= MAX_USERNAME_LENGTH
        ? body.username.trim()
        : "";
    if (!isAllowedProfileUsername(username, user.username, user.nuwax_subject)) {
      return apiError(reply, 400, "USERNAME_INVALID");
    }
    const displayName = text(body?.displayName ?? user.display_name, MAX_DISPLAY_NAME_LENGTH);
    if (await db.identity.usernameIsTaken(username, user.id)) return apiError(reply, 409, "USERNAME_ALREADY_IN_USE");
    const updated = await db.identity.updateProfile(user.id, username, displayName);
    return { user: publicUser(updated!) };
  });

  app.put("/api/me/password", async (request, reply) => {
    const user = await requireUser(request, reply, db);
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
    await db.identity.setPassword(user.id, passwordHash);
    const retainedSessionId = user.session_id ?? digestToken(request.cookies.texlite_session ?? "");
    const deletedSessionIds = await db.identity.deleteOtherSessions(user.id, retainedSessionId);
    for (const sessionId of deletedSessionIds) collaboration.disconnectSession(sessionId, "Password changed");
    const updated = await db.identity.findUserById(user.id);
    return { user: publicUser(updated!) };
  });
}

/** Link an existing account found by Nuwax search, or provision a new one. */
export async function upsertNuwaxUser(db: DatabaseConnection, profile: NuwaxProfile): Promise<UserRow> {
  return await db.identity.upsertNuwaxUser({
    subject: profile.subject,
    name: profile.name,
    avatarUrl: profile.avatarUrl
  }, now(), randomUUID());
}

export function isValidUsername(value: string): boolean {
  return isUsernameSyntaxValid(value);
}

/** Nuwax may provide a stable username shorter than the local minimum. */
export function isValidNuwaxUsername(value: string): boolean {
  return isUsernameSyntaxValid(value, 1);
}

/**
 * A short Nuwax-generated username may be retained, but never chosen as a
 * new local username. The current subject marker prevents short legacy names
 * from being grandfathered in accidentally.
 */
export function isAllowedProfileUsername(value: string, currentUsername: string, nuwaxSubject: string | null): boolean {
  return isValidUsername(value)
    || (Boolean(nuwaxSubject) && value === currentUsername && isValidNuwaxUsername(value));
}

export function initialNuwaxUsername(subject: string): string {
  if (isValidNuwaxUsername(subject)) return subject;
  return `nuwax-${createHash("sha256").update(subject).digest("hex").slice(0, 32)}`;
}

export async function uniqueLocalUsername(db: DatabaseConnection, login: string): Promise<string> {
  const base = login.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, MAX_USERNAME_LENGTH) || "nuwax-user";
  let username = base;
  let suffix = 2;
  while (await db.identity.usernameIsTaken(username)) {
    username = `${base.slice(0, Math.max(1, MAX_USERNAME_LENGTH - String(suffix).length - 1))}-${suffix}`;
    suffix += 1;
  }
  return username;
}

async function setSessionCookie(
  reply: { setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown },
  request: { protocol: string; headers: Record<string, string | string[] | undefined> },
  config: Config,
  db: DatabaseConnection,
  userId: string
): Promise<void> {
  const session = createSessionToken();
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  await db.identity.createSession({
    id: session.digest,
    userId,
    expiresAt: expires.toISOString(),
    createdAt: now()
  });
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
