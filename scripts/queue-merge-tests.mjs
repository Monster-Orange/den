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
      with those of the test files that exist at that commit (none: green),
      in a throwaway worktree of it. On a machine with a test queue, pass
      the command through it, for example
      --run "<cli> gate run --kind cpu -- npx jest --maxWorkers=1".
      The worktree uses this checkout's node_modules: a batch that changes
      dependencies is tested against today's.`;

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
  for (const h of heads)
    if (!isAncestor(h, opt.merged)) {
      console.error(
        `queue-merge-tests: ${h} is not in ${opt.merged}: pass the merged commit`,
      );
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
  console.error(tally(fs.readFileSync(out, "utf-8")));
  return 0;
}

export function tally(list) {
  const lines = list.split("\n").filter(Boolean);
  if (lines[0]?.startsWith("ALL"))
    return "queue-merge-tests: every test (the reason is on the line above)";
  const by = new Map();
  for (const l of lines) {
    const why = l.split("  # ")[1] ?? "";
    for (const part of why.split("; ")) {
      const m = /^mapped: \S+(?: \+\d+)? \((.*)\)/.exec(part);
      const k = m ? `mapped (${m[1]})` : part.split(":")[0] || "listed";
      by.set(k, (by.get(k) ?? 0) + 1);
    }
  }
  const rows = [...by]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  ${n}  ${k}`);
  return [`queue-merge-tests: ${lines.length} tests, by reason:`, ...rows].join(
    "\n",
  );
}

export async function bisectRun({
  commits,
  tests,
  run,
  root = ROOT,
  log = () => {},
}) {
  const [cmd, ...args] = run.split(/\s+/);
  const isRed = (c) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-bisect-"));
    try {
      git(["worktree", "add", "--detach", dir, c], root);
      const here = tests.filter((t) => fs.existsSync(path.join(dir, t)));
      if (!here.length) {
        log(
          `queue-merge-tests: ${c.slice(0, 9)} green (none of the tests exist yet)`,
        );
        return false;
      }
      const mods = path.join(root, "node_modules");
      if (fs.existsSync(mods))
        fs.symlinkSync(mods, path.join(dir, "node_modules"));
      const r = spawnSync(cmd, [...args, ...here], {
        cwd: dir,
        stdio: "inherit",
      });
      log(
        `queue-merge-tests: ${c.slice(0, 9)} ${r.status === 0 ? "green" : "red"}`,
      );
      return r.status !== 0;
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: root });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  return firstRed(commits, isRed);
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
  const red = await bisectRun({
    commits,
    tests,
    run: opt.run ?? "npx jest --maxWorkers=1",
    log: (m) => console.error(m),
  });
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
