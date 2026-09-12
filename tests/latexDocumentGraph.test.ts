import { describe, expect, it } from "vitest";
import { documentSourceOrder, latexDocumentDirectives } from "../src/server/latexDocumentGraph.js";

describe("LaTeX document graph", () => {
  it("uses the compiler root for ordinary input outside an import context", () => {
    const sources = new Map([
      ["main.tex", latexDocumentDirectives("\\input{chapters/intro}")],
      ["chapters/intro.tex", latexDocumentDirectives([
        "\\input{method}",
        "\\subimport{nested/}{proof}"
      ].join("\n"))],
      ["method.tex", latexDocumentDirectives("% root-level method")],
      ["chapters/method.tex", latexDocumentDirectives("% should not shadow root input")],
      ["nested/proof.tex", latexDocumentDirectives("% subimport extends the root import base")],
      ["chapters/nested/proof.tex", latexDocumentDirectives("% should not shadow root subimport")]
    ]);

    expect(documentSourceOrder(sources, "main.tex")).toEqual([
      "main.tex",
      "chapters/intro.tex",
      "method.tex",
      "nested/proof.tex"
    ]);
  });

  it("carries import package context through nested inputs and sub-commands", () => {
    const sources = new Map([
      ["main.tex", latexDocumentDirectives("\\import{chapters/}{intro}")],
      ["chapters/intro.tex", latexDocumentDirectives([
        "\\input{method}",
        "\\input{fallback}",
        "\\subimport{nested/}{proof}",
        "\\subinputfrom{tools/}{tool}",
        "\\subincludefrom{appendix/}{appendix}",
        "\\inputfrom{appendices/}{rooted-proof}"
      ].join("\n"))],
      ["method.tex", latexDocumentDirectives("% root-level method should not shadow import path")],
      ["chapters/method.tex", latexDocumentDirectives("% active import path target")],
      ["fallback.tex", latexDocumentDirectives("% input@path misses and falls back to root")],
      ["chapters/nested/proof.tex", latexDocumentDirectives("\\input{detail}")],
      ["chapters/nested/detail.tex", latexDocumentDirectives("% nested import context target")],
      ["chapters/tools/tool.tex", latexDocumentDirectives("% subinputfrom target")],
      ["chapters/appendix/appendix.tex", latexDocumentDirectives("% subincludefrom target")],
      ["appendices/rooted-proof.tex", latexDocumentDirectives("\\input{detail}")],
      ["appendices/detail.tex", latexDocumentDirectives("% inputfrom resets the active import base")]
    ]);

    expect(documentSourceOrder(sources, "main.tex")).toEqual([
      "main.tex",
      "chapters/intro.tex",
      "chapters/method.tex",
      "fallback.tex",
      "chapters/nested/proof.tex",
      "chapters/tools/tool.tex",
      "chapters/appendix/appendix.tex",
      "appendices/rooted-proof.tex",
      "chapters/nested/detail.tex",
      "appendices/detail.tex"
    ]);
  });

  it("treats subfile as a subimport and keeps its directory active", () => {
    const sources = new Map([
      ["main.tex", latexDocumentDirectives("\\subfile{chapters/intro}")],
      ["chapters/intro.tex", latexDocumentDirectives("\\input{method}")],
      ["method.tex", latexDocumentDirectives("% root method should not win")],
      ["chapters/method.tex", latexDocumentDirectives("% subfile context target")]
    ]);

    expect(documentSourceOrder(sources, "main.tex")).toEqual([
      "main.tex",
      "chapters/intro.tex",
      "chapters/method.tex"
    ]);
  });

  it("retains include command semantics in document directives", () => {
    const directives = latexDocumentDirectives([
      "\\input chapter",
      "\\include{appendix}",
      "\\import{sections/}{methods}"
    ].join("\n"));
    expect(directives.includes).toEqual([
      { path: "chapter", command: "input" },
      { path: "appendix", command: "include" },
      { path: "sections/methods", command: "import", directory: "sections/" }
    ]);
  });
});
