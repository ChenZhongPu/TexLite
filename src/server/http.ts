import { serverErrorMessage, serverLocale, type ServerErrorCode } from "./i18n.js";

const POSTGRES_UNIQUE_CONSTRAINT_CODES: Record<string, ServerErrorCode> = {
  users_username_ci_unique: "USERNAME_ALREADY_IN_USE",
  users_email_ci_unique: "EMAIL_ALREADY_IN_USE",
  auth_identities_issuer_subject_unique: "OAUTH_IDENTITY_ALREADY_LINKED",
  project_invitations_pending_recipient_unique: "INVITATION_ALREADY_PENDING",
  project_invitations_pending_email_unique: "INVITATION_ALREADY_PENDING",
  project_members_pkey: "INVITATION_MEMBER_EXISTS",
  tags_name_ci_unique: "TAG_NAME_EXISTS",
  user_tags_user_name_ci_unique: "TAG_NAME_EXISTS",
  citation_library_entries_user_key_ci_unique: "CITATION_KEY_EXISTS"
};

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ServerErrorCode,
    readonly details: Record<string, unknown> = {}
  ) {
    // Keep a useful, locale-neutral message for internal callers and logs.
    // HTTP responses are still rendered using the request's actual locale.
    super(serverErrorMessage("en", code, details));
    this.name = "HttpError";
  }
}

/**
 * Create a user-correctable error without putting a locale-specific string in
 * service or route code. `apiError` resolves the code using the request locale.
 */
export function httpError(
  statusCode: number,
  code: ServerErrorCode,
  details: Record<string, unknown> = {}
): HttpError {
  return new HttpError(statusCode, code, details);
}

export class ValidationError extends HttpError {
  constructor(code: ServerErrorCode = "REQUEST_INVALID", details: Record<string, unknown> = {}) {
    super(400, code, details);
    this.name = "ValidationError";
  }
}

/** Convert PostgreSQL integrity and retryable-transaction failures into API errors. */
export function postgresConflictCode(error: unknown): ServerErrorCode | null {
  const databaseError = postgresErrorDetails(error);
  if (!databaseError) return null;
  const { code, constraint } = databaseError;
  if (code === "23505") {
    return POSTGRES_UNIQUE_CONSTRAINT_CODES[constraint] ?? "CONFLICT";
  }
  // Foreign-key races and serializable retries are expected conflict classes
  // at an HTTP boundary, never internal-server failures for the caller.
  return code === "23503" || code === "40001" ? "CONFLICT" : null;
}

/**
 * Drizzle wraps node-postgres errors in DrizzleQueryError and preserves the
 * PostgreSQL fields on `cause`. Inspect a short, cycle-safe cause chain so
 * the HTTP boundary sees the actual SQLSTATE rather than only the wrapper.
 */
function postgresErrorDetails(error: unknown): { code: string; constraint: string } | null {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return null;
    seen.add(current);
    const record = current as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : null;
    if (code) return { code, constraint: typeof record.constraint === "string" ? record.constraint : "" };
    current = record.cause;
  }
  return null;
}

/**
 * A collaborative draft could not be made durable on disk.  Mutations that
 * replace or remove source files must stop at this boundary instead of
 * continuing with a stale filesystem snapshot.
 */
export class SourceFlushError extends HttpError {
  readonly failedPaths: string[];

  constructor(failedPaths: readonly string[] = []) {
    const paths = [...new Set(failedPaths)].slice(0, 100);
    super(409, "SOURCE_FLUSH_FAILED", { failedPaths: paths });
    this.name = "SourceFlushError";
    this.failedPaths = paths;
  }
}

export function apiError(
  reply: {
    code: (status: number) => { send: (payload: unknown) => unknown };
    request?: { headers?: Record<string, string | string[] | undefined> };
  },
  status: number,
  code: string,
  details: Record<string, unknown> = {}
): unknown {
  return reply.code(status).send({
    code,
    error: serverErrorMessage(serverLocale(reply.request?.headers), code, details),
    ...details
  });
}

export function contentDisposition(filename: string, mode: "inline" | "attachment"): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
