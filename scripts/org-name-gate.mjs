#!/usr/bin/env node
/**
 * Org-name gate: Den is public, so no org's names, hosts or accounts may land
 * in it. The patterns are NOT in this repo (listing them would publish them):
 * they come from DEN_ORG_NAMES (one regex per line; a CI secret) or the file
 * named by DEN_ORG_NAMES_FILE. With neither set the gate fails, so a missing
 * secret can never pass silently.
 *
 *   DEN_ORG_NAMES_FILE=../notes/org-names.txt node scripts/org-name-gate.mjs
 *   node scripts/org-name-gate.mjs --tree <commit>   that commit's files (pre-push)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { orgHitsWide, orgPatterns } from "./org-names.js";

const [flag, tree] = process.argv.slice(2);
if (flag === "--tree" && !tree) {
  console.error("usage: org-name-gate.mjs [--tree <commit>]");
  process.exit(2);
}
const patterns = orgPatterns();
if (patterns.length === 0) {
  console.error(
    "org-name gate: no patterns (set DEN_ORG_NAMES or DEN_ORG_NAMES_FILE)",
  );
  process.exit(2);
}

// The publisher's own identity, from package.json (never listed here). Den's
// own npm name and repo are allowed everywhere; the publisher's name only
// outside what Den shows (src/ui/server/public), so no distribution's pages
// ever name it.
// A commit's files are read in one `git cat-file --batch` pass.
function treeFiles(commit) {
  const list = execFileSync("git", ["ls-tree", "-r", "-z", commit], {
    encoding: "utf-8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean)
    .map((l) => {
      const [meta, file] = l.split("\t");
      const [, type, oid] = meta.split(" ");
      return { type, oid, file };
    })
    .filter((e) => e.type === "blob");
  const out = execFileSync("git", ["cat-file", "--batch"], {
    input: list.map((e) => e.oid).join("\n") + "\n",
    maxBuffer: 1 << 30,
  });
  const texts = new Map();
  let at = 0;
  for (const e of list) {
    const nl = out.indexOf(10, at);
    const size = Number(out.subarray(at, nl).toString().split(" ")[2]);
    texts.set(e.file, out.subarray(nl + 1, nl + 1 + size).toString("utf-8"));
    at = nl + 1 + size + 1;
  }
  return texts;
}
const fromTree = flag === "--tree" ? treeFiles(tree) : null;
const read = (file) =>
  fromTree ? (fromTree.get(file) ?? "") : readFileSync(file, "utf-8");

const pkg = JSON.parse(read("package.json") || "{}");
const run = (v) =>
  String(v ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
const [, scope = "", pkgName = ""] =
  /^@([^/]+)\/(.+)$/.exec(String(pkg.name ?? "")) ?? [];
const [, owner = "", repo = ""] =
  /github\.com[/:]([^/]+)\/([^/.]+)/.exec(
    String(pkg.repository?.url ?? pkg.repository ?? ""),
  ) ?? [];
const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
const coords = [
  scope && `@${run(scope)}/${run(pkgName)}`,
  owner && `${run(owner)}/${run(repo)}`,
].filter(Boolean);
const publisher = [...coords, run(author), run(scope), run(owner)].filter(
  Boolean,
);
// What a page shows: Den's pages, and the UI kit they load (den-ui).
const shown = (file) =>
  file.startsWith("src/ui/server/public/") ||
  file.startsWith("packages/den-ui/src/");

const files = fromTree
  ? [...fromTree.keys()]
  : execFileSync("git", ["ls-files", "-z"], { encoding: "utf-8" })
      .split("\0")
      .filter(Boolean);
let hits = 0;
for (const file of files) {
  let text;
  try {
    text = read(file);
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  const lines = [file, ...text.split("\n")];
  lines.forEach((line, i) => {
    const allowed = shown(file) ? coords : publisher;
    for (const { index } of orgHitsWide(line, patterns, allowed)) {
      hits++;
      // Name the file, line and pattern index, never the matched text: CI
      // logs are public too.
      console.log(
        `${file}:${i === 0 ? "(path)" : i} matches pattern #${index}`,
      );
    }
  });
}
if (hits) {
  console.error(`org-name gate: ${hits} hit(s)`);
  process.exit(1);
}
console.log(`org-name gate: ${files.length} files clean`);
