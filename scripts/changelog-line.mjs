#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const PRODUCT = /^(?:src|packages|bin)\//;
const SHARED = /^(?:next\/queue$|release\/|rel\/)/;
const UNRELEASED = /^## \[[^\]]+\] - unreleased\s*$/;

function placed(spec) {
  const [base, head] = (spec ?? "").split("..");
  if (!base || !head) {
    console.error(
      "usage: node scripts/changelog-line.mjs --placed <base>..<head>",
    );
    return 2;
  }
  const git = (...a) => execFileSync("git", a, { encoding: "utf-8" });
  const log = git("show", `${head}:CHANGELOG.md`).split("\n");
  const heads = log.flatMap((l, i) => (/^## /.test(l) ? [i] : []));
  const top = heads.length && UNRELEASED.test(log[heads[0]]) ? heads[0] : -1;
  const end = top < 0 ? -1 : (heads[1] ?? log.length);
  const under = (n) => {
    const h = heads.filter((i) => i < n).pop();
    return h === undefined ? "the top of the file" : `"${log[h].trim()}"`;
  };
  const stray = [];
  let at = 0;
  for (const l of git("diff", "-U0", base, head, "--", "CHANGELOG.md").split(
    "\n",
  )) {
    const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) at = Number(hunk[1]) - 1;
    else if (l.startsWith("+") && !l.startsWith("+++")) {
      if (l.slice(1).trim() && !(top >= 0 && at > top && at < end))
        stray.push(`  ${l.slice(1)}   (under ${under(at)})`);
      at++;
    }
  }
  if (!stray.length) {
    console.log("changelog placed: ok");
    return 0;
  }
  console.error(
    [
      `changelog placed: ${stray.length} line(s) added to CHANGELOG.md in ${base}..${head} are not under its top "- unreleased" heading${top < 0 ? " (its first section is not an unreleased one)" : ` (${log[top].trim()})`}:`,
      ...stray,
    ].join("\n"),
  );
  return 1;
}

function main() {
  if (process.argv[2] === "--placed") return placed(process.argv[3]);
  const [base, head] = (process.argv[2] ?? "").split("..");
  if (!base || !head) {
    console.error(
      "usage: PR_BODY=… PR_HEAD_REF=… node scripts/changelog-line.mjs <base>..<head>",
    );
    return 2;
  }
  const git = (...a) => execFileSync("git", a, { encoding: "utf-8" });
  const headRef = (process.env.PR_HEAD_REF ?? "").trim();
  if (SHARED.test(headRef)) {
    console.log(`changelog line: not held (from ${headRef})`);
    return 0;
  }
  const range = `${base}...${head}`;
  const files = git("diff", "--name-only", range).split("\n").filter(Boolean);
  if (!files.some((f) => PRODUCT.test(f))) {
    console.log(
      "changelog line: not held (no change under src/, packages/ or bin/)",
    );
    return 0;
  }
  const version = git("diff", "-U0", range, "--", "package.json")
    .split("\n")
    .some((l) => /^\+\s*"version":/.test(l));
  if (version) {
    console.log("changelog line: not held (the version-setting commit)");
    return 0;
  }
  const said = /^no-changelog:(.*)$/im.exec(process.env.PR_BODY ?? "");
  if (said && said[1].trim()) {
    console.log(`changelog line: not needed (no-changelog: ${said[1].trim()})`);
    return 0;
  }
  const log = git("show", `${head}:CHANGELOG.md`).split("\n");
  const start = log.findIndex((l) => UNRELEASED.test(l));
  const end =
    start < 0 ? -1 : log.findIndex((l, i) => i > start && /^## /.test(l));
  const inUnreleased = (n) => start >= 0 && n > start && (end < 0 || n < end);
  let added = false;
  let at = 0;
  for (const l of git("diff", "-U0", range, "--", "CHANGELOG.md").split("\n")) {
    const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) at = Number(hunk[1]) - 1;
    else if (l.startsWith("+") && !l.startsWith("+++")) {
      if (/^\s*[-*] \S/.test(l.slice(1)) && inUnreleased(at)) added = true;
      at++;
    }
  }
  if (added) {
    console.log("changelog line: ok");
    return 0;
  }
  const heading = start >= 0 ? log[start].trim() : "## [X] - unreleased";
  console.error(
    [
      `changelog line: this pull request changes ${files.filter((f) => PRODUCT.test(f)).length} file(s) under src/, packages/ or bin/ and adds no line to CHANGELOG.md under "${heading}".`,
      said ? `Its "no-changelog:" line gives no reason.` : "",
      "Either:",
      `  - add a line under "${heading}" in CHANGELOG.md, or`,
      "  - put a line in the pull request's body: no-changelog: <reason>",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return 1;
}

process.exitCode = main();
