import type { Config } from "./config.js";
import { CONFIG_DEFAULTS } from "./config.js";
import type { DatabaseConnection } from "./db.js";
import { projectSourceBytes } from "./files.js";
import { httpError } from "./http.js";

interface OwnerUsage {
  projectCount: number;
  bytes: number;
  projectBytes: Map<string, number>;
}

interface CachedProjectBytes {
  ownerId: string;
  bytes: number;
}

/**
 * In-process accounting for durable user-controlled project source files.
 *
 * TexLite deliberately keeps generated compiler data and retained history in
 * their own bounded stores.  This service covers the otherwise unbounded
 * user-controlled input path: projects, imports, copied projects, uploads
 * and source edits.  The database is reconciled on each owner lookup, while
 * byte counts are cached and updated after every routed source mutation so a
 * collaboration autosave does not need to walk every project on each keypress.
 */
export class ProjectQuotaService {
  private readonly cachedProjectBytes = new Map<string, CachedProjectBytes>();
  /**
   * One TexLite process owns a data directory (enforced by instanceLock), so
   * an in-process per-owner queue is enough to make asynchronous imports,
   * copies and deletion observe the same project-count/storage snapshot.
   */
  private readonly ownerQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Config,
    private readonly db: DatabaseConnection
  ) {}

  get maxProjectsPerUser(): number {
    return this.config.maxProjectsPerUser ?? CONFIG_DEFAULTS.maxProjectsPerUser;
  }

  get maxSourceStorageBytesPerUser(): number {
    return this.config.maxSourceStorageBytesPerUser
      ?? CONFIG_DEFAULTS.maxSourceStorageMBPerUser * 1024 * 1024;
  }

  /** Serialize quota-changing catalog operations for one owning account. */
  async runForOwner<T>(ownerId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.ownerQueues.get(ownerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.ownerQueues.set(ownerId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.ownerQueues.get(ownerId) === tail) this.ownerQueues.delete(ownerId);
    }
  }

  /** Reject creation when the owner would exceed either durable quota. */
  async assertCanCreate(ownerId: string, initialSourceBytes: number): Promise<void> {
    const usage = await this.usage(ownerId);
    if (usage.projectCount >= this.maxProjectsPerUser) {
      throw httpError(403, "PROJECT_QUOTA_EXCEEDED", { maxProjects: this.maxProjectsPerUser });
    }
    this.assertBytesWithinLimit(usage.bytes + normalizedBytes(initialSourceBytes));
  }

  /**
   * Reject a source-tree replacement or file write if its resulting project
   * size would exceed the owner's aggregate source quota.
   */
  async assertCanStoreSource(ownerId: string, projectId: string, nextProjectBytes: number): Promise<void> {
    const usage = await this.usage(ownerId);
    const currentProjectBytes = usage.projectBytes.get(projectId) ?? 0;
    const next = normalizedBytes(nextProjectBytes);
    const nextTotal = usage.bytes - currentProjectBytes + next;
    // A newly enabled quota must not trap an existing oversized account: it
    // may always keep or reduce one project's source footprint, but may not
    // make an already-over-limit account consume additional source storage.
    if (next <= currentProjectBytes) return;
    this.assertBytesWithinLimit(nextTotal);
  }

  /** Return whether an aggregate source update can become durable. */
  async canStoreSource(ownerId: string, projectId: string, nextProjectBytes: number): Promise<boolean> {
    try {
      await this.assertCanStoreSource(ownerId, projectId, nextProjectBytes);
      return true;
    } catch (error) {
      if (isQuotaError(error)) return false;
      throw error;
    }
  }

  /** Current cached-or-scanned source bytes for one owned project. */
  async sourceBytes(ownerId: string, projectId: string): Promise<number> {
    return (await this.usage(ownerId)).projectBytes.get(projectId) ?? 0;
  }

  /** Record the source size after a successful routed source mutation. */
  setSourceBytes(ownerId: string, projectId: string, bytes: number): void {
    this.cachedProjectBytes.set(projectId, { ownerId, bytes: normalizedBytes(bytes) });
  }

  /** Record a known delta without re-walking the source tree. */
  async adjustSourceBytes(ownerId: string, projectId: string, delta: number): Promise<void> {
    const current = await this.sourceBytes(ownerId, projectId);
    this.setSourceBytes(ownerId, projectId, Math.max(0, current + delta));
  }

  /** Force a re-scan after an operation that replaced a whole source tree. */
  refreshSourceBytes(ownerId: string, projectId: string): number {
    const bytes = projectSourceBytes(this.config, projectId);
    this.setSourceBytes(ownerId, projectId, bytes);
    return bytes;
  }

  private async usage(ownerId: string): Promise<OwnerUsage> {
    const projectIds = await this.db.projects.listOwnedProjectIds(ownerId);
    const activeIds = new Set(projectIds);
    for (const [projectId, cached] of this.cachedProjectBytes) {
      if (cached.ownerId === ownerId && !activeIds.has(projectId)) this.cachedProjectBytes.delete(projectId);
    }
    const projectBytes = new Map<string, number>();
    let bytes = 0;
    for (const projectId of projectIds) {
      const cached = this.cachedProjectBytes.get(projectId);
      const projectBytesValue = cached?.ownerId === ownerId
        ? cached.bytes
        : this.refreshSourceBytes(ownerId, projectId);
      projectBytes.set(projectId, projectBytesValue);
      bytes += projectBytesValue;
    }
    return { projectCount: projectIds.length, bytes, projectBytes };
  }

  private assertBytesWithinLimit(bytes: number): void {
    if (bytes <= this.maxSourceStorageBytesPerUser) return;
    throw httpError(413, "PROJECT_STORAGE_QUOTA_EXCEEDED", {
      maxStorageMB: Math.floor(this.maxSourceStorageBytesPerUser / 1024 / 1024)
    });
  }
}

function normalizedBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid project source byte count");
  }
  return value;
}

function isQuotaError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && ((error as { code?: unknown }).code === "PROJECT_QUOTA_EXCEEDED"
      || (error as { code?: unknown }).code === "PROJECT_STORAGE_QUOTA_EXCEEDED");
}
