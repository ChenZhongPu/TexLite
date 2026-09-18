import { createHash } from "node:crypto";
import path from "node:path";
import { Dialect, LocalLinter, SuggestionKind, type Lint } from "harper.js";
import { binary } from "harper.js/binary";
import { maskLatexSource } from "./latexSpellMask.js";

export interface RawHarperLint {
  start: number;
  end: number;
  problem: string;
  kind: string;
  message: string;
  suggestions: string[];
}

interface CachedLintResult {
  expiresAt: number;
  lints: RawHarperLint[];
}

interface ScheduledLint {
  key: string;
  source: string;
  filePath: string;
  started: boolean;
  cancelled: boolean;
  /** Browser lanes currently waiting for this shared queued operation. */
  lanes: Set<string>;
  /** A caller without a lane still expects this operation to run. */
  hasUnscopedWaiter: boolean;
  promise: Promise<RawHarperLint[]>;
  resolve: (lints: RawHarperLint[]) => void;
  reject: (error: unknown) => void;
}

const maxCachedSourceBytes = 512 * 1024;
const maxCachedResults = 24;
const cacheTtlMs = 15_000;
const unavailableRetryMs = 15_000;
// A browser can send an older request after a newer one when HTTP requests
// race. Keep the latest sequence briefly so that late arrivals cannot replace
// a newer queued revision. The bound is intentionally generous for a small
// collaborative installation while keeping abandoned browser-page lanes from
// accumulating forever.
const laneSequenceRetentionMs = 10 * 60_000;
const maxTrackedLaneSequences = 512;

interface LaneSequence {
  sequence: number;
  key: string;
  seenAt: number;
}

export class HarperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarperUnavailableError";
  }
}

/** A newer source revision made a waiting writing check irrelevant. */
export class HarperLintSupersededError extends Error {
  constructor() {
    super("A newer writing check replaced this request.");
    this.name = "HarperLintSupersededError";
  }
}

function lintCacheKey(source: string, filePath: string): string {
  // Keep equivalent source in different LaTeX file types isolated, matching
  // the previous file-backed integration's cache semantics.
  return createHash("sha256").update(temporaryFileExtension(filePath)).update("\0").update(source).digest("base64url");
}

function temporaryFileExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  // Source-like companion files use the same plaintext Harper.js linter;
  // BibTeX keys are intentionally kept out of writing checks by the route.
  return extension === ".tex" || extension === ".sty" || extension === ".cls" ? extension : ".tex";
}

function rawHarperLint(lint: Lint): RawHarperLint {
  const span = lint.span();
  const suggestions = lint.suggestions();
  try {
    return {
      start: span.start,
      end: span.end,
      problem: lint.get_problem_text(),
      kind: lint.lint_kind(),
      message: lint.message(),
      suggestions: [...new Set(suggestions
        .filter((suggestion) => suggestion.kind() !== SuggestionKind.InsertAfter)
        .map((suggestion) => suggestion.get_replacement_text()))].slice(0, 5)
    };
  } finally {
    for (const suggestion of suggestions) suggestion.free();
    span.free();
    lint.free();
  }
}

function rawHarperLints(lints: Lint[]): RawHarperLint[] {
  return lints.map(rawHarperLint);
}

/** Server-side Harper.js integration backed by the bundled WebAssembly binary. */
export class HarperService {
  private availability: "unknown" | "available" | "unavailable" = "unknown";
  private lastUnavailableAt = 0;
  private setupPromise: Promise<void> | null = null;
  private linter: LocalLinter | null = null;
  /** One LocalLinter operation at a time; Harper's Node implementation is synchronous internally. */
  private queueRunner: Promise<void> | null = null;
  // Set preserves insertion order, giving the scheduler FIFO behaviour while
  // allowing a superseded waiting item to be removed immediately. An array
  // would otherwise retain its complete source string until the active check
  // finishes.
  private readonly queued = new Set<ScheduledLint>();
  /** Only waiting work belongs here; a running process must finish safely. */
  private readonly waitingByLane = new Map<string, ScheduledLint>();
  /** Latest accepted browser revision for each project/user/page/file lane. */
  private readonly latestSequenceByLane = new Map<string, LaneSequence>();
  private readonly inFlight = new Map<string, Promise<RawHarperLint[]>>();
  /** Lets coalesced browser lanes share one queued operation safely. */
  private readonly scheduledByKey = new Map<string, ScheduledLint>();
  private readonly cache = new Map<string, CachedLintResult>();
  private disposed = false;

  constructor() {}

  async preload(): Promise<void> {
    await this.ensureAvailable();
  }

  /**
   * Schedule one server-side check. A lane represents one browser page's
   * current file, so an edit can replace only its own stale waiting request
   * without cancelling checks requested by collaborators.
   */
  async lint(source: string, filePath = "main.tex", lane?: string, sequence?: number): Promise<RawHarperLint[]> {
    if (this.disposed) throw new HarperUnavailableError("Harper service stopped.");
    const key = lintCacheKey(source, filePath);
    const laneKey = lane || null;
    if (laneKey && sequence !== undefined) this.acceptLaneSequence(laneKey, sequence, key);
    const waiting = laneKey ? this.waitingByLane.get(laneKey) : undefined;
    // Repeated requests for the same queued revision share it. A newer
    // revision replaces only work that has not started yet.
    if (waiting?.key === key) return waiting.promise;
    if (laneKey && waiting) this.releaseWaitingLane(laneKey, waiting);

    const cacheable = Buffer.byteLength(source, "utf8") <= maxCachedSourceBytes;
    const cached = cacheable ? this.cachedResult(key) : null;
    if (cached) return cached;
    // Result caching is deliberately size-bounded, but duplicate active work
    // is still coalesced for large files. The latter is transient and avoids
    // starting multiple expensive WASM checks for identical content.
    const existing = this.inFlight.get(key);
    if (existing) {
      const scheduled = this.scheduledByKey.get(key);
      if (laneKey && scheduled) this.addWaitingLane(scheduled, laneKey);
      else if (scheduled && !scheduled.started) scheduled.hasUnscopedWaiter = true;
      return existing;
    }

    let resolve!: (lints: RawHarperLint[]) => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<RawHarperLint[]>((resolveOperation, rejectOperation) => {
      resolve = resolveOperation;
      reject = rejectOperation;
    });
    const scheduled: ScheduledLint = {
      key,
      source,
      filePath,
      started: false,
      cancelled: false,
      lanes: laneKey ? new Set([laneKey]) : new Set(),
      hasUnscopedWaiter: laneKey === null,
      promise: operation,
      resolve,
      reject
    };
    this.inFlight.set(key, operation);
    this.scheduledByKey.set(key, scheduled);
    if (laneKey) this.waitingByLane.set(laneKey, scheduled);
    this.queued.add(scheduled);
    this.startQueue();

    if (cacheable) {
      void operation.then(
        (lints) => this.cacheResult(key, lints),
        () => undefined
      ).finally(() => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
        if (this.scheduledByKey.get(key) === scheduled) this.scheduledByKey.delete(key);
      });
    } else {
      // Attach a rejection handler even for uncached results. This keeps a
      // superseded request from becoming an unhandled rejection when a client
      // disconnects before it awaits the response.
      void operation.catch(() => undefined).finally(() => {
        if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
        if (this.scheduledByKey.get(key) === scheduled) this.scheduledByKey.delete(key);
      });
    }
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const stopped = new HarperUnavailableError("Harper service stopped.");
    for (const scheduled of [...this.queued]) {
      if (!scheduled.cancelled && !scheduled.started) {
        scheduled.cancelled = true;
        this.discardQueuedLint(scheduled);
        scheduled.reject(stopped);
      }
    }
    this.waitingByLane.clear();
    this.latestSequenceByLane.clear();
    await this.setupPromise?.catch(() => undefined);
    await this.queueRunner?.catch(() => undefined);
    const linter = this.linter;
    this.linter = null;
    await linter?.dispose().catch(() => undefined);
    this.inFlight.clear();
    this.scheduledByKey.clear();
    this.cache.clear();
  }

  private addWaitingLane(scheduled: ScheduledLint, lane: string): void {
    if (scheduled.started || scheduled.cancelled) return;
    scheduled.lanes.add(lane);
    this.waitingByLane.set(lane, scheduled);
  }

  private releaseWaitingLane(lane: string, scheduled: ScheduledLint): void {
    if (this.waitingByLane.get(lane) === scheduled) this.waitingByLane.delete(lane);
    scheduled.lanes.delete(lane);
    // The exact same queued source can be requested by multiple sessions.
    // Discard it only after every interested lane has moved on.
    if (scheduled.started || scheduled.cancelled || scheduled.hasUnscopedWaiter || scheduled.lanes.size > 0) return;
    this.cancelScheduledLint(scheduled);
  }

  private cancelScheduledLint(scheduled: ScheduledLint): void {
    if (scheduled.started || scheduled.cancelled) return;
    scheduled.cancelled = true;
    for (const lane of scheduled.lanes) {
      if (this.waitingByLane.get(lane) === scheduled) this.waitingByLane.delete(lane);
    }
    scheduled.lanes.clear();
    // Remove this rejected promise immediately so a later return to the same
    // text can enqueue fresh work instead of inheriting a stale rejection.
    if (this.inFlight.get(scheduled.key) === scheduled.promise) {
      this.inFlight.delete(scheduled.key);
    }
    if (this.scheduledByKey.get(scheduled.key) === scheduled) {
      this.scheduledByKey.delete(scheduled.key);
    }
    this.discardQueuedLint(scheduled);
    scheduled.reject(new HarperLintSupersededError());
  }

  /** Remove a waiting task and promptly release its potentially large text. */
  private discardQueuedLint(scheduled: ScheduledLint): void {
    this.queued.delete(scheduled);
    scheduled.source = "";
    scheduled.filePath = "";
  }

  /** Reject an out-of-order request before it can alter queued work. */
  private acceptLaneSequence(lane: string, sequence: number, key: string): void {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new HarperLintSupersededError();
    }
    const now = Date.now();
    this.pruneLaneSequences(now);
    const previous = this.latestSequenceByLane.get(lane);
    if (previous && (sequence < previous.sequence || (sequence === previous.sequence && previous.key !== key))) {
      throw new HarperLintSupersededError();
    }
    // Refresh insertion order so the bounded map evicts the least recently
    // used abandoned page lane first.
    this.latestSequenceByLane.delete(lane);
    this.latestSequenceByLane.set(lane, { sequence, key, seenAt: now });
    while (this.latestSequenceByLane.size > maxTrackedLaneSequences) {
      const oldest = this.latestSequenceByLane.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.latestSequenceByLane.delete(oldest);
    }
  }

  private pruneLaneSequences(now: number): void {
    for (const [lane, state] of this.latestSequenceByLane) {
      if (now - state.seenAt <= laneSequenceRetentionMs) continue;
      this.latestSequenceByLane.delete(lane);
    }
  }

  private startQueue(): void {
    if (this.queueRunner) return;
    this.queueRunner = (async () => {
      while (!this.disposed) {
        const scheduled = this.queued.values().next().value as ScheduledLint | undefined;
        if (!scheduled) return;
        this.queued.delete(scheduled);
        if (scheduled.cancelled) continue;
        scheduled.started = true;
        for (const lane of scheduled.lanes) {
          if (this.waitingByLane.get(lane) === scheduled) this.waitingByLane.delete(lane);
        }
        scheduled.lanes.clear();
        try {
          scheduled.resolve(await this.lintOnce(scheduled.source, scheduled.filePath));
        } catch (error) {
          scheduled.reject(error);
        }
      }
    })().finally(() => {
      this.queueRunner = null;
      // A request can arrive just after the loop observes an empty queue.
      if (!this.disposed && this.queued.size) this.startQueue();
    });
  }

  private async ensureAvailable(): Promise<LocalLinter> {
    if (this.disposed) throw new HarperUnavailableError("Harper service stopped.");
    if (this.availability === "available" && this.linter) return this.linter;
    if (this.setupPromise) {
      await this.setupPromise;
      if (this.linter) return this.linter;
      throw new HarperUnavailableError("The bundled Harper.js linter is unavailable.");
    }
    if (this.availability === "unavailable" && Date.now() - this.lastUnavailableAt < unavailableRetryMs) {
      throw new HarperUnavailableError("The bundled Harper.js linter is unavailable.");
    }
    const setup = (async () => {
      const linter = new LocalLinter({ binary, dialect: Dialect.American });
      try {
        await linter.setup();
        if (this.disposed) throw new HarperUnavailableError("Harper service stopped.");
        this.linter = linter;
        this.availability = "available";
      } catch (error) {
        await linter.dispose().catch(() => undefined);
        throw error;
      }
    })();
    this.setupPromise = setup
      .catch((error) => {
        this.availability = "unavailable";
        this.lastUnavailableAt = Date.now();
        if (error instanceof HarperUnavailableError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new HarperUnavailableError(`The bundled Harper.js linter is unavailable: ${detail}`);
      })
      .finally(() => { this.setupPromise = null; });
    await this.setupPromise;
    if (!this.linter) throw new HarperUnavailableError("The bundled Harper.js linter is unavailable.");
    return this.linter;
  }

  protected async runLint(source: string, _filePath: string): Promise<RawHarperLint[]> {
    const linter = await this.ensureAvailable();
    // Harper.js currently supports plaintext, Markdown, and Typst. Masking
    // LaTeX first keeps commands, comments, math, and literal environments out
    // of the prose check while preserving the source's UTF-16 coordinates.
    const lints = await linter.lint(maskLatexSource(source), { language: "plaintext" });
    return rawHarperLints(lints);
  }

  private async lintOnce(source: string, filePath: string): Promise<RawHarperLint[]> {
    return this.runLint(source, filePath);
  }

  private cachedResult(key: string): RawHarperLint[] | null {
    const cached = this.cache.get(key);
    if (!cached || cached.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached.lints;
  }

  private cacheResult(key: string, lints: RawHarperLint[]): void {
    this.cache.set(key, { expiresAt: Date.now() + cacheTtlMs, lints });
    while (this.cache.size > maxCachedResults) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

}
