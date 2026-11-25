import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "changelog-line.mjs");

const BASE_LOG = [
  "# Changelog",
  "",
  "## [0.4.90] - unreleased",
  "",
  "### Fixed",
  "",
  "- An earlier fix.",
  "",
  "## [0.4.89] - 2026-11-24",
  "",
  "### Fixed",
  "",
  "- A released fix.",
  "",
].join("\n");

const repos: string[] = [];
afterEach(() => {
  for (const d of repos.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...a: string[]) {
  return execFileSync("git", a, {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function write(dir: string, file: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

function pr(
  change: (dir: string) => void,
  env: { body?: string; headRef?: string } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-changelog-"));
  repos.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, "CHANGELOG.md", BASE_LOG);
  write(dir, "package.json", '{\n  "name": "x",\n  "version": "0.4.89"\n}\n');
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "tests/a.test.ts", "// a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  change(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
  const head = git(dir, "rev-parse", "HEAD");
  const r = spawnSync("node", [SCRIPT, `${base}..${head}`], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      PR_BODY: env.body ?? "A change.\n\nRefs #1",
      PR_HEAD_REF: env.headRef ?? "fix/x",
    },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const srcChange = (dir: string) =>
  write(dir, "src/a.ts", "export const a = 2;\n");
const logLine = (dir: string, after: string, line: string) =>
  write(dir, "CHANGELOG.md", BASE_LOG.replace(after, `${after}\n${line}`));

describe("a changelog line for each change to the product (issue 1611)", () => {
  it("PR 1585's shape: src changed, no changelog line, no no-changelog line, fails and names both ways out", () => {
    const r = pr((d) => {
      srcChange(d);
      write(d, "tests/a.test.ts", "// b\n");
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("## [0.4.90] - unreleased");
    expect(r.out).toContain("no-changelog: <reason>");
  });

  it.each(["packages/kit/x.js", "bin/den"])(
    "a change under %s counts as the product",
    (file) => {
      expect(pr((d) => write(d, file, "x\n")).code).toBe(1);
    },
  );

  it("a line added under the unreleased heading passes", () => {
    const r = pr((d) => {
      srcChange(d);
      logLine(d, "- An earlier fix.", "- The new fix.");
    });
    expect(r).toMatchObject({ code: 0 });
  });

  it("a line added under a released heading fails", () => {
    const r = pr((d) => {
      srcChange(d);
      logLine(d, "- A released fix.", "- The new fix.");
    });
    expect(r.code).toBe(1);
  });

  it("only a blank line added under the unreleased heading fails", () => {
    const r = pr((d) => {
      srcChange(d);
      logLine(d, "- An earlier fix.", "");
    });
    expect(r.code).toBe(1);
  });

  it("no-changelog with a reason passes", () => {
    const r = pr(srcChange, {
      body: "A change.\n\nno-changelog: an internal rename\n\nRefs #1",
    });
    expect(r).toMatchObject({ code: 0 });
  });

  it.each(["no-changelog:", "no-changelog:   ", "no-changelog: \t"])(
    "no-changelog with no reason fails: %j",
    (line) => {
      const r = pr(srcChange, { body: `A change.\n\n${line}\n\nRefs #1` });
      expect(r.code).toBe(1);
      expect(r.out).toContain("reason");
    },
  );

  it.each([
    ["tests only", (d: string) => write(d, "tests/a.test.ts", "// b\n")],
    ["docs only", (d: string) => write(d, "docs/x.md", "x\n")],
    [
      "a workflow only",
      (d: string) => write(d, ".github/workflows/x.yml", "x: 1\n"),
    ],
  ])("%s isn't held", (_what, change) => {
    expect(pr(change)).toMatchObject({ code: 0 });
  });

  it.each(["next/queue", "release/0.4.90", "rel/0.4.90"])(
    "a pull request from the shared branch %s isn't held",
    (headRef) => {
      expect(pr(srcChange, { headRef })).toMatchObject({ code: 0 });
    },
  );

  it("the version-setting commit isn't held", () => {
    const r = pr((d) => {
      srcChange(d);
      write(d, "package.json", '{\n  "name": "x",\n  "version": "0.4.90"\n}\n');
    });
    expect(r).toMatchObject({ code: 0 });
  });
});
