import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { openOrmDatabase, type OrmDatabaseConnection } from "./connection.js";
import { migrateDatabase } from "./migrations.js";
import { PostgresAdministratorRepository, type InitialAdministrator } from "./repositories/admin.js";

export interface AdministrationDatabase {
  readonly driver: "postgresql";
  readonly location: string;
  activeAdminCount: () => Promise<number>;
  createInitialAdministrator: (input: Omit<InitialAdministrator, "id"> & { id?: string }) => Promise<boolean>;
  close: () => Promise<void>;
}

/**
 * Open the database facilities needed by `init`, `doctor`, and process
 * management. PostgreSQL migrations run before any account inspection, so an
 * empty database can be initialized without a separate manual schema step.
 */
export async function openAdministrationDatabase(config: Config): Promise<AdministrationDatabase> {
  const connection = await openOrmDatabase(config);
  try {
    await migrateDatabase(connection);
  } catch (error) {
    await connection.close();
    throw error;
  }
  const administrators = new PostgresAdministratorRepository(connection.orm);
  return {
    driver: "postgresql",
    location: postgresLocation(connection),
    activeAdminCount: async () => await administrators.activeAdminCount(),
    createInitialAdministrator: async (input) => await administrators.createInitialAdministrator({
      ...input,
      id: input.id ?? randomUUID()
    }),
    close: async () => { await connection.close(); }
  };
}

function postgresLocation(connection: Extract<OrmDatabaseConnection, { driver: "postgresql" }>): string {
  const parsed = new URL(connection.config.url);
  // Do not expose the username or password in CLI/doctor output.
  return `PostgreSQL ${parsed.host}${parsed.pathname || "/"}`;
}
