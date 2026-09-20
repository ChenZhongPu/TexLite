import { loadConfig } from "../config.js";
import { openOrmDatabase } from "./connection.js";
import { migrateDatabase } from "./migrations.js";

/**
 * Source-checkout migration entry point. Unlike drizzle-kit directly, this
 * reads the same TexLite configuration as the server, including a URL stored
 * in the JSON configuration file or its environment override.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.database?.driver !== "postgresql") {
    throw new Error("PostgreSQL is not selected. Set database.driver to \"postgresql\" first.");
  }
  const connection = await openOrmDatabase(config);
  try {
    await migrateDatabase(connection);
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
