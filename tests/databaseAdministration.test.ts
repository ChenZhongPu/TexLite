import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { openAdministrationDatabase } from "../src/server/database/administration.js";
import { openDatabase } from "../src/server/db.js";

function configFor(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "Test", adminEmail: "",
    host: "127.0.0.1", port: 3000, basePath: "/", dataDir: root,
    database: { driver: "postgresql", url: process.env.TEXLITE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/texlite-test", sslMode: "disable" },
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 1, latexmk: "latexmk", defaultEngine: "xelatex",
    allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [], maxUploadBytes: 50 * 1024 * 1024,
    pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
    historyMaxVersions: 0, historyMaxStorageBytes: 64 * 1024 * 1024, editHistoryMaxStorageBytes: 32 * 1024 * 1024,
  };
}

describe("administration database bootstrap", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(!process.env.TEXLITE_TEST_DATABASE_URL)("bootstraps a PostgreSQL administration database", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-admin-db-"));
    roots.push(root);
    const database = await openAdministrationDatabase(configFor(root));
    try {
      expect(database.driver).toBe("postgresql");
      expect(await database.activeAdminCount()).toBe(0);
      await expect(database.createInitialAdministrator({
        username: "admin", displayName: "Administrator", passwordHash: "hash", email: null,
        createdAt: "2026-01-01T00:00:00.000Z"
      })).resolves.toBe(true);
      expect(await database.activeAdminCount()).toBe(1);
      await expect(database.createInitialAdministrator({
        username: "second", displayName: "Second", passwordHash: "hash", email: null,
        createdAt: "2026-01-01T00:00:00.000Z"
      })).resolves.toBe(false);
    } finally {
      await database.close();
    }
  });

  it("does not let the legacy synchronous opener silently create SQLite when PostgreSQL is selected", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-postgres-guard-"));
    roots.push(root);
    const config = {
      ...configFor(root),
      database: { driver: "postgresql" as const, url: "postgresql://postgres@127.0.0.1:5432/texlite", sslMode: "disable" as const }
    };
    expect(() => openDatabase(config)).toThrow(/SQLite is no longer supported/);
    expect(fs.existsSync(path.join(root, "texlite.db"))).toBe(false);
  });
});
