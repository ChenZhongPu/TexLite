import { drizzle as drizzlePostgres, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Config, PostgresDatabaseConfig } from "../config.js";
import * as postgresSchema from "./schema/postgres.js";

/**
 * ORM connection lifecycle. Callers use this module instead of constructing a
 * PostgreSQL pool directly.
 *
 * All runtime database access is asynchronous and PostgreSQL-only.
 */
export type OrmDatabaseConnection = PostgresOrmDatabaseConnection;

export interface PostgresOrmDatabaseConnection {
  driver: "postgresql";
  config: PostgresDatabaseConfig;
  client: Pool;
  orm: NodePgDatabase<typeof postgresSchema>;
  close: () => Promise<void>;
}

/** Open and health-check an ORM database connection. */
export async function openOrmDatabase(config: Config): Promise<OrmDatabaseConnection> {
  return await openPostgresOrmDatabase(config.database);
}

async function openPostgresOrmDatabase(config: PostgresDatabaseConfig): Promise<PostgresOrmDatabaseConnection> {
  const client = new Pool({
    connectionString: config.url,
    connectionTimeoutMillis: 5_000,
    application_name: "texlite",
    ssl: config.sslMode === "require" ? { rejectUnauthorized: true } : undefined
  });
  try {
    await client.query("SELECT 1");
  } catch (error) {
    await client.end().catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to connect to PostgreSQL: ${detail}`);
  }
  return {
    driver: "postgresql",
    config,
    client,
    orm: drizzlePostgres({ client, schema: postgresSchema }),
    close: async () => { await client.end(); }
  };
}
