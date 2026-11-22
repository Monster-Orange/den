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
