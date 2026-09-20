import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresDatabaseConfig } from "../config.js";
import type { UserRow } from "../db.js";
import type { OrmDatabaseConnection, PostgresOrmDatabaseConnection } from "./connection.js";
import { PostgresIdentityRepository } from "./repositories/identity.js";
import { PostgresProjectRepository } from "./repositories/projects.js";
import { PostgresShareLinkRepository } from "./repositories/shareLinks.js";
import { PostgresNuwaxTokenRepository } from "./repositories/nuwaxTokens.js";
import { PostgresAdministratorRepository } from "./repositories/admin.js";
import { PostgresProjectMemberRepository } from "./repositories/projectMembers.js";
import { PostgresProjectDataRepository } from "./repositories/projectData.js";
import { PostgresCommentMentionRepository } from "./repositories/commentMentions.js";
import { PostgresCommentRepository } from "./repositories/comments.js";
import { PostgresCompileRunRepository } from "./repositories/compileRuns.js";
import { PostgresProjectCatalogRepository } from "./repositories/projectCatalog.js";
import { PostgresProjectDirectoryStagingRepository } from "./repositories/projectDirectoryStaging.js";
import { PostgresEditHistoryRepository } from "./repositories/editHistory.js";
import { PostgresHistoryRepository } from "./repositories/history.js";
import { PostgresCitationRepository } from "./repositories/citations.js";
import * as schema from "./schema/postgres.js";

export interface PostgresRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface PostgresStatement {
  get<T extends QueryResultRow = QueryResultRow>(...params: unknown[]): Promise<T | undefined>;
  all<T extends QueryResultRow = QueryResultRow>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<PostgresRunResult>;
}

/**
 * The application database during the async migration.
 *
 * Drizzle owns the connection and schema. The small prepare/get/all/run
 * facade exists only to let route migrations land one module at a time; it is
 * asynchronous and PostgreSQL-native, so it does not emulate SQLite or hold
 * a worker thread. New code should use `orm` and the typed repositories.
 */
export class PostgresRuntimeDatabase {
  readonly driver = "postgresql" as const;
  readonly orm: NodePgDatabase<typeof schema>;
  /** Typed identity/session access used by authentication and request auth. */
  readonly identity: PostgresIdentityRepository;
  /** Typed project access checks shared by HTTP and collaboration. */
  readonly projects: PostgresProjectRepository;
  /** Typed bearer-link lookup used to attach request-scoped access. */
  readonly shareLinks: PostgresShareLinkRepository;
  /** Encrypted Nuwax access/refresh token storage. */
  readonly nuwaxTokens: PostgresNuwaxTokenRepository;
  /** Typed administrator/user-management queries. */
  readonly administrators: PostgresAdministratorRepository;
  /** Typed project membership and invitation queries. */
  readonly projectMembers: PostgresProjectMemberRepository;
  /** Typed project-list metadata and aggregate queries. */
  readonly projectData: PostgresProjectDataRepository;
  /** Typed @mention candidate and notification queries. */
  readonly commentMentions: PostgresCommentMentionRepository;
  /** Typed comment/reply read queries. */
  readonly comments: PostgresCommentRepository;
  /** Typed compile queue and run-state queries. */
  readonly compileRuns: PostgresCompileRunRepository;
  /** Typed project metadata, tags, archives, and dictionary queries. */
  readonly projectCatalog: PostgresProjectCatalogRepository;
  /** Typed journal access for reversible directory moves. */
  readonly projectDirectoryStaging: PostgresProjectDirectoryStagingRepository;
  /** Typed bounded collaboration edit-history access. */
  readonly editHistory: PostgresEditHistoryRepository;
  /** Typed immutable project snapshot and recovery-history access. */
  readonly history: PostgresHistoryRepository;
  /** Typed private citation-library access. */
  readonly citations: PostgresCitationRepository;
  private readonly transactions = new AsyncLocalStorage<PoolClient>();

  constructor(private readonly connection: PostgresOrmDatabaseConnection) {
    this.orm = connection.orm;
    this.identity = new PostgresIdentityRepository(this.orm);
    this.projects = new PostgresProjectRepository(this.orm);
    this.shareLinks = new PostgresShareLinkRepository(this.orm);
    this.nuwaxTokens = new PostgresNuwaxTokenRepository(this.orm);
    this.administrators = new PostgresAdministratorRepository(this.orm);
    this.projectMembers = new PostgresProjectMemberRepository(this.orm);
    this.projectData = new PostgresProjectDataRepository(this.orm);
    this.commentMentions = new PostgresCommentMentionRepository(this.orm);
    this.comments = new PostgresCommentRepository(this.orm);
    this.compileRuns = new PostgresCompileRunRepository(this.orm);
    this.projectCatalog = new PostgresProjectCatalogRepository(this.orm);
    this.projectDirectoryStaging = new PostgresProjectDirectoryStagingRepository(this.orm);
    this.editHistory = new PostgresEditHistoryRepository(this.orm);
    this.history = new PostgresHistoryRepository(this.orm);
    this.citations = new PostgresCitationRepository(this.orm);
  }

  prepare(sqlText: string): PostgresStatement {
    return {
      get: async <T extends QueryResultRow = QueryResultRow>(...params: unknown[]) => {
        const result = await this.query<T>(sqlText, params);
        return result.rows[0] as T | undefined;
      },
      all: async <T extends QueryResultRow = QueryResultRow>(...params: unknown[]) => {
        const result = await this.query<T>(sqlText, params);
        return result.rows as T[];
      },
      run: async (...params: unknown[]) => {
        const result = await this.query(sqlText, params);
        return { changes: result.rowCount ?? 0, lastInsertRowid: 0 };
      }
    };
  }

  async exec(sqlText: string): Promise<void> {
    await this.query(sqlText, []);
  }

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    const existing = this.transactions.getStore();
    if (existing) throw new Error("Nested PostgreSQL transaction is not supported");
    const client = await this.connection.client.connect();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      client.release();
    };
    try {
      await client.query("BEGIN");
      const result = await this.transactions.run(client, callback);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } finally { release(); }
      throw error;
    }
    finally {
      release();
    }
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  private async query<T extends QueryResultRow = QueryResultRow>(sqlText: string, params: unknown[]) {
    const bound = bindPostgresParameters(sqlText, params);
    const client = this.transactions.getStore();
    return client
      ? await client.query<T>(bound.text, bound.params)
      : await this.connection.client.query<T>(bound.text, bound.params);
  }
}

export type ApplicationDatabase = PostgresRuntimeDatabase;

export function postgresConfigOf(config: { database: PostgresDatabaseConfig }): PostgresDatabaseConfig {
  return config.database;
}

export function asUserRow(row: typeof schema.users.$inferSelect, session?: { id: string; expiresAt: string }): UserRow {
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
    ...(session ? { session_id: session.id, session_expires_at: session.expiresAt } : {})
  };
}

interface BoundPostgresQuery {
  text: string;
  params: unknown[];
}

/** Convert the legacy placeholder spelling while keeping values parameterized. */
export function bindPostgresParameters(sqlText: string, input: unknown[]): BoundPostgresQuery {
  if (input.length === 1 && isParameterObject(input[0])) {
    const values = input[0] as Record<string, unknown>;
    const params: unknown[] = [];
    const text = sqlText.replace(/(?<!:):([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
      params.push(values[name]);
      return `$${params.length}`;
    });
    return { text, params };
  }
  let index = 0;
  return {
    text: sqlText.replace(/\?/g, () => `$${++index}`),
    params: input
  };
}

function isParameterObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}

export type PostgresPool = Pool;
export type PostgresConnection = OrmDatabaseConnection;
