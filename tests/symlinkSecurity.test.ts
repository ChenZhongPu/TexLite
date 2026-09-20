import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { listProjectFiles, listProjectFilesAsync, resolveSourcePath } from "../src/server/files.js";

describe("project source symlink protection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects symlinks in path resolution and directory listings", async () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-symlink-"));
    roots.push(root);
    const config = testConfig(root);
    const projectId = randomUUID();
    const source = path.join(config.projectsDir, projectId, "source");
    const outside = path.join(root, "outside.txt");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(outside, "must not be exposed");
    fs.symlinkSync(outside, path.join(source, "leak.txt"));

    expect(() => resolveSourcePath(config, projectId, "leak.txt")).toThrowError(/Symbolic links/);
    expect(() => listProjectFiles(config, projectId)).toThrowError(/Symbolic links/);
    await expect(listProjectFilesAsync(config, projectId)).rejects.toThrow(/Symbolic links/);

    fs.rmSync(path.join(source, "leak.txt"));
    fs.mkdirSync(path.join(root, "outside-dir"));
    fs.writeFileSync(path.join(root, "outside-dir", "secret.txt"), "must not be exposed");
    fs.symlinkSync(path.join(root, "outside-dir"), path.join(source, "assets"), "dir");
    expect(() => resolveSourcePath(config, projectId, "assets/secret.txt")).toThrowError(/Symbolic links/);
  });

});

function testConfig(root: string): Config {
  return {
    configPath: path.join(root, "config.json"), siteName: "Test", adminEmail: "admin@example.test",
    host: "127.0.0.1", port: 3000, basePath: "/", dataDir: root,
    database: { driver: "postgresql", url: "postgresql://postgres@127.0.0.1:5432/texlite-test", sslMode: "disable" },
    projectsDir: path.join(root, "projects"), clientDir: path.join(root, "client"), sessionDays: 1,
    compileTimeoutMs: 30_000, maxCompileJobs: 3, latexmk: "latexmk", defaultEngine: "pdflatex",
    allowedEngines: ["pdflatex", "xelatex", "lualatex"], extraArgs: [],
    maxUploadBytes: 50 * 1024 * 1024, pdfLoadingStrategy: "auto", pdfRangeThresholdBytes: 5 * 1024 * 1024,
    historyMaxVersions: 200, historyMaxStorageBytes: 512 * 1024 * 1024, editHistoryMaxStorageBytes: 32 * 1024 * 1024,
  };
}
