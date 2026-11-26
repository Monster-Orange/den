#!/usr/bin/env node
/**
 * Live-check evidence for a pull request (issue 1652). Reads a release-bed
 * verdict.json (an evidence-only module run against a dev tag's install) and
 * prints a Markdown block to paste into the pull request.
 *
 *   node scripts/gate-evidence.mjs <verdict.json | -> [--base <ref>] [--repo <dir>]
 *
 * Exit 0: every clause passed or was not run. Exit 1: a clause is FAIL,
 * FAIL_TO_RUN or ERROR. Exit 2: refused (a module the pull request adds or
 * changes under gate/ is missing from the verdict, or the block names an org).
 * Notes keep no local paths or host names; evidence shows file names only.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { orgPatterns } from "./org-names.js";

const BAD = new Set(["FAIL", "FAIL_TO_RUN", "ERROR"]);

export function changedModules(base, repo) {
  const out = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=AMR",
      `${base}...HEAD`,
      "--",
      "gate/",
    ],
    { cwd: repo, encoding: "utf-8" },
  );
  return out
    .split("\n")
    .map((f) => /^gate\/([^/]+)\.mjs$/.exec(f.trim())?.[1])
    .filter(Boolean);
}

export function scrub(text) {
  return String(text ?? "")
    .replace(/\b(https?|wss?):\/\/[^/\s"'\\]+/g, "$1://<host>")
    .replace(
      /(?:~|\/(?:Users|home|private|tmp|var|opt))(?:\/[^\s"'\\,;)]+)+/g,
      (p) => basename(p),
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<host>")
    .replace(/\blocalhost(?::\d+)?\b/gi, "<host>");
}

const cell = (s, max = 300) => {
  const t = scrub(s).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const secs = (ms) =>
  typeof ms === "number" ? `${(ms / 1000).toFixed(1)} s` : "–";

export function block(v) {
  const rows = [...(v.clauses ?? [])].sort(
    (a, b) => Number(BAD.has(b.verdict)) - Number(BAD.has(a.verdict)),
  );
  const mods = [...new Set(rows.map((c) => String(c.issue)))];
  const from = v.modulesFrom?.commit ?? v.modulesFrom?.from;
  const bad = rows.filter((c) => BAD.has(c.verdict)).length;
  const lines = [
    `### Live check evidence: ${v.tag ?? "unknown tag"}`,
    "",
    `- Checks from: ${from ? `\`${from.slice(0, 12)}\`` : "the tag itself"}` +
      (v.sha ? ` · install built from \`${v.sha.slice(0, 12)}\`` : ""),
    `- Run: ${v.startedPT ?? v.startedAt ?? "–"} · ${bad ? `${bad} failing` : "no failing"} clause(s) of ${rows.length}`,
    `- Modules: ${mods.join(", ") || "none"}`,
    "",
    "| Module | Clause | Result | Time | Note | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (c) =>
        `| ${cell(c.issue)} | ${cell(c.clause, 200)} | **${cell(c.verdict)}** | ${secs(c.ms)} | ${cell(c.note)} | ${(c.evidence ?? []).map((e) => cell(basename(String(e)), 80)).join(", ")} |`,
    ),
    "",
  ];
  return { text: lines.join("\n"), mods, bad };
}

function main(argv) {
  const opt = { base: "origin/next/queue", repo: process.cwd() };
  let file;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") opt.base = argv[++i];
    else if (argv[i] === "--repo") opt.repo = argv[++i];
    else file = argv[i];
  }
  if (!file) {
    process.stderr.write(
      "usage: gate-evidence.mjs <verdict.json | -> [--base <ref>] [--repo <dir>]\n",
    );
    return 2;
  }
  const v = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf-8"));
  const { text, mods, bad } = block(v);
  const missing = changedModules(opt.base, opt.repo).filter(
    (m) => !mods.includes(m),
  );
  if (missing.length) {
    process.stderr.write(
      `refused: this verdict has no run of the live check(s) this pull request adds or changes: ${missing.join(", ")}. Ask the bed for a run that names them.\n`,
    );
    return 2;
  }
  const hit = orgPatterns().find((re) => re.test(text));
  if (hit) {
    process.stderr.write(
      "refused: the block names an org name from the org-names list; fix the note at its source\n",
    );
    return 2;
  }
  process.stdout.write(text);
  return bad ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = main(process.argv.slice(2));
