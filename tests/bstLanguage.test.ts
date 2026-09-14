import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { bracketMatching, matchBrackets, StringStream } from "@codemirror/language";
import { bstLanguage, bstStream } from "../src/client/bstLanguage";
import { isEditableTextFile } from "../src/client/workspace/useProjectFiles";
import { isCollaborativeTextFile } from "../src/server/collaboration";

function tokenize(source: string): Array<{ text: string; style: string | null }> {
  const state = bstStream.startState!(2);
  const tokens: Array<{ text: string; style: string | null }> = [];
  for (const line of source.split("\n")) {
    const stream = new StringStream(line, 4, 2);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const style = bstStream.token(stream, state);
      tokens.push({ text: line.slice(stream.start, stream.pos), style });
    }
  }
  return tokens;
}

describe("BibTeX style language", () => {
  it("treats .bst files as collaborative editor source on both sides", () => {
    expect(isEditableTextFile("plain.bst")).toBe(true);
    expect(isEditableTextFile("styles/CUSTOM.BST")).toBe(true);
    expect(isCollaborativeTextFile("plain.bst")).toBe(true);
    expect(isCollaborativeTextFile("styles/CUSTOM.BST")).toBe(true);
  });

  it("highlights declarations, standard functions, strings, comments, numbers, and delimiters", () => {
    const tokens = tokenize(String.raw`% A style-file comment
ENTRY { author title } {} {}
FUNCTION {article} {
  author empty$ { skip$ } { author write$ } if$
  #42 'output.check
  "A \LaTeX\ command with % text"
}`);
    const styleFor = (text: string) => tokens.find((token) => token.text === text)?.style;

    expect(styleFor("% A style-file comment")).toBe("comment");
    expect(styleFor("ENTRY")).toBe("keyword");
    expect(styleFor("FUNCTION")).toBe("keyword");
    expect(styleFor("empty$")).toBe("builtin");
    expect(styleFor("skip$")).toBe("builtin");
    expect(styleFor("#42")).toBe("number");
    expect(styleFor("'")).toBe("operator");
    expect(tokens.some((token) => token.text.includes("LaTeX") && token.style === "string")).toBe(true);
    expect(tokens.filter((token) => token.text === "{").every((token) => token.style === "bracket")).toBe(true);
  });

  it("uses BST's line-bound strings and recognises signed integer literals", () => {
    const tokens = tokenize(String.raw`duplicate$ "\" = { pop$ }
#-1 #42
"unfinished string
FUNCTION {next} { skip$ }`);
    const styleFor = (text: string) => tokens.find((token) => token.text === text)?.style;

    // A literal backslash is written as "\" in BST rather than using a
    // JavaScript-like escaped quote. The following operator must remain code.
    expect(styleFor("=")).toBe("operator");
    expect(styleFor("#-1")).toBe("number");
    expect(styleFor("#42")).toBe("number");
    // BibTeX strings cannot cross physical lines, including while editing an
    // incomplete literal.
    expect(styleFor("FUNCTION")).toBe("keyword");
    expect(styleFor("skip$")).toBe("builtin");
  });

  it("keeps generic bracket matching available for nested style functions", () => {
    const source = String.raw`FUNCTION {article} {
  author empty$ { skip$ } { author write$ } if$
}`;
    const state = EditorState.create({ doc: source, extensions: [bstLanguage, bracketMatching()] });
    const closing = source.lastIndexOf("}");
    const opening = source.indexOf("{", source.indexOf("article") + "article".length);

    expect(matchBrackets(state, closing + 1, -1)).toMatchObject({
      start: { from: closing, to: closing + 1 },
      end: { from: opening, to: opening + 1 },
      matched: true
    });
  });
});
