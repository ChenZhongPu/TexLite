import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import type { Config } from "../config.js";
import type { DatabaseConnection } from "../db.js";
import { AiServiceError, AiTaskCancelledError, AiTaskService } from "../aiService.js";
import { apiError } from "../http.js";
import { requireEditableProject } from "./projectShared.js";
import { safeRelativePath } from "../files.js";
import { AI_PROTOCOL_VERSION, isAiContextFilePath } from "../../shared/aiProtocol.js";

interface ProjectAiRouteContext {
  config: Config;
  db: DatabaseConnection;
  ai: AiTaskService;
}

/** Register ephemeral, live-room AI writing tasks. */
export function registerProjectAiRoutes(app: FastifyInstance, context: ProjectAiRouteContext): void {
  const { config, db, ai } = context;

  app.post("/api/projects/:id/ai/tasks", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    if (!config.ai) return apiError(reply, 404, "AI_NOT_CONFIGURED");
    const { id: projectId } = request.params as { id: string };
    await requireEditableProject(db, projectId, user);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const operation = body.operation;
    if (operation !== "insert" && operation !== "replace") return apiError(reply, 400, "AI_REQUEST_INVALID");
    const lang = body.lang;
    if (lang !== "en" && lang !== "any") return apiError(reply, 400, "AI_LANGUAGE_INVALID");
    const filePathValue = body.targetFilePath;
    if (typeof filePathValue !== "string") return apiError(reply, 400, "AI_REQUEST_INVALID");
    let filePath: string;
    try { filePath = safeRelativePath(filePathValue); }
    catch { return apiError(reply, 400, "AI_REQUEST_INVALID"); }
    const startOffset = body.startOffset;
    const endOffset = body.endOffset;
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)
      || (startOffset as number) < 0 || (endOffset as number) < (startOffset as number)) {
      return apiError(reply, 400, "AI_REQUEST_INVALID");
    }
    if ((operation === "insert" && startOffset !== endOffset)
      || (operation === "replace" && startOffset === endOffset)) {
      return apiError(reply, 400, "AI_REQUEST_INVALID");
    }
    const rawIncludeCurrentFile = body.includeCurrentFile;
    if (rawIncludeCurrentFile !== undefined && typeof rawIncludeCurrentFile !== "boolean") {
      return apiError(reply, 400, "AI_REQUEST_INVALID");
    }
    const includeCurrentFile = rawIncludeCurrentFile === undefined ? false : rawIncludeCurrentFile;
    const rawContextFiles = body.contextFiles === undefined ? [] : body.contextFiles;
    if (!Array.isArray(rawContextFiles)) return apiError(reply, 400, "AI_CONTEXT_FILES_INVALID");
    const contextFiles: string[] = [];
    const seenContextFiles = new Set<string>();
    for (const value of rawContextFiles) {
      if (typeof value !== "string") return apiError(reply, 400, "AI_CONTEXT_FILES_INVALID");
      let contextPath: string;
      try { contextPath = safeRelativePath(value); }
      catch { return apiError(reply, 400, "AI_CONTEXT_FILES_INVALID"); }
      if (!isAiContextFilePath(contextPath) || contextPath === filePath || seenContextFiles.has(contextPath)) {
        return apiError(reply, 400, "AI_CONTEXT_FILES_INVALID");
      }
      seenContextFiles.add(contextPath);
      contextFiles.push(contextPath);
    }
    const taskDescription = typeof body.taskDescription === "string" ? body.taskDescription.trim() : "";
    if (!taskDescription || taskDescription.length > 2_000) return apiError(reply, 400, "AI_REQUEST_INVALID");
    const promptId = body.promptId === undefined ? undefined : body.promptId;
    if (promptId !== undefined && (typeof promptId !== "string" || promptId.length > 128)) {
      return apiError(reply, 400, "AI_REQUEST_INVALID");
    }
    const requestId = typeof body.requestId === "string" && body.requestId.trim()
      ? body.requestId.trim() : randomUUID();
    if (requestId.length > 128) return apiError(reply, 400, "AI_REQUEST_INVALID");

    const controller = new AbortController();
    let finished = false;
    const abort = (): void => {
      if (!finished) controller.abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const send = (payload: Record<string, unknown>): void => {
      if (finished || reply.raw.destroyed) return;
      try {
        reply.raw.write(`data: ${JSON.stringify({ protocolVersion: AI_PROTOCOL_VERSION, requestId, ...payload })}\n\n`);
      } catch {
        controller.abort();
      }
    };
    try {
      const result = await ai.run({
        requestId,
        projectId,
        targetFilePath: filePath,
        operation,
        lang,
        startOffset: startOffset as number,
        endOffset: endOffset as number,
        includeCurrentFile,
        contextFiles,
        ...(promptId ? { promptId } : {}),
        taskDescription,
        user
      }, controller.signal, (event) => send(event));
      send({ type: "done", resultText: result.resultText, applied: false });
      send({ type: "terminal", status: "ready", applied: false });
    } catch (error) {
      if (!controller.signal.aborted || error instanceof AiTaskCancelledError) {
        const normalized = normalizeAiError(error);
        send({ type: "terminal", status: normalized.status, code: normalized.code, message: normalized.message });
      }
    } finally {
      finished = true;
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  app.post("/api/projects/:id/ai/tasks/:requestId/cancel", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id: projectId, requestId } = request.params as { id: string; requestId: string };
    // Cancellation is intentionally allowed after edit permission is revoked:
    // it only aborts this user's own in-memory task and avoids keeping an
    // upstream request alive until the global timeout.
    return { cancelled: ai.cancel(projectId, requestId, user.id) };
  });

  app.post("/api/projects/:id/ai/tasks/:requestId/confirm", async (request, reply) => {
    const user = await requireUser(request, reply, db);
    if (!user) return;
    const { id: projectId, requestId } = request.params as { id: string; requestId: string };
    const controller = new AbortController();
    let finished = false;
    const abort = (): void => {
      if (!finished) controller.abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      const result = await ai.confirm(projectId, requestId, user.id, user.session_id, controller.signal);
      return { applied: result.applied, resultText: result.resultText };
    } catch (error) {
      const normalized = normalizeAiError(error);
      return apiError(reply, normalized.status === "conflict" ? 409 : error instanceof AiServiceError ? error.statusCode : 502, normalized.code);
    } finally {
      finished = true;
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abort);
    }
  });
}

function normalizeAiError(error: unknown): { status: "failed" | "conflict" | "cancelled"; code: string; message: string } {
  if (error instanceof AiTaskCancelledError) return { status: "cancelled", code: error.code, message: "AI task cancelled." };
  if (error instanceof AiServiceError) {
    return {
      status: error.code === "AI_TARGET_CONFLICT" ? "conflict" : "failed",
      code: error.code,
      message: error.message
    };
  }
  return { status: "failed", code: "AI_INTERNAL_ERROR", message: "The AI task could not be completed." };
}
