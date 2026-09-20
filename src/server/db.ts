import type { Config } from "./config.js";
import { migrateDatabase } from "./database/migrations.js";
import { openOrmDatabase } from "./database/connection.js";
import { PostgresRuntimeDatabase } from "./database/runtime.js";

/** PostgreSQL-only runtime database. All application calls are asynchronous. */
export type DatabaseConnection = PostgresRuntimeDatabase;
export type ApplicationDatabaseConnection = DatabaseConnection;

export type UserRole = "admin" | "user";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  email: string | null;
  /** Stable Nuwax subject used to link pre-provisioned and OAuth accounts. */
  nuwax_subject: string | null;
  avatar_url: string | null;
  role: UserRole;
  disabled: number;
  must_change_password: number;
  can_create_projects: number;
  created_at: string;
  /** Request-scoped access granted by an active share-link cookie. */
  share_link_id?: string | null;
  /** Internal digest of the session that authenticated this request. */
  session_id?: string | null;
  /** Expiry of the concrete browser session that authenticated this request. */
  session_expires_at?: string | null;
}

export interface AuthIdentityRow {
  id: string;
  user_id: string;
  issuer: string;
  subject: string;
  provider_username: string | null;
  provider_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  last_modified_by: string | null;
  name: string;
  main_file: string;
  engine: "pdflatex" | "xelatex" | "lualatex";
  icon: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The former SQLite entry point is intentionally retained only as a migration
 * guard for downstream callers. The application no longer creates or opens a
 * local database; PostgreSQL is opened by openApplicationDatabase().
 */
export function openDatabase(_config: Config): never {
  throw new Error("SQLite is no longer supported. Use PostgreSQL and openApplicationDatabase().");
}

/** Open PostgreSQL, apply Drizzle migrations, and return the runtime facade. */
export async function openApplicationDatabase(config: Config): Promise<{
  db: ApplicationDatabaseConnection;
  close: () => Promise<void>;
}> {
  const orm = await openOrmDatabase(config);
  try {
    await migrateDatabase(orm);
    const db = new PostgresRuntimeDatabase(orm);
    return { db, close: async () => { await db.close(); } };
  } catch (error) {
    await orm.close();
    throw error;
  }
}

/** Remove sessions that can no longer authenticate any request. */
export async function pruneExpiredSessions(db: DatabaseConnection, asOf = new Date().toISOString()): Promise<number> {
  return await db.identity.pruneExpiredSessions(asOf);
}

/** Session identifiers that should be disconnected before their rows are pruned. */
export async function expiredSessionIds(db: DatabaseConnection, asOf = new Date().toISOString()): Promise<string[]> {
  return await db.identity.expiredSessionIds(asOf);
}

export async function pruneExpiredOauthStates(db: DatabaseConnection, asOf = new Date().toISOString()): Promise<number> {
  return await db.identity.pruneExpiredOAuthStates(asOf);
}

export async function activeAdminCount(db: DatabaseConnection): Promise<number> {
  return await db.administrators.activeAdminCount();
}

/**
 * Recover an account that was suspended before a process stopped during the
 * multi-project deletion workflow. A missing user means the deletion commit
 * already completed and therefore needs no restoration.
 */
export async function recoverInterruptedUserDeletions(db: DatabaseConnection): Promise<void> {
  await db.administrators.recoverInterruptedUserDeletions();
}
