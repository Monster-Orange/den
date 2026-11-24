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
 * The commands and one jest run over the listed files (one start-up for all
 * of them) run side by side; each one's output is printed whole when it
 * ends. Every check runs even when another fails; the exit code is 1 when
 * any failed. DEN_FAST_JEST_CACHE names a jest cache directory (CI keeps
 * one between runs).
 */
import { spawn } from "node:child_process";
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

const t0 = Date.now();
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1);

function run(name, cmd, args) {
  const t = Date.now();
  return new Promise((resolve) => {
    const out = [];
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => out.push(d));
    const done = (ok) => {
      process.stdout.write(Buffer.concat(out));
      console.log(
        `fast-checks: ${ok ? "ok" : "FAILED"} ${name} (${secs(t)} s)`,
      );
      resolve(ok ? null : name);
    };
    child.on("error", (e) => {
      out.push(Buffer.from(`${e.message}\n`));
      done(false);
    });
    child.on("close", (code) => done(code === 0));
  });
}

// jest's package exports only its package.json: its bin sits beside it.
const jest = join(
  dirname(
    createRequire(join(root, "package.json")).resolve("jest/package.json"),
  ),
  "bin",
  "jest.js",
);
const cache = process.env.DEN_FAST_JEST_CACHE;
// A test that runs the pre-push hook must never start these checks again from
// inside them (a hook test that reached the real list re-ran it forever).
process.env.DEN_PREPUSH_FAST = "0";

const failed = (
  await Promise.all([
    ...list.commands.map((c) => {
      const [cmd, ...args] = c.run;
      return run(c.name, cmd === "node" ? process.execPath : cmd, args);
    }),
    run("jest", process.execPath, [
      jest,
      "--forceExit",
      ...(cache ? ["--cacheDirectory", cache] : []),
      ...list.jest,
    ]),
  ])
).filter(Boolean);

console.log(`fast-checks: ${secs(t0)} s in all`);
if (failed.length) {
  console.error(`fast-checks: failed: ${failed.join(", ")}`);
  process.exit(1);
}
