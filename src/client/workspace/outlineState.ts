import type { ProjectOutlineItem } from "./types";

export interface OutlineSourceSnapshot {
  filePath: string;
  content: string;
}

export interface LoadedProjectOutline {
  mainFile: string;
  items: ProjectOutlineItem[];
}

/**
 * Keep the outline scoped to the selected root document.  The small local
 * fallback is useful before the server has returned, but must never turn the
 * currently edited included file into the outline source.
 */
export function workspaceOutlineForMainFile(
  loaded: LoadedProjectOutline,
  activeMainFile: string,
  analysisSource: OutlineSourceSnapshot
): ProjectOutlineItem[] {
  if (loaded.mainFile === activeMainFile) return loaded.items;
  if (!activeMainFile || analysisSource.filePath !== activeMainFile) return [];
  return parseMainFileOutline(analysisSource.content).map((item) => ({ ...item, path: activeMainFile }));
}

function parseMainFileOutline(content: string): Array<Omit<ProjectOutlineItem, "path">> {
  const result: Array<Omit<ProjectOutlineItem, "path">> = [];
  const pattern = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^}]*)\}/;
  const levels: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3 };
  content.split("\n").forEach((line, index) => {
    const match = line.match(pattern);
    if (match) result.push({ level: levels[match[1]], title: match[2], line: index + 1 });
  });
  return result;
}
