import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NUWAX_MAX_RESPONSE_BYTES,
  NUWAX_REQUEST_TIMEOUT_MS,
  NuwaxOAuthError,
  NuwaxOAuthService,
  type NuwaxTokenSet
} from "../src/server/nuwaxOAuth.js";
import type { Config } from "../src/server/config.js";
import type { DatabaseConnection } from "../src/server/db.js";
import type { NuwaxTokenRecord } from "../src/server/database/repositories/nuwaxTokens.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixtureTokens(overrides: Partial<NuwaxTokenSet> = {}): NuwaxTokenSet {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresInSeconds: 3_600,
    scope: "profile,user:search",
    ...overrides
  };
}

function responseJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function tokenResponse(accessToken = "refreshed-access", refreshToken = "refreshed-refresh"): Response {
  return responseJson({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3_600,
    scope: "profile,user:search"
  });
}

function profileResponse(): Response {
  return responseJson({ user_id: "target-user", sub: "target-sub", name: "Target User" });
}

function createFixture(fetchImpl: typeof fetch) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-nuwax-test-"));
  temporaryDirectories.push(dataDir);
  let row: NuwaxTokenRecord | null = null;
  const tokenRepository = {
    upsert: vi.fn(async (input: NuwaxTokenRecord & { created_at: string; updated_at: string }) => {
      row = {
        user_id: input.user_id,
        access_token_ciphertext: input.access_token_ciphertext,
        access_token_expires_at: input.access_token_expires_at,
        refresh_token_ciphertext: input.refresh_token_ciphertext,
        scope: input.scope
      };
    }),
    findByUserId: vi.fn(async (userId: string) => row?.user_id === userId ? row : null),
    deleteByUserId: vi.fn(async (userId: string) => {
      if (row?.user_id === userId) row = null;
    }),
    deleteByUserIdIfCurrent: vi.fn(async (
      userId: string,
      expectedAccessTokenCiphertext: string,
      expectedRefreshTokenCiphertext: string
    ) => {
      if (row?.user_id !== userId
        || row.access_token_ciphertext !== expectedAccessTokenCiphertext
        || row.refresh_token_ciphertext !== expectedRefreshTokenCiphertext) return false;
      row = null;
      return true;
    }),
    replaceIfCurrent: vi.fn(async (
      input: NuwaxTokenRecord & { created_at: string; updated_at: string },
      expectedAccessTokenCiphertext: string,
      expectedRefreshTokenCiphertext: string
    ) => {
      if (row?.user_id !== input.user_id
        || row.access_token_ciphertext !== expectedAccessTokenCiphertext
        || row.refresh_token_ciphertext !== expectedRefreshTokenCiphertext) return false;
      row = {
        user_id: input.user_id,
        access_token_ciphertext: input.access_token_ciphertext,
        access_token_expires_at: input.access_token_expires_at,
        refresh_token_ciphertext: input.refresh_token_ciphertext,
        scope: input.scope
      };
      return true;
    }),
    expireAccessToken: vi.fn(async (userId: string, expectedCiphertext?: string) => {
      if (row?.user_id === userId && (!expectedCiphertext || row.access_token_ciphertext === expectedCiphertext)) {
        row = { ...row, access_token_expires_at: "1970-01-01T00:00:00.000Z" };
      }
    }),
    // This deliberately throws: the service must never scan all users to find
    // the owner of an invalid access token.
    list: vi.fn(() => { throw new Error("all-user token scans are not allowed"); })
  };
  const db = { nuwaxTokens: tokenRepository } as unknown as DatabaseConnection;
  const config = {
    dataDir,
    oauth: {
      baseUrl: "https://testagent.xspaceagi.com",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost:3001/auth/nuwax/callback"
    }
  } as Config;
  return { service: new NuwaxOAuthService(config, db, fetchImpl), tokenRepository };
}

describe("Nuwax OAuth service", () => {
  it("keeps encrypted credentials after a transient refresh failure", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const { service, tokenRepository } = createFixture(fetchImpl);
    await service.storeTokens("owner-1", fixtureTokens({ expiresInSeconds: 0 }));

    await expect(service.searchByPhone("owner-1", "+8613800000000")).rejects.toMatchObject({
      failure: "unavailable"
    });
    expect(tokenRepository.deleteByUserId).not.toHaveBeenCalled();
    expect(tokenRepository.list).not.toHaveBeenCalled();
    expect(tokenRepository.findByUserId).toHaveBeenCalled();
  });

  it("clears credentials only after an explicit invalid refresh response", async () => {
    const fetchImpl: typeof fetch = async () => responseJson({ error: "invalid_grant" }, 400);
    const { service, tokenRepository } = createFixture(fetchImpl);
    await service.storeTokens("owner-1", fixtureTokens({ expiresInSeconds: 0 }));

    await expect(service.searchByPhone("owner-1", "+8613800000000")).rejects.toMatchObject({
      failure: "reauth"
    });
    expect(tokenRepository.deleteByUserIdIfCurrent).toHaveBeenCalledWith(
      "owner-1",
      expect.any(String),
      expect.any(String)
    );
  });

  it("does not clear credentials for an unrelated HTTP 401", async () => {
    const fetchImpl: typeof fetch = async () => responseJson({ error: "invalid_client" }, 401);
    const { service, tokenRepository } = createFixture(fetchImpl);
    await service.storeTokens("owner-1", fixtureTokens({ expiresInSeconds: 0 }));

    await expect(service.searchByPhone("owner-1", "+8613800000000")).rejects.toMatchObject({
      failure: "provider"
    });
    expect(tokenRepository.deleteByUserId).not.toHaveBeenCalled();
    expect(tokenRepository.deleteByUserIdIfCurrent).not.toHaveBeenCalled();
  });

  it("treats a successful HTTP response with Nuwax code 4010 as invalid credentials", async () => {
    const fetchImpl: typeof fetch = async () => responseJson({ code: 4010 });
    const { service, tokenRepository } = createFixture(fetchImpl);
    await service.storeTokens("owner-1", fixtureTokens({ expiresInSeconds: 0 }));

    await expect(service.searchByPhone("owner-1", "+8613800000000")).rejects.toMatchObject({
      failure: "reauth"
    });
    expect(tokenRepository.deleteByUserIdIfCurrent).toHaveBeenCalledWith(
      "owner-1",
      expect.any(String),
      expect.any(String)
    );
  });

  it("preserves a new sign-in when an older refresh later reports invalid credentials", async () => {
    let releaseRefresh!: () => void;
    let refreshStarted!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refreshReady = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/oauth2/token")) {
        refreshStarted();
        await refreshGate;
        return responseJson({ code: 4010 });
      }
      return profileResponse();
    };
    const { service, tokenRepository } = createFixture(fetchImpl);
    await service.storeTokens("owner-1", fixtureTokens({ expiresInSeconds: 0 }));
    const pendingSearch = service.searchByPhone("owner-1", "+8613800000000");
    await refreshReady;

    await service.storeTokens("owner-1", fixtureTokens({
      accessToken: "new-login-access",
      refreshToken: "new-login-refresh",
      expiresInSeconds: 3_600
    }));
    releaseRefresh();

    await expect(pendingSearch).resolves.toMatchObject({ subject: "target-sub" });
    expect(tokenRepository.deleteByUserIdIfCurrent).toHaveBeenCalled();
    await expect(tokenRepository.deleteByUserIdIfCurrent.mock.results.at(-1)?.value).resolves.toBe(false);
    expect(tokenRepository.deleteByUserId).not.toHaveBeenCalled();
  });

  it("shares one refresh operation between concurrent requests", async () => {
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/oauth2/token")) {
        refreshCalls += 1;
        await refreshGate;
        return tokenResponse();
      }
      return profileResponse();
    };
    const { service } = createFixture(fetchImpl);
    await service.storeTokens("owner-1", fixtureTokens({ expiresInSeconds: 0 }));

    const first = service.searchByPhone("owner-1", "+8613800000000");
    const second = service.searchByPhone("owner-1", "+8613800000001");
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ subject: "target-sub" }),
      expect.objectContaining({ subject: "target-sub" })
    ]);
    expect(refreshCalls).toBe(1);
  });

  it("expires only the current user's matching token without scanning other users", async () => {
    let searchCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/oauth2/token")) return tokenResponse();
      searchCalls += 1;
      return searchCalls === 1 ? responseJson({ code: 4010 }) : profileResponse();
    };
    const { service, tokenRepository } = createFixture(fetchImpl);
    await service.storeTokens("owner-1", fixtureTokens());

    await expect(service.searchByPhone("owner-1", "+8613800000000")).resolves.toMatchObject({ subject: "target-sub" });
    expect(tokenRepository.list).not.toHaveBeenCalled();
    expect(tokenRepository.expireAccessToken).toHaveBeenCalledWith("owner-1", expect.any(String));
  });

  it("enforces the response size limit", async () => {
    const fetchImpl: typeof fetch = async () => new Response("x".repeat(NUWAX_MAX_RESPONSE_BYTES + 1));
    const { service } = createFixture(fetchImpl);
    await service.storeTokens("owner-1", fixtureTokens());

    await expect(service.searchByPhone("owner-1", "+8613800000000")).rejects.toMatchObject({
      failure: "provider"
    });
  });

  it("aborts an OAuth request that exceeds the timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const { service } = createFixture(fetchImpl);
    await service.storeTokens("owner-1", fixtureTokens());
    const pending = service.searchByPhone("owner-1", "+8613800000000");
    const assertion = expect(pending).rejects.toMatchObject({ failure: "timeout" });
    await vi.advanceTimersByTimeAsync(NUWAX_REQUEST_TIMEOUT_MS);

    await assertion;
  });
});
