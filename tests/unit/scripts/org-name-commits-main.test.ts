/**
 * The org-name range check skips commits already on origin/main: they are
 * public and can't be reworded ("nothing already on main is rewritten").
 * A merge of main into a work branch brings main's own merge commits into
 * the pushed range; only the commits that are new must pass. Invented
 * names only, in a temp names file.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-commits-main-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "work");
  names = path.join(dir, "names.txt");
  fs.writeFileSync(names, "# invented\nzorblaxcorp\n");
  base = commit("start");
  // main moves on with a merge commit whose subject names the org, as a
  // hosted merge button writes it.
  git("checkout", "-q", "-b", "main");
  const onMain = commit("Merge pull request #7 from Zorblax Corp/rel", "m.txt");
  git("update-ref", "refs/remotes/origin/main", onMain);
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
    "Merge main into work",
    "main",
  );
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("commits already on origin/main", () => {
  it("are skipped when a merge of main brings them into the range", () => {
    const r = check(`${base}..HEAD`);
    expect(r.stdout + r.stderr).not.toMatch(/with a hit/);
    expect(r.status).toBe(0);
  });

  it("still leave a new commit with a listed name failing", () => {
    commit("Fix the Zorblax Corp login", "n.txt");
    const r = check(`${base}..HEAD`);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(
      /1 commit message\(s\) with a hit|matches pattern/,
    );
    expect(r.stderr).toMatch(/1 commit message\(s\) with a hit/);
  });
});
