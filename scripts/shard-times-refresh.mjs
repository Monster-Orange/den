#!/usr/bin/env node
/**
 * Issue 845, clause 1: refresh tests/shard-times.json (the measured times
 * scripts/shard-plan.cjs plans shards from) from the full-suite runs of
 * what lands on main, and check that the shards stay balanced.
 *
 * The runs: the last green ci.yml runs on a branch (the staging pull
 * request from next/queue: a version change makes it run every test in
 * shards) that uploaded at least --min-shards shard-times artifacts.
 *
 * - Each file's time is its median over those runs (one slow run doesn't
 *   move it); a file the runs never measured keeps its old time; a file no
 *   longer in the repo drops out. CI's absolute paths become repo paths.
 * - Each shard's p90 comes from its job's seconds over the runs (nearest
 *   rank). Balanced: the slowest shard's p90 is at most 20% over the
 *   fastest's. --check exits 1 when it isn't.
 *
 *   node scripts/shard-times-refresh.mjs --branch next/queue [--runs 5]
 *     [--min-shards 6] [--out tests/shard-times.json] [--summary <file>]
 *     [--check]
 *
 * Reads GitHub with `gh` (GH_TOKEN in CI): run lists, artifacts and jobs.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- pure parts (unit-tested) ---------------------------------------------

/** A jest result's file name as a repo path ("tests/…"), or null. */
export function repoPath(name) {
  const s = String(name ?? "").replaceAll("\\", "/");
  if (s.startsWith("tests/")) return s;
  const i = s.lastIndexOf("/tests/");
  return i >= 0 ? s.slice(i + 1) : null;
}

/** One run's times, from all its shards' jest --json reports: each file's longest. */
export function runTimes(reports) {
  const out = {};
  for (const r of reports)
    for (const t of r?.testResults ?? []) {
      const rel = repoPath(t.name);
      const secs =
        Math.round(((t.endTime ?? 0) - (t.startTime ?? 0)) / 100) / 10;
      if (rel && secs > 0) out[rel] = Math.max(out[rel] ?? 0, secs);
    }
  return out;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}

/**
 * The refreshed times file: each existing test's median over `runs` (a
 * list of { file: seconds }), its old time when no run measured it, and
 * nothing for a file not in `existing`. Sorted by path.
 */
export function refreshTimes(old, runs, existing) {
  const keep = new Set(existing);
  const seen = {};
  for (const r of runs)
    for (const [f, s] of Object.entries(r))
      if (keep.has(f)) (seen[f] ??= []).push(s);
  const files = {};
  for (const f of [...keep].sort()) {
    if (seen[f]) files[f] = median(seen[f]);
    else if (old?.files?.[f] !== undefined) files[f] = old.files[f];
  }
  return { files };
}

/** Each shard's p90 (nearest rank) over the runs: `runs` is [{ shard: seconds }]. */
export function shardP90s(runs) {
  const by = {};
  for (const r of runs)
    for (const [k, s] of Object.entries(r)) (by[k] ??= []).push(s);
  const out = {};
  for (const [k, xs] of Object.entries(by)) {
    const s = [...xs].sort((a, b) => a - b);
    out[k] = s[Math.max(0, Math.ceil(0.9 * s.length) - 1)];
  }
  return out;
}

/**
 * Whether the shards are balanced: the slowest p90 at most 20% over the
 * fastest. Fewer than two shards: ok null (nothing compared, never a pass).
 */
export function balance(p90s, limitPct = 20) {
  const rows = Object.entries(p90s);
  if (rows.length < 2)
    return { ok: null, spreadPct: 0, slowest: null, fastest: null };
  rows.sort((a, b) => a[1] - b[1]);
  const [fastest, lo] = rows[0];
  const [slowest, hi] = rows[rows.length - 1];
  const spreadPct = Math.round(((hi - lo) / lo) * 1000) / 10;
  return { ok: spreadPct <= limitPct, spreadPct, slowest, fastest };
}

/** The summary: the runs used, each shard's p90, and the verdict. */
export function summaryMarkdown(runIds, p90s, verdict, changed) {
  const lines = [
    "### Shard times (issue 845)",
    "",
    `Runs: ${runIds.join(", ") || "none"}. Files with a new time: ${changed}.`,
    "",
    "| Shard | p90 |",
    "| --- | --- |",
    ...Object.entries(p90s)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(
        ([k, s]) =>
          `| ${k} | ${Math.floor(s / 60)} min ${Math.round(s % 60)} s |`,
      ),
    "",
    verdict.ok === null
      ? "**Balance:** fewer than two shards measured; nothing compared."
      : `**Balance:** ${verdict.ok ? "ok" : "over the limit"}: shard ${verdict.slowest}'s p90 is ${verdict.spreadPct}% over shard ${verdict.fastest}'s (limit 20%).`,
    "",
  ];
  return lines.join("\n");
}

// --- GitHub (gh) ------------------------------------------------------------

function gh(args) {
  return execFileSync("gh", args, {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The pr-shards jobs' seconds, by shard number, for one run. */
function shardSeconds(repo, id) {
  const jobs = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/actions/runs/${id}/jobs?per_page=100`,
    ]),
  ).flatMap((p) => p.jobs ?? []);
  const out = {};
  for (const j of jobs) {
    const m = /^pr-shards \(.*?, (\d+)\)$/.exec(j.name ?? "");
    if (!m || j.conclusion !== "success") continue;
    out[m[1]] = Math.round(
      (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000,
    );
  }
  return out;
}

function arg(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}

export function main(argv) {
  const branch = arg(argv, "--branch", "");
  const want = Number(arg(argv, "--runs", "5"));
  const minShards = Number(arg(argv, "--min-shards", "6"));
  const out = arg(argv, "--out", path.join(ROOT, "tests", "shard-times.json"));
  const summary = arg(argv, "--summary", "");
  if (!branch || !(want > 0) || !(minShards > 1)) {
    console.error(
      "usage: shard-times-refresh.mjs --branch <name> [--runs 5] [--min-shards 6] [--out file] [--summary file] [--check]",
    );
    return 2;
  }
  const repo = gh([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).trim();
  const candidates = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow",
      "ci.yml",
      "--branch",
      branch,
      "--status",
      "success",
      "--limit",
      "40",
      "--json",
      "databaseId",
    ]),
  ).map((r) => r.databaseId);
  const used = [];
  const times = [];
  const shards = [];
  for (const id of candidates) {
    if (used.length >= want) break;
    const names = JSON.parse(
      gh(["api", `repos/${repo}/actions/runs/${id}/artifacts?per_page=100`]),
    )
      .artifacts.map((a) => a.name)
      .filter((n) => /^shard-times-\d+$/.test(n));
    if (names.length < minShards) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-shard-times-"));
    try {
      gh(["run", "download", String(id), "-p", "shard-times-*", "-D", dir]);
      const reports = [];
      for (const sub of fs.readdirSync(dir))
        for (const f of fs.readdirSync(path.join(dir, sub)))
          if (f.endsWith(".json"))
            reports.push(
              JSON.parse(fs.readFileSync(path.join(dir, sub, f), "utf-8")),
            );
      times.push(runTimes(reports));
      shards.push(shardSeconds(repo, id));
      used.push(id);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!used.length) {
    console.error(
      `no green full-suite run on ${branch} with ${minShards}+ shard-times artifacts`,
    );
    return 1;
  }
  const old = fs.existsSync(out)
    ? JSON.parse(fs.readFileSync(out, "utf-8"))
    : { files: {} };
  const existing = execFileSync("git", ["ls-files", "tests"], {
    cwd: ROOT,
    encoding: "utf-8",
  })
    .split("\n")
    .filter((f) => /\.test\.ts$/.test(f));
  const next = refreshTimes(old, times, existing);
  const changed = Object.keys(next.files).filter(
    (f) => next.files[f] !== old.files?.[f],
  ).length;
  fs.writeFileSync(out, JSON.stringify(next, null, 2) + "\n");
  const p90s = shardP90s(shards);
  const verdict = balance(p90s);
  const md = summaryMarkdown(used, p90s, verdict, changed);
  console.log(md);
  if (summary) fs.appendFileSync(summary, md);
  return argv.includes("--check") && verdict.ok === false ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
