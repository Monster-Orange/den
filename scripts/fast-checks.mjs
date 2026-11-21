#!/usr/bin/env node
/**
 * Issue 843: the static checks that fail most often (version sync, the
 * words gate, the colour and kit tokens, i18n parity, the pop-up and dialog
 * ratchets) run first, in seconds, before any ten-minute test shard. The
 * list is scripts/fast-checks.json; CI's `fast` job and .husky/pre-push both
 * run it through this script, so the two never drift.
 *
 *   node scripts/fast-checks.mjs          # run them all
 *   node scripts/fast-checks.mjs --list   # print the list
 *
 * Each command runs in turn, then one jest run over the listed files (one
 * start-up for all of them). Every check runs even after one fails; the exit
 * code is 1 when any failed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const list = JSON.parse(
  readFileSync(join(root, "scripts", "fast-checks.json"), "utf-8"),
);

if (process.argv.includes("--list")) {
  for (const c of list.commands) console.log(c.run.join(" "));
  for (const f of list.jest) console.log(`jest ${f}`);
  process.exit(0);
}

const failed = [];
const t0 = Date.now();
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1);

function run(name, cmd, args) {
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  const ok = r.status === 0;
  console.log(`fast-checks: ${ok ? "ok" : "FAILED"} ${name} (${secs(t)} s)`);
  if (!ok) failed.push(name);
}

for (const c of list.commands) {
  const [cmd, ...args] = c.run;
  run(c.name, cmd === "node" ? process.execPath : cmd, args);
}
// jest's package exports only its package.json: its bin sits beside it.
const jest = join(
  dirname(
    createRequire(join(root, "package.json")).resolve("jest/package.json"),
  ),
  "bin",
  "jest.js",
);
run("jest", process.execPath, [jest, "--forceExit", ...list.jest]);

console.log(`fast-checks: ${secs(t0)} s in all`);
if (failed.length) {
  console.error(`fast-checks: failed: ${failed.join(", ")}`);
  process.exit(1);
}
