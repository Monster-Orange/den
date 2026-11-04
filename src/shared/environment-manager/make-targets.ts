/**
 * Lightweight Makefile target discovery.
 *
 * `den graph`/`up` annotate each node with the make targets it exposes and
 * warn when the ones den drives (`setup`/`up`/`down`) are missing. We parse
 * the root `Makefile` plus any `include`d `*.mk` for target definitions —
 * deliberately simple (no variable expansion), reading a fixed set of files.
 */

import * as fs from "fs";
import * as path from "path";

export interface MakeTargets {
  /** Sorted, unique runnable target names. */
  targets: string[];
  /** Makefiles parsed, relative to repo root. */
  files: string[];
}

const TARGET_LINE = /^([A-Za-z0-9][A-Za-z0-9_.-]*)[ \t]*:(?!=)/gm;
const INCLUDE_LINE = /^[ \t]*-?include[ \t]+(.+)$/gm;

function readSafe(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

function collectTargets(content: string, into: Set<string>): void {
  for (const m of content.matchAll(TARGET_LINE)) {
    const name = m[1];
    if (name.startsWith(".")) continue; // .PHONY, .DEFAULT_GOAL, …
    into.add(name);
  }
}

/** Parse the root Makefile (+ statically-includable `*.mk`) for target names. */
export function listMakeTargets(repoPath: string): MakeTargets {
  const rootMk = path.join(repoPath, "Makefile");
  const rootContent = readSafe(rootMk);
  if (rootContent === null) return { targets: [], files: [] };

  const targets = new Set<string>();
  const filesParsed: string[] = ["Makefile"];
  collectTargets(rootContent, targets);

  // Follow one level of `include`d makefiles with literal (non-variable) paths.
  const seen = new Set<string>([rootMk]);
  for (const inc of rootContent.matchAll(INCLUDE_LINE)) {
    const spec = inc[1].trim();
    if (spec.includes("$")) continue; // variable path — can't resolve statically
    for (const rel of spec.split(/\s+/)) {
      const abs = path.join(repoPath, rel);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const content = readSafe(abs);
      if (content === null) continue;
      filesParsed.push(rel);
      collectTargets(content, targets);
    }
  }

  return { targets: [...targets].sort(), files: filesParsed };
}

/** Split `required` into those present in the repo's Makefile(s) and those missing. */
export function requireTargets(
  repoPath: string,
  required: string[],
): { present: string[]; missing: string[] } {
  const have = new Set(listMakeTargets(repoPath).targets);
  const present: string[] = [];
  const missing: string[] = [];
  for (const t of required) (have.has(t) ? present : missing).push(t);
  return { present, missing };
}
