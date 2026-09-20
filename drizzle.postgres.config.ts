import { defineConfig } from "drizzle-kit";

/**
 * Versioned PostgreSQL migrations. `generate` does not connect to the URL;
 * `migrate` requires TEXLITE_DATABASE_URL to point at the target database.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/database/schema/postgres.ts",
  out: "./drizzle/postgres",
  dbCredentials: {
    url: process.env.TEXLITE_DATABASE_URL ?? "postgresql://localhost/texlite"
  }
});
