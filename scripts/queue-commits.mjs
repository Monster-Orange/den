#!/usr/bin/env node
/**
 * The merge queue's commit check. A commit can reach the queue's branch
 * without a pre-push (a hosted merge button), and the pre-push name check
 * skips what is already there, so CI checks it here instead: every commit
 * in the range must be signed by a key in the allowed-signers file, and
 * its message must not match the names list (scripts/org-names.js).
 *
 *   node scripts/queue-commits.mjs <base>..<head> [--signers <file>] [--allow <file>]
 *
 * --signers defaults to .github/release-signers and --allow to
 * scripts/queue-commits-allow.json, both in this checkout. The allow-list
 * holds known commits, each by its full SHA with a reason; they pass.
 * Output names only a SHA and the rule it broke, never a message: CI logs
 * are public. Exit 1 on a hit; 2 on bad input, a bad allow-list, or no
 * names list (a missing secret never passes silently).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { orgHitsWide, orgPatterns } from "./org-names.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`queue commits: ${msg}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const range = args[0];
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (!v) fail(`${name} needs a file`);
  return path.resolve(v);
}
if (!range || !range.includes("..")) {
  fail(
    "usage: queue-commits.mjs <base>..<head> [--signers <file>] [--allow <file>]",
  );
}
const signers = flag(
  "--signers",
  path.join(ROOT, ".github", "release-signers"),
);
const allowFile = flag(
  "--allow",
  path.join(ROOT, "scripts", "queue-commits-allow.json"),
);

const patterns = orgPatterns();
if (patterns.length === 0) {
  fail("no patterns (set DEN_ORG_NAMES or DEN_ORG_NAMES_FILE)");
}

let allowed;
try {
  const list = JSON.parse(readFileSync(allowFile, "utf-8"));
  if (!Array.isArray(list)) throw new Error("not a list");
  allowed = new Set(
    list.map((e, i) => {
      if (
        typeof e?.sha !== "string" ||
        !/^[0-9a-f]{40}$/.test(e.sha) ||
        typeof e.reason !== "string" ||
        !e.reason.trim()
      ) {
        throw new Error(`entry ${i + 1} needs a full SHA and a reason`);
      }
      return e.sha;
    }),
  );
} catch (e) {
  fail(`the allow-list ${allowFile} can't be used: ${e.message}`);
}
try {
  readFileSync(signers);
} catch {
  fail(`no allowed-signers file at ${signers}`);
}

let shas;
try {
  shas = execFileSync("git", ["rev-list", range], { encoding: "utf-8" })
    .split("\n")
    .filter(Boolean);
} catch {
  fail(`git can't list ${range}`);
}

let bad = 0;
let checked = 0;
for (const sha of shas) {
  if (allowed.has(sha)) continue;
  checked++;
  const broke = [];
  const signed = spawnSync(
    "git",
    ["-c", `gpg.ssh.allowedSignersFile=${signers}`, "verify-commit", sha],
    { stdio: "ignore" },
  );
  if (signed.status !== 0) broke.push("not signed by an allowed key");
  const msg = execFileSync("git", ["show", "-s", "--format=%B", sha], {
    encoding: "utf-8",
  });
  const hits = orgHitsWide(msg, patterns);
  if (hits.length) {
    broke.push(
      `message matches pattern #${hits.map((h) => h.index).join(", #")}`,
    );
  }
  if (!broke.length) continue;
  bad++;
  console.log(`${sha.slice(0, 12)} ${broke.join("; ")}`);
}
if (bad) {
  const shownAllow = allowFile.startsWith(ROOT + path.sep)
    ? path.relative(ROOT, allowFile)
    : allowFile;
  console.error(
    `queue commits: ${bad} of ${checked} commit(s) broke a rule. A commit already on the queue can't be reworded: put its full SHA, with a reason, in ${shownAllow}, and find how it got there.`,
  );
  process.exit(1);
}
console.log(`queue commits: ${checked} commit(s) signed and clean`);
