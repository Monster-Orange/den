#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { orgPatterns } from "./org-names.js";

const OK = new Set(["PASS", "NOT_RUN"]);
const result = (c) =>
  typeof c.verdict === "string" && c.verdict.trim() ? c.verdict : "NONE";
const failing = (c) => !OK.has(result(c));

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
    (a, b) => Number(failing(b)) - Number(failing(a)),
  );
  const mods = [...new Set(rows.map((c) => String(c.issue)))];
  const from = String(v.modulesFrom?.commit ?? v.modulesFrom?.from ?? "");
  const overall = cell(v.overall ?? "NONE");
  const bad = rows.filter(failing).length + (overall === "PASS" ? 0 : 1);
  const lines = [
    `### Live check evidence: ${v.tag ?? "unknown tag"}`,
    "",
    `- Checks from: ${from ? `\`${from.slice(0, 12)}\`` : "the tag itself"}` +
      (v.sha ? ` · install built from \`${String(v.sha).slice(0, 12)}\`` : ""),
    `- Run: ${v.startedPT ?? v.startedAt ?? "–"} · overall **${overall}** · fail to run ${Number(v.failToRun) || 0} · ${rows.filter(failing).length} failing clause(s) of ${rows.length}`,
    `- Modules: ${mods.join(", ") || "none"}`,
    "",
    "| Module | Clause | Result | Time | Note | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (c) =>
        `| ${cell(c.issue)} | ${cell(c.clause, 200)} | **${cell(result(c))}** | ${secs(c.ms)} | ${cell(c.note)} | ${(c.evidence ?? []).map((e) => cell(basename(String(e)), 80)).join(", ")} |`,
    ),
    "",
  ];
  return { text: lines.join("\n"), rows, from, bad };
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
  const { text, rows, from, bad } = block(v);
  const refuse = (why) => {
    process.stderr.write(`refused: ${why}\n`);
    return 2;
  };
  const changed = changedModules(opt.base, opt.repo);
  const ran = (m) => rows.filter((c) => String(c.issue) === m);
  const missing = changed.filter((m) => !ran(m).length);
  if (missing.length)
    return refuse(
      `this verdict has no run of the live check(s) this pull request adds or changes: ${missing.join(", ")}. Ask the bed for a run that names them.`,
    );
  const unproven = changed.filter(
    (m) => !ran(m).some((c) => result(c) === "PASS"),
  );
  if (unproven.length)
    return refuse(
      `no PASS clause for the changed check(s) ${unproven.join(", ")}: a run where every clause was not run proves nothing.`,
    );
  if (!from && changed.length)
    return refuse(
      "the verdict has no modulesFrom commit, so its checks came from the tag, not this pull request's gate/.",
    );
  if (from) {
    if (!/^[0-9a-f]{7,40}$/.test(from))
      return refuse(
        `modulesFrom commit "${cell(from, 60)}" is not a commit id.`,
      );
    const same = spawnSync(
      "git",
      ["diff", "--quiet", from, "HEAD", "--", "gate/"],
      { cwd: opt.repo },
    ).status;
    if (same === 1)
      return refuse(
        `gate/ changed since ${from.slice(0, 12)}, the commit the run's checks came from. Ask for a run from this head.`,
      );
    if (same !== 0)
      return refuse(
        `modulesFrom commit ${from.slice(0, 12)} is not in this repo; fetch it first.`,
      );
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
