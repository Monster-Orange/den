#!/usr/bin/env node
/**
 * Issue 1012: type-checks the test files (tsconfig.tests.json), held to a
 * per-file baseline that only goes down (tests/typecheck-baseline.json).
 *
 * The test files were never type-checked, so they carry a backlog of
 * errors. This fails only when a file has more errors than its baseline,
 * or a file with none in the baseline has any: a test that imports a name
 * its helper no longer exports fails here, in seconds, not in a CI shard.
 *
 *   node scripts/typecheck-tests.mjs            check (npm run typecheck)
 *   node scripts/typecheck-tests.mjs --update   lower the baseline to today
 *   node scripts/typecheck-tests.mjs -p <tsconfig> [--baseline <file>]
 *
 * --update never raises a file's number: a file that got worse is left
 * failing, and one fixed to zero leaves the baseline.
 *
 * Known limit: a per-file count misses a swap (one error fixed and a new
 * one added in the same file). That's accepted, since counts only go down
 * and each fix lowers the baseline.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ERR = /^(.+?)\(\d+,\d+\): error TS\d+:/;

/** tsc's output → { file: errorCount }. */
export function countErrors(output) {
  const counts = {};
  for (const line of output.split("\n")) {
    const m = ERR.exec(line.trim());
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

/** Files whose count went over the baseline: [{ file, was, now }]. */
export function regressions(counts, baseline) {
  return Object.entries(counts)
    .filter(([file, n]) => n > (baseline[file] ?? 0))
    .map(([file, now]) => ({ file, was: baseline[file] ?? 0, now }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** The baseline lowered to today: never raised, zeros dropped. */
export function lowered(counts, baseline) {
  const out = {};
  for (const [file, was] of Object.entries(baseline)) {
    const now = Math.min(was, counts[file] ?? 0);
    if (now > 0) out[file] = now;
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const project = arg("-p", "tsconfig.tests.json");
  const baseFile = arg("--baseline", "tests/typecheck-baseline.json");
  const tsc = path.join("node_modules", ".bin", "tsc");
  const r = spawnSync(tsc, ["--noEmit", "--pretty", "false", "-p", project], {
    encoding: "utf8",
  });
  if (r.error) {
    console.error(`typecheck-tests: couldn't run tsc: ${r.error.message}`);
    return 2;
  }
  const output = `${r.stdout}${r.stderr}`;
  const counts = countErrors(output);
  if (r.status !== 0 && Object.keys(counts).length === 0) {
    console.error(output.trim());
    return 2;
  }
  const baseline = fs.existsSync(baseFile)
    ? JSON.parse(fs.readFileSync(baseFile, "utf8"))
    : {};
  if (argv.includes("--update")) {
    fs.writeFileSync(
      baseFile,
      `${JSON.stringify(lowered(counts, baseline), null, 2)}\n`,
    );
  }
  const worse = regressions(counts, baseline);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (worse.length) {
    console.error(
      `typecheck-tests: ${worse.length} file(s) have more type errors than their baseline (${baseFile}):`,
    );
    for (const w of worse) console.error(`  ${w.file}: ${w.was} -> ${w.now}`);
    const set = new Set(worse.map((w) => w.file));
    for (const line of output.split("\n")) {
      const m = ERR.exec(line.trim());
      if (m && set.has(m[1])) console.error(`  ${line.trim()}`);
    }
    return 1;
  }
  console.log(
    `typecheck-tests: no file over its baseline (${total} known errors in ${Object.keys(counts).length} files; the baseline only goes down)`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
