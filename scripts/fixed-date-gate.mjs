#!/usr/bin/env node
/**
 * A test case may not plant a fixed date and read the real clock: it passes
 * for a day, then fails everywhere. Flags an `it`/`test` body holding an ISO
 * date literal and `new Date()` or `Date.now()`, unless the file fakes the
 * clock.
 *
 *   node scripts/fixed-date-gate.mjs [path ...]   default: tests gate
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ISO = /["'`]20\d\d-\d\d-\d\d(?:[T ][0-9:.]+Z?)?["'`]/;
const REAL = /\bnew Date\(\s*\)|\bDate\.now\(\s*\)/;
const FAKE =
  /useFakeTimers|setSystemTime|mockdate|clock\.install|page\.clock\./;
const CASE = /\b(?:it|test)(?:\.only|\.skip|\.each\([^)]*\))?\(\s*["'`]/g;
const OK = /mo-lint-ok:[ \t]*\S/;
const FILE =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|\.browser\.[cm]?[jt]s$|^gate\/[^/]+\.mjs$/;

export const MESSAGE =
  "plants a fixed date and reads the real clock, so it passes for a day and then fails everywhere. " +
  "Fake the clock (jest.useFakeTimers().setSystemTime(...)), pass `now` all the way down, " +
  "or place the dates from the real clock. A case that is safe (the real clock only times it) says why in a " +
  "`// mo-lint-ok: <why>` comment in its body.";

function caseBody(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

export function fixedDateHits(src) {
  if (FAKE.test(src)) return [];
  const hits = [];
  for (const m of src.matchAll(CASE)) {
    const body = caseBody(src, m.index);
    if (ISO.test(body) && REAL.test(body) && !OK.test(body)) {
      hits.push(src.slice(0, m.index).split("\n").length);
    }
  }
  return hits;
}

function* walk(root, p) {
  const s = statSync(p, { throwIfNoEntry: false });
  if (!s) return;
  if (s.isFile()) {
    if (FILE.test(relative(root, p).replaceAll("\\", "/")) || FILE.test(p))
      yield p;
    return;
  }
  for (const n of readdirSync(p)) {
    if (n === "node_modules" || n === "fixtures" || n.startsWith(".")) continue;
    yield* walk(root, join(p, n));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const paths = (args.length ? args : ["tests", "gate"]).map((a) =>
    join(root, a),
  );
  let n = 0;
  for (const p of paths) {
    for (const f of walk(root, p)) {
      for (const line of fixedDateHits(readFileSync(f, "utf-8"))) {
        n++;
        console.log(`${relative(root, f)}:${line}: this case ${MESSAGE}`);
      }
    }
  }
  console.log(`fixed-date gate: ${n ? `${n} case(s)` : "ok"}`);
  process.exit(n ? 1 : 0);
}
