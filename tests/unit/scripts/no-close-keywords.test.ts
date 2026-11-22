/**
 * Vision 11-22: an issue (897) closed itself through a commit's closing
 * keyword, with no proof it worked. In Den an issue closes only with a
 * live-proof comment, so a pull request's title, body or commits may not
 * carry a GitHub closing keyword ("Fixes #N"). They say "Refs #N".
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "no-close-keywords.mjs");

/** closingRefs, run in node (jest here does not load .mjs). */
function closingRefs(text: string): string[] {
  const r = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(SCRIPT)}); process.stdout.write(JSON.stringify(m.closingRefs(process.env.T)));`,
    ],
    { encoding: "utf-8", env: { ...process.env, T: text } },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as string[];
}

describe("closing keywords (Vision 11-22, issue 897)", () => {
  it.each([
    "Fixes #12",
    "fix #427",
    "fixed #3",
    "Closes #564",
    "close #1",
    "closed #2",
    "Resolves #9",
    "resolve #9",
    "resolved #9",
    "Fixes: #12",
    "fixes Monster-Orange/den#12",
    "Closes https://github.com/o/r/issues/7",
    "a line\nand then FIXES #8 later",
  ])("finds %j", (text) => {
    expect(closingRefs(text).length).toBe(1);
  });

  it.each([
    "Refs #12",
    "Part of #12",
    "a fix for #12 lands",
    "prefixes #12",
    "fixes the bell",
    "fixtures #3",
    "closes the dialog (#12)",
  ])("leaves %j alone", (text) => {
    expect(closingRefs(text)).toEqual([]);
  });
});

describe("the CI check", () => {
  const run = (env: Record<string, string>) =>
    spawnSync("node", [SCRIPT], {
      encoding: "utf-8",
      env: { ...process.env, PR_TITLE: "", PR_BODY: "", ...env },
    });

  it("fails on the title or body and says what to write", () => {
    const r = run({ PR_TITLE: "Bell: fix the race", PR_BODY: "Fixes #427" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pull request body");
    expect(r.stderr).toContain("Fixes #427");
    expect(r.stderr).toContain(
      "use Refs #N; issues close only with a live-proof comment",
    );
  });

  it("passes Refs", () => {
    expect(
      run({ PR_TITLE: "Bell (Refs #427)", PR_BODY: "Refs #427" }).status,
    ).toBe(0);
  });

  // Builder 2, 11-22: a release PR (next/queue into main) carries commits that
  // came before the rule, and history is never rewritten. Commits on another
  // shared branch, or older than the commit that added this script, are not
  // checked; the PR's own head branch never counts as shared, so a fresh
  // release/x branch can't skip its own commits.
  describe("history", () => {
    const at = (iso: string) => ({
      GIT_COMMITTER_DATE: iso,
      GIT_AUTHOR_DATE: iso,
    });
    function repo() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noclose-hist-"));
      const git = (env: Record<string, string>, ...a: string[]) =>
        spawnSync(
          "git",
          ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a],
          { cwd: dir, encoding: "utf-8", env: { ...process.env, ...env } },
        ).stdout.trim();
      git({}, "init", "-q");
      git(
        at("2026-11-01T00:00:00Z"),
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "main",
      );
      const base = git({}, "rev-parse", "HEAD");
      git(
        at("2026-11-10T00:00:00Z"),
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "old\n\nFixes #1",
      );
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.writeFileSync(path.join(dir, "scripts", "no-close-keywords.mjs"), "");
      git({}, "add", "-A");
      git(at("2026-11-22T00:00:00Z"), "commit", "-q", "-m", "add the check");
      git({}, "update-ref", "refs/remotes/origin/next/queue", "HEAD");
      const run = (range: string, head: string) =>
        spawnSync("node", [SCRIPT, range], {
          cwd: dir,
          encoding: "utf-8",
          env: { ...process.env, PR_TITLE: "", PR_BODY: "", PR_HEAD_REF: head },
        });
      return { git, base, run };
    }

    it("a release PR from next/queue passes: its old closing keyword came before the check", () => {
      const { base, run } = repo();
      const r = run(`${base}..refs/remotes/origin/next/queue`, "next/queue");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(
        "1 commit from before this check, not checked",
      );
    });

    it("a commit already on another shared branch is not checked", () => {
      const { git, base, run } = repo();
      git(
        at("2026-11-23T00:00:00Z"),
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "landed\n\nFixes #3",
      );
      git({}, "update-ref", "refs/remotes/origin/next/0.4.86", "HEAD");
      git({}, "update-ref", "refs/remotes/origin/release/0.4.86", "HEAD");
      const r = run(
        `${base}..refs/remotes/origin/release/0.4.86`,
        "release/0.4.86",
      );
      expect(r.status).toBe(0);
      // The old commit, the check's own and the landed one: all on next/*.
      expect(r.stdout).toContain(
        "3 commits already on a shared branch, not checked",
      );
    });

    it("a PR from a fresh release/x branch can't skip its own new commit", () => {
      const { git, base, run } = repo();
      git(
        at("2026-11-23T00:00:00Z"),
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "new\n\nFixes #1",
      );
      git({}, "update-ref", "refs/remotes/origin/release/x", "HEAD");
      const r = run(`${base}..refs/remotes/origin/release/x`, "release/x");
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/commit [0-9a-f]{8}: Fixes #1/);
      expect(r.stderr.match(/Fixes #1/g)?.length).toBe(1);
    });
  });

  it("fails on a commit in the range", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "noclose-"));
    const git = (...a: string[]) =>
      spawnSync("git", a, { cwd: repo, encoding: "utf-8" }).stdout.trim();
    git("init", "-q");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    );
    const base = git("rev-parse", "HEAD");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Bell\n\nCloses #564",
    );
    const r = spawnSync("node", [SCRIPT, `${base}..HEAD`], {
      cwd: repo,
      encoding: "utf-8",
      env: { ...process.env, PR_TITLE: "", PR_BODY: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/commit [0-9a-f]{8}: Closes #564/);
  });
});
