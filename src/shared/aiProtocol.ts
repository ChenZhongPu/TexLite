/**
 * Protocol shared by TexLite and the configured AI service.
 *
 * Prompt templates deliberately do not live here: the AI service owns prompt
 * selection and wording. TexLite sends the target context and optional,
 * read-only project files.
 */
export const AI_PROTOCOL_VERSION = 2 as const;

export const AI_MIME_TYPES = {
  JSON: "application/json",
  NDJSON: "application/x-ndjson"
} as const;

export const AI_ERROR_CODES = {
  UNSUPPORTED_TASK_TYPE: "AI_UNSUPPORTED_TASK_TYPE",
  INVALID_OPERATION: "AI_INVALID_OPERATION",
  INVALID_CONTEXT: "AI_INVALID_CONTEXT",
  CONTEXT_TOO_LARGE: "AI_CONTEXT_TOO_LARGE",
  INVALID_REQUEST: "AI_INVALID_REQUEST",
  LANGUAGE_INVALID: "AI_LANGUAGE_INVALID",
  UNAUTHORIZED: "AI_UNAUTHORIZED",
  NOT_ACCEPTABLE: "AI_NOT_ACCEPTABLE",
  UPSTREAM_ERROR: "AI_UPSTREAM_ERROR",
  STREAM_ERROR: "AI_STREAM_ERROR",
  INTERNAL_ERROR: "AI_INTERNAL_ERROR"
} as const;

export type AiErrorCode = typeof AI_ERROR_CODES[keyof typeof AI_ERROR_CODES];

export const AI_PROTOCOL_LIMITS = {
  DEFAULT_MAX_OUTPUT_BYTES: 32 * 1024,
  MAX_SERVER_OUTPUT_BYTES: 64 * 1024,
  MAX_CONTEXT_BEFORE_BYTES: 64 * 1024,
  MAX_CONTEXT_SELECTED_BYTES: 32 * 1024,
  MAX_CONTEXT_AFTER_BYTES: 32 * 1024,
  MAX_CONTEXT_TOTAL_BYTES: 128 * 1024,
  MAX_CONTEXT_FILES_TOTAL_BYTES: 1024 * 1024
} as const;

export type AiOperation = "insert" | "replace";
export type AiLanguage = "en" | "any";

/** Only these project files may be sent as additional AI context. */
export function isAiContextFilePath(filePath: string): boolean {
  return /\.(?:tex|bib)$/i.test(filePath);
}

export interface AiRequestActor {
  userId: string;
  username: string;
  /** Stable Nuwax `sub`, when the account was authenticated by Nuwax. */
  nuwaxSubject?: string;
}

export interface AiTargetContext {
  filePath: string;
  before: string;
  selectedText: string;
  after: string;
}

export interface AiContextFile {
  filePath: string;
  content: string;
}

export interface AiGenerateRequest {
  protocolVersion: typeof AI_PROTOCOL_VERSION;
  requestId: string;
  actor: AiRequestActor;
  projectId: string;
  taskType: "writing";
  operation: AiOperation;
  lang: AiLanguage;
  target: AiTargetContext;
  contextFiles: AiContextFile[];
  promptId?: string;
  taskDescription: string;
  limits: {
    maxOutputBytes: number;
  };
}

export interface AiStatusEvent {
  protocolVersion: typeof AI_PROTOCOL_VERSION;
  requestId: string;
  type: "status";
  phase: "preparing" | "generating";
}

export interface AiDeltaEvent {
  protocolVersion: typeof AI_PROTOCOL_VERSION;
  requestId: string;
  type: "delta";
  text: string;
}

export interface AiDoneEvent {
  protocolVersion: typeof AI_PROTOCOL_VERSION;
  requestId: string;
  type: "done";
  resultText: string;
}

export interface AiErrorEvent {
  protocolVersion: typeof AI_PROTOCOL_VERSION;
  requestId: string;
  type: "error";
  code: string;
  message: string;
}

export type AiStreamEvent = AiStatusEvent | AiDeltaEvent | AiDoneEvent | AiErrorEvent;

export interface AiJsonResponse {
  protocolVersion: typeof AI_PROTOCOL_VERSION;
  requestId: string;
  resultText: string;
}
