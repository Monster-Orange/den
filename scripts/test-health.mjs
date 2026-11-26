#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PAGES = 10;
const ms = (s) => (s ? Date.parse(s) : NaN);
const day = (d) => d.toISOString().slice(0, 10);
const min = (x) => (x == null ? null : Math.round(x / 6000) / 10);

export function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[
    Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length))) - 1
  ];
}

function spread(xs) {
  return { p50Min: min(pct(xs, 50)), p90Min: min(pct(xs, 90)) };
}

async function dayRuns(api, repo, date) {
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await api(
      `repos/${repo}/actions/runs?event=pull_request&created=${date}&per_page=100&page=${page}`,
    );
    const got = r?.workflow_runs ?? [];
    runs.push(...got);
    if (got.length < 100) return { runs, capped: false };
  }
  return { runs, capped: true };
}

async function prRuns(api, repo, since, until) {
  const runs = [];
  let capped = false;
  for (
    let d = new Date(`${since}T00:00:00Z`);
    day(d) <= until;
    d = new Date(d.getTime() + 86_400_000)
  ) {
    const r = await dayRuns(api, repo, day(d));
    runs.push(...r.runs);
    capped ||= r.capped;
  }
  return { runs, capped };
}

const jobsOf = async (api, repo, id, attempt) =>
  (
    await api(
      `repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`,
    )
  )?.jobs ?? [];

function prTime(done) {
  const heads = new Map();
  for (const r of done) {
    const h = heads.get(r.head_sha) ?? { from: Infinity, to: -Infinity };
    h.from = Math.min(h.from, ms(r.created_at));
    h.to = Math.max(h.to, ms(r.updated_at));
    heads.set(r.head_sha, h);
  }
  return [...heads.values()].map((h) => h.to - h.from).filter((x) => x >= 0);
}

function firstRedOf(jobs) {
  const failed = jobs
    .filter((j) => j.conclusion === "failure")
    .map((j) => ms(j.completed_at));
  const started = jobs
    .map((j) => ms(j.started_at))
    .filter((x) => !Number.isNaN(x));
  if (!failed.length || !started.length) return null;
  return Math.min(...failed) - Math.min(...started);
}

function bedWall(dir, sinceMs, untilMs) {
  if (!dir) return null;
  const walls = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const f = path.join(dir, name, "verdict.json");
    if (!fs.existsSync(f)) continue;
    let v;
    try {
      v = JSON.parse(fs.readFileSync(f, "utf-8"));
    } catch {
      continue;
    }
    const at = ms(v.startedAt);
    if (at >= sinceMs && at < untilMs && Number.isFinite(v.wallMs))
      walls.push(v.wallMs);
  }
  return {
    runs: walls.length,
    ...spread(walls),
    longestMin: walls.length ? min(Math.max(...walls)) : null,
  };
}

export async function health({
  api,
  repo,
  now = new Date(),
  days = 7,
  bedDir = null,
  brittle,
}) {
  const sinceDate = new Date(now.getTime() - days * 86_400_000);
  const since = day(sinceDate);
  const { runs, capped } = await prRuns(api, repo, since, day(now));
  const done = runs.filter((r) => r.status === "completed");

  const reds = [];
  const flakyJobs = new Set();
  let flakyRuns = 0;
  for (const r of done) {
    const needFirst = r.conclusion === "failure" || (r.run_attempt ?? 1) > 1;
    if (!needFirst) continue;
    const first = await jobsOf(api, repo, r.id, 1);
    const red = firstRedOf(first);
    if (red != null) reds.push(red);
    if ((r.run_attempt ?? 1) > 1) {
      const last = await jobsOf(api, repo, r.id, r.run_attempt);
      const passed = new Set(
        last.filter((j) => j.conclusion === "success").map((j) => j.name),
      );
      const flaky = first.filter(
        (j) => j.conclusion === "failure" && passed.has(j.name),
      );
      for (const j of flaky) flakyJobs.add(j.name);
      if (flaky.length) flakyRuns++;
    }
  }

  const times = prTime(done);
  return {
    window: { since, until: day(now) },
    pr: { heads: times.length, ...spread(times), capped },
    firstRed: { runs: reds.length, ...spread(reds) },
    flakes: {
      runs: done.length,
      flakyRuns,
      flakyJobs: [...flakyJobs].sort(),
      rate: done.length ? flakyRuns / done.length : null,
    },
    bed: bedWall(bedDir, sinceDate.getTime(), now.getTime()),
    brittle: brittle ? brittle() : null,
  };
}

const m = (x) => (x == null ? "none" : `${x.toFixed(1)} min`);

export function markdown(h) {
  const b = h.bed;
  const total = h.brittle
    ? Object.values(h.brittle).reduce((a, n) => a + n, 0)
    : null;
  const rows = [
    [
      "PR CI time",
      m(h.pr.p50Min),
      m(h.pr.p90Min),
      `${h.pr.heads} heads${h.pr.capped ? " (a day over 1000 runs: cut)" : ""}`,
    ],
    [
      "Time to first red",
      m(h.firstRed.p50Min),
      m(h.firstRed.p90Min),
      `${h.firstRed.runs} red runs`,
    ],
    [
      "Flake rate",
      h.flakes.rate == null ? "none" : `${Math.round(h.flakes.rate * 100)}%`,
      `${h.flakes.flakyRuns} of ${h.flakes.runs} runs`,
      h.flakes.flakyJobs.join(", ") || "no job passed on a re-run",
    ],
    b
      ? [
          "Live-check bed wall time",
          m(b.p50Min),
          m(b.p90Min),
          `${b.runs} bed runs, longest ${m(b.longestMin)}`,
        ]
      : [
          "Live-check bed wall time",
          "not read here",
          "",
          "the bed's runs are on the bed machine: pass --bed <folder>",
        ],
    [
      "Brittle patterns",
      total == null ? "not read" : String(total),
      "",
      h.brittle
        ? Object.entries(h.brittle)
            .map(([k, n]) => `${k} ${n}`)
            .join(", ")
        : "",
    ],
  ];
  return [
    `## Test health, ${h.window.since} to ${h.window.until}`,
    "",
    "| Measure | p50 | p90 | Notes |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    "PR CI time: a head's first pull-request run created to its last run finished. " +
      "Time to first red: a red run's first job start to its first failed job's end. " +
      "Flake rate: finished runs with a job that failed, then passed on a re-run.",
  ].join("\n");
}

function brittleTotals(root) {
  const r = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "brittle-ratchet.mjs"), "--report", "--json"],
    {
      cwd: root,
      encoding: "utf-8",
    },
  );
  if (r.status !== 0)
    throw new Error(
      `brittle-ratchet --report exited ${r.status}: ${r.stderr.trim()}`,
    );
  return JSON.parse(r.stdout).totals;
}

async function main(argv) {
  const opt = {
    days: 7,
    bed: null,
    json: false,
    repo: process.env.GITHUB_REPOSITORY ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") opt.repo = argv[++i];
    else if (a === "--days") opt.days = Number(argv[++i]);
    else if (a === "--bed") opt.bed = argv[++i];
    else if (a === "--json") opt.json = true;
    else {
      console.error(`test-health: unknown argument ${a}`);
      return 2;
    }
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error(
      "test-health: needs GITHUB_TOKEN, with read access to the repo's Actions",
    );
    return 2;
  }
  if (!opt.repo || !/^[\w.-]+\/[\w.-]+$/.test(opt.repo)) {
    console.error(
      "test-health: needs --repo owner/name (or GITHUB_REPOSITORY)",
    );
    return 2;
  }
  if (!Number.isInteger(opt.days) || opt.days < 1 || opt.days > 90) {
    console.error("test-health: --days is a whole number from 1 to 90");
    return 2;
  }
  const api = async (p) => {
    const r = await fetch(`https://api.github.com/${p}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
      },
    });
    if (!r.ok) throw new Error(`GET ${p.split("?")[0]}: ${r.status}`);
    return r.json();
  };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const h = await health({
    api,
    repo: opt.repo,
    days: opt.days,
    bedDir: opt.bed,
    brittle: () => brittleTotals(root),
  });
  console.log(opt.json ? JSON.stringify(h, null, 2) : markdown(h));
  return 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`test-health: ${e.message}`);
      process.exit(1);
    },
  );
