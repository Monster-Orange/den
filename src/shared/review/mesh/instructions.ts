/**
 * Issue 476 (REVIEW-MESH-SPEC RV-8 item 13): the instruction files a review
 * leg reads first, for the changed paths. In order: the root CLAUDE.md and
 * AGENTS.md; each CLAUDE.md and AGENTS.md in a changed path's folders, from
 * the top down; then each .claude/rules/*.md whose `paths:` frontmatter
 * matches a changed path (one with no `paths:` covers everything). Paths
 * are relative to `dir`, the leg's checkout; a path that climbs out of it
 * is ignored.
 */
import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";
import { globRegExp } from "../../verify/changes.js";

const NAMES = ["CLAUDE.md", "AGENTS.md"];

const isFile = (f: string) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

/** A changed path, kept only if it stays inside the checkout. */
function inside(p: string): string | null {
  if (path.isAbsolute(p)) return null;
  const n = path.posix.normalize(p.replace(/\\/g, "/"));
  return n.startsWith("../") || n === ".." ? null : n;
}

function rulePaths(text: string): string[] | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  try {
    const fm = parse(m[1]) as { paths?: unknown } | null;
    if (!Array.isArray(fm?.paths)) return null;
    return fm.paths.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

export function instructionFiles(
  dir: string,
  changed: readonly string[],
): string[] {
  const paths = changed.map(inside).filter((p): p is string => p !== null);
  const out: string[] = [];
  const add = (rel: string) => {
    if (!out.includes(rel) && isFile(path.join(dir, rel))) out.push(rel);
  };
  for (const n of NAMES) add(n);
  const folders = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++)
      folders.add(parts.slice(0, i).join("/"));
  }
  for (const f of [...folders].sort()) for (const n of NAMES) add(`${f}/${n}`);
  const rulesDir = path.join(dir, ".claude", "rules");
  let rules: string[] = [];
  try {
    rules = fs
      .readdirSync(rulesDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    rules = [];
  }
  for (const r of rules) {
    const rel = `.claude/rules/${r}`;
    let text = "";
    try {
      text = fs.readFileSync(path.join(rulesDir, r), "utf-8");
    } catch {
      continue;
    }
    const globs = rulePaths(text);
    if (globs === null) add(rel);
    else {
      const res = globs.map(globRegExp);
      if (paths.some((p) => res.some((re) => re.test(p)))) add(rel);
    }
  }
  return out;
}
