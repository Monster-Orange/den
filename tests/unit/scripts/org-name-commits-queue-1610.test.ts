/**
 * Issue 1610: the org-name range check skips commits already on
 * origin/next/queue as well as origin/main. A hosted merge button's commit
 * on the merge queue's branch is as public as one on main and can't be
 * reworded; a merge of the queue into a work branch brings it into the
 * pushed range. Any other branch's commits are still checked, pushed or not,
 * so a bad commit pushed once to a feature branch never passes for good.
 * Invented names only, in a temp names file.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "org-name-commits.mjs");

let dir: string;
let repo: string;
let names: string;
let base: string;

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function check(range: string) {
  return spawnSync("node", [SCRIPT, range], {
    cwd: repo,
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", DEN_ORG_NAMES_FILE: names },
  });
}

function commit(msg: string, file = "f.txt"): string {
  fs.writeFileSync(path.join(repo, file), msg);
  git("add", file);
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    msg,
  );
  return git("rev-parse", "HEAD");
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-commits-queue-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "work");
  names = path.join(dir, "names.txt");
  fs.writeFileSync(names, "# invented\nzorblaxcorp\n");
  base = commit("start");
  git("update-ref", "refs/remotes/origin/main", base);
  // The queue moves on with a merge commit whose subject names the org, as
  // a hosted merge button writes it. main hasn't got it.
  git("checkout", "-q", "-b", "queue");
  const onQueue = commit(
    "Merge pull request #7 from Zorblax Corp/rel",
    "q.txt",
  );
  git("update-ref", "refs/remotes/origin/next/queue", onQueue);
  git("checkout", "-q", "work");
  commit("A plain change on the work branch", "w.txt");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge the queue into work",
    "queue",
  );
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("issue 1610: commits already on the queue's remote branch", () => {
  it("are skipped when a merge of the queue brings them into the range", () => {
    const r = check(`${base}..HEAD`);
    expect(r.stdout + r.stderr).not.toMatch(/with a hit/);
    expect(r.status).toBe(0);
  });

  it("still leave a new commit with a listed name failing", () => {
    commit("Fix the Zorblax Corp login", "n.txt");
    const r = check(`${base}..HEAD`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/1 commit message\(s\) with a hit/);
  });

  it("a hit on another branch already pushed is still caught when merged in", () => {
    const before = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "feat", base);
    const onFeat = commit("Wire the Zorblax Corp sign-in", "x.txt");
    git("update-ref", "refs/remotes/origin/feat/x", onFeat);
    git("checkout", "-q", "work");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "Merge feat into work",
      "feat",
    );
    const r = check(`${before}..HEAD`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/1 commit message\(s\) with a hit/);
  });
});
