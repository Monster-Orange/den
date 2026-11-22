/**
 * The release job's tree check (scripts/release-tree.sh): the release
 * commit holds what its newest gated candidate held, apart from the
 * version lines and the changelog. Found when a pull request merged
 * straight to main after the candidate was tagged: the ancestry check
 * passed, and the release would have shipped work no gate had run.
 * A temp git repo, no signing, no global config.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.resolve(__dirname, "../../../scripts/release-tree.sh");
let repo: string;
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const git = (...args: string[]) => {
  const r = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    {
      cwd: repo,
      env,
      encoding: "utf8",
    },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const write = (file: string, text: string) =>
  fs.writeFileSync(path.join(repo, file), text);
const pkg = (version: string, extra = "") =>
  `{\n  "name": "den",\n  "version": "${version}",${extra}\n  "private": true\n}\n`;
const lock = (version: string, dep = "1.0.0") =>
  `{\n  "name": "den",\n  "version": "${version}",\n  "packages": {\n    "node_modules/x": {\n      "version": "${dep}",\n      "integrity": "sha512-${dep}"\n    }\n  }\n}\n`;
const commitAll = (msg: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
};
const check = (version: string, sha: string) =>
  spawnSync("sh", [SCRIPT, version, sha], { cwd: repo, env, encoding: "utf8" });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "den-reltree-"));
  git("init", "-q", "-b", "main");
  write("package.json", pkg("1.1.0"));
  write("package-lock.json", lock("1.1.0"));
  write("CHANGELOG.md", "# Changelog\n");
  write("app.js", "one\n");
  commitAll("base");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

/** A candidate v1.2.0-dev.N on the current commit. */
const candidate = (n: number) => git("tag", `v1.2.0-dev.${n}`);
/** The release commit: version lines and the changelog only. */
const releaseCommit = () => {
  write("package.json", pkg("1.2.0"));
  write("package-lock.json", lock("1.2.0"));
  write("CHANGELOG.md", "# Changelog\n\n## [1.2.0]\n");
  return commitAll("Den 1.2.0");
};

describe("release-tree.sh", () => {
  it("the candidate plus only the version and changelog: passes", () => {
    write("app.js", "two\n");
    commitAll("work");
    candidate(1);
    const r = check("1.2.0", releaseCommit());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("v1.2.0-dev.1");
  });

  it("work merged after the candidate was tagged: fails, naming the file", () => {
    candidate(1);
    write("gate.js", "load hold\n");
    commitAll("a pull request straight to main");
    const r = check("1.2.0", releaseCommit());
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/::error::.*v1\.2\.0-dev\.1.*gate\.js/);
  });

  it("compares with the newest candidate, by number not by name order", () => {
    candidate(9);
    write("app.js", "two\n");
    commitAll("fix after dev.9");
    candidate(10);
    expect(check("1.2.0", releaseCommit()).status).toBe(0);
  });

  it("a package.json change beyond its version: fails", () => {
    candidate(1);
    write("package.json", pkg("1.2.0", '\n  "main": "other.js",'));
    write("package-lock.json", lock("1.2.0"));
    const rel = commitAll("Den 1.2.0, with a sneaked change");
    const r = check("1.2.0", rel);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/::error::.*package\.json/);
  });

  it("a dependency change in the lockfile: fails", () => {
    candidate(1);
    write("package.json", pkg("1.2.0"));
    write("package-lock.json", lock("1.2.0", "2.0.0"));
    const rel = commitAll("Den 1.2.0, with a new dependency");
    const r = check("1.2.0", rel);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/::error::.*package-lock\.json/);
  });

  it("no candidate for this version: warns and passes, as the ancestry check does", () => {
    git("tag", "v1.3.0-dev.0");
    const r = check("1.2.0", releaseCommit());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning::/);
  });

  it("bad arguments: exit 2", () => {
    expect(check("", "HEAD").status).toBe(2);
    expect(check("1.2.0", "").status).toBe(2);
    expect(check("1.2.0;rm", "HEAD").status).toBe(2);
  });
});
