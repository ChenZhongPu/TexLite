import { describe, expect, it } from "vitest";
import { hasCjkLanguageSupport } from "../src/shared/aiLanguage";
import { AI_PROTOCOL_LIMITS } from "../src/shared/aiProtocol";

describe("AI language capability detection", () => {
  it("uses only a total context-file byte limit", () => {
    expect(AI_PROTOCOL_LIMITS.MAX_CONTEXT_FILES_TOTAL_BYTES).toBe(1024 * 1024);
    expect("MAX_CONTEXT_FILES" in AI_PROTOCOL_LIMITS).toBe(false);
    expect("MAX_CONTEXT_FILE_BYTES" in AI_PROTOCOL_LIMITS).toBe(false);
  });

  it.each([
    "\\documentclass{ctexart}",
    "\\documentclass[UTF8]{ctexrep}",
    "\\usepackage[UTF8]{ctex}",
    "\\RequirePackage{xeCJK}",
    "\\usepackage{amsmath, xeCJK}",
    "\\setCJKmainfont{Noto Sans CJK SC}"
  ])("detects CJK support in %s", (source) => {
    expect(hasCjkLanguageSupport(source)).toBe(true);
  });

  it("ignores commented declarations and ordinary CJK text", () => {
    expect(hasCjkLanguageSupport("% \\usepackage{ctex}\n本文包含中文，但没有 CJK 包。")).toBe(false);
  });

  it("does not treat an unrelated document class as CJK support", () => {
    expect(hasCjkLanguageSupport("\\documentclass{article}\n\\usepackage{amsmath}")).toBe(false);
  });
});
