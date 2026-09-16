import { describe, expect, it } from "vitest";
import { workspaceOutlineForMainFile } from "../src/client/workspace/outlineState";

describe("workspace outline scope", () => {
  it("keeps an authoritative main-document outline when another file is active", () => {
    const outline = workspaceOutlineForMainFile(
      { mainFile: "main.tex", items: [{ path: "main.tex", line: 3, level: 1, title: "Main" }] },
      "main.tex",
      { filePath: "chapter.tex", content: "\\section{Included chapter}" }
    );

    expect(outline).toEqual([{ path: "main.tex", line: 3, level: 1, title: "Main" }]);
  });

  it("does not replace an authoritative empty main outline with the active file", () => {
    const outline = workspaceOutlineForMainFile(
      { mainFile: "main.tex", items: [] },
      "main.tex",
      { filePath: "notes.tex", content: "\\section{Notes}" }
    );

    expect(outline).toEqual([]);
  });

  it("uses a local fallback only while the current main file is awaiting its outline", () => {
    const outline = workspaceOutlineForMainFile(
      { mainFile: "other.tex", items: [{ path: "other.tex", line: 1, level: 1, title: "Old" }] },
      "main.tex",
      { filePath: "main.tex", content: "\\section{Current root}\n\\subsection{Detail}" }
    );

    expect(outline).toEqual([
      { path: "main.tex", line: 1, level: 1, title: "Current root" },
      { path: "main.tex", line: 2, level: 2, title: "Detail" }
    ]);
  });
});
