import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import { captureCompileSnapshot, compileProject, publishCompileArtifacts } from "../src/server/compiler.js";
import { availablePdf, compileRunPdf } from "../src/server/compileArtifacts.js";

describe("external command process groups", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("terminates latexmk descendants when compilation times out", async () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-process-tree-"));
    roots.push(root);
    const config = testConfig(root);
    config.compileTimeoutMs = 500;
    config.latexmk = writeExecutable(root, "fake-latexmk.mjs", `
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const output = process.argv.find((value) => value.startsWith("-outdir=")).slice("-outdir=".length);
fs.mkdirSync(output, { recursive: true });
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(path.join(output, "descendant.pid"), String(descendant.pid));
setInterval(() => {}, 1000);
`);
    const projectId = randomUUID();
    const source = path.join(config.projectsDir, projectId, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), "\\documentclass{article}\\begin{document}x\\end{document}\\n");
    const snapshot = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", extraArgs: []
    });

    const result = await compileProject(config, snapshot, "main.tex", "pdflatex", null);
    expect(result.ok).toBe(false);
    expect(result.log).toContain("Compilation exceeded");
    const marker = findFile(path.join(config.projectsDir, projectId), "descendant.pid");
    expect(marker).not.toBeNull();
    const descendantPid = Number(fs.readFileSync(marker!, "utf8"));
    const exited = await waitFor(() => !isAlive(descendantPid), 3_000);
    if (!exited && isAlive(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    expect(exited).toBe(true);
  }, 10_000);

  it("terminates latexmk descendants when a user cancels compilation", async () => {
    if (process.platform === "win32") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-process-cancel-"));
    roots.push(root);
    const config = testConfig(root);
    config.latexmk = writeExecutable(root, "fake-latexmk.mjs", `
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const output = process.argv.find((value) => value.startsWith("-outdir=")).slice("-outdir=".length);
fs.mkdirSync(output, { recursive: true });
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(path.join(output, "descendant.pid"), String(descendant.pid));
setInterval(() => {}, 1000);
`);
    const projectId = randomUUID();
    const source = path.join(config.projectsDir, projectId, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "main.tex"), "\\documentclass{article}\\begin{document}x\\end{document}\\n");
    const snapshot = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "main.tex", engine: "pdflatex", extraArgs: []
    });
    const controller = new AbortController();
    const compiling = compileProject(config, snapshot, "main.tex", "pdflatex", null, { signal: controller.signal });
    let marker: string | null = null;
    expect(await waitFor(() => {
      marker = findFile(path.join(config.projectsDir, projectId), "descendant.pid");
      return marker !== null;
    }, 3_000)).toBe(true);
    const descendantPid = Number(fs.readFileSync(marker!, "utf8"));
    controller.abort();
    const result = await compiling;
    expect(result).toMatchObject({ ok: false, cancelled: true });
    const exited = await waitFor(() => !isAlive(descendantPid), 3_000);
    if (!exited && isAlive(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
    expect(exited).toBe(true);
  }, 10_000);

  it("accepts uppercase TeX extensions and uses one canonical PDF stem", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-uppercase-tex-"));
    roots.push(root);
    const config = testConfig(root);
    config.latexmk = writeExecutable(root, "fake-latexmk.mjs", `
import fs from "node:fs";
import path from "node:path";
const output = process.argv.find((value) => value.startsWith("-outdir=")).slice("-outdir=".length);
const main = process.argv.at(-1);
const stem = path.basename(main).replace(/\\.tex$/i, "");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, stem + ".pdf"), "%PDF-1.4\\n");
`);
    const projectId = randomUUID();
    const source = path.join(config.projectsDir, projectId, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "paper.TEX"), "\\documentclass{article}\\begin{document}x\\end{document}\\n");
    const snapshot = await captureCompileSnapshot(config, projectId, randomUUID(), {
      mainFile: "paper.TEX", engine: "pdflatex", extraArgs: []
    });
    const result = await compileProject(config, snapshot, "paper.TEX", "pdflatex", null);
    expect(result.ok, result.log).toBe(true);
    expect(path.basename(result.pdfPath!)).toBe("paper.pdf");
    expect(fs.existsSync(path.join(snapshot.outputDir, "paper.pdf"))).toBe(true);
    expect(fs.existsSync(path.join(snapshot.outputDir, "paper.TEX.pdf"))).toBe(false);
    publishCompileArtifacts(config, projectId, snapshot, result);
    expect(availablePdf(config, projectId, "paper.TEX", "paper.TEX")).toMatchObject({ path: result.pdfPath });
    expect(compileRunPdf(config, projectId, "paper.TEX", snapshot.runId)).toMatchObject({ path: result.pdfPath });
  });

});

function writeExecutable(root: string, name: string, body: string): string {
  const target = path.join(root, name);
  fs.writeFileSync(target, `#!/usr/bin/env node\n${body}`, { encoding: "utf8", mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

function findFile(root: string, name: string): string | null {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return target;
    if (entry.isDirectory()) {
      const nested = findFile(target, name);
      if (nested) return nested;
    }
  }
  return null;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

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
