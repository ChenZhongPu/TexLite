import { describe, expect, it } from "vitest";
import { postgresConflictCode } from "../src/server/http.js";

describe("PostgreSQL conflict mapping", () => {
  it("preserves user-facing conflict codes for known unique constraints", () => {
    expect(postgresConflictCode({ code: "23505", constraint: "users_username_ci_unique" }))
      .toBe("USERNAME_ALREADY_IN_USE");
    expect(postgresConflictCode({ code: "23505", constraint: "project_invitations_pending_recipient_unique" }))
      .toBe("INVITATION_ALREADY_PENDING");
    expect(postgresConflictCode({ cause: { code: "23505", constraint: "users_email_ci_unique" } }))
      .toBe("EMAIL_ALREADY_IN_USE");
  });

  it("returns a safe conflict response for other integrity races", () => {
    expect(postgresConflictCode({ code: "23505", constraint: "unrecognized_constraint" })).toBe("CONFLICT");
    expect(postgresConflictCode({ code: "23503" })).toBe("CONFLICT");
    expect(postgresConflictCode({ code: "40001" })).toBe("CONFLICT");
    expect(postgresConflictCode(new Error("not a database error"))).toBeNull();
  });

  it("does not loop forever on malformed wrapped errors", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(postgresConflictCode(error)).toBeNull();
  });
});
