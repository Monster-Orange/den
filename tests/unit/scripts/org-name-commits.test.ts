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

describe("the names file without the variable (a per-user file)", () => {
  const home = () => {
    const h = path.join(dir, "home");
    fs.mkdirSync(path.join(h, ".config", "den-dev"), { recursive: true });
    fs.copyFileSync(names, path.join(h, ".config", "den-dev", "org-names.txt"));
    return h;
  };

  it("range check: reads ~/.config/den-dev/org-names.txt when no variable is set", () => {
    const r = check([`${base}..${bad}`], { HOME: home() });
    expect(r.status).toBe(1);
  });

  it("XDG_CONFIG_HOME wins over HOME", () => {
    const h = home();
    const r = check([`${base}..${bad}`], {
      HOME: path.join(dir, "nowhere"),
      XDG_CONFIG_HOME: path.join(h, ".config"),
    });
    expect(r.status).toBe(1);
  });
});

describe("pre-push hook", () => {
  const hook = path.join(ROOT, ".husky", "pre-push");
  const Z = "0".repeat(40);
  const push = (lines: string, env: Record<string, string>) =>
    spawnSync("sh", [hook, "origin", "git@example.com:x/y.git"], {
      cwd: repo,
      input: lines,
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH ?? "",
        DEN_HOOK_ROOT: ROOT,
        DEN_PREPUSH_FILES: "0",
        ...env,
      },
    });

  it("refuses a push whose new commits name an org", () => {
    const r = push(`refs/heads/x ${bad} refs/heads/x ${base}\n`, {
      DEN_ORG_NAMES_FILE: names,
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`.toLowerCase()).not.toContain("zorblax");
  });

  it("checks a brand-new branch too (no remote tip): from where it left main", () => {
    git("update-ref", "refs/remotes/origin/main", base);
    const r = push(`refs/heads/new ${bad} refs/heads/new ${Z}\n`, {
      DEN_ORG_NAMES_FILE: names,
    });
    expect(r.status).not.toBe(0);
  });

  it("lets a clean push through, and a branch delete", () => {
    expect(
      push(`refs/heads/x ${clean} refs/heads/x ${base}\n`, {
        DEN_ORG_NAMES_FILE: names,
      }).status,
    ).toBe(0);
    expect(
      push(`(delete) ${Z} refs/heads/x ${clean}\n`, {
        DEN_ORG_NAMES_FILE: names,
      }).status,
    ).toBe(0);
  });

  it("passes quietly with no names configured (a contributor's machine)", () => {
    const r = push(`refs/heads/x ${bad} refs/heads/x ${base}\n`, {});
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("ignores DEN_ROOT, which names a distribution, not the checkout (issue 1252)", () => {
    const r = push(`refs/heads/x ${clean} refs/heads/x ${base}\n`, {
      DEN_ORG_NAMES_FILE: names,
      DEN_ROOT: path.join(dir, "a-distribution"),
    });
    expect(r.stderr).not.toContain("can't be read");
    expect(r.status).toBe(0);
  });

  describe("as an agent runs it: no DEN_HOOK_ROOT, DEN_ROOT set elsewhere (issue 1252)", () => {
    let scripts: string;
    const agentPush = (lines: string) =>
      spawnSync("sh", [hook, "origin", "git@example.com:x/y.git"], {
        cwd: repo,
        input: lines,
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH ?? "",
          DEN_ROOT: path.join(dir, "a-distribution"),
          DEN_PREPUSH_FILES: "0",
          DEN_ORG_NAMES_FILE: names,
        },
      });

    beforeAll(() => {
      // The checkout's top level carries the gates, as a real clone does.
      scripts = path.join(repo, "scripts");
      fs.mkdirSync(scripts, { recursive: true });
      for (const f of ["org-names.js", "org-name-commits.mjs"]) {
        fs.copyFileSync(path.join(ROOT, "scripts", f), path.join(scripts, f));
      }
    });
    afterAll(() => fs.rmSync(scripts, { recursive: true, force: true }));

    it("refuses a commit that names an org", () => {
      const r = agentPush(`refs/heads/x ${bad} refs/heads/x ${base}\n`);
      expect(r.stderr).not.toContain("can't be read");
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`.toLowerCase()).not.toContain("zorblax");
    });

    it("lets a clean commit through", () => {
      const r = agentPush(`refs/heads/x ${clean} refs/heads/x ${base}\n`);
      expect(r.status).toBe(0);
    });
  });

  it("fails closed when a names file is set but missing", () => {
    const r = push(`refs/heads/x ${clean} refs/heads/x ${base}\n`, {
      DEN_ORG_NAMES_FILE: path.join(dir, "missing.txt"),
    });
    expect(r.status).not.toBe(0);
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
