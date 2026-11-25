#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
    "usage: queue-commits.mjs <base>..<head> [--trusted <ref> | --signers <file> --allow <file>]",
  );
}
const SIGNERS_PATH = ".github/release-signers";
const ALLOW_PATH = "scripts/queue-commits-allow.json";
const trustedAt = args.indexOf("--trusted");
const trusted = trustedAt === -1 ? undefined : args[trustedAt + 1];
if (trustedAt !== -1 && !trusted) fail("--trusted needs a ref");

function atTrusted(rel) {
  const r = spawnSync("git", ["show", `${trusted}:${rel}`], {
    encoding: "utf-8",
  });
  return r.status === 0 ? r.stdout : null;
}

let signersText;
let allowText;
let allowName;
let signersName;
if (trusted) {
  signersName = `${trusted}:${SIGNERS_PATH}`;
  allowName = `${trusted}:${ALLOW_PATH}`;
  signersText = atTrusted(SIGNERS_PATH);
  allowText = atTrusted(ALLOW_PATH) ?? "[]";
} else {
  signersName = flag("--signers", path.join(ROOT, SIGNERS_PATH));
  allowName = flag("--allow", path.join(ROOT, ALLOW_PATH));
  try {
    signersText = readFileSync(signersName, "utf-8");
  } catch {
    signersText = null;
  }
  try {
    allowText = readFileSync(allowName, "utf-8");
  } catch (e) {
    if (args.includes("--allow")) {
      fail(`the allow-list ${allowName} can't be used: ${e.message}`);
    }
    allowText = "[]";
  }
}
if (signersText === null) fail(`no allowed-signers file at ${signersName}`);

const patterns = orgPatterns();
if (patterns.length === 0) {
  fail("no patterns (set DEN_ORG_NAMES or DEN_ORG_NAMES_FILE)");
}

let allowed;
try {
  const list = JSON.parse(allowText);
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
  fail(`the allow-list ${allowName} can't be used: ${e.message}`);
}
const signersDir = mkdtempSync(path.join(os.tmpdir(), "queue-commits-"));
const signers = path.join(signersDir, "allowed_signers");
writeFileSync(signers, signersText);
process.on("exit", () => rmSync(signersDir, { recursive: true, force: true }));

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
let passedByList = 0;
for (const sha of shas) {
  if (allowed.has(sha)) {
    passedByList++;
    continue;
  }
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
  const shownAllow =
    trusted || !allowName.startsWith(ROOT + path.sep)
      ? allowName
      : path.relative(ROOT, allowName);
  console.error(
    `queue commits: ${bad} of ${checked} commit(s) broke a rule. A commit already on the queue can't be reworded: put its full SHA, with a reason, in ${shownAllow}, and find how it got there.`,
  );
  process.exit(1);
}
console.log(
  `queue commits: ${checked} commit(s) signed and clean; ${passedByList} passed by the allow-list`,
);
