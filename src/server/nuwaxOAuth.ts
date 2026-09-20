import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NuwaxOAuthConfig, Config } from "./config.js";
import type { DatabaseConnection } from "./db.js";

/** Nuwax uses commas, rather than spaces, to separate OAuth scopes. */
export const NUWAX_OAUTH_SCOPE = "profile,user:search";
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;
const SEARCH_WINDOW_MS = 5 * 60_000;
const SEARCH_LIMIT = 20;

export interface NuwaxProfile {
  subject: string;
  name: string | null;
  avatarUrl: string | null;
  tenantId: string | null;
}

export interface NuwaxTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
}

export type NuwaxOAuthFailure = "reauth" | "scope" | "rate_limited" | "provider";

export class NuwaxOAuthError extends Error {
  constructor(readonly failure: NuwaxOAuthFailure, message: string) {
    super(message);
    this.name = "NuwaxOAuthError";
  }
}

interface SearchCounter {
  startedAtMs: number;
  count: number;
}

/**
 * Server-side Nuwax client. Access and refresh tokens never leave this class;
 * only the short-lived TexLite session is sent to the browser.
 */
export class NuwaxOAuthService {
  private readonly pendingRefreshes = new Map<string, Promise<string>>();
  private readonly searchCounters = new Map<string, SearchCounter>();

  constructor(
    private readonly config: Config,
    private readonly db: DatabaseConnection,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.oauth);
  }

  authorizationUrl(state: string, redirectUri: string): string {
    const oauth = this.requireConfig();
    const authorize = new URL(`${oauth.baseUrl}/api/oauth2/authorize`);
    authorize.searchParams.set("client_id", oauth.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", NUWAX_OAUTH_SCOPE);
    authorize.searchParams.set("state", state);
    return authorize.toString();
  }

  async exchangeAuthorizationCode(code: string, redirectUri: string): Promise<NuwaxTokenSet> {
    return await this.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.requireConfig().clientId,
      client_secret: this.requireConfig().clientSecret
    }));
  }

  async fetchProfile(accessToken: string): Promise<NuwaxProfile> {
    const payload = await this.requestJson(`${this.requireConfig().baseUrl}/api/oauth2/userinfo`, accessToken);
    const profile = parseNuwaxProfile(payload, false);
    if (!profile) throw new NuwaxOAuthError("provider", "Nuwax did not return a valid user profile");
    return profile;
  }

  async storeTokens(userId: string, tokens: NuwaxTokenSet): Promise<void> {
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1_000).toISOString();
    await this.db.nuwaxTokens.upsert({
      user_id: userId,
      access_token_ciphertext: encryptToken(this.config, tokens.accessToken),
      access_token_expires_at: expiresAt,
      refresh_token_ciphertext: encryptToken(this.config, tokens.refreshToken),
      scope: tokens.scope,
      created_at: timestamp,
      updated_at: timestamp
    });
  }

  /** Return a profile found by exact phone match, without persisting the phone. */
  async searchByPhone(userId: string, phone: string): Promise<NuwaxProfile | null> {
    const retryAfterSeconds = this.takeSearchSlot(userId);
    if (retryAfterSeconds !== null) {
      throw new NuwaxOAuthError("rate_limited", "Nuwax user search rate limit exceeded");
    }
    try {
      return await this.searchWithAccessToken(phone, await this.accessTokenForUser(userId));
    } catch (error) {
      // Nuwax can invalidate an access token before its advertised expiry.
      // Use the rotated refresh token once before asking the owner to
      // authorize again; a revoked refresh token still becomes `reauth`.
      if (!(error instanceof NuwaxOAuthError) || error.failure !== "reauth") throw error;
      return await this.searchWithAccessToken(phone, await this.refreshAccessTokenForUser(userId));
    }
  }

  async clearTokens(userId: string): Promise<void> {
    await this.db.nuwaxTokens.deleteByUserId(userId);
  }

  private requireConfig(): NuwaxOAuthConfig {
    if (!this.config.oauth) throw new NuwaxOAuthError("provider", "Nuwax OAuth is not configured");
    return this.config.oauth;
  }

  private async accessTokenForUser(userId: string): Promise<string> {
    const row = await this.db.nuwaxTokens.findByUserId(userId);
    if (!row) throw new NuwaxOAuthError("reauth", "The user must sign in with Nuwax again before searching users");
    if (Date.parse(row.access_token_expires_at) > Date.now() + ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return decryptToken(this.config, row.access_token_ciphertext);
    }

    const pending = this.pendingRefreshes.get(userId);
    if (pending) return await pending;
    const refresh = this.refreshAccessToken(userId, decryptToken(this.config, row.refresh_token_ciphertext));
    this.pendingRefreshes.set(userId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.pendingRefreshes.get(userId) === refresh) this.pendingRefreshes.delete(userId);
    }
  }

  private async refreshAccessTokenForUser(userId: string): Promise<string> {
    const pending = this.pendingRefreshes.get(userId);
    if (pending) return await pending;
    const row = await this.db.nuwaxTokens.findByUserId(userId);
    if (!row) throw new NuwaxOAuthError("reauth", "The user must sign in with Nuwax again before searching users");
    const refresh = this.refreshAccessToken(userId, decryptToken(this.config, row.refresh_token_ciphertext));
    this.pendingRefreshes.set(userId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.pendingRefreshes.get(userId) === refresh) this.pendingRefreshes.delete(userId);
    }
  }

  private async searchWithAccessToken(phone: string, accessToken: string): Promise<NuwaxProfile | null> {
    const url = new URL(`${this.requireConfig().baseUrl}/api/oauth2/user/search`);
    url.searchParams.set("phone", phone);
    const payload = await this.requestJson(url.toString(), accessToken);
    return parseNuwaxProfile(payload, true);
  }

  private async refreshAccessToken(userId: string, refreshToken: string): Promise<string> {
    try {
      const tokens = await this.exchangeToken(new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.requireConfig().clientId,
        client_secret: this.requireConfig().clientSecret
      }));
      await this.storeTokens(userId, tokens);
      return tokens.accessToken;
    } catch (error) {
      await this.clearTokens(userId);
      if (error instanceof NuwaxOAuthError && error.failure === "scope") throw error;
      throw new NuwaxOAuthError("reauth", "The Nuwax session must be authorized again");
    }
  }

  private async exchangeToken(parameters: URLSearchParams): Promise<NuwaxTokenSet> {
    const response = await this.fetchImpl(`${this.requireConfig().baseUrl}/api/oauth2/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: parameters.toString()
    });
    const payload = await parseResponseJson(response);
    if (!response.ok || isProtocolError(payload)) {
      throw new NuwaxOAuthError("provider", "Nuwax token exchange failed");
    }
    if (!isRecord(payload)
      || typeof payload.access_token !== "string" || !payload.access_token
      || typeof payload.refresh_token !== "string" || !payload.refresh_token) {
      throw new NuwaxOAuthError("provider", "Nuwax returned an invalid token response");
    }
    const expiresIn = typeof payload.expires_in === "number"
      ? payload.expires_in
      : typeof payload.expires_in === "string" ? Number(payload.expires_in) : NaN;
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new NuwaxOAuthError("provider", "Nuwax returned an invalid token lifetime");
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresInSeconds: Math.min(Math.max(Math.floor(expiresIn), 60), 30 * 86_400),
      scope: typeof payload.scope === "string" ? payload.scope : NUWAX_OAUTH_SCOPE
    };
  }

  private async requestJson(url: string, accessToken: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` }
    });
    const payload = await parseResponseJson(response);
    if (isRecord(payload) && (payload.code === "4010" || payload.code === 4010)) {
      await this.clearTokensForExpiredAccessToken(accessToken);
      throw new NuwaxOAuthError("reauth", "The Nuwax access token is no longer valid");
    }
    if (isRecord(payload) && (payload.code === "4030" || payload.code === 4030)) {
      throw new NuwaxOAuthError("scope", "The Nuwax application is not allowed to search users");
    }
    if (!response.ok || isProtocolError(payload)) {
      throw new NuwaxOAuthError("provider", "Nuwax user lookup failed");
    }
    return payload;
  }

  private async clearTokensForExpiredAccessToken(accessToken: string): Promise<void> {
    // The token is never stored in plaintext. Mark the matching encrypted row
    // stale so the next call refreshes it without exposing the credential.
    const rows = await this.db.nuwaxTokens.list();
    for (const row of rows) {
      try {
        if (decryptToken(this.config, row.access_token_ciphertext) === accessToken) {
          await this.db.nuwaxTokens.expireAccessToken(row.user_id);
          return;
        }
      } catch {
        // A later call will require reauthorization if the encrypted row is
        // no longer readable.
      }
    }
  }

  private takeSearchSlot(userId: string): number | null {
    const now = Date.now();
    const current = this.searchCounters.get(userId);
    if (!current || now - current.startedAtMs >= SEARCH_WINDOW_MS) {
      this.searchCounters.set(userId, { startedAtMs: now, count: 1 });
      return null;
    }
    if (current.count >= SEARCH_LIMIT) {
      return Math.max(1, Math.ceil((current.startedAtMs + SEARCH_WINDOW_MS - now) / 1000));
    }
    current.count += 1;
    return null;
  }
}

async function parseResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseNuwaxProfile(payload: unknown, emptyObjectMeansNoMatch: boolean): NuwaxProfile | null {
  if (!isRecord(payload)) {
    if (emptyObjectMeansNoMatch) return null;
    throw new NuwaxOAuthError("provider", "Nuwax returned an invalid user profile");
  }
  if (emptyObjectMeansNoMatch && Object.keys(payload).length === 0) return null;
  if (emptyObjectMeansNoMatch && (payload.user_id === undefined || payload.user_id === null)) return null;
  const rawSubject = payload.sub;
  const subject = typeof rawSubject === "string" ? rawSubject.trim() : typeof rawSubject === "number" ? String(rawSubject) : "";
  if (!subject) {
    if (emptyObjectMeansNoMatch) return null;
    throw new NuwaxOAuthError("provider", "Nuwax returned a profile without a subject");
  }
  return {
    subject,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 50) : null,
    avatarUrl: typeof payload.avatar === "string" && payload.avatar.trim() ? payload.avatar.trim().slice(0, 2_048) : null,
    tenantId: typeof payload.tenant_id === "string" || typeof payload.tenant_id === "number" ? String(payload.tenant_id) : null
  };
}

function isProtocolError(value: unknown): boolean {
  return isRecord(value) && typeof value.error === "string";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encryptToken(config: Config, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", oauthKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptToken(config: Config, ciphertext: string): string {
  const [version, ivText, tagText, encryptedText] = ciphertext.split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) throw new NuwaxOAuthError("reauth", "Nuwax credentials are unavailable");
  try {
    const decipher = createDecipheriv("aes-256-gcm", oauthKey(config), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new NuwaxOAuthError("reauth", "Nuwax credentials are unavailable");
  }
}

function oauthKey(config: Config): Buffer {
  const target = path.join(config.dataDir, "nuwax-oauth.key");
  if (!fs.existsSync(target)) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(target, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!fs.existsSync(target)) throw error;
    }
  }
  const key = fs.readFileSync(target);
  if (key.length !== 32) throw new Error("Invalid Nuwax OAuth encryption key");
  return key;
}
