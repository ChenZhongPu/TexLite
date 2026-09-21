import { ApiError, api, localizedResponseError, responseErrorCode } from "./api";
import { appPath } from "./basePath";
import i18n from "./i18n";
import { AI_PROTOCOL_VERSION } from "../shared/aiProtocol";

export interface AiTaskRequest {
  projectId: string;
  requestId: string;
  targetFilePath: string;
  operation: "insert" | "replace";
  startOffset: number;
  endOffset: number;
  includeCurrentFile: boolean;
  contextFiles: string[];
  promptId?: string;
  taskDescription: string;
  signal?: AbortSignal;
}

export type AiClientEvent =
  | { type: "status"; phase: "preparing" | "generating" }
  | { type: "delta"; text: string }
  | { type: "done"; resultText: string };

export class AiClientError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 502) {
    super(message);
    this.name = "AiClientError";
  }
}

export async function streamAiTask(request: AiTaskRequest, onEvent: (event: AiClientEvent) => void): Promise<void> {
  let response: Response;
  try {
    response = await fetch(appPath("/api/projects/" + encodeURIComponent(request.projectId) + "/ai/tasks"), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "Accept-Language": i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en"
      },
      body: JSON.stringify({
        requestId: request.requestId,
        targetFilePath: request.targetFilePath,
        operation: request.operation,
        startOffset: request.startOffset,
        endOffset: request.endOffset,
        includeCurrentFile: request.includeCurrentFile,
        contextFiles: request.contextFiles,
        ...(request.promptId ? { promptId: request.promptId } : {}),
        taskDescription: request.taskDescription
      }),
      signal: request.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new AiClientError(i18n.t("network.requestFailed"), "NETWORK_ERROR", 0);
  }
  if (!response.ok) {
    let payload: unknown = null;
    try { payload = await response.json(); } catch { /* Use the localized status fallback. */ }
    throw new ApiError(localizedResponseError(payload, response.status), response.status, responseErrorCode(payload));
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new AiClientError(i18n.t("ai.invalidResponse"), "AI_UPSTREAM_INVALID_RESPONSE", 502);
  }
  if (!response.body) throw new AiClientError(i18n.t("ai.invalidResponse"), "AI_UPSTREAM_INVALID_RESPONSE", 502);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) return;
    let payload: unknown;
    try { payload = JSON.parse(trimmed.slice(5).trim()); }
    catch { throw new AiClientError(i18n.t("ai.invalidResponse"), "AI_UPSTREAM_INVALID_RESPONSE", 502); }
    if (!isRecord(payload)
      || payload.protocolVersion !== AI_PROTOCOL_VERSION
      || payload.requestId !== request.requestId
      || typeof payload.type !== "string") {
      throw new AiClientError(i18n.t("ai.invalidResponse"), "AI_UPSTREAM_INVALID_RESPONSE", 502);
    }
    if (completed && payload.type !== "terminal") {
      throw new AiClientError(i18n.t("ai.invalidResponse"), "AI_UPSTREAM_INVALID_RESPONSE", 502);
    }
    if (payload.type === "status" && (payload.phase === "preparing" || payload.phase === "generating")) {
      onEvent({ type: "status", phase: payload.phase });
    } else if (payload.type === "delta" && typeof payload.text === "string") {
      onEvent({ type: "delta", text: payload.text });
    } else if (payload.type === "done" && typeof payload.resultText === "string") {
      completed = true;
      onEvent({ type: "done", resultText: payload.resultText });
    } else if (payload.type === "terminal") {
      if (payload.status === "ready" || payload.status === "completed") {
        if (!completed) throw new AiClientError(i18n.t("ai.invalidResponse"), "AI_UPSTREAM_INVALID_RESPONSE", 502);
        return;
      }
      if (completed) throw new AiClientError(i18n.t("ai.invalidResponse"), "AI_UPSTREAM_INVALID_RESPONSE", 502);
      const code = typeof payload.code === "string" ? payload.code : "AI_TASK_FAILED";
      const message = localizedAiError(code, typeof payload.message === "string" ? payload.message : i18n.t("ai.failed"));
      throw new AiClientError(message, code, payload.status === "conflict" ? 409 : 502);
    } else {
      throw new AiClientError(i18n.t("ai.invalidResponse"), "AI_UPSTREAM_INVALID_RESPONSE", 502);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
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
    reader.releaseLock();
  }
  if (!completed) throw new AiClientError(i18n.t("ai.incomplete"), "AI_INCOMPLETE", 502);
}

export async function confirmAiTask(projectId: string, requestId: string, signal?: AbortSignal): Promise<{ applied: boolean; resultText: string }> {
  return api<{ applied: boolean; resultText: string }>(
    "/api/projects/" + encodeURIComponent(projectId) + "/ai/tasks/" + encodeURIComponent(requestId) + "/confirm",
    { method: "POST", signal }
  );
}

export async function cancelAiTask(projectId: string, requestId: string): Promise<boolean> {
  const result = await api<{ cancelled: boolean }>(
    "/api/projects/" + encodeURIComponent(projectId) + "/ai/tasks/" + encodeURIComponent(requestId) + "/cancel",
    { method: "POST" }
  );
  return result.cancelled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localizedAiError(code: string, fallback: string): string {
  const keys: Record<string, string> = {
    AI_UPSTREAM_TIMEOUT: "ai.timeout",
    AI_UPSTREAM_UNAVAILABLE: "ai.unavailable",
    AI_UPSTREAM_ERROR: "ai.failed",
    AI_UPSTREAM_INVALID_RESPONSE: "ai.invalidResponse",
    AI_UPSTREAM_UNAUTHORIZED: "ai.unauthorized",
    AI_OUTPUT_TOO_LARGE: "ai.invalidResponse",
    AI_CONTEXT_FILES_INVALID: "ai.contextFilesInvalid",
    AI_CONTEXT_TOO_LARGE: "ai.contextTooLarge",
    AI_TARGET_CONFLICT: "ai.targetChanged",
    AI_TASK_NOT_FOUND: "ai.previewExpired",
    AI_PERMISSION_REVOKED: "ai.permissionRevoked",
    AI_AUTH_REVOKED: "ai.authRevoked",
    AI_SOURCE_SAVE_FAILED: "ai.sourceSaveFailed",
    AI_TASK_CANCELLED: "ai.cancelled",
    AI_INTERNAL_ERROR: "ai.failed"
  };
  return keys[code] ? i18n.t(keys[code]) : fallback;
}
