#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `The tests a queue merge runs on the merged tree, before it is pushed.

  node scripts/queue-merge-tests.mjs plan --queue <the queue before the merge> --merged <commit> <pr-head>... [--out <file>]
      The affected tests of everything between the oldest pull request's
      fork point from the queue and the merged commit: each pull request's
      own files, and every file the queue changed since it went green (a
      test added there runs as a changed test). One pull request, or a
      batch merged in order.

  node scripts/queue-merge-tests.mjs bisect --tests <file> [--run <command>] <merged commit>...
      The merged commits of a batch, in merge order, and the tests that
      failed on the last one: the first commit they fail on, found by
      halving. Each step runs <command> (default: npx jest --maxWorkers=1)
      with the test files, in a throwaway worktree of that commit.`;

function git(args, cwd = ROOT) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
  return r.stdout.trim();
}

const isAncestor = (a, b, cwd) =>
  spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd }).status === 0;

export function oldestForkPoint(queue, heads, cwd = ROOT) {
  if (!heads.length) throw new Error("no pull request heads");
  for (const h of heads)
    if (isAncestor(h, queue, cwd))
      throw new Error(
        `${h} is already in ${queue}: pass the queue as it was before the merge`,
      );
  const points = heads.map((h) => git(["merge-base", queue, h], cwd));
  let oldest = points[0];
  for (const p of points.slice(1)) {
    if (isAncestor(p, oldest, cwd)) oldest = p;
    else if (!isAncestor(oldest, p, cwd))
      oldest = git(["merge-base", oldest, p], cwd);
  }
  return oldest;
}

export function changedFiles(base, merged, cwd = ROOT) {
  return git(["diff", "--name-only", "--no-renames", base, merged], cwd)
    .split("\n")
    .filter(Boolean);
}

export async function firstRed(commits, isRed) {
  if (!commits.length) return null;
  if (!(await isRed(commits[commits.length - 1]))) return null;
  let lo = 0;
  let hi = commits.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await isRed(commits[mid])) hi = mid;
    else lo = mid + 1;
  }
  return commits[lo];
}

function parse(argv) {
  const opt = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) opt[k.slice(2)] = argv[++i];
    else pos.push(k);
  }
  return { opt, pos };
}

function plan(opt, heads) {
  if (!opt.queue || !opt.merged || !heads.length) {
    console.error(USAGE);
    return 2;
  }
  const base = oldestForkPoint(opt.queue, heads);
  const out =
    opt.out ?? path.join(os.tmpdir(), `queue-merge-${process.pid}.txt`);
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "affected-tests.mjs"),
      base,
      opt.merged,
      "--out",
      out,
    ],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (r.status !== 0) return r.status ?? 1;
  const changed = changedFiles(base, opt.merged);
  console.error(
    `queue-merge-tests: ${changed.length} files changed since ${base.slice(0, 9)} (the oldest fork point); tests in ${out}`,
  );
  return 0;
}

async function bisect(opt, commits) {
  if (!opt.tests || !commits.length) {
    console.error(USAGE);
    return 2;
  }
  const tests = fs
    .readFileSync(opt.tests, "utf-8")
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
  if (!tests.length) {
    console.error("queue-merge-tests: the test list is empty");
    return 2;
  }
  const [cmd, ...args] = (opt.run ?? "npx jest --maxWorkers=1").split(/\s+/);
  const isRed = (c) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-bisect-"));
    try {
      git(["worktree", "add", "--detach", dir, c]);
      const mods = path.join(ROOT, "node_modules");
      if (fs.existsSync(mods))
        fs.symlinkSync(mods, path.join(dir, "node_modules"));
      const r = spawnSync(cmd, [...args, ...tests], {
        cwd: dir,
        stdio: "inherit",
      });
      console.error(
        `queue-merge-tests: ${c.slice(0, 9)} ${r.status === 0 ? "green" : "red"}`,
      );
      return r.status !== 0;
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: ROOT });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const red = await firstRed(commits, isRed);
  console.log(red ?? "none");
  return red ? 1 : 0;
}

export async function main(argv) {
  const [mode, ...rest] = argv;
  const { opt, pos } = parse(rest);
  if (mode === "plan") return plan(opt, pos);
  if (mode === "bisect") return bisect(opt, pos);
  console.error(USAGE);
  return 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
