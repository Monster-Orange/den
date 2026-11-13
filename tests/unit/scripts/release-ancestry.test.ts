/**
 * The release job's ancestry check (scripts/release-ancestry.sh): every
 * gated candidate of a version (its tags v<version>-dev.N) is in the
 * release commit's history. Found when three gated candidates never
 * reached main and their versions went to other work. A temp git repo,
 * no signing, no global config.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.resolve(__dirname, "../../../scripts/release-ancestry.sh");
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
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const commit = (msg: string) => {
  git("commit", "-q", "--allow-empty", "-m", msg);
  return git("rev-parse", "HEAD");
};
const check = (version: string, sha: string) =>
  spawnSync("sh", [SCRIPT, version, sha], { cwd: repo, env, encoding: "utf8" });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "den-ancestry-"));
  git("init", "-q", "-b", "main");
  commit("base");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("release-ancestry.sh", () => {
  it("every gated candidate in the release's history: passes", () => {
    commit("work");
    git("tag", "v1.2.0-dev.0");
    commit("fix");
    git("tag", "v1.2.0-dev.1");
    const rel = commit("Den 1.2.0");
    const r = check("1.2.0", rel);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("v1.2.0-dev.0");
    expect(r.stdout).toContain("v1.2.0-dev.1");
  });

  it("a gated candidate on a branch that never merged: fails, naming it", () => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "side");
    commit("side work");
    git("tag", "v1.2.0-dev.0");
    git("checkout", "-q", "main");
    git("reset", "-q", "--hard", base);
    const rel = commit("Den 1.2.0, other work");
    const r = check("1.2.0", rel);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/::error::.*v1\.2\.0-dev\.0.*isn't in/);
  });

  it("another version's candidates don't count; none at all only warns", () => {
    git("checkout", "-q", "-b", "side");
    commit("x");
    git("tag", "v1.3.0-dev.0");
    git("checkout", "-q", "main");
    const rel = commit("Den 1.2.0");
    const r = check("1.2.0", rel);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning::no gated candidate tagged for 1\.2\.0/);
  });

  it("refuses bad arguments", () => {
    expect(check("", "HEAD").status).toBe(2);
    expect(check("1.2.0;rm", "HEAD").status).toBe(2);
  });
});
