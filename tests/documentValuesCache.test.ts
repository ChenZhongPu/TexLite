import { syntaxTree } from "@codemirror/language";
import { EditorState, StateEffect } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { bibtexLanguage } from "../src/client/bibtex";
import { collectDocumentValues } from "../src/client/bibtex/documentValues";

describe("BibTeX document value cache", () => {
  it("reuses values for an unchanged CodeMirror document and refreshes after edits", () => {
    const state = EditorState.create({
      doc: "@article{first, author = {Ada Lovelace}, journal = {Examples}}\n",
      extensions: [bibtexLanguage]
    });
    const first = collectDocumentValues(state);
    const selectionOnly = state.update({ selection: { anchor: 0 } }).state;

    // Completion requests frequently create a new EditorState only to move a
    // selection or update the popup. The immutable document and syntax tree
    // are unchanged, so reuse the original tree walk.
    expect(selectionOnly.doc).toBe(state.doc);
    expect(syntaxTree(selectionOnly)).toBe(syntaxTree(state));
    expect(collectDocumentValues(selectionOnly)).toBe(first);

    // A reconfiguration can replace the syntax tree while retaining the same
    // immutable document. The cache must not return values built for the old
    // parser tree in that case.
    const withoutLanguage = state.update({ effects: StateEffect.reconfigure.of([]) }).state;
    expect(withoutLanguage.doc).toBe(state.doc);
    expect(syntaxTree(withoutLanguage)).not.toBe(syntaxTree(state));
    expect(collectDocumentValues(withoutLanguage)).not.toBe(first);
    expect(collectDocumentValues(withoutLanguage).keys).toEqual(new Set());

    const edited = state.update({
      changes: { from: state.doc.length, insert: "@article{second, author = {Grace Hopper}}" }
    }).state;
    const refreshed = collectDocumentValues(edited);
    expect(refreshed).not.toBe(first);
    expect(refreshed.authors).toEqual(new Set(["Ada Lovelace", "Grace Hopper"]));
  });
});
