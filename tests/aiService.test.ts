import { describe, expect, it, vi } from "vitest";
import { AiTaskService } from "../src/server/aiService.js";
import type { AiTargetSnapshot } from "../src/server/collaboration.js";
import type { Config } from "../src/server/config.js";
import type { DatabaseConnection, UserRow } from "../src/server/db.js";

const user = {
  id: "user-1", username: "nuwax-user", display_name: "Nuwax User", password_hash: "",
  email: null, nuwax_subject: "nuwax-sub-1", avatar_url: null, role: "user", disabled: 0,
  must_change_password: 0, can_create_projects: 1, created_at: new Date().toISOString()
} as UserRow;

function fixtureSnapshot(): AiTargetSnapshot {
  return {
    projectId: "project-1", filePath: "main.tex", roomInstanceId: "room-1", roomEpoch: "1:epoch",
    operation: "replace", startPosition: new Uint8Array([1]), endPosition: new Uint8Array([2]),
    selectedText: "old", guardBefore: "before ", guardAfter: " after",
    contextBefore: "before ", contextAfter: " after"
  };
}

function service(fetchImpl: typeof fetch, mainDocument = "context from main.tex") {
  const collaboration = {
    captureAiTarget: vi.fn(() => fixtureSnapshot()),
    captureAiContextFiles: vi.fn((_: string, paths: readonly string[]) => paths.map((filePath) => ({
      filePath, content: filePath === "main.tex" ? mainDocument : "context from " + filePath
    }))),
    applyAiResult: vi.fn(async () => ({ status: "applied", receipt: { revision: 1, persistedAt: "now", ok: true } }))
  };
  const db = {
    identity: {
      findUserById: async () => user,
      sessionIsActive: async () => true
    },
    projects: {
      findCollaborationAccess: async () => ({ permission: "owner" as const }),
      findById: async () => ({ main_file: "main.tex" })
    }
  } as unknown as DatabaseConnection;
  const config = { ai: { baseUrl: "http://127.0.0.1:4010", apiKey: "test-key-from-local" } } as Config;
  const taskService = new AiTaskService(config, db, collaboration as never, fetchImpl);
  return { taskService, collaboration };
}

function input() {
  return {
    requestId: "request-1", projectId: "project-1", targetFilePath: "main.tex", operation: "replace" as const,
    startOffset: 7, endOffset: 10, includeCurrentFile: false, lang: "en" as const, contextFiles: ["refs.bib"], promptId: "polish",
    taskDescription: "Polish this text.", user
  };
}

describe("AI task service", () => {
  it("sends v2 target/context data and keeps a complete result pending confirmation", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        protocolVersion: number;
        lang?: string;
        actor?: { userId?: string; nuwaxSubject?: string };
        target?: { filePath?: string; before?: string; after?: string };
        contextFiles?: Array<{ filePath: string; content: string }>;
      };
      expect(payload.protocolVersion).toBe(2);
      expect(payload.lang).toBe("en");
      expect(payload.actor).toMatchObject({ userId: "user-1", nuwaxSubject: "nuwax-sub-1" });
      expect(payload.target?.filePath).toBe("main.tex");
      expect(payload.target?.before).toBe("");
      expect(payload.target?.after).toBe("");
      expect(payload.contextFiles).toEqual([{ filePath: "refs.bib", content: "context from refs.bib" }]);
      const lines = [
        { protocolVersion: 2, requestId: "request-1", type: "status", phase: "preparing" },
        { protocolVersion: 2, requestId: "request-1", type: "status", phase: "generating" },
        { protocolVersion: 2, requestId: "request-1", type: "delta", text: "new" },
        { protocolVersion: 2, requestId: "request-1", type: "done", resultText: "new" }
      ].map((event) => JSON.stringify(event)).join("\n");
      return new Response(lines + "\n", { headers: { "content-type": "application/x-ndjson" } });
    };
    const { taskService, collaboration } = service(fetchImpl);
    const events: string[] = [];
    const result = await taskService.run(input(), new AbortController().signal, (event) => events.push(event.type));
    expect(result).toEqual({ resultText: "new", applied: false });
    expect(events).toEqual(["status", "status", "delta"]);
    expect(collaboration.applyAiResult).not.toHaveBeenCalled();

    const confirmed = await taskService.confirm("project-1", "request-1", "user-1", undefined);
    expect(confirmed).toEqual({ resultText: "new", applied: true });
    expect(collaboration.applyAiResult).toHaveBeenCalledWith(expect.anything(), "new", "user-1", undefined, undefined);
  });

  it("rejects a mismatched streamed final result without keeping an applicable result", async () => {
    const fetchImpl: typeof fetch = async () => new Response([
      JSON.stringify({ protocolVersion: 2, requestId: "request-1", type: "delta", text: "partial" }),
      JSON.stringify({ protocolVersion: 2, requestId: "request-1", type: "done", resultText: "different" })
    ].join("\n"), { headers: { "content-type": "application/x-ndjson" } });
    const { taskService, collaboration } = service(fetchImpl);
    await expect(taskService.run(input(), new AbortController().signal, () => undefined)).rejects.toMatchObject({
      code: "AI_UPSTREAM_INVALID_RESPONSE"
    });
    expect(collaboration.applyAiResult).not.toHaveBeenCalled();
  });

  it("sends current-file context only after explicit selection", async () => {
    const targets: Array<{ before?: string; after?: string }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { requestId: string; target?: { before?: string; after?: string } };
      targets.push({ before: payload.target?.before, after: payload.target?.after });
      const lines = [
        { protocolVersion: 2, requestId: payload.requestId, type: "delta", text: "new" },
        { protocolVersion: 2, requestId: payload.requestId, type: "done", resultText: "new" }
      ]
        .map((event) => JSON.stringify(event)).join("\n");
      return new Response(lines + "\n", { headers: { "content-type": "application/x-ndjson" } });
    };
    const { taskService } = service(fetchImpl);
    await taskService.run({ ...input(), requestId: "without-context" }, new AbortController().signal, () => undefined);
    await taskService.run({ ...input(), requestId: "with-context", includeCurrentFile: true }, new AbortController().signal, () => undefined);
    expect(targets).toEqual([
      { before: "", after: "" },
      { before: "before ", after: " after" }
    ]);
  });

  it("normalizes unrestricted output to English when the main document has no CJK support", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { requestId: string; lang?: string };
      expect(payload.lang).toBe("en");
      const lines = [
        { protocolVersion: 2, requestId: payload.requestId, type: "delta", text: "new" },
        { protocolVersion: 2, requestId: payload.requestId, type: "done", resultText: "new" }
      ].map((event) => JSON.stringify(event)).join("\n");
      return new Response(lines + "\n", { headers: { "content-type": "application/x-ndjson" } });
    };
    const { taskService } = service(fetchImpl);
    await taskService.run({ ...input(), requestId: "language-default", lang: "any" }, new AbortController().signal, () => undefined);
  });

  it("keeps unrestricted output when the main document declares CJK support", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { requestId: string; lang?: string };
      expect(payload.lang).toBe("any");
      const lines = [
        { protocolVersion: 2, requestId: payload.requestId, type: "delta", text: "new" },
        { protocolVersion: 2, requestId: payload.requestId, type: "done", resultText: "new" }
      ].map((event) => JSON.stringify(event)).join("\n");
      return new Response(lines + "\n", { headers: { "content-type": "application/x-ndjson" } });
    };
    const { taskService } = service(fetchImpl, "\\documentclass{ctexart}");
    await taskService.run({ ...input(), requestId: "language-cjk", lang: "any" }, new AbortController().signal, () => undefined);
  });

  it("rejects malformed upstream JSON and does not write a partial result", async () => {
    const fetchImpl: typeof fetch = async () => new Response("{not-json", {
      headers: { "content-type": "application/json" }
    });
    const { taskService, collaboration } = service(fetchImpl);
    await expect(taskService.run(input(), new AbortController().signal, () => undefined)).rejects.toMatchObject({
      code: "AI_UPSTREAM_INVALID_RESPONSE"
    });
    expect(collaboration.applyAiResult).not.toHaveBeenCalled();
  });

  it("maps an unreachable upstream service to a safe availability error", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const { taskService, collaboration } = service(fetchImpl);
    await expect(taskService.run(input(), new AbortController().signal, () => undefined)).rejects.toMatchObject({
      code: "AI_UPSTREAM_UNAVAILABLE"
    });
    expect(collaboration.applyAiResult).not.toHaveBeenCalled();
  });

  it("rejects non-TeX context files before contacting the AI service", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { taskService, collaboration } = service(fetchImpl);
    await expect(taskService.run({ ...input(), contextFiles: ["figures/plot.png"] }, new AbortController().signal, () => undefined)).rejects.toMatchObject({
      code: "AI_CONTEXT_FILES_INVALID",
      statusCode: 400
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(collaboration.captureAiContextFiles).not.toHaveBeenCalled();
  });
});
