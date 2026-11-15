/**
 * Issue 189: the org-name gate also reads commit messages (history in a
 * public repo is forever). A range check in CI, a commit-msg hook locally.
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
let clean: string;
let bad: string;

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function check(args: string[], env: Record<string, string>) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

function commit(msg: string): string {
  fs.writeFileSync(path.join(repo, "f.txt"), msg);
  git("add", "f.txt");
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-commits-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git("init", "-q");
  names = path.join(dir, "names.txt");
  fs.writeFileSync(names, "# invented\nzorblaxcorp\n");
  base = commit("start");
  clean = commit("A plain change");
  bad = commit("Fix the Zorblax Corp login");
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("range check", () => {
  it("fails on a listed name, naming the commit without echoing the name", () => {
    const r = check([`${base}..${bad}`], { DEN_ORG_NAMES_FILE: names });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(bad.slice(0, 8));
    expect(r.stdout).toContain("pattern #1");
    expect(`${r.stdout}${r.stderr}`.toLowerCase()).not.toContain("zorblax");
  });

  it("passes a clean range", () => {
    const r = check([`${base}..${clean}`], { DEN_ORG_NAMES_FILE: names });
    expect(r.status).toBe(0);
  });

  it("shows the subject when the match is only in the body", () => {
    const body = commit("Tidy up\n\nasked by zorblaxcorp");
    const r = check([`${bad}..${body}`], { DEN_ORG_NAMES: "zorblaxcorp" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Tidy up");
  });

  it("fails with no patterns, like the file gate", () => {
    expect(check([`${base}..${clean}`], {}).status).toBe(2);
  });
});

describe("commit-msg hook", () => {
  const hook = path.join(ROOT, ".husky", "commit-msg");
  const run = (msg: string, env: Record<string, string>) => {
    const f = path.join(dir, "MSG");
    fs.writeFileSync(f, msg);
    return spawnSync("sh", [hook, f], {
      cwd: ROOT,
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", ...env },
    });
  };

  it("rejects a message with a listed name", () => {
    const r = run("Add zorblax-corp support\n", { DEN_ORG_NAMES_FILE: names });
    expect(r.status).toBe(1);
    expect(r.stderr.toLowerCase()).not.toContain("zorblax");
  });

  it("accepts a clean message, and ignores git's # comment lines", () => {
    const r = run("Add a thing\n# zorblaxcorp in a comment\n", {
      DEN_ORG_NAMES_FILE: names,
    });
    expect(r.status).toBe(0);
  });

  it("passes quietly with no names configured", () => {
    const r = run("Add zorblaxcorp support\n", {});
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });
});

describe("ci.yml", () => {
  it("runs the commit check on the PR range and the push range, with full history", () => {
    const ci = fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "ci.yml"),
      "utf-8",
    );
    expect(ci).toContain("scripts/org-name-commits.mjs");
    expect(ci).toContain("github.event.pull_request.base.sha");
    expect(ci).toContain("github.event.before");
    expect(ci).toMatch(/fetch-depth: 0/);
  });
});
