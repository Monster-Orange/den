import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "changelog-line.mjs");

const BASE_LOG = [
  "# Changelog",
  "",
  "## [0.4.91] - unreleased",
  "",
  "- An unreleased line.",
  "- A second unreleased line.",
  "- A third unreleased line.",
  "- A fourth unreleased line.",
  "",
  "## [0.4.90] - 2026-11-25",
  "",
  "- A released line.",
  "",
].join("\n");

const repos: string[] = [];
afterEach(() => {
  for (const d of repos.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(dir: string, ...a: string[]) {
  return execFileSync("git", a, {
    cwd: dir,
    encoding: "utf-8",
    env: GIT_ENV,
  }).trim();
}

function log(dir: string) {
  return fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8");
}

function setLog(dir: string, text: string) {
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), text);
}

function commit(dir: string, msg: string) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", msg);
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-changelog-placed-"));
  repos.push(dir);
  git(dir, "init", "-q", "-b", "queue");
  git(dir, "config", "commit.gpgsign", "false");
  setLog(dir, BASE_LOG);
  commit(dir, "base");
  return dir;
}

function merge(
  dir: string,
  onQueue: (t: string) => string,
  onBranch: (t: string) => string,
  settle?: (t: string) => string,
) {
  git(dir, "switch", "-q", "-c", "pr");
  setLog(dir, onBranch(log(dir)));
  commit(dir, "pr");
  git(dir, "switch", "-q", "queue");
  setLog(dir, onQueue(log(dir)));
  commit(dir, "queue");
  const r = spawnSync("git", ["merge", "-q", "--no-ff", "--no-edit", "pr"], {
    cwd: dir,
    encoding: "utf-8",
    env: GIT_ENV,
  });
  if (r.status !== 0) {
    if (!settle) throw new Error(`merge conflicted: ${r.stdout}${r.stderr}`);
    setLog(dir, settle(log(dir)));
    commit(dir, "settled");
  }
  return placed(dir, "HEAD^1..HEAD");
}

function placed(dir: string, range: string) {
  const r = spawnSync("node", [SCRIPT, "--placed", range], {
    cwd: dir,
    encoding: "utf-8",
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const after = (line: string, add: string) => (t: string) =>
  t.replace(`${line}\n`, `${line}\n${add}\n`);

const release = (t: string) =>
  t.replace(
    "## [0.4.91] - unreleased",
    "## [0.4.92] - unreleased\n\n- A queue line in 0.4.92.\n\n## [0.4.91] - 2026-11-26",
  );

const opened = (line: string) => (t: string) =>
  t.replace(
    "## [0.4.91] - unreleased\n\n",
    `## [0.4.91] - unreleased\n\n### Changed\n\n${line}\n\n`,
  );

describe("changelog-line --placed: a heading added twice in one release", () => {
  it("fails when the merge leaves the top section with the same ### heading twice", () => {
    const d = repo();
    const r = merge(d, opened("- A queue line."), opened("- A PR line."), (t) =>
      t.replace(
        /<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/,
        "$1$2",
      ),
    );
    expect(r.out).toContain('"### Changed" twice');
    expect(r.out).toContain("## [0.4.91] - unreleased");
    expect(r.code).toBe(1);
  });

  it("passes one ### heading with both sides' lines under it", () => {
    const d = repo();
    const r = merge(d, opened("- A queue line."), opened("- A PR line."), (t) =>
      t.replace(
        /<<<<<<< [^\n]*\n([\s\S]*?)=======\n### Changed\n\n([\s\S]*?)>>>>>>> [^\n]*\n/,
        "$1$2",
      ),
    );
    expect(r.code).toBe(0);
  });

  it("passes a heading that a released section repeats: only the top section is checked", () => {
    const d = repo();
    setLog(
      d,
      log(d).replace(
        "## [0.4.90] - 2026-11-25\n\n",
        "## [0.4.90] - 2026-11-25\n\n### Fixed\n\n- One.\n\n### Fixed\n\n",
      ),
    );
    commit(d, "old repeat");
    const r = merge(
      d,
      (t) => t,
      after("- A fourth unreleased line.", "- A PR line."),
    );
    expect(r.code).toBe(0);
  });
});

describe("changelog-line --placed <base>..<head> (issue 1769)", () => {
  it("fails a stale branch whose line merges cleanly under a heading the queue has since released", () => {
    const d = repo();
    const r = merge(
      d,
      release,
      after("- A fourth unreleased line.", "- A stale line."),
    );
    expect(r.out).toContain("- A stale line.");
    expect(r.out).toContain("## [0.4.91] - 2026-11-26");
    expect(r.code).toBe(1);
  });

  it("passes a line under the top unreleased heading", () => {
    const d = repo();
    const r = merge(
      d,
      after("- A fourth unreleased line.", "- A queue line."),
      after("- An unreleased line.", "- A branch line."),
    );
    expect(r.code).toBe(0);
  });

  it("passes a merge that adds no changelog lines", () => {
    const d = repo();
    git(d, "switch", "-q", "-c", "pr");
    fs.writeFileSync(path.join(d, "a.txt"), "a\n");
    commit(d, "pr");
    git(d, "switch", "-q", "queue");
    git(d, "merge", "-q", "--no-ff", "--no-edit", "pr");
    expect(placed(d, "HEAD^1..HEAD").code).toBe(0);
  });

  it("passes a conflict settled by keeping both sides' lines under the unreleased heading", () => {
    const d = repo();
    const add = "- A third unreleased line.";
    const r = merge(
      d,
      after(add, "- A queue line."),
      after(add, "- A branch line."),
      (t) => t.replace(/<<<<<<< .*\n|=======\n|>>>>>>> .*\n/g, ""),
    );
    expect(log(d)).not.toContain("<<<<<<<");
    expect(r.code).toBe(0);
  });

  it("fails that settled conflict when one of its lines lands outside the unreleased heading", () => {
    const d = repo();
    const add = "- A third unreleased line.";
    const r = merge(
      d,
      after(add, "- A queue line."),
      (t) =>
        after(
          "- A released line.",
          "- A stray line.",
        )(after(add, "- A branch line.")(t)),
      (t) => t.replace(/<<<<<<< .*\n|=======\n|>>>>>>> .*\n/g, ""),
    );
    expect(r.out).toContain("- A stray line.");
    expect(r.out).toContain("## [0.4.90] - 2026-11-25");
    expect(r.code).toBe(1);
  });

  it("fails when the file's first section is not an unreleased one", () => {
    const d = repo();
    setLog(
      d,
      log(d).replace("## [0.4.91] - unreleased", "## [0.4.91] - 2026-11-26"),
    );
    commit(d, "released");
    setLog(d, after("- An unreleased line.", "- A late line.")(log(d)));
    commit(d, "late");
    const r = placed(d, "HEAD^1..HEAD");
    expect(r.out).toContain("- A late line.");
    expect(r.code).toBe(1);
  });

  it("says how to use it when the range is missing", () => {
    const d = repo();
    expect(placed(d, "").code).toBe(2);
  });
});
