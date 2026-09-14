import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";

/**
 * BibTeX style files are a small postfix language, not BibTeX databases.
 *
 * CodeMirror has no built-in BST language, and applying the .bib parser here
 * would produce false diagnostics and completions. This deliberately compact
 * stream mode covers the stable lexical structure authors need while editing:
 * declarations, standard built-ins, quoted strings, numeric literals,
 * comments, operators, and balanced delimiters.
 */
const declarations = new Set([
  "ENTRY", "EXECUTE", "FUNCTION", "INTEGERS", "ITERATE", "MACRO", "READ", "REVERSE", "SORT", "STRINGS"
]);

const builtins = new Set([
  "add.period$", "call.type$", "change.case$", "chr.to.int$", "cite$", "duplicate$", "empty$", "format.name$",
  "if$", "int.to.chr$", "int.to.str$", "missing$", "newline$", "num.names$", "pop$", "preamble$", "purify$",
  "quote$", "skip$", "stack$", "substring$", "swap$", "text.length$", "text.prefix$", "top$", "type$",
  "warning$", "while$", "width$", "write$"
]);

interface BstStreamState {}

function consumeString(stream: StringStream): string {
  while (!stream.eol()) {
    const character = stream.next();
    // Unlike JavaScript, a backslash is ordinary string content and does not
    // escape the following quote. BibTeX also requires a string literal to
    // end on its opening line, so an unfinished edit must not colour the rest
    // of the document.
    if (character === '"') break;
  }
  return "string";
}

/** A focused CodeMirror mode for BibTeX .bst style-program source. */
export const bstStream: StreamParser<BstStreamState> = {
  name: "bibtex-style",
  startState() {
    return {};
  },
  languageData: {
    commentTokens: { line: "%" },
    closeBrackets: { brackets: ["{", "(", "[", '"'] }
  },
  token(stream, _state) {
    if (stream.eatSpace()) return null;

    const character = stream.peek();
    if (character === "%") {
      stream.skipToEnd();
      return "comment";
    }
    if (character === '"') {
      stream.next();
      return consumeString(stream);
    }
    if (character && "{}[]()".includes(character)) {
      stream.next();
      return "bracket";
    }
    if (stream.match(/#-?\d+/)) return "number";
    if (character === "'") {
      stream.next();
      return "operator";
    }
    if (stream.match(/:=|[=<>+*/-]/)) return "operator";
    if (character && /[A-Za-z]/.test(character)) {
      stream.eatWhile(/[A-Za-z0-9_.$:-]/);
      const word = stream.current();
      if (declarations.has(word.toUpperCase())) return "keyword";
      if (builtins.has(word.toLowerCase())) return "builtin";
      return "variable";
    }
    stream.next();
    return null;
  }
};

export const bstLanguage = StreamLanguage.define(bstStream);
