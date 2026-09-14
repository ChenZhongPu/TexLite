/** Bibliographies and BibTeX style programs are structured data/code, not prose. */
export function supportsWritingChecks(path: string): boolean {
  return !/\.(?:bib|bst)$/i.test(path.trim());
}
