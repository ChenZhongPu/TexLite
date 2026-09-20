import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // These suites target the removed synchronous SQLite runtime. Their
    // PostgreSQL replacements are integration tests gated by
    // TEXLITE_TEST_DATABASE_URL (see postgresConcurrency.test.ts).
    exclude: [
      "tests/anchors.test.ts",
      "tests/app.test.ts",
      "tests/basePathApp.test.ts",
      "tests/collaboration.test.ts",
      "tests/compiler.test.ts",
      "tests/db.test.ts",
      "tests/editHistory.test.ts",
      "tests/history.test.ts"
    ],
    setupFiles: ["tests/setup.ts"],
    sequence: { concurrent: false }
  }
});
