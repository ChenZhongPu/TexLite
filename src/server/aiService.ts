import type { Config } from "./config.js";
import type { DatabaseConnection, UserRow } from "./db.js";
import {
  AiApplyAbortedError,
  AiAuthenticationError,
  AiTargetConflictError,
  AiPermissionError,
  CollaborationService,
  type AiTargetSnapshot
} from "./collaboration.js";
import {
  AI_MIME_TYPES,
  AI_PROTOCOL_LIMITS,
  AI_PROTOCOL_VERSION,
  isAiContextFilePath,
  type AiContextFile,
  type AiGenerateRequest,
  type AiOperation,
  type AiStreamEvent
} from "../shared/aiProtocol.js";

const AI_ENDPOINT_PATH = "/api/texlite/ai/generate";
const AI_REQUEST_TIMEOUT_MS = 120_000;
const MAX_TASK_DESCRIPTION_CHARS = 2_000;
const MAX_PROMPT_ID_CHARS = 128;
const MAX_REQUEST_ID_CHARS = 128;
const PENDING_TASK_TTL_MS = 10 * 60 * 1000;

export type AiTaskEvent =
  | { type: "status"; phase: "preparing" | "generating" }
  | { type: "delta"; text: string };

export interface AiTaskInput {
  requestId: string;
  projectId: string;
  targetFilePath: string;
  operation: AiOperation;
  startOffset: number;
  endOffset: number;
  contextFiles: string[];
  promptId?: string;
  taskDescription: string;
  user: UserRow;
}

export interface AiTaskResult {
  resultText: string;
  applied: false;
}

export interface AiConfirmedTaskResult {
  resultText: string;
  applied: boolean;
}

export class AiServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 502
  ) {
    super(message);
    this.name = "AiServiceError";
  }
}

export class AiTaskCancelledError extends AiServiceError {
  constructor() {
    super("AI_TASK_CANCELLED", "The AI task was cancelled.", 499);
    this.name = "AiTaskCancelledError";
  }
}

interface ActiveTask {
  projectId: string;
  userId: string;
  controller: AbortController;
}

interface PendingTask {
  projectId: string;
  userId: string;
  snapshot: AiTargetSnapshot;
  resultText: string;
  expiresAt: number;
}

interface ParsedAiResult {
  resultText: string;
}

/**
 * Ephemeral AI task coordinator. Generated text is kept in memory until the
 * user confirms the preview. There is deliberately no database table: a task
 * belongs to the live collaboration room and disappears on restart.
 */
export class AiTaskService {
  private readonly activeTasks = new Map<string, ActiveTask>();
  private readonly pendingTasks = new Map<string, PendingTask>();

  constructor(
    private readonly config: Config,
    private readonly db: DatabaseConnection,
    private readonly collaboration: CollaborationService,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async run(input: AiTaskInput, externalSignal: AbortSignal, onEvent: (event: AiTaskEvent) => void): Promise<AiTaskResult> {
    const ai = this.config.ai;
    if (!ai) throw new AiServiceError("AI_NOT_CONFIGURED", "AI assistance is not configured.", 404);
    validateTaskInput(input);
    const key = taskKey(input.user.id, input.projectId, input.requestId);
    this.removeExpiredPendingTasks();
    if (this.activeTasks.has(key) || this.pendingTasks.has(key)) {
      throw new AiServiceError("AI_TASK_EXISTS", "An AI task with this request ID is already running.", 409);
    }

    const controller = new AbortController();
    const active: ActiveTask = { projectId: input.projectId, userId: input.user.id, controller };
    this.activeTasks.set(key, active);
    const forwardAbort = (): void => controller.abort();
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", forwardAbort, { once: true });

    try {
      if (controller.signal.aborted) throw new AiTaskCancelledError();
      await this.ensureStillAuthorized(input);
      if (controller.signal.aborted) throw new AiTaskCancelledError();

      const snapshot = this.captureTarget(input);
      const contextFiles = this.captureContextFiles(input);
      const request: AiGenerateRequest = {
        protocolVersion: AI_PROTOCOL_VERSION,
        requestId: input.requestId,
        actor: {
          userId: input.user.id,
          username: input.user.username,
          ...(input.user.nuwax_subject ? { nuwaxSubject: input.user.nuwax_subject } : {})
        },
        projectId: input.projectId,
        taskType: "writing",
        operation: input.operation,
        target: buildTarget(snapshot),
        contextFiles,
        ...(input.promptId ? { promptId: input.promptId } : {}),
        taskDescription: input.taskDescription.trim(),
        limits: {
          maxOutputBytes: AI_PROTOCOL_LIMITS.DEFAULT_MAX_OUTPUT_BYTES
        }
      };
      const result = await this.requestAi(request, ai.baseUrl, ai.apiKey, controller.signal, onEvent);
      if (controller.signal.aborted) throw new AiTaskCancelledError();
      await this.ensureStillAuthorized(input);
      if (controller.signal.aborted) throw new AiTaskCancelledError();

      this.pendingTasks.set(key, {
        projectId: input.projectId,
        userId: input.user.id,
        snapshot,
        resultText: result.resultText,
        expiresAt: Date.now() + PENDING_TASK_TTL_MS
      });
      return { resultText: result.resultText, applied: false };
    } catch (error) {
      if (error instanceof AiServiceError) throw error;
      if (externalSignal.aborted || controller.signal.aborted) throw new AiTaskCancelledError();
      throw new AiServiceError("AI_INTERNAL_ERROR", "The AI task could not be completed.", 502);
    } finally {
      externalSignal.removeEventListener("abort", forwardAbort);
      if (this.activeTasks.get(key) === active) this.activeTasks.delete(key);
    }
  }

  async confirm(
    projectId: string,
    requestId: string,
    userId: string,
    sessionId: string | null | undefined,
    signal?: AbortSignal
  ): Promise<AiConfirmedTaskResult> {
    const key = taskKey(userId, projectId, requestId);
    this.removeExpiredPendingTasks();
    const pending = this.pendingTasks.get(key);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingTasks.delete(key);
      throw new AiServiceError("AI_TASK_NOT_FOUND", "The AI preview is no longer available.", 404);
    }
    if (pending.projectId !== projectId || pending.userId !== userId) {
      throw new AiServiceError("AI_TASK_NOT_FOUND", "The AI preview is no longer available.", 404);
    }
    try {
      const appliedResult = await this.collaboration.applyAiResult(
        pending.snapshot,
        pending.resultText,
        userId,
        signal,
        sessionId
      );
      return { resultText: pending.resultText, applied: appliedResult.status === "applied" };
    } catch (error) {
      if (error instanceof AiApplyAbortedError) throw new AiTaskCancelledError();
      if (error instanceof AiAuthenticationError) {
        throw new AiServiceError("AI_AUTH_REVOKED", "Your sign-in session is no longer active.", 401);
      }
      if (error instanceof AiTargetConflictError) {
        throw new AiServiceError(
          "AI_TARGET_CONFLICT",
          "The document changed while the AI result was waiting for confirmation. Review it and try again.",
          409
        );
      }
      if (error instanceof AiPermissionError) {
        throw new AiServiceError("AI_PERMISSION_REVOKED", "You no longer have edit permission for this project.", 403);
      }
      throw new AiServiceError(
        "AI_SOURCE_SAVE_FAILED",
        "The AI result was confirmed, but the source could not be saved.",
        409
      );
    } finally {
      if (this.pendingTasks.get(key) === pending) this.pendingTasks.delete(key);
    }
  }

  cancel(projectId: string, requestId: string, userId: string): boolean {
    const key = taskKey(userId, projectId, requestId);
    this.removeExpiredPendingTasks();
    const active = this.activeTasks.get(key);
    if (active && active.userId === userId) {
      active.controller.abort();
      return true;
    }
    const pending = this.pendingTasks.get(key);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingTasks.delete(key);
      return false;
    }
    if (pending.userId !== userId || pending.projectId !== projectId) return false;
    this.pendingTasks.delete(key);
    return true;
  }

  dispose(): void {
    for (const task of this.activeTasks.values()) task.controller.abort();
    this.activeTasks.clear();
    this.pendingTasks.clear();
  }

  private captureTarget(input: AiTaskInput): AiTargetSnapshot {
    try {
      return this.collaboration.captureAiTarget(
        input.projectId,
        input.targetFilePath,
        input.startOffset,
        input.endOffset,
        input.operation
      );
    } catch (error) {
      if (error instanceof AiTargetConflictError) {
        throw new AiServiceError("AI_TARGET_CONFLICT", "The collaborative document is not ready for AI editing.", 409);
      }
      throw new AiServiceError("AI_TARGET_INVALID", "The selected source range is invalid.", 400);
    }
  }

  private captureContextFiles(input: AiTaskInput): AiContextFile[] {
    try {
      const files = this.collaboration.captureAiContextFiles(input.projectId, input.contextFiles);
      let totalBytes = 0;
      for (const file of files) {
        const bytes = Buffer.byteLength(file.content, "utf8");
        if (bytes > AI_PROTOCOL_LIMITS.MAX_CONTEXT_FILE_BYTES) {
          throw new AiServiceError("AI_CONTEXT_TOO_LARGE", "An AI context file is too large.", 413);
        }
        totalBytes += bytes;
      }
      if (totalBytes > AI_PROTOCOL_LIMITS.MAX_CONTEXT_FILES_TOTAL_BYTES) {
        throw new AiServiceError("AI_CONTEXT_TOO_LARGE", "The AI context files are too large.", 413);
      }
      return files;
    } catch (error) {
      if (error instanceof AiServiceError) throw error;
      if (error instanceof AiTargetConflictError) {
        throw new AiServiceError("AI_CONTEXT_FILES_INVALID", "One of the selected AI context files is unavailable.", 400);
      }
      throw new AiServiceError("AI_CONTEXT_FILES_INVALID", "The selected AI context files are invalid.", 400);
    }
  }

  private async ensureStillAuthorized(input: AiTaskInput): Promise<void> {
    const currentUser = await this.db.identity.findUserById(input.user.id);
    if (!currentUser || currentUser.disabled
      || (input.user.session_id !== null && input.user.session_id !== undefined
        && !(await this.db.identity.sessionIsActive(input.user.session_id, input.user.id, new Date().toISOString())))) {
      throw new AiServiceError("AI_AUTH_REVOKED", "Your sign-in session is no longer active.", 401);
    }
    const project = await this.db.projects.findCollaborationAccess(input.projectId, currentUser);
    if (!project || (project.permission !== "owner" && project.permission !== "edit")) {
      throw new AiServiceError("AI_PERMISSION_REVOKED", "You no longer have edit permission for this project.", 403);
    }
  }

  private removeExpiredPendingTasks(): void {
    const now = Date.now();
    for (const [key, pending] of this.pendingTasks) {
      if (pending.expiresAt <= now) this.pendingTasks.delete(key);
    }
  }

  private async requestAi(
    request: AiGenerateRequest,
    baseUrl: string,
    apiKey: string,
    signal: AbortSignal,
    onEvent: (event: AiTaskEvent) => void
  ): Promise<ParsedAiResult> {
    const endpoint = baseUrl + AI_ENDPOINT_PATH;
    const timeoutController = new AbortController();
    let timedOut = false;
    const abortUpstream = (): void => timeoutController.abort();
    signal.addEventListener("abort", abortUpstream, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, AI_REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Accept: AI_MIME_TYPES.NDJSON + ", " + AI_MIME_TYPES.JSON,
            "Content-Type": "application/json",
            Authorization: "Bearer " + apiKey
          },
          body: JSON.stringify(request),
          signal: timeoutController.signal,
          redirect: "error"
        });
      } catch {
        if (timedOut) throw new AiServiceError("AI_UPSTREAM_TIMEOUT", "The AI service timed out.", 504);
        if (signal.aborted) throw new AiTaskCancelledError();
        throw new AiServiceError("AI_UPSTREAM_UNAVAILABLE", "The AI service could not be reached.", 502);
      }
      try {
        if (!response.ok) throw await upstreamHttpError(response);
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        if (contentType.includes(AI_MIME_TYPES.NDJSON)) {
          return await this.parseNdjson(response, request.requestId, signal, onEvent);
        }
        if (contentType.includes(AI_MIME_TYPES.JSON) || !contentType) {
          return parseJsonResult(await readJsonLimited(response), request.requestId);
        }
        throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI service returned an unsupported response format.", 502);
      } catch (error) {
        if (timedOut) throw new AiServiceError("AI_UPSTREAM_TIMEOUT", "The AI service timed out.", 504);
        if (signal.aborted) throw new AiTaskCancelledError();
        if (error instanceof AiServiceError) throw error;
        throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI service returned an invalid response.", 502);
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortUpstream);
    }
  }

  private async parseNdjson(
    response: Response,
    requestId: string,
    signal: AbortSignal,
    onEvent: (event: AiTaskEvent) => void
  ): Promise<ParsedAiResult> {
    if (!response.body) throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI service returned an empty stream.", 502);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    let resultText: string | null = null;
    let streamedText = "";
    let receivedBytes = 0;
    let seenDone = false;
    let readerDone = false;
    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      totalBytes += Buffer.byteLength(trimmed, "utf8");
      if (totalBytes > 256 * 1024) throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI response is too large.", 502);
      let event: unknown;
      try { event = JSON.parse(trimmed); }
      catch { throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI service returned malformed JSON.", 502); }
      if (!isAiStreamEvent(event) || event.requestId !== requestId) {
        throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI service returned an invalid event.", 502);
      }
      if (seenDone) throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI stream emitted data after completion.", 502);
      if (event.type === "status") {
        onEvent({ type: "status", phase: event.phase });
      } else if (event.type === "delta") {
        streamedText += event.text;
        enforceOutputLimit(streamedText);
        onEvent({ type: "delta", text: event.text });
      } else if (event.type === "done") {
        if (seenDone) throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI stream emitted multiple completions.", 502);
        enforceResultText(event.resultText);
        if (streamedText !== event.resultText) {
          throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI stream did not match its final result.", 502);
        }
        resultText = event.resultText;
        seenDone = true;
      } else {
        throw new AiServiceError(event.code || "AI_UPSTREAM_ERROR", event.message || "The AI service returned an error.", 502);
      }
    };
    try {
      while (true) {
        if (signal.aborted) throw new AiTaskCancelledError();
        const { value, done } = await reader.read();
        if (done) {
          readerDone = true;
          break;
        }
        receivedBytes += value.byteLength;
        if (receivedBytes > 256 * 1024) {
          throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI response is too large.", 502);
        }
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          consume(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    } finally {
      if (!readerDone) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!seenDone || resultText === null) {
      throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI stream ended before completion.", 502);
    }
    return { resultText };
  }
}

function taskKey(userId: string, projectId: string, requestId: string): string {
  return [userId, projectId, requestId].join(":");
}

function validateTaskInput(input: AiTaskInput): void {
  if (!input.requestId || input.requestId.length > MAX_REQUEST_ID_CHARS) {
    throw new AiServiceError("AI_REQUEST_INVALID", "The AI request ID is invalid.", 400);
  }
  if (!input.taskDescription.trim() || input.taskDescription.length > MAX_TASK_DESCRIPTION_CHARS) {
    throw new AiServiceError("AI_REQUEST_INVALID", "The AI task description is invalid.", 400);
  }
  if (input.promptId && input.promptId.length > MAX_PROMPT_ID_CHARS) {
    throw new AiServiceError("AI_REQUEST_INVALID", "The AI prompt ID is invalid.", 400);
  }
  if (input.operation !== "insert" && input.operation !== "replace") {
    throw new AiServiceError("AI_REQUEST_INVALID", "The AI operation is invalid.", 400);
  }
  if (!Array.isArray(input.contextFiles) || input.contextFiles.length > AI_PROTOCOL_LIMITS.MAX_CONTEXT_FILES) {
    throw new AiServiceError("AI_CONTEXT_TOO_LARGE", "Too many AI context files were selected.", 413);
  }
  const seen = new Set<string>();
  for (const filePath of input.contextFiles) {
    if (typeof filePath !== "string" || !isAiContextFilePath(filePath) || seen.has(filePath)
      || filePath === input.targetFilePath || filePath.includes("\\") || filePath.startsWith("/")) {
      throw new AiServiceError("AI_CONTEXT_FILES_INVALID", "The selected AI context files are invalid.", 400);
    }
    seen.add(filePath);
  }
}

function buildTarget(snapshot: AiTargetSnapshot) {
  const beforeBytes = Buffer.byteLength(snapshot.contextBefore, "utf8");
  const selectedBytes = Buffer.byteLength(snapshot.selectedText, "utf8");
  const afterBytes = Buffer.byteLength(snapshot.contextAfter, "utf8");
  if (beforeBytes > AI_PROTOCOL_LIMITS.MAX_CONTEXT_BEFORE_BYTES
    || selectedBytes > AI_PROTOCOL_LIMITS.MAX_CONTEXT_SELECTED_BYTES
    || afterBytes > AI_PROTOCOL_LIMITS.MAX_CONTEXT_AFTER_BYTES
    || beforeBytes + selectedBytes + afterBytes > AI_PROTOCOL_LIMITS.MAX_CONTEXT_TOTAL_BYTES) {
    throw new AiServiceError("AI_CONTEXT_TOO_LARGE", "The selected document context is too large for AI assistance.", 413);
  }
  return {
    filePath: snapshot.filePath,
    before: snapshot.contextBefore,
    selectedText: snapshot.selectedText,
    after: snapshot.contextAfter
  };
}

async function upstreamHttpError(response: Response): Promise<AiServiceError> {
  let remoteCode = "";
  try {
    const payload = await readJsonLimited(response);
    if (isRecord(payload)) {
      if (typeof payload.code === "string") remoteCode = payload.code;
      else if (isRecord(payload.error) && typeof payload.error.code === "string") remoteCode = payload.error.code;
    }
  } catch { /* The status itself is sufficient for the caller. */ }
  if (response.status === 401 || response.status === 403) {
    return new AiServiceError("AI_UPSTREAM_UNAUTHORIZED", "The AI service rejected the configured API key.", 502);
  }
  if (response.status === 408 || response.status === 504) {
    return new AiServiceError("AI_UPSTREAM_TIMEOUT", "The AI service timed out.", 504);
  }
  return new AiServiceError(
    remoteCode || "AI_UPSTREAM_ERROR",
    "The AI service rejected the request.",
    response.status >= 400 && response.status < 500 ? 502 : 503
  );
}

async function readJsonLimited(response: Response): Promise<unknown> {
  if (!response.body) throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI service returned an empty response.", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > 256 * 1024) {
        try { await reader.cancel(); } catch { /* The response is already invalid. */ }
        throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI response is too large.", 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(text); }
  catch { throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI service returned malformed JSON.", 502); }
}

function parseJsonResult(payload: unknown, requestId: string): ParsedAiResult {
  if (!isRecord(payload)
    || payload.protocolVersion !== AI_PROTOCOL_VERSION
    || payload.requestId !== requestId
    || typeof payload.resultText !== "string") {
    throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI service returned an invalid result.", 502);
  }
  enforceResultText(payload.resultText);
  return { resultText: payload.resultText };
}

function isAiStreamEvent(value: unknown): value is AiStreamEvent {
  if (!isRecord(value) || value.protocolVersion !== AI_PROTOCOL_VERSION || typeof value.requestId !== "string") return false;
  if (value.type === "status") return value.phase === "preparing" || value.phase === "generating";
  if (value.type === "delta") return typeof value.text === "string";
  if (value.type === "done") return typeof value.resultText === "string";
  return value.type === "error" && typeof value.code === "string" && typeof value.message === "string";
}

function enforceOutputLimit(value: string): void {
  if (Buffer.byteLength(value, "utf8") > AI_PROTOCOL_LIMITS.DEFAULT_MAX_OUTPUT_BYTES) {
    throw new AiServiceError("AI_OUTPUT_TOO_LARGE", "The AI result is too large.", 502);
  }
}

function enforceResultText(value: string): void {
  enforceOutputLimit(value);
  if (!value.trim()) {
    throw new AiServiceError("AI_UPSTREAM_INVALID_RESPONSE", "The AI service returned an empty result.", 502);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
