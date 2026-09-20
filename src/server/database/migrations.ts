import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { OrmDatabaseConnection } from "./connection.js";
import * as postgresSchema from "./schema/postgres.js";

const MIGRATION_LOCK_KEY = "texlite:postgres-schema-migrations";

/**
 * Apply versioned PostgreSQL migrations under an advisory lock. The lock makes
 * a rolling deployment safe: only one TexLite process can change the schema
 * at a time, while other instances wait for the same migration history.
 */
export async function migrateDatabase(connection: OrmDatabaseConnection): Promise<void> {
  await migratePostgres(connection);
}

async function migratePostgres(connection: OrmDatabaseConnection): Promise<void> {
  // PostgreSQL advisory locks are tied to one backend connection. Borrow it
  // explicitly instead of issuing lock/migration/unlock through Pool, where
  // three successive calls may land on three different connections.
  const client = await connection.client.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    locked = true;
    const migrationDatabase = drizzle({ client, schema: postgresSchema });
    await migrate(migrationDatabase, { migrationsFolder: postgresMigrationDirectory() });
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

function postgresMigrationDirectory(): string {
  // Works from both src/server/database during development and
  // dist/server/database in a published package. The migration assets are
  // shipped at the package root rather than copied into dist.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../drizzle/postgres");
}
