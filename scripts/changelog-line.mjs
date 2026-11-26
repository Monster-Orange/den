#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  FRAGMENT_SHAPE,
  FragmentError,
  SECTIONS,
  isFragmentPath,
  parseFragment,
} from "./changelog-fragments.mjs";

const PRODUCT = /^(?:src|packages|bin)\//;
const SHARED = /^(?:next\/queue$|release\/|rel\/)/;

function main() {
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
  const version = git("diff", "-U0", range, "--", "package.json")
    .split("\n")
    .some((l) => /^\+\s*"version":/.test(l));
  if (version) {
    console.log("changelog line: not held (the version-setting commit)");
    return 0;
  }
  if (files.includes("CHANGELOG.md")) {
    console.error(
      [
        "changelog line: this pull request edits CHANGELOG.md. Only the version commit does (release-dry-run.mjs apply assembles the fragments into it).",
        `Put the line in ${FRAGMENT_SHAPE} instead, under its "### <section>" heading.`,
      ].join("\n"),
    );
    return 1;
  }
  const added = [];
  for (const row of git("diff", "--name-status", "--no-renames", range)
    .split("\n")
    .filter(Boolean)) {
    const [status, file] = row.split("\t");
    if (status === "D" || !isFragmentPath(file)) continue;
    try {
      parseFragment(file, git("show", `${head}:${file}`));
      if (status === "A") added.push(file);
    } catch (e) {
      if (!(e instanceof FragmentError)) throw e;
      console.error(`changelog line: ${e.message}`);
      return 1;
    }
  }
  if (!files.some((f) => PRODUCT.test(f))) {
    console.log(
      "changelog line: not held (no change under src/, packages/ or bin/)",
    );
    return 0;
  }
  const said = /^no-changelog:(.*)$/im.exec(process.env.PR_BODY ?? "");
  if (said && said[1].trim()) {
    console.log(`changelog line: not needed (no-changelog: ${said[1].trim()})`);
    return 0;
  }
  if (added.length) {
    console.log(`changelog line: ok (${added.join(", ")})`);
    return 0;
  }
  console.error(
    [
      `changelog line: this pull request changes ${files.filter((f) => PRODUCT.test(f)).length} file(s) under src/, packages/ or bin/ and adds no changelog fragment.`,
      said ? `Its "no-changelog:" line gives no reason.` : "",
      "Either:",
      `  - add ${FRAGMENT_SHAPE} with a "### <section>" heading (${SECTIONS.join(", ")}) and its "- " line, or`,
      "  - put a line in the pull request's body: no-changelog: <reason>",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return 1;
}

process.exitCode = main();
