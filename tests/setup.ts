import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Application-level tests exercise successful compilation and SyncTeX routes.
// Keep them independent from a host TeX Live installation so that the same
// suite runs locally and in CI. Individual compiler tests can still provide a
// purpose-built executable when they need to inspect compiler arguments.
const toolsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "texlite-test-tools-"));
process.env.PATH = `${toolsDirectory}${path.delimiter}${process.env.PATH ?? ""}`;

writeExecutable("latexmk", `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const outputArgument = process.argv.find((argument) => argument.startsWith("-outdir="));
if (!outputArgument) {
  console.error("fake latexmk requires -outdir");
  process.exit(2);
}
const outputDirectory = outputArgument.slice("-outdir=".length);
const mainFile = process.argv.at(-1);
if (!mainFile || !/\\.tex$/i.test(mainFile)) {
  console.error("fake latexmk requires a .tex main file");
  process.exit(2);
}
const stem = path.basename(mainFile).replace(/\\.tex$/i, "");
const source = fs.readFileSync(mainFile, "utf8");
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, stem + ".pdf"), "%PDF-1.4\\n% TexLite test fixture\\n" + source);
fs.writeFileSync(
  path.join(outputDirectory, stem + ".synctex.gz"),
  gzipSync("SyncTeX Version:1\\nInput:1:" + path.resolve(mainFile) + "\\n")
);
console.log("Fake latexmk completed.");
`);

writeExecutable("synctex", `#!/bin/sh
set -e

case "$1" in
  view)
    printf '%s\\n' 'Page:1' 'x:42' 'y:84' 'W:10' 'H:12'
    ;;
  edit)
    location=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then
        shift
        location="$1"
        break
      fi
      shift
    done
    pdfPath="$(printf '%s' "$location" | sed 's/^.*:[^:]*:[^:]*://')"
    stem="$(basename "$pdfPath" .pdf)"
    printf 'Input:%s/%s.tex\\nLine:4\\nColumn:1\\n' "$(pwd)" "$stem"
    ;;
  *)
    printf '%s\\n' 'unsupported fake synctex operation' >&2
    exit 2
    ;;
esac
`);

function writeExecutable(name: string, source: string): void {
  const executable = path.join(toolsDirectory, name);
  fs.writeFileSync(executable, source, { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
}
