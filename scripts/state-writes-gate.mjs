#!/usr/bin/env node
/**
 * Issue 786: every state file is written whole, through
 * src/shared/atomic-write.ts (a temp file, flushed, then renamed). A plain
 * fs.writeFileSync empties the file first: a crash, a power loss or a full
 * disk in that window leaves the person's state empty or half-written.
 *
 * The check counts plain whole-file writes (`writeFileSync(`, and the async
 * fs.promises.writeFile / writeFile from fs/promises) per source file under
 * src/ (tests left out) and fails when a file has more than its allow-list entry lets it
 * have. A file with no entry may have none. Each entry names a reason: a
 * temp file, a file in the person's repo, a one-off export, test tooling.
 * An entry that allows more than the file now has is reported, so the list
 * shrinks with the code; it never fails the check.
 *
 *   node scripts/state-writes-gate.mjs [--root dir] [--allow file] [--json]
 *
 * The allow-list (scripts/state-writes-allow.json):
 *   { "src/path/file.ts": { "count": 1, "reason": "…" }, … }
 *
 * Plain Node, no imports but node:*. Exit 0 when clean, 1 when a file has a
 * write the list doesn't allow, 2 on a usage error or a bad list.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST = /(\.test\.|\.spec\.|\.browser\.|__tests__)/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const CALL = /\bwriteFileSync\s*\(/g;
/** An async whole-file write through a namespace: fs.promises.writeFile(, fsp.writeFile(. */
const ASYNC_NS = /\b(?:promises|fsp|fs)\.writeFile\s*\(/g;
/** writeFile imported by name from fs/promises (or fs): then a bare writeFile( counts. */
const ASYNC_IMPORT =
  /\bimport\s*\{[^}]*\bwriteFile\b[^}]*\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/;
const ASYNC_BARE = /(?<![.\w])writeFile\s*\(/g;
/** The one file that may write plainly: it is the safe way. */
export const ATOMIC_WRITE = "src/shared/atomic-write.ts";

/** Comments out, so a doc line that names the call never counts. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/**
 * Plain whole-file writes in `text`, comments left out: `writeFileSync(`,
 * and the async ones (fs.promises.writeFile, writeFile from fs/promises),
 * which empty the file first in the same way. appendFileSync never counts:
 * a log is appended to, never replaced.
 */
export function countWrites(text) {
  const t = stripComments(text);
  const n = (re) => (t.match(re) ?? []).length;
  return n(CALL) + n(ASYNC_NS) + (ASYNC_IMPORT.test(t) ? n(ASYNC_BARE) : 0);
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SOURCE.test(e.name) && !TEST.test(p)) out.push(p);
  }
}

/** Reads and checks the allow-list; throws with a plain reason when it's bad. */
export function readAllow(file) {
  const v = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("the allow-list must be an object of file → entry");
  for (const [f, e] of Object.entries(v)) {
    if (!e || !Number.isInteger(e.count) || e.count < 1)
      throw new Error(`${f}: count must be a whole number of 1 or more`);
    if (typeof e.reason !== "string" || e.reason.trim().length < 8)
      throw new Error(`${f}: every entry needs a reason`);
  }
  return v;
}

/**
 * The check itself. `root` is the repo; `allow` the parsed list.
 * Returns { over: [{file, count, allowed}], stale: [{file, count, allowed}] }.
 */
export function check(root, allow) {
  const files = [];
  walk(path.join(root, "src"), files);
  const over = [];
  const stale = [];
  const seen = new Set();
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (rel === ATOMIC_WRITE) continue;
    const count = countWrites(fs.readFileSync(abs, "utf8"));
    const allowed = allow[rel]?.count ?? 0;
    if (allow[rel]) seen.add(rel);
    if (count > allowed) over.push({ file: rel, count, allowed });
    else if (count < allowed) stale.push({ file: rel, count, allowed });
  }
  for (const rel of Object.keys(allow))
    if (!seen.has(rel))
      stale.push({ file: rel, count: 0, allowed: allow[rel].count });
  return { over, stale };
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let root = path.resolve(here, "..");
  let allowFile = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = path.resolve(argv[++i] ?? "");
    else if (a === "--allow") allowFile = path.resolve(argv[++i] ?? "");
    else if (a === "--json") json = true;
    else {
      console.error(`state-writes-gate: unknown argument ${a}`);
      return 2;
    }
  }
  allowFile ??= path.join(root, "scripts", "state-writes-allow.json");
  let allow;
  try {
    allow = readAllow(allowFile);
  } catch (e) {
    console.error(`state-writes-gate: ${allowFile}: ${e.message}`);
    return 2;
  }
  const r = check(root, allow);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const s of r.stale)
      console.log(
        `note: ${s.file} allows ${s.allowed} plain write(s) and has ${s.count}: lower its entry`,
      );
    for (const o of r.over)
      console.error(
        `${o.file}: ${o.count} plain whole-file write(s), ${o.allowed} allowed. ` +
          `Write state with writeFileAtomic (${ATOMIC_WRITE}); ` +
          `for a temp file or a file outside the state folder, add an entry with its reason to scripts/state-writes-allow.json.`,
      );
    if (!r.over.length)
      console.log(
        "state-writes-gate: every state write goes through atomic-write",
      );
  }
  return r.over.length ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exit(main(process.argv.slice(2)));
