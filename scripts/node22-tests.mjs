#!/usr/bin/env node
/**
 * The tests a pull request runs again on Node 22 (the supported range's low
 * end, with npm 10), in the `pr-node22` job. A pull request runs on Node 24
 * (npm 11) only (issue 998), so a test that reads what npm prints could
 * pass there and fail only in a release dry run, which runs Node 22:
 * PR 1145 changed tests/unit/scripts/org-names-not-packed.test.ts, npm 10
 * printed husky's prepare line before `npm pack --json`'s JSON, and
 * v0.4.90-dev.1's dry run went red.
 *
 * The version-sensitive tests are the ones over Den's own scripts
 * (tests/unit/scripts/) and any test that runs npm itself. Of those, the
 * ones the change affects (scripts/affected-tests.mjs's list; all of them
 * when that list is ALL). Not picked: a test outside tests/unit/scripts that
 * uses a Node 24-only API, or that starts Den with npx (those run nightly on
 * Node 22). Browser tests never: the browser is the same on
 * either Node, and they are most of a run's minutes.
 *
 *   node scripts/node22-tests.mjs <affected.txt> [--out <file>]
 *
 * Prints (or writes) one test file per line; nothing when none applies.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** A test that runs npm: `spawnSync("npm", …)`, the name on its own line, or `execSync("npm …")`. */
const RUNS_NPM =
  /(?:^|[(,]\s*)["'`]npm["'`]\s*(?:,|$)|exec(?:Sync)?\(\s*["'`]npm /m;

const isBrowser = (f) => /\.browser\.test\.ts$/.test(f);

/** Whether a test file is one Node 22 runs again (its path and text). */
export function versionSensitive(file, text) {
  if (!/\.test\.ts$/.test(file) || isBrowser(file)) return false;
  if (file.startsWith("tests/unit/scripts/")) return true;
  return RUNS_NPM.test(text);
}

/**
 * From the affected list's lines (or ["ALL"]) and every test file with its
 * text, the ones Node 22 runs, sorted.
 */
export function node22Tests(affected, tests) {
  const all = affected[0] === "ALL";
  const want = new Set(affected);
  return tests
    .filter(({ file }) => all || want.has(file))
    .filter(({ file, text }) => versionSensitive(file, text))
    .map(({ file }) => file)
    .sort();
}

function main(argv) {
  const [list, ...rest] = argv;
  if (!list) {
    console.error(
      "usage: node scripts/node22-tests.mjs <affected.txt> [--out <file>]",
    );
    return 2;
  }
  const out = rest[0] === "--out" ? rest[1] : null;
  const affected = fs
    .readFileSync(list, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const files = execFileSync("git", ["ls-files", "tests"], {
    encoding: "utf-8",
  })
    .split("\n")
    .filter((f) => /\.test\.ts$/.test(f) && fs.existsSync(f));
  const picked = node22Tests(
    affected,
    files.map((file) => ({ file, text: fs.readFileSync(file, "utf-8") })),
  );
  const text = picked.length ? `${picked.join("\n")}\n` : "";
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
