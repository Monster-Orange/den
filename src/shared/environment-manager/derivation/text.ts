/**
 * Small text helpers shared by the derivation rules — turning a regex match
 * into human-readable `file:line  snippet` evidence.
 */

import type { ScannedFile } from "./types.js";

export function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/** The trimmed source line containing `index`, capped for display. */
function lineTextAt(content: string, index: number): string {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  let end = content.indexOf("\n", index);
  if (end === -1) end = content.length;
  const text = content.slice(start, end).trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export function evidenceAt(file: ScannedFile, index: number): string {
  return `${file.rel}:${lineNumberAt(file.content, index)}  ${lineTextAt(file.content, index)}`;
}

/**
 * Whether the source line containing `index` is commented out (`#` for
 * yaml/env/toml/python, `//` for go/js). Used to skip false-positive matches on
 * commented-out config like `# FILES_API_URL=...`.
 */
export function isCommentedLine(content: string, index: number): boolean {
  const start = content.lastIndexOf("\n", index - 1) + 1;
  let end = content.indexOf("\n", index);
  if (end === -1) end = content.length;
  const line = content.slice(start, end).trimStart();
  return line.startsWith("#") || line.startsWith("//");
}
