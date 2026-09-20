import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { DatabaseConnection } from "./db.js";
import { httpError, type HttpError } from "./http.js";

export interface FileEntry {
  path: string;
  type: "file" | "directory";
  size?: number;
  mtimeMs?: number;
}

export function projectRoot(config: Config, projectId: string): string {
  return path.join(config.projectsDir, projectId);
}

export function sourceRoot(config: Config, projectId: string): string {
  return path.join(projectRoot(config, projectId), "source");
}

export function outputRoot(config: Config, projectId: string): string {
  return path.join(projectRoot(config, projectId), "output");
}

const DEFAULT_PROJECT_MAIN_FILE = `\\documentclass{article}
\\title{New Project}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Start writing here.

\\end{document}
`;

export function defaultProjectSourceBytes(): number {
  return Buffer.byteLength(DEFAULT_PROJECT_MAIN_FILE, "utf8");
}

/**
 * Return the number of regular-file bytes in a project's source tree.
 *
 * This deliberately excludes generated output, collaboration state and file
 * system metadata.  It is the durable user-controlled content to which the
 * per-account project-storage quota applies.  Source symlinks are rejected
 * rather than followed so a malformed tree can never make quota accounting
 * inspect data outside the project directory.
 */
export function projectSourceBytes(config: Config, projectId: string): number {
  return directoryRegularFileBytes(sourceRoot(config, projectId), "source");
}

function directoryRegularFileBytes(root: string, displayedPath: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const relative = `${displayedPath}/${entry.name}`;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw symbolicLinkError(relative);
    if (entry.isDirectory()) {
      total += directoryRegularFileBytes(absolute, relative);
      continue;
    }
    if (!entry.isFile()) continue;
    const size = fs.statSync(absolute).size;
    if (!Number.isSafeInteger(size) || size < 0 || total > Number.MAX_SAFE_INTEGER - size) {
      throw new Error("Project source size exceeds supported quota accounting range");
    }
    total += size;
  }
  return total;
}

export function createProjectFiles(config: Config, projectId: string): void {
  const source = sourceRoot(config, projectId);
  fs.mkdirSync(source, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputRoot(config, projectId), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(source, "main.tex"),
    DEFAULT_PROJECT_MAIN_FILE,
    { encoding: "utf8", mode: 0o600 }
  );
}

/** A project tree that has been atomically moved out of its live location. */
export interface StagedProjectDirectoryRemoval {
  projectId: string;
  source: string;
  trash: string;
  trashName: string;
}

const safeTrashName = /^[A-Za-z0-9._-]+$/;
const legacyStagedProjectDirectoryName = /^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})-\d+-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function projectTrashDirectory(config: Config): string {
  return path.join(config.dataDir, "trash");
}

function stagedProjectDirectoryRemoval(config: Config, projectId: string, trashName = `${projectId}-${Date.now()}-${randomUUID()}`): StagedProjectDirectoryRemoval {
  if (!safeTrashName.test(trashName)) throw new Error("Invalid project trash directory name");
  return {
    projectId,
    source: projectRoot(config, projectId),
    trash: path.join(projectTrashDirectory(config), trashName),
    trashName
  };
}

/**
 * Move a project tree to private trash without deleting it yet.
 *
 * Callers which need to coordinate a filesystem removal with a database
 * transaction can restore this handle if that transaction fails, or purge it
 * after the row is gone.  `projectsDir` always lives below `dataDir`, so the
 * rename is an atomic same-filesystem operation for supported configurations.
 */
export function stageProjectDirectoryRemoval(config: Config, projectId: string): StagedProjectDirectoryRemoval | null {
  const source = projectRoot(config, projectId);
  if (!fs.existsSync(source)) return null;
  const removal = stagedProjectDirectoryRemoval(config, projectId);
  fs.mkdirSync(projectTrashDirectory(config), { recursive: true, mode: 0o700 });
  fs.renameSync(removal.source, removal.trash);
  return removal;
}

/**
 * Stage a persisted project tree with a database journal written before the
 * filesystem rename. A restart can therefore resolve the move safely.
 */
export function stagePersistedProjectDirectoryRemoval(
  config: Config,
  db: DatabaseConnection,
  projectId: string
): StagedProjectDirectoryRemoval | null {
  if (!fs.existsSync(projectRoot(config, projectId))) return null;
  const removal = stagedProjectDirectoryRemoval(config, projectId);
  db.prepare(`INSERT INTO project_directory_staging (project_id, trash_name, created_at)
    VALUES (?, ?, ?)`).run(projectId, removal.trashName, new Date().toISOString());
  try {
    fs.mkdirSync(projectTrashDirectory(config), { recursive: true, mode: 0o700 });
    fs.renameSync(removal.source, removal.trash);
    return removal;
  } catch (error) {
    clearPersistedProjectDirectoryRemoval(db, removal);
    throw error;
  }
}

/** Remove a previously staged project tree. It is no longer live or reachable. */
export async function purgeStagedProjectDirectory(removal: StagedProjectDirectoryRemoval): Promise<void> {
  await fs.promises.rm(removal.trash, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (fs.existsSync(removal.trash)) {
    throw new Error(`Unable to remove staged project directory: ${removal.trash}`);
  }
}

/** Purge a staged persisted tree and clear its recovery journal afterwards. */
export async function purgePersistedProjectDirectoryRemoval(
  db: DatabaseConnection,
  removal: StagedProjectDirectoryRemoval
): Promise<void> {
  await purgeStagedProjectDirectory(removal);
  clearPersistedProjectDirectoryRemoval(db, removal);
}

/** Restore an intact staged tree after a later database operation fails. */
export function restoreStagedProjectDirectory(removal: StagedProjectDirectoryRemoval): void {
  if (!fs.existsSync(removal.trash)) return;
  if (fs.existsSync(removal.source)) {
    throw new Error(`Unable to restore staged project directory because its source exists: ${removal.source}`);
  }
  fs.renameSync(removal.trash, removal.source);
}

/** Restore a persisted tree and remove its recovery journal only after success. */
export function restorePersistedProjectDirectoryRemoval(
  db: DatabaseConnection,
  removal: StagedProjectDirectoryRemoval
): void {
  if (fs.existsSync(removal.source)) {
    if (fs.existsSync(removal.trash)) {
      throw new Error(`Unable to restore staged project directory because both locations exist: ${removal.source}`);
    }
    clearPersistedProjectDirectoryRemoval(db, removal);
    return;
  }
  if (!fs.existsSync(removal.trash)) {
    throw new Error(`Unable to restore staged project directory because it is missing: ${removal.trash}`);
  }
  restoreStagedProjectDirectory(removal);
  clearPersistedProjectDirectoryRemoval(db, removal);
}

function clearPersistedProjectDirectoryRemoval(db: DatabaseConnection, removal: StagedProjectDirectoryRemoval): void {
  db.prepare("DELETE FROM project_directory_staging WHERE project_id = ? AND trash_name = ?")
    .run(removal.projectId, removal.trashName);
}

export async function duplicateProjectFiles(config: Config, sourceProjectId: string, targetProjectId: string): Promise<void> {
  const source = sourceRoot(config, sourceProjectId);
  const target = sourceRoot(config, targetProjectId);
  assertNoSourceSymlinks(config, sourceProjectId);
  await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
  if (fs.existsSync(source)) {
    const entries = await fs.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw symbolicLinkError(entry.name);
      if (isReservedProjectPath(entry.name)) continue;
      await fs.promises.cp(path.join(source, entry.name), path.join(target, entry.name), {
        recursive: true, errorOnExist: true, force: false, verbatimSymlinks: false
      });
    }
  }
  await fs.promises.mkdir(outputRoot(config, targetProjectId), { recursive: true, mode: 0o700 });
}

export function safeRelativePath(input: string): string {
  if (!input || input.includes("\0") || path.isAbsolute(input)) {
    throw httpError(400, "INVALID_PATH");
  }
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw httpError(400, "INVALID_PATH");
  }
  if (normalized.split("/").some((segment) => isReservedProjectPath(segment))) {
    throw httpError(400, "RESERVED_PATH");
  }
  return normalized;
}

/** Validate a user-provided file or directory name used within one folder. */
export function safePathSegment(input: string): string {
  const name = input.trim();
  if (!name || name.includes("\0") || name.includes("/") || name.includes("\\")) {
    throw httpError(400, "INVALID_PATH");
  }
  return safeRelativePath(name);
}

export interface ResolveSourcePathOptions {
  /** Deletion is allowed to address the link itself, never its target. */
  allowFinalSymlink?: boolean;
}

export function symbolicLinkError(relativePath: string): HttpError {
  return httpError(409, "SYMLINK_FORBIDDEN", { path: relativePath || "source" });
}

/** Paths with execution/configuration semantics that must never enter a project. */
export function isReservedProjectPath(input: string): boolean {
  const name = input.toLocaleLowerCase();
  return name === ".git" || name === ".latexmkrc" || name === "latexmkrc" || name.endsWith(".latexmkrc");
}

/**
 * Check every existing component below the project directory without
 * resolving it.  `stat()` and most file APIs follow links, so a lexical
 * `safeRelativePath()` check alone is not sufficient after a Git checkout.
 */
function assertSourcePathComponents(
  config: Config,
  projectId: string,
  relativePath: string,
  allowFinalSymlink = false
): void {
  let current = projectRoot(config, projectId);
  const segments = ["source", ...relativePath.split("/").filter(Boolean)];
  const projectStat = lstatIfPresent(current);
  if (projectStat?.isSymbolicLink()) throw symbolicLinkError("source");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = lstatIfPresent(current);
    if (!stat) return;
    const isFinal = index === segments.length - 1;
    if (stat.isSymbolicLink() && !(allowFinalSymlink && isFinal && relativePath.length > 0)) {
      const displayed = relativePath || segments.slice(0, index + 1).join("/");
      throw symbolicLinkError(displayed);
    }
  }
}

function lstatIfPresent(target: string): fs.Stats | null {
  try { return fs.lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Reject every link below an existing directory without following it. */
export function assertNoSymbolicLinks(root: string, ignoreGitDirectory = false): void {
  const rootStat = lstatIfPresent(root);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw symbolicLinkError("source");
  const visit = (directory: string, prefix: string): void => {
    const directoryStat = lstatIfPresent(directory);
    if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw symbolicLinkError(prefix || "source");
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw symbolicLinkError(relative);
      if (ignoreGitDirectory && (entry.name === ".git" || isReservedProjectPath(entry.name))) continue;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
    }
  };
  visit(root, "");
}

/** Reject every link in a checked-out project source tree. */
export function assertNoSourceSymlinks(config: Config, projectId: string): void {
  assertSourcePathComponents(config, projectId, "");
  assertNoSymbolicLinks(sourceRoot(config, projectId), true);
}

/** Return the output stem for a TeX file, regardless of extension casing. */
export function texFileStem(input: string): string {
  return path.basename(input).replace(/\.tex$/i, "");
}

export function resolveSourcePath(
  config: Config,
  projectId: string,
  input: string,
  options: ResolveSourcePathOptions = {}
): string {
  const relativePath = safeRelativePath(input);
  assertSourcePathComponents(config, projectId, relativePath, options.allowFinalSymlink === true);
  return path.join(sourceRoot(config, projectId), relativePath);
}

export function listProjectFiles(config: Config, projectId: string): FileEntry[] {
  const root = sourceRoot(config, projectId);
  const result: FileEntry[] = [];
  const visit = (directory: string, prefix: string): void => {
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw symbolicLinkError(prefix || "source");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw symbolicLinkError(relative);
      if (isReservedProjectPath(entry.name)) continue;
      if (entry.isDirectory()) {
        result.push({ path: relative, type: "directory" });
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) throw symbolicLinkError(relative);
        if (stat.isFile()) result.push({ path: relative, type: "file", size: stat.size });
      }
    }
  };
  assertSourcePathComponents(config, projectId, "");
  if (lstatIfPresent(root)) visit(root, "");
  return result;
}

export async function listProjectFilesAsync(config: Config, projectId: string): Promise<FileEntry[]> {
  const root = sourceRoot(config, projectId);
  const result: FileEntry[] = [];
  let activeIo = 0;
  const waiters: Array<() => void> = [];
  const limited = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (activeIo >= 4) await new Promise<void>((resolve) => waiters.push(resolve));
    activeIo += 1;
    try { return await operation(); }
    finally {
      activeIo -= 1;
      waiters.shift()?.();
    }
  };
  const visit = async (directory: string, prefix: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      const directoryStat = await limited(() => fs.promises.lstat(directory));
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw symbolicLinkError(prefix || "source");
      entries = await limited(() => fs.promises.readdir(directory, { withFileTypes: true }));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const children: Promise<void>[] = [];
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw symbolicLinkError(relative);
      if (isReservedProjectPath(entry.name)) continue;
      if (entry.isDirectory()) {
        result.push({ path: relative, type: "directory" });
        children.push(visit(absolute, relative));
      } else if (entry.isFile()) {
        try {
          const stat = await limited(() => fs.promises.lstat(absolute));
          if (stat.isSymbolicLink()) throw symbolicLinkError(relative);
          if (stat.isFile()) result.push({ path: relative, type: "file", size: stat.size, mtimeMs: stat.mtimeMs });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    await Promise.all(children);
  };
  assertSourcePathComponents(config, projectId, "");
  try { await visit(root, ""); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Remove a project tree before its database row stops counting toward quota.
 *
 * The rename keeps readers from seeing a half-deleted tree, while awaiting
 * removal prevents a user from repeatedly deleting and recreating projects
 * faster than background trash cleanup can release their disk space.
 */
export async function removeProjectDirectory(config: Config, projectId: string): Promise<void> {
  const root = projectRoot(config, projectId);
  const staged = stageProjectDirectoryRemoval(config, projectId);
  if (!staged) return;
  try {
    await purgeStagedProjectDirectory(staged);
    return;
  } catch (error) {
    try {
      // Keep a still-intact tree addressable by its database row when a direct
      // project deletion cannot complete.  A partial recursive deletion cannot
      // be made atomic, but rename failures leave the original tree intact.
      restoreStagedProjectDirectory(staged);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Unable to remove project directory: ${root}`);
    }
    throw error;
  }
}

/**
 * Resolve directory moves that were interrupted between their filesystem
 * rename and the corresponding project-row deletion. This runs before normal
 * trash pruning, so an existing project always gets its source tree back.
 */
export async function recoverProjectDirectoryStaging(config: Config, db: DatabaseConnection): Promise<void> {
  const records = db.prepare("SELECT project_id, trash_name FROM project_directory_staging ORDER BY created_at, project_id")
    .all() as Array<{ project_id: string; trash_name: string }>;
  const journaledTrash = new Set(records.map((record) => record.trash_name));
  const projectExists = db.prepare("SELECT 1 FROM projects WHERE id = ?");
  for (const record of records) {
    const removal = stagedProjectDirectoryRemoval(config, record.project_id, record.trash_name);
    if (projectExists.get(removal.projectId)) {
      restorePersistedProjectDirectoryRemoval(db, removal);
      continue;
    }
    if (fs.existsSync(removal.source)) {
      throw new Error(`Deleted project staging has a live source directory: ${removal.source}`);
    }
    await purgePersistedProjectDirectoryRemoval(db, removal);
  }
  recoverLegacyStagedProjectDirectories(config, journaledTrash, projectExists);
}

/**
 * Older releases staged trees without a database journal. Their names encode
 * the project UUID, so recover a live row before the general trash sweep.
 */
function recoverLegacyStagedProjectDirectories(
  config: Config,
  journaledTrash: ReadonlySet<string>,
  projectExists: { get: (projectId: string) => unknown }
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectTrashDirectory(config), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || journaledTrash.has(entry.name)) continue;
    const match = legacyStagedProjectDirectoryName.exec(entry.name);
    if (!match || !projectExists.get(match[1])) continue;
    const removal = stagedProjectDirectoryRemoval(config, match[1], entry.name);
    if (fs.existsSync(removal.source)) continue;
    fs.renameSync(removal.trash, removal.source);
  }
}

export async function pruneTrashDirectory(config: Config): Promise<void> {
  for (const folder of ["trash", "tmp"]) {
    const dir = path.join(config.dataDir, folder);
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = await fs.promises.readdir(dir);
      await Promise.allSettled(entries.map((entry) => fs.promises.rm(path.join(dir, entry), { recursive: true, force: true })));
    } catch {
      // Ignore error
    }
  }
}
