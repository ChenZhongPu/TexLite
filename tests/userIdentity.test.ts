import { describe, expect, it } from "vitest";
import {
  isAllowedProfileUsername,
  isValidNuwaxUsername,
  isValidUsername
} from "../src/server/routes/auth.js";

describe("username policy", () => {
  it("requires five characters for manually chosen usernames", () => {
    expect(isValidUsername("abcd")).toBe(false);
    expect(isValidUsername("abcde")).toBe(true);
    expect(isValidUsername("a.b-c_d")).toBe(true);
    expect(isValidUsername("bad name")).toBe(false);
    expect(isValidUsername("a".repeat(51))).toBe(false);
  });

  it("allows short Nuwax usernames only when they are retained", () => {
    expect(isValidNuwaxUsername("abc")).toBe(true);
    expect(isAllowedProfileUsername("abc", "abc", "nuwax-subject")).toBe(true);
    expect(isAllowedProfileUsername("abcd", "abc", "nuwax-subject")).toBe(false);
    expect(isAllowedProfileUsername("abc", "abc", null)).toBe(false);
    expect(isAllowedProfileUsername("abc", "abcd", "nuwax-subject")).toBe(false);
  });
});
