import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema/postgres.js";

export interface NuwaxTokenRecord {
  user_id: string;
  access_token_ciphertext: string;
  access_token_expires_at: string;
  refresh_token_ciphertext: string;
  scope: string;
}

export class PostgresNuwaxTokenRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async upsert(input: NuwaxTokenRecord & { created_at: string; updated_at: string }): Promise<void> {
    await this.db.insert(schema.nuwaxOauthTokens).values({
      userId: input.user_id,
      accessTokenCiphertext: input.access_token_ciphertext,
      accessTokenExpiresAt: input.access_token_expires_at,
      refreshTokenCiphertext: input.refresh_token_ciphertext,
      scope: input.scope,
      createdAt: input.created_at,
      updatedAt: input.updated_at
    }).onConflictDoUpdate({
      target: schema.nuwaxOauthTokens.userId,
      set: {
        accessTokenCiphertext: input.access_token_ciphertext,
        accessTokenExpiresAt: input.access_token_expires_at,
        refreshTokenCiphertext: input.refresh_token_ciphertext,
        scope: input.scope,
        updatedAt: input.updated_at
      }
    });
  }

  async findByUserId(userId: string): Promise<NuwaxTokenRecord | null> {
    const [row] = await this.db.select({
      user_id: schema.nuwaxOauthTokens.userId,
      access_token_ciphertext: schema.nuwaxOauthTokens.accessTokenCiphertext,
      access_token_expires_at: schema.nuwaxOauthTokens.accessTokenExpiresAt,
      refresh_token_ciphertext: schema.nuwaxOauthTokens.refreshTokenCiphertext,
      scope: schema.nuwaxOauthTokens.scope
    }).from(schema.nuwaxOauthTokens).where(eq(schema.nuwaxOauthTokens.userId, userId)).limit(1);
    return row ?? null;
  }

  async deleteByUserId(userId: string): Promise<void> {
    await this.db.delete(schema.nuwaxOauthTokens).where(eq(schema.nuwaxOauthTokens.userId, userId));
  }

  async deleteByUserIdIfCurrent(
    userId: string,
    expectedAccessTokenCiphertext: string,
    expectedRefreshTokenCiphertext: string
  ): Promise<boolean> {
    const deleted = await this.db.delete(schema.nuwaxOauthTokens)
      .where(and(
        eq(schema.nuwaxOauthTokens.userId, userId),
        eq(schema.nuwaxOauthTokens.accessTokenCiphertext, expectedAccessTokenCiphertext),
        eq(schema.nuwaxOauthTokens.refreshTokenCiphertext, expectedRefreshTokenCiphertext)
      ))
      .returning({ userId: schema.nuwaxOauthTokens.userId });
    return deleted.length > 0;
  }

  async replaceIfCurrent(
    input: NuwaxTokenRecord & { created_at: string; updated_at: string },
    expectedAccessTokenCiphertext: string,
    expectedRefreshTokenCiphertext: string
  ): Promise<boolean> {
    const updated = await this.db.update(schema.nuwaxOauthTokens)
      .set({
        accessTokenCiphertext: input.access_token_ciphertext,
        accessTokenExpiresAt: input.access_token_expires_at,
        refreshTokenCiphertext: input.refresh_token_ciphertext,
        scope: input.scope,
        updatedAt: input.updated_at
      })
      .where(and(
        eq(schema.nuwaxOauthTokens.userId, input.user_id),
        eq(schema.nuwaxOauthTokens.accessTokenCiphertext, expectedAccessTokenCiphertext),
        eq(schema.nuwaxOauthTokens.refreshTokenCiphertext, expectedRefreshTokenCiphertext)
      ))
      .returning({ userId: schema.nuwaxOauthTokens.userId });
    return updated.length > 0;
  }

  async expireAccessToken(userId: string, expectedCiphertext?: string): Promise<void> {
    const condition = expectedCiphertext
      ? and(
        eq(schema.nuwaxOauthTokens.userId, userId),
        eq(schema.nuwaxOauthTokens.accessTokenCiphertext, expectedCiphertext)
      )
      : eq(schema.nuwaxOauthTokens.userId, userId);
    await this.db.update(schema.nuwaxOauthTokens)
      .set({ accessTokenExpiresAt: "1970-01-01T00:00:00.000Z" })
      .where(condition);
  }
}
