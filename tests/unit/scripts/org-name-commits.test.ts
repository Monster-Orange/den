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
        DEN_ROOT: ROOT,
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

  it("fails closed when a names file is set but missing", () => {
    const r = push(`refs/heads/x ${clean} refs/heads/x ${base}\n`, {
      DEN_ORG_NAMES_FILE: path.join(dir, "missing.txt"),
    });
    expect(r.status).not.toBe(0);
  });
});

describe("issue 528: a per-user names file set but broken fails (never passes quietly)", () => {
  const hookMsg = path.join(ROOT, ".husky", "commit-msg");
  const hookPush = path.join(ROOT, ".husky", "pre-push");
  const GATE = path.join(ROOT, "scripts", "org-name-gate.mjs");
  const BROKEN =
    /is set but has no patterns \(a broken link, or empty\); fix it or remove it/;
  let n = 0;
  // A temp HOME whose ~/.config/den-dev/org-names.txt is what `make` leaves.
  const homeWith = (make: (file: string) => void) => {
    const h = path.join(dir, `h528-${n++}`);
    const d = path.join(h, ".config", "den-dev");
    fs.mkdirSync(d, { recursive: true });
    make(path.join(d, "org-names.txt"));
    return h;
  };
  const dangling = () =>
    homeWith((f) => fs.symlinkSync(path.join(dir, "gone-528.txt"), f));
  const empty = () =>
    homeWith((f) => fs.writeFileSync(f, "# only a comment\n\n"));
  const none = () => homeWith(() => {});
  const good = () => homeWith((f) => fs.writeFileSync(f, "acme-secret\n"));
  const env = (h: string, more: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? "",
    HOME: h,
    XDG_CONFIG_HOME: path.join(h, ".config"),
    ...more,
  });
  const msg = (h: string) => {
    const f = path.join(dir, "MSG528");
    fs.writeFileSync(f, "A plain change\n");
    return spawnSync("sh", [hookMsg, f], {
      cwd: ROOT,
      encoding: "utf-8",
      env: env(h),
    });
  };
  const push = (h: string) =>
    spawnSync("sh", [hookPush, "origin", "git@example.com:x/y.git"], {
      cwd: repo,
      input: `refs/heads/x ${clean} refs/heads/x ${base}\n`,
      encoding: "utf-8",
      env: env(h, { DEN_ROOT: ROOT, DEN_PREPUSH_FILES: "0" }),
    });
  const gate = (args: string[], h: string, more: Record<string, string> = {}) =>
    spawnSync("node", [GATE, ...args], {
      cwd: ROOT,
      encoding: "utf-8",
      env: env(h, more),
    });

  it("commit-msg: a dangling link fails with the broken-file message", () => {
    const r = msg(dangling());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(BROKEN);
  });

  it("commit-msg: a file with no patterns fails", () => {
    const r = msg(empty());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(BROKEN);
  });

  it("commit-msg: no file still passes quietly", () => {
    const r = msg(none());
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("pre-push: a dangling link fails with the broken-file message", () => {
    const r = push(dangling());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(BROKEN);
  });

  it("pre-push: a file with no patterns fails", () => {
    const r = push(empty());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(BROKEN);
  });

  it("pre-push: no file still passes quietly", () => {
    const r = push(none());
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("the file gate fails on a broken file with the message, naming the path", () => {
    const h = empty();
    const r = gate([], h);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(BROKEN);
    expect(r.stderr).toContain(
      path.join(h, ".config", "den-dev", "org-names.txt"),
    );
  });

  it("CI's path is unchanged: the variables win over a broken user file, and no patterns exit 2", () => {
    const h = dangling();
    const emptyFile = path.join(dir, "empty-528.txt");
    fs.writeFileSync(emptyFile, "\n");
    const viaVar = check([`${base}..${clean}`], {
      ...env(h),
      DEN_ORG_NAMES: "acme-secret",
    });
    expect(viaVar.status).toBe(0);
    const r1 = check([`${base}..${clean}`], {
      ...env(h),
      DEN_ORG_NAMES_FILE: emptyFile,
    });
    expect(r1.status).toBe(2);
    expect(r1.stderr).not.toMatch(BROKEN);
    const r2 = gate([], h, { DEN_ORG_NAMES: "" });
    expect(r2.status).toBe(2);
    expect(r2.stderr).not.toMatch(BROKEN);
  });

  it("--check-file names the case and the count, never the patterns", () => {
    const ok = gate(["--check-file"], good());
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/\b1 pattern\b/);
    expect(ok.stdout + ok.stderr).not.toContain("acme");
    const d = gate(["--check-file"], dangling());
    expect(d.status).toBe(1);
    expect(d.stdout + d.stderr).toMatch(/broken link/);
    const e = gate(["--check-file"], empty());
    expect(e.status).toBe(1);
    expect(e.stdout + e.stderr).toMatch(/0 patterns/);
    const z = gate(["--check-file"], none());
    expect(z.status).toBe(3);
    expect(z.stdout).toMatch(/no names file/);
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
