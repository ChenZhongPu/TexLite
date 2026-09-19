import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config, GithubOAuthConfig } from "../config.js";
import type { DatabaseConnection, UserRow } from "../db.js";
import { normalizeEmail, publicUser, requireUser } from "../auth.js";
import {
  createSessionToken,
  digestToken,
  hashPassword,
  LoginRateLimiter,
  verifyPassword
} from "../security.js";
import { apiError, ValidationError } from "../http.js";
import { basePathHref, withBasePath, withoutBasePath } from "../../shared/basePath.js";

interface AuthRouteContext {
  config: Config;
  db: DatabaseConnection;
  loginLimiter: LoginRateLimiter;
  githubFetch?: typeof fetch;
}

const now = (): string => new Date().toISOString();
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const GITHUB_ISSUER = "github";

function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError();
  }
  return value.trim();
}

/** Register local compatibility login, GitHub OAuth, logout, and password routes. */
export function registerAuthRoutes(app: FastifyInstance, context: AuthRouteContext): void {
  const { config, db, loginLimiter, githubFetch = fetch } = context;

  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { username?: unknown; password?: unknown };
    const usernameInput = text(body?.username, 64);
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

  app.get("/api/auth/github", async (request, reply) => {
    const oauth = config.githubOAuth;
    if (!oauth) return apiError(reply, 404, "OAUTH_NOT_CONFIGURED");
    const query = request.query as { return?: unknown };
    const returnPath = safeReturnPath(query.return, config.basePath);
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
    const redirectUri = oauthRedirectUri(config, request, oauth);
    db.prepare("INSERT INTO oauth_states (id, return_path, redirect_uri, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(digestToken(state), returnPath, redirectUri, expiresAt, now());
    reply.setCookie("texlite_oauth_state", state, {
      path: basePathHref(config.basePath),
      httpOnly: true,
      sameSite: "lax",
      secure: requestIsSecure(request),
      maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000)
    });
    const authorize = new URL(oauth.authorizeUrl);
    authorize.searchParams.set("client_id", oauth.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", "read:user user:email");
    authorize.searchParams.set("state", state);
    return reply.redirect(authorize.toString());
  });

  app.get("/auth/github/callback", async (request, reply) => {
    const oauth = config.githubOAuth;
    if (!oauth) return apiError(reply, 404, "OAUTH_NOT_CONFIGURED");
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
      const accessToken = await exchangeGithubCode(githubFetch, oauth, query.code, state.redirect_uri);
      const profile = await fetchGithubProfile(githubFetch, oauth, accessToken);
      const user = upsertGithubUser(db, profile);
      if (user.disabled) return apiError(reply, 403, "AUTH_DISABLED");
      setSessionCookie(reply, request, config, db, user.id);
      return reply.redirect(withBasePath(config.basePath, state.return_path));
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      request.log.warn({ err: error }, "GitHub OAuth sign-in failed");
      return apiError(reply, 502, "OAUTH_PROVIDER_FAILED");
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies.texlite_session;
    if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(digestToken(token));
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
    const body = request.body as { displayName?: unknown };
    const displayName = text(body?.displayName, 100);
    db.prepare("UPDATE users SET display_name = ? WHERE id = ?")
      .run(displayName, user.id);
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
    return { user: publicUser(updated) };
  });

  app.put("/api/me/password", async (request, reply) => {
    const user = requireUser(request, reply, db);
    if (!user) return;
    const body = request.body as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    // GitHub-only accounts have no local password yet. Their authenticated
    // session is sufficient to establish the first local password; existing
    // password accounts must still prove knowledge of the current password.
    if (user.password_hash && !(await verifyPassword(currentPassword, user.password_hash))) {
      return apiError(reply, 400, "CURRENT_PASSWORD_INVALID");
    }
    const passwordHash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")
      .run(passwordHash, user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
      .run(user.id, digestToken(request.cookies.texlite_session ?? ""));
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
    return { user: publicUser(updated) };
  });
}

interface GithubProfile {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

async function exchangeGithubCode(
  githubFetch: typeof fetch,
  oauth: GithubOAuthConfig,
  code: string,
  redirectUri: string
): Promise<string> {
  const response = await githubFetch(oauth.tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret, code, redirect_uri: redirectUri }).toString()
  });
  const payload = await response.json() as { access_token?: unknown };
  if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error(`GitHub token exchange failed (${response.status})`);
  }
  return payload.access_token;
}

async function fetchGithubProfile(githubFetch: typeof fetch, oauth: GithubOAuthConfig, token: string): Promise<GithubProfile> {
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
  const profileResponse = await githubFetch(`${oauth.apiUrl}/user`, { method: "GET", headers });
  if (!profileResponse.ok) throw new Error(`GitHub profile request failed (${profileResponse.status})`);
  const profile = await profileResponse.json() as { id?: unknown; login?: unknown; name?: unknown; email?: unknown; avatar_url?: unknown };
  if ((typeof profile.id !== "number" && typeof profile.id !== "string") || typeof profile.login !== "string" || !profile.login.trim()) {
    throw new ValidationError("GITHUB_ACCOUNT_INVALID");
  }
  // GitHub may legitimately return no verified address: the user can hide
  // private email addresses or have no verified address at all. Authentication
  // still succeeds without one. Only a verified address may link an OAuth
  // identity to an existing local account.
  let email: string | null = null;
  try {
    const emailResponse = await githubFetch(`${oauth.apiUrl}/user/emails`, { method: "GET", headers });
    if (emailResponse.ok) {
      const emails = await emailResponse.json() as Array<{ email?: unknown; primary?: unknown; verified?: unknown }>;
      const verified = emails.filter((item) => item.verified === true && typeof item.email === "string" && item.email.trim());
      const selected = verified.find((item) => item.primary === true) ?? verified[0];
      if (selected && typeof selected.email === "string") email = normalizeEmail(selected.email);
    }
  } catch {
    // A public profile address is not enough to link two accounts safely.
    // Leave the account without an email when GitHub's verified-email endpoint
    // is unavailable.
  }
  return {
    id: String(profile.id),
    login: profile.login.trim().slice(0, 64),
    name: typeof profile.name === "string" && profile.name.trim() ? profile.name.trim().slice(0, 100) : null,
    email,
    avatarUrl: typeof profile.avatar_url === "string" ? profile.avatar_url.slice(0, 2_048) : null
  };
}

function upsertGithubUser(db: DatabaseConnection, profile: GithubProfile): UserRow {
  return db.transaction(() => {
    let user = db.prepare(`
      SELECT user.* FROM auth_identities identity
      JOIN users user ON user.id = identity.user_id
      WHERE identity.issuer = ? AND identity.subject = ?
    `).get(GITHUB_ISSUER, profile.id) as UserRow | undefined;
    // Keep this fallback for databases that may have been stopped between the
    // legacy GitHub column and the normalized identity migration. The v4
    // migration normally makes this path unnecessary.
    if (!user) user = db.prepare("SELECT * FROM users WHERE github_id = ?").get(profile.id) as UserRow | undefined;

    // A verified mailbox is an optional but unique account key. A new OAuth
    // identity that presents an existing address belongs to that TexLite user,
    // allowing one account to accumulate identities from multiple providers.
    let linkedByEmail = false;
    if (!user && profile.email) {
      user = db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(profile.email) as UserRow | undefined;
      linkedByEmail = Boolean(user);
    }

    // An already-bound identity must never be moved to a different account if
    // the provider reports a changed email address.
    if (profile.email) {
      const emailOwner = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(profile.email) as { id: string } | undefined;
      if (emailOwner && emailOwner.id !== user?.id) throw new ValidationError("EMAIL_ALREADY_IN_USE");
    }

    const timestamp = now();
    if (user) {
      if (linkedByEmail) {
        const githubIdentity = db.prepare(`SELECT subject FROM auth_identities
          WHERE user_id = ? AND issuer = ?`).get(user.id, GITHUB_ISSUER) as { subject: string } | undefined;
        if ((githubIdentity && githubIdentity.subject !== profile.id) || (user.github_id && user.github_id !== profile.id)) {
          throw new ValidationError("OAUTH_IDENTITY_ALREADY_LINKED");
        }
      }
      // Keep a locally chosen display name and local username. GitHub's name
      // and login are provider attributes, not application identity fields.
      db.prepare("UPDATE users SET github_id = ?, email = ?, avatar_url = ? WHERE id = ?")
        .run(profile.id, profile.email ?? user.email, profile.avatarUrl, user.id);
      upsertAuthIdentity(db, user.id, profile, timestamp);
      return db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as UserRow;
    }

    const id = randomUUID();
    const username = uniqueLocalUsername(db, profile.login);
    const displayName = profile.name ?? profile.login;
    db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, email, github_id, avatar_url, role, disabled, must_change_password, can_create_projects, created_at)
      VALUES (?, ?, ?, '', ?, ?, ?, 'user', 0, 0, 1, ?)`)
      .run(id, username, displayName, profile.email, profile.id, profile.avatarUrl, timestamp);
    upsertAuthIdentity(db, id, profile, timestamp);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  })();
}

function upsertAuthIdentity(db: DatabaseConnection, userId: string, profile: GithubProfile, timestamp: string): void {
  db.prepare(`
    INSERT INTO auth_identities
      (id, user_id, issuer, subject, provider_username, provider_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (issuer, subject) DO UPDATE SET
      user_id = excluded.user_id,
      provider_username = excluded.provider_username,
      provider_email = excluded.provider_email,
      updated_at = excluded.updated_at
  `).run(randomUUID(), userId, GITHUB_ISSUER, profile.id, profile.login, profile.email, timestamp, timestamp);
}

function uniqueLocalUsername(db: DatabaseConnection, login: string): string {
  const base = login.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "github-user";
  let username = base;
  let suffix = 2;
  while (db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
    username = `${base.slice(0, Math.max(1, 64 - String(suffix).length - 1))}-${suffix}`;
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

function oauthRedirectUri(config: Config, request: { protocol: string; headers: Record<string, string | string[] | undefined> }, oauth: GithubOAuthConfig): string {
  if (oauth.redirectUri) return oauth.redirectUri;
  const host = typeof request.headers.host === "string" ? request.headers.host : "127.0.0.1";
  return new URL(`${basePathHref(config.basePath)}auth/github/callback`, `${request.protocol || "http"}://${host}`).toString();
}

function safeReturnPath(value: unknown, basePath = "/"): string {
  if (typeof value !== "string" || !value.trim()) return "/";
  const candidate = value.trim();
  if (candidate.length > 2_048 || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\0")) return "/";
  return withoutBasePath(basePath, candidate) ?? "/";
}
