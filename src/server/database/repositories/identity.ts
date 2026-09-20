import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { UserRow } from "../../db.js";
import * as schema from "../schema/postgres.js";

const NUWAX_ISSUER = "nuwax";
const MAX_USERNAME_LENGTH = 50;

export interface NuwaxAccountProfile {
  subject: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface OAuthStateRecord {
  id: string;
  returnPath: string;
  redirectUri: string;
}

/**
 * Typed PostgreSQL repository for identities, browser sessions, and OAuth
 * state. It deliberately returns the existing UserRow shape during the
 * migration so route behavior can move incrementally without leaking Drizzle
 * column names into HTTP handlers.
 */
export class PostgresIdentityRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async findUserById(id: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return row ? toUserRow(row) : null;
  }

  async findUserByUsername(username: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(schema.users)
      .where(sql`lower(${schema.users.username}) = lower(${username})`).limit(1);
    return row ? toUserRow(row) : null;
  }

  async findActiveUserByEmail(email: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(schema.users)
      .where(and(
        sql`lower(${schema.users.email}) = lower(${email})`,
        eq(schema.users.disabled, 0)
      )).limit(1);
    return row ? toUserRow(row) : null;
  }

  async usernameIsTaken(username: string, exceptUserId?: string): Promise<boolean> {
    const conditions = [sql`lower(${schema.users.username}) = lower(${username})`];
    if (exceptUserId) conditions.push(ne(schema.users.id, exceptUserId));
    const [row] = await this.db.select({ id: schema.users.id }).from(schema.users).where(and(...conditions)).limit(1);
    return Boolean(row);
  }

  async findActiveSessionUser(sessionId: string, asOf: string): Promise<UserRow | null> {
    const [row] = await this.db.select({
      user: schema.users,
      sessionId: schema.sessions.id,
      sessionExpiresAt: schema.sessions.expiresAt
    })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(
        eq(schema.sessions.id, sessionId),
        gt(schema.sessions.expiresAt, asOf),
        eq(schema.users.disabled, 0)
      ))
      .limit(1);
    return row ? toUserRow(row.user, { sessionId: row.sessionId, sessionExpiresAt: row.sessionExpiresAt }) : null;
  }

  async sessionIsActive(sessionId: string, userId: string, asOf: string): Promise<boolean> {
    const [row] = await this.db.select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(
        eq(schema.sessions.id, sessionId),
        eq(schema.sessions.userId, userId),
        gt(schema.sessions.expiresAt, asOf)
      ))
      .limit(1);
    return Boolean(row);
  }

  async createSession(input: { id: string; userId: string; expiresAt: string; createdAt: string }): Promise<void> {
    await this.db.insert(schema.sessions).values(input);
  }

  async deleteSession(id: string): Promise<boolean> {
    const rows = await this.db.delete(schema.sessions).where(eq(schema.sessions.id, id)).returning({ id: schema.sessions.id });
    return rows.length > 0;
  }

  async deleteOtherSessions(userId: string, retainedSessionId: string): Promise<string[]> {
    const rows = await this.db.delete(schema.sessions)
      .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, retainedSessionId)))
      .returning({ id: schema.sessions.id });
    return rows.map((row) => row.id);
  }

  async deleteAllSessions(userId: string): Promise<string[]> {
    const rows = await this.db.delete(schema.sessions)
      .where(eq(schema.sessions.userId, userId))
      .returning({ id: schema.sessions.id });
    return rows.map((row) => row.id);
  }

  async expiredSessionIds(asOf: string): Promise<string[]> {
    const rows = await this.db.select({ id: schema.sessions.id }).from(schema.sessions)
      .where(sql`${schema.sessions.expiresAt} <= ${asOf}`);
    return rows.map((row) => row.id);
  }

  async pruneExpiredSessions(asOf: string): Promise<number> {
    const rows = await this.db.delete(schema.sessions).where(sql`${schema.sessions.expiresAt} <= ${asOf}`)
      .returning({ id: schema.sessions.id });
    return rows.length;
  }

  async createOAuthState(input: {
    id: string;
    returnPath: string;
    redirectUri: string;
    expiresAt: string;
    createdAt: string;
  }): Promise<void> {
    await this.db.insert(schema.oauthStates).values(input);
  }

  /** Consume state in one statement so an OAuth callback cannot be replayed. */
  async consumeOAuthState(id: string, asOf: string): Promise<OAuthStateRecord | null> {
    const [row] = await this.db.delete(schema.oauthStates)
      .where(and(eq(schema.oauthStates.id, id), gt(schema.oauthStates.expiresAt, asOf)))
      .returning({ id: schema.oauthStates.id, returnPath: schema.oauthStates.returnPath, redirectUri: schema.oauthStates.redirectUri });
    return row ?? null;
  }

  async pruneExpiredOAuthStates(asOf: string): Promise<number> {
    const rows = await this.db.delete(schema.oauthStates).where(sql`${schema.oauthStates.expiresAt} <= ${asOf}`)
      .returning({ id: schema.oauthStates.id });
    return rows.length;
  }

  async updateProfile(userId: string, username: string, displayName: string): Promise<UserRow | null> {
    const [row] = await this.db.update(schema.users).set({ username, displayName })
      .where(eq(schema.users.id, userId)).returning();
    return row ? toUserRow(row) : null;
  }

  async setPassword(userId: string, passwordHash: string): Promise<UserRow | null> {
    const [row] = await this.db.update(schema.users).set({ passwordHash, mustChangePassword: 0 })
      .where(eq(schema.users.id, userId)).returning();
    return row ? toUserRow(row) : null;
  }

  /**
   * Link a searched/pre-provisioned Nuwax account or create a new local
   * account. Advisory locks make the subject and generated username stable
   * under concurrent OAuth callbacks without relying on SQLite's writer lock.
   */
  async upsertNuwaxUser(profile: NuwaxAccountProfile, timestamp: string, newUserId: string): Promise<UserRow> {
    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`texlite:nuwax-subject:${profile.subject}`}))`);
      let [row] = await tx.select().from(schema.users).where(eq(schema.users.nuwaxSubject, profile.subject)).limit(1);
      if (!row) {
        const [identity] = await tx.select({ user: schema.users })
          .from(schema.authIdentities)
          .innerJoin(schema.users, eq(schema.users.id, schema.authIdentities.userId))
          .where(and(eq(schema.authIdentities.issuer, NUWAX_ISSUER), eq(schema.authIdentities.subject, profile.subject)))
          .limit(1);
        row = identity?.user;
      }

      if (row) {
        const [updated] = await tx.update(schema.users)
          .set({ nuwaxSubject: profile.subject, avatarUrl: profile.avatarUrl })
          .where(eq(schema.users.id, row.id)).returning();
        row = updated!;
      } else {
        const baseUsername = sanitizeNuwaxUsername(profile.subject);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`texlite:username:${baseUsername}`}))`);
        const username = await availableUsername(tx, baseUsername);
        const [created] = await tx.insert(schema.users).values({
          id: newUserId,
          username,
          displayName: profile.name ?? username,
          passwordHash: "",
          nuwaxSubject: profile.subject,
          avatarUrl: profile.avatarUrl,
          role: "user",
          disabled: 0,
          mustChangePassword: 0,
          canCreateProjects: 1,
          createdAt: timestamp
        }).returning();
        row = created!;
      }

      await tx.insert(schema.authIdentities).values({
        id: randomUUID(),
        userId: row.id,
        issuer: NUWAX_ISSUER,
        subject: profile.subject,
        providerUsername: profile.name,
        providerEmail: null,
        createdAt: timestamp,
        updatedAt: timestamp
      }).onConflictDoUpdate({
        target: [schema.authIdentities.issuer, schema.authIdentities.subject],
        set: {
          userId: row.id,
          providerUsername: profile.name,
          providerEmail: null,
          updatedAt: timestamp
        }
      });
      return toUserRow(row);
    });
  }
}

async function availableUsername(
  tx: Parameters<NodePgDatabase<typeof schema>["transaction"]>[0] extends (transaction: infer Transaction) => unknown
    ? Transaction : never,
  base: string
): Promise<string> {
  let username = base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const [existing] = await tx.select({ id: schema.users.id }).from(schema.users)
      .where(sql`lower(${schema.users.username}) = lower(${username})`).limit(1);
    if (!existing) return username;
    username = `${base.slice(0, Math.max(1, MAX_USERNAME_LENGTH - String(suffix).length - 1))}-${suffix}`;
  }
  throw new Error("Could not allocate a unique local username for the OAuth account.");
}

function sanitizeNuwaxUsername(subject: string): string {
  const sanitized = subject.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, MAX_USERNAME_LENGTH);
  if (sanitized) return sanitized;
  return `nuwax-${createHash("sha256").update(subject).digest("hex").slice(0, 32)}`;
}

function toUserRow(
  row: typeof schema.users.$inferSelect,
  session: { sessionId: string; sessionExpiresAt: string } | null = null
): UserRow {
  return {
    id: row.id,
    username: row.username,
    display_name: row.displayName,
    password_hash: row.passwordHash,
    email: row.email,
    nuwax_subject: row.nuwaxSubject,
    avatar_url: row.avatarUrl,
    role: row.role === "admin" ? "admin" : "user",
    disabled: row.disabled,
    must_change_password: row.mustChangePassword,
    can_create_projects: row.canCreateProjects,
    created_at: row.createdAt,
    ...(session ? { session_id: session.sessionId, session_expires_at: session.sessionExpiresAt } : {})
  };
}

export { toUserRow };
