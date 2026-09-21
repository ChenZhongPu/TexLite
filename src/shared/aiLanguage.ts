/**
 * Detect whether a LaTeX document declares the packages/classes normally used
 * for CJK typesetting. This is deliberately conservative: text that happens
 * to contain CJK characters is not enough to opt out of the English default.
 */
export function hasCjkLanguageSupport(source: string): boolean {
  const withoutComments = source.replace(/(^|[^\\])%[^\r\n]*/gm, "$1");
  const declarations = /\\(?:usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/gi;
  for (const match of withoutComments.matchAll(declarations)) {
    for (const rawName of match[1].split(",")) {
      const name = rawName.trim().replace(/\.(?:cls|sty)$/i, "").toLowerCase();
      if (name === "xecjk" || name === "ctex" || /^ctex(?:art|book|rep|beamer)$/.test(name)) return true;
    }
  }

  // These declarations are also strong evidence that the document opted into
  // CJK support even when the package is loaded indirectly.
  return /\\(?:setCJK(?:main|sans|mono)font|newCJKfontfamily|CJKfamily)\b/i.test(withoutComments);
}
