/** Lightweight extraction of source and bibliography dependencies from TeX. */

import {
  forEachLatexCommand,
  isLatexCommentStart,
  readLatexMandatoryArguments,
  skipLatexComment,
  skipLatexTrivia,
  type LatexArgumentSpan
} from "./latexScanner.js";

export interface LatexPathReference {
  path: string;
  command: string;
  from: number;
  to: number;
  /** Directory argument of an import-package directive, when present. */
  directory?: string;
}

function pathRanges(source: string, argument: LatexArgumentSpan, splitOnComma: boolean): LatexPathReference[] {
  const paths: LatexPathReference[] = [];
  let segmentStart = argument.contentFrom;
  let index = argument.contentFrom;
  while (index <= argument.contentTo) {
    if (index < argument.contentTo && isLatexCommentStart(source, index)) {
      index = skipLatexComment(source, index);
      if (source[index] === "\n") index += 1;
      continue;
    }
    if (index !== argument.contentTo && (!splitOnComma || source[index] !== ",")) {
      index += 1;
      continue;
    }
    const reference = pathReferenceFromRange(source, segmentStart, index);
    if (reference) paths.push(reference);
    segmentStart = index + 1;
    index += 1;
  }
  return paths;
}

/**
 * Turn a raw argument segment into a project path while preserving the source
 * range that produced it. Comments disappear in TeX before filename handling,
 * so a comment between path fragments must not become part of the path.
 */
function pathReferenceFromRange(source: string, start: number, end: number): LatexPathReference | null {
  const characters: Array<{ character: string; index: number }> = [];
  let index = start;
  while (index < end) {
    if (isLatexCommentStart(source, index)) {
      index = skipLatexComment(source, index);
      if (source[index] === "\n") index += 1;
      continue;
    }
    characters.push({ character: source[index], index });
    index += 1;
  }
  let first = 0;
  let last = characters.length;
  while (first < last && /\s/.test(characters[first].character)) first += 1;
  while (last > first && /\s/.test(characters[last - 1].character)) last -= 1;
  if (first === last) return null;
  return {
    path: characters.slice(first, last).map((entry) => entry.character).join(""),
    command: "",
    from: characters[first].index,
    to: characters[last - 1].index + 1
  };
}

/** Read TeX's common `\\input filename` form without guessing macro expansion. */
function readUnbracedInputPath(source: string, start: number): LatexPathReference | null {
  const from = skipLatexTrivia(source, start);
  if (from >= source.length || /[\\{}\[\]#~]/.test(source[from])) return null;
  let to = from;
  while (to < source.length && !/\s/.test(source[to]) && !isLatexCommentStart(source, to)) {
    if (/[\\{}\[\]#~]/.test(source[to])) break;
    to += 1;
  }
  if (to === from) return null;
  return { path: source.slice(from, to), command: "", from, to };
}

/**
 * Find source files pulled into a LaTeX document. Paths intentionally remain
 * raw: project-level code is responsible for resolving them safely.
 */
export function findLatexSourceIncludes(source: string): LatexPathReference[] {
  const includes: LatexPathReference[] = [];
  forEachLatexCommand(source, (command) => {
    const name = command.name.toLowerCase();
    if (name === "input" || name === "include" || name === "subfile") {
      const argument = readLatexMandatoryArguments(source, command.to, 1)[0];
      if (argument) {
        for (const include of pathRanges(source, argument, false)) includes.push({ ...include, command: command.name });
      } else if (name === "input") {
        const include = readUnbracedInputPath(source, command.to);
        if (include) includes.push({ ...include, command: command.name });
      }
      return;
    }
    if (name !== "import" && name !== "subimport" && name !== "includefrom" && name !== "inputfrom"
      && name !== "subinputfrom" && name !== "subincludefrom") return;
    const argumentsFound = readLatexMandatoryArguments(source, command.to, 2);
    if (argumentsFound.length !== 2) return;
    const directory = pathRanges(source, argumentsFound[0], false)[0]?.path ?? "";
    const file = pathRanges(source, argumentsFound[1], false)[0];
    if (!file) return;
    const separator = directory && !directory.endsWith("/") ? "/" : "";
    includes.push({
      path: directory + separator + file.path,
      command: command.name,
      from: file.from,
      to: file.to,
      directory
    });
  });
  return includes;
}

/** Find bibliography resources declared by a LaTeX document. */
export function findLatexBibliographyFiles(source: string): LatexPathReference[] {
  const files: LatexPathReference[] = [];
  forEachLatexCommand(source, (command) => {
    const name = command.name.toLowerCase();
    if (name !== "bibliography" && name !== "addbibresource" && name !== "addglobalbib" && name !== "addsectionbib") return;
    const argument = readLatexMandatoryArguments(source, command.to, 1)[0];
    if (!argument) return;
    const splitOnComma = name === "bibliography";
    for (const file of pathRanges(source, argument, splitOnComma)) files.push({ ...file, command: command.name });
  });
  return files;
}
