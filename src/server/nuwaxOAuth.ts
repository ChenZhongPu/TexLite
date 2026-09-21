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
export const NUWAX_REQUEST_TIMEOUT_MS = 10_000;
export const NUWAX_MAX_RESPONSE_BYTES = 256 * 1024;

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

export type NuwaxOAuthFailure = "reauth" | "scope" | "rate_limited" | "provider" | "timeout" | "unavailable";

export class NuwaxOAuthError extends Error {
  constructor(
    readonly failure: NuwaxOAuthFailure,
    message: string,
    readonly confirmedInvalidCredential = false
  ) {
    super(message);
    this.name = "NuwaxOAuthError";
  }
}

interface SearchCounter {
  startedAtMs: number;
  count: number;
}

interface AccessTokenContext {
  accessToken: string;
  accessTokenCiphertext: string;
}

/**
 * Server-side Nuwax client. Access and refresh tokens never leave this class;
 * only the short-lived TexLite session is sent to the browser.
 */
export class NuwaxOAuthService {
  private readonly pendingRefreshes = new Map<string, Promise<AccessTokenContext>>();
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
    await this.db.nuwaxTokens.upsert(this.encryptedTokenRecord(userId, tokens));
  }

  /** Return a profile found by exact phone match, without persisting the phone. */
  async searchByPhone(userId: string, phone: string): Promise<NuwaxProfile | null> {
    const retryAfterSeconds = this.takeSearchSlot(userId);
    if (retryAfterSeconds !== null) {
      throw new NuwaxOAuthError("rate_limited", "Nuwax user search rate limit exceeded");
    }
    try {
      return await this.searchWithAccessToken(phone, await this.accessTokenForUser(userId), userId);
    } catch (error) {
      // Nuwax can invalidate an access token before its advertised expiry.
      // Use the rotated refresh token once before asking the owner to
      // authorize again; a revoked refresh token still becomes `reauth`.
      if (!(error instanceof NuwaxOAuthError) || error.failure !== "reauth") throw error;
      return await this.searchWithAccessToken(phone, await this.refreshAccessTokenForUser(userId), userId);
    }
  }

  async clearTokens(userId: string): Promise<void> {
    await this.db.nuwaxTokens.deleteByUserId(userId);
  }

  private requireConfig(): NuwaxOAuthConfig {
    if (!this.config.oauth) throw new NuwaxOAuthError("provider", "Nuwax OAuth is not configured");
    return this.config.oauth;
  }

  private async accessTokenForUser(userId: string): Promise<AccessTokenContext> {
    const row = await this.db.nuwaxTokens.findByUserId(userId);
    if (!row) throw new NuwaxOAuthError("reauth", "The user must sign in with Nuwax again before searching users");
    if (Date.parse(row.access_token_expires_at) > Date.now() + ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return {
        accessToken: decryptToken(this.config, row.access_token_ciphertext),
        accessTokenCiphertext: row.access_token_ciphertext
      };
    }
    return await this.refreshAccessTokenForUser(userId);
  }

  private refreshAccessTokenForUser(userId: string): Promise<AccessTokenContext> {
    const pending = this.pendingRefreshes.get(userId);
    if (pending) return pending;

    // Set the promise immediately, before the first database await. This makes
    // simultaneous requests share one refresh even when they all observe an
    // expired access token at the same time.
    const refresh = this.refreshAccessToken(userId);
    this.pendingRefreshes.set(userId, refresh);
    void refresh.then(
      () => {
        if (this.pendingRefreshes.get(userId) === refresh) this.pendingRefreshes.delete(userId);
      },
      () => {
        if (this.pendingRefreshes.get(userId) === refresh) this.pendingRefreshes.delete(userId);
      }
    );
    return refresh;
  }

  private async searchWithAccessToken(phone: string, token: AccessTokenContext, userId: string): Promise<NuwaxProfile | null> {
    const url = new URL(`${this.requireConfig().baseUrl}/api/oauth2/user/search`);
    url.searchParams.set("phone", phone);
    const payload = await this.requestJson(url.toString(), token.accessToken, {
      userId,
      accessTokenCiphertext: token.accessTokenCiphertext
    });
    return parseNuwaxProfile(payload, true);
  }

  private async refreshAccessToken(userId: string): Promise<AccessTokenContext> {
    const row = await this.db.nuwaxTokens.findByUserId(userId);
    if (!row) throw new NuwaxOAuthError("reauth", "The user must sign in with Nuwax again before searching users");
    try {
      const tokens = await this.exchangeToken(new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: decryptToken(this.config, row.refresh_token_ciphertext),
        client_id: this.requireConfig().clientId,
        client_secret: this.requireConfig().clientSecret
      }));
      const replacement = this.encryptedTokenRecord(userId, tokens);
      const replaced = await this.db.nuwaxTokens.replaceIfCurrent(
        replacement,
        row.access_token_ciphertext,
        row.refresh_token_ciphertext
      );
      if (!replaced) {
        // A concurrent sign-in or refresh won the update. Keep its current
        // credentials instead of overwriting them with this stale result.
        const current = await this.db.nuwaxTokens.findByUserId(userId);
        if (!current) throw new NuwaxOAuthError("reauth", "The user must sign in with Nuwax again before searching users");
        return this.accessTokenContext(current);
      }
      return {
        accessToken: tokens.accessToken,
        accessTokenCiphertext: replacement.access_token_ciphertext
      };
    } catch (error) {
      if (error instanceof NuwaxOAuthError && error.confirmedInvalidCredential) {
        // Only an explicit invalid_grant/invalid_token-style response permits
        // deleting credentials. Network failures and provider 5xx responses
        // must leave the refresh token available for a later retry.
        try {
          const removed = await this.db.nuwaxTokens.deleteByUserIdIfCurrent(
            userId,
            row.access_token_ciphertext,
            row.refresh_token_ciphertext
          );
          if (!removed) {
            // The row changed while this refresh was in flight. The newer
            // credentials belong to the current session and must survive.
            const current = await this.db.nuwaxTokens.findByUserId(userId);
            if (current) return this.accessTokenContext(current);
          }
        } catch {
          // Preserve the safe reauthorization response even if cleanup itself
          // is temporarily unavailable.
        }
        throw new NuwaxOAuthError("reauth", "The Nuwax session must be authorized again");
      }
      if (error instanceof NuwaxOAuthError) throw error;
      throw new NuwaxOAuthError("provider", "Nuwax token refresh failed");
    }
  }

  private encryptedTokenRecord(userId: string, tokens: NuwaxTokenSet) {
    const timestamp = new Date().toISOString();
    return {
      user_id: userId,
      access_token_ciphertext: encryptToken(this.config, tokens.accessToken),
      access_token_expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1_000).toISOString(),
      refresh_token_ciphertext: encryptToken(this.config, tokens.refreshToken),
      scope: tokens.scope,
      created_at: timestamp,
      updated_at: timestamp
    };
  }

  private accessTokenContext(row: {
    access_token_ciphertext: string;
    access_token_expires_at: string;
  }): AccessTokenContext {
    return {
      accessToken: decryptToken(this.config, row.access_token_ciphertext),
      accessTokenCiphertext: row.access_token_ciphertext
    };
  }

  private async exchangeToken(parameters: URLSearchParams): Promise<NuwaxTokenSet> {
    const { response, payload } = await this.fetchJson(`${this.requireConfig().baseUrl}/api/oauth2/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: parameters.toString()
    });
    if (response.status === 429) {
      throw new NuwaxOAuthError("rate_limited", "Nuwax token endpoint rate limit exceeded");
    }
    if (isConfirmedInvalidCredential(payload)) {
      throw new NuwaxOAuthError("provider", "Nuwax token exchange failed", true);
    }
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

  private async requestJson(
    url: string,
    accessToken: string,
    invalidation?: { userId: string; accessTokenCiphertext: string }
  ): Promise<unknown> {
    const { response, payload } = await this.fetchJson(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` }
    });
    if (isInvalidAccessTokenResponse(response, payload)) {
      if (invalidation) {
        try {
          await this.db.nuwaxTokens.expireAccessToken(invalidation.userId, invalidation.accessTokenCiphertext);
        } catch {
          // The explicit reauth signal is still useful: searchByPhone will
          // attempt the refresh path even if this bookkeeping update failed.
        }
      }
      throw new NuwaxOAuthError("reauth", "The Nuwax access token is no longer valid");
    }
    if (response.status === 429) {
      throw new NuwaxOAuthError("rate_limited", "Nuwax user search rate limit exceeded");
    }
    if (response.status === 403 || (isRecord(payload) && (payload.code === "4030" || payload.code === 4030))) {
      throw new NuwaxOAuthError("scope", "The Nuwax application is not allowed to search users");
    }
    if (!response.ok || isProtocolError(payload)) {
      throw new NuwaxOAuthError("provider", "Nuwax user lookup failed");
    }
    return payload;
  }

  private async fetchJson(input: string, init: RequestInit): Promise<{ response: Response; payload: unknown }> {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const request = (async () => {
      const response = await this.fetchImpl(input, { ...init, signal: controller.signal });
      const payload = await parseResponseJson(response);
      return { response, payload };
    })();
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new NuwaxOAuthError("timeout", "Nuwax request timed out"));
      }, NUWAX_REQUEST_TIMEOUT_MS);
    });
    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (error instanceof NuwaxOAuthError) throw error;
      throw new NuwaxOAuthError("unavailable", "Nuwax OAuth service is unavailable");
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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
  if (!response.body) {
    try {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > NUWAX_MAX_RESPONSE_BYTES) {
        throw new NuwaxOAuthError("provider", "Nuwax response is too large");
      }
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (error instanceof NuwaxOAuthError) throw error;
      return null;
    }
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > NUWAX_MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* The response is already invalid. */ }
        throw new NuwaxOAuthError("provider", "Nuwax response is too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text.trim() ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof NuwaxOAuthError) throw error;
    return null;
  } finally {
    reader.releaseLock();
  }
}

function isConfirmedInvalidCredential(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.code === "4010" || payload.code === 4010) return true;
  if (typeof payload.error !== "string") return false;
  return new Set(["invalid_grant", "invalid_token"]).has(payload.error.trim().toLowerCase());
}

function isInvalidAccessTokenResponse(response: Response, payload: unknown): boolean {
  if (response.status === 401) return true;
  if (!isRecord(payload)) return false;
  if (payload.code === "4010" || payload.code === 4010) return true;
  return typeof payload.error === "string" && payload.error.trim().toLowerCase() === "invalid_token";
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
