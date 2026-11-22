#!/usr/bin/env node
/**
 * Issue 998: split a test run into shards by measured time, so every shard
 * finishes under a limit. A shard's load is its files' seconds divided by
 * its jest workers, or its slowest file if that is longer (one file runs in
 * one worker). Files go longest-first to the least-loaded shard; the plan
 * takes the fewest shards, at least the minimum, whose loads all fit. A file
 * slower than the limit can't fit anywhere: it runs in a shard of its own
 * and is named. A file with no recorded time counts as the median.
 *
 * The times are tests/shard-times.json ({ files: { "<path>": seconds } }),
 * refreshed from the per-shard artifacts CI uploads (--merge).
 *
 *   node scripts/shard-plan.cjs --files affected.txt --count     → N
 *   node scripts/shard-plan.cjs --files affected.txt --shard 3   → shard 3's files
 *   node scripts/shard-plan.cjs --files affected.txt --summary   → the plan
 *   node scripts/shard-plan.cjs --merge out.json a.json b.json   → times from jest --json
 *
 * Options: --times <file> (tests/shard-times.json), --limit-min (9, or
 * DEN_SHARD_LIMIT_MIN), --workers (2, or DEN_TEST_WORKERS), --min (6), --max (24).
 * The same input always gives the same plan: each shard job plans alone.
 */
"use strict";
const fs = require("fs");
const path = require("path");

function median(xs) {
  if (!xs.length) return 1;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pack(files, timeOf, n, workers) {
  const shards = Array.from({ length: n }, () => ({
    files: [],
    sum: 0,
    max: 0,
  }));
  for (const f of files) {
    let best = 0;
    for (let i = 1; i < n; i++) if (shards[i].sum < shards[best].sum) best = i;
    const t = timeOf(f);
    shards[best].files.push(f);
    shards[best].sum += t;
    shards[best].max = Math.max(shards[best].max, t);
  }
  return shards.map((s) => ({
    files: s.files,
    load: Math.max(s.sum / workers, s.max),
  }));
}

/** The plan for `files`: { count, shards, loads, oversized, timeOf }. */
function plan({
  files,
  times,
  workers = 2,
  limitMin = 9,
  minShards = 6,
  maxShards = 24,
}) {
  const limit = limitMin * 60;
  const known = Object.values(times).filter((t) => typeof t === "number");
  const med = median(known);
  const timeOf = (f) => (typeof times[f] === "number" ? times[f] : med);
  const uniq = [...new Set(files)];
  // Longest first; equal times by name, so the input's order never matters.
  const sorted = uniq.sort(
    (a, b) => timeOf(b) - timeOf(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const oversized = sorted.filter((f) => timeOf(f) > limit);
  const rest = sorted.filter((f) => timeOf(f) <= limit);
  const lo = Math.max(1, minShards - oversized.length);
  const hi = Math.max(lo, maxShards - oversized.length);
  let packed = pack(rest, timeOf, lo, workers);
  for (let n = lo; n <= hi; n++) {
    packed = pack(rest, timeOf, n, workers);
    if (packed.every((s) => s.load <= limit)) break;
  }
  const all = [
    ...oversized.map((f) => ({ files: [f], load: timeOf(f) })),
    ...packed,
  ];
  return {
    count: all.length,
    shards: all.map((s) => s.files),
    loads: all.map((s) => s.load),
    oversized,
    timeOf,
  };
}

/** Per-file seconds from jest --json result files (the slowest seen wins). */
function mergeTimes(results, root) {
  const out = {};
  for (const r of results)
    for (const t of r.testResults ?? []) {
      const rel = path.relative(root, t.name).split(path.sep).join("/");
      const secs =
        Math.round(((t.endTime ?? 0) - (t.startTime ?? 0)) / 100) / 10;
      if (secs > 0) out[rel] = Math.max(out[rel] ?? 0, secs);
    }
  return out;
}

function arg(argv, name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}

function main(argv) {
  const root = process.cwd();
  if (argv[0] === "--merge") {
    const [out, ...ins] = argv.slice(1);
    const prev = fs.existsSync(out)
      ? (JSON.parse(fs.readFileSync(out, "utf-8")).files ?? {})
      : {};
    const files = {
      ...prev,
      ...mergeTimes(
        ins.map((f) => JSON.parse(fs.readFileSync(f, "utf-8"))),
        root,
      ),
    };
    const sorted = Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((k) => [k, files[k]]),
    );
    fs.writeFileSync(out, JSON.stringify({ files: sorted }, null, 2) + "\n");
    return;
  }
  const list = fs
    .readFileSync(arg(argv, "--files"), "utf-8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const timesFile = arg(
    argv,
    "--times",
    path.join(root, "tests", "shard-times.json"),
  );
  const times = fs.existsSync(timesFile)
    ? (JSON.parse(fs.readFileSync(timesFile, "utf-8")).files ?? {})
    : {};
  const p = plan({
    files: list,
    times,
    workers: Number(arg(argv, "--workers", process.env.DEN_TEST_WORKERS || 2)),
    limitMin: Number(
      arg(argv, "--limit-min", process.env.DEN_SHARD_LIMIT_MIN || 9),
    ),
    minShards: Number(arg(argv, "--min", 6)),
    maxShards: Number(arg(argv, "--max", 24)),
  });
  if (argv.includes("--count")) {
    process.stdout.write(`${p.count}\n`);
  } else if (arg(argv, "--shard")) {
    const i = Number(arg(argv, "--shard")) - 1;
    const files = p.shards[i] ?? [];
    process.stdout.write(files.length ? files.join("\n") + "\n" : "");
  } else {
    const lines = p.shards.map(
      (s, i) =>
        `shard ${i + 1}: ${s.length} files, ~${(p.loads[i] / 60).toFixed(1)} min`,
    );
    for (const f of p.oversized)
      lines.push(
        `too slow for any shard, runs alone: ${f} (~${(p.timeOf(f) / 60).toFixed(1)} min)`,
      );
    process.stdout.write(lines.join("\n") + "\n");
  }
}

module.exports = { plan, mergeTimes };
if (require.main === module) main(process.argv.slice(2));
