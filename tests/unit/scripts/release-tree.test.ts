/**
 * The release job's tree check (scripts/release-tree.sh): the release
 * commit is its newest gated candidate with the release commit's own edits
 * applied (release-dry-run.mjs apply: Den's version in package.json, the
 * lockfile and the example distribution, the kit's version in the kit and
 * the lockfile), and nothing else; the changelog may differ. Found when a
 * pull request merged straight to main after the candidate was tagged: the
 * ancestry check passed, and the release would have shipped work no gate
 * had run. A temp git repo shaped like Den's, no signing, no global config.
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
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8");

/** The release-commit files, in the line shapes release-dry-run.mjs edits. */
type V = {
  den: string;
  kit: string;
  dep?: string;
  example?: string;
  extra?: string;
};
const files = ({ den, kit, dep = "1.0.0", example = den, extra = "" }: V) => {
  write(
    "package.json",
    `{\n  "name": "@acme/den",\n  "version": "${den}",${extra}\n  "private": false\n}\n`,
  );
  write(
    "package-lock.json",
    `{\n  "name": "@acme/den",\n  "version": "${den}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "@acme/den",\n      "version": "${den}"\n    },\n    "node_modules/x": {\n      "version": "${dep}",\n      "integrity": "sha512-1"\n    },\n    "packages/den-ui": {\n      "name": "@acme/den-ui",\n      "version": "${kit}"\n    }\n  }\n}\n`,
  );
  write(
    "examples/distribution/package.json",
    `{\n  "name": "example",\n  "dependencies": {\n    "@acme/den": "${example}"\n  }\n}\n`,
  );
  write(
    "packages/den-ui/package.json",
    `{\n  "name": "@acme/den-ui",\n  "version": "${kit}"\n}\n`,
  );
};
const commitAll = (msg: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
};
const check = (version: string, sha: string) =>
  spawnSync("sh", [SCRIPT, version, sha], { cwd: repo, env, encoding: "utf8" });
const out = (r: ReturnType<typeof check>) => r.stdout + r.stderr;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "den-reltree-"));
  git("init", "-q", "-b", "main");
  // the candidate line carries the last release's version, as next/queue does
  files({ den: "1.1.0", kit: "0.5.0" });
  write("CHANGELOG.md", "# Changelog\n");
  write("app.js", "one\n");
  commitAll("base");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

/** A candidate v1.2.0-dev.N on the current commit. */
const candidate = (n: number) => git("tag", `v1.2.0-dev.${n}`);
/** The release commit as the release makes it: the version edits and the changelog. */
const releaseCommit = (v: Partial<V> = {}) => {
  const kit = JSON.parse(read("packages/den-ui/package.json"))
    .version as string;
  files({ den: "1.2.0", kit, ...v });
  write("CHANGELOG.md", "# Changelog\n\n## [1.2.0] - 2026-11-22\n");
  return commitAll("Den 1.2.0");
};

describe("release-tree.sh", () => {
  it("the candidate plus the release's version edits in all four files and the changelog: passes", () => {
    write("app.js", "two\n");
    commitAll("work");
    candidate(1);
    const rel = releaseCommit();
    expect(
      git("diff", "--name-only", "v1.2.0-dev.1", rel).split("\n").sort(),
    ).toEqual([
      "CHANGELOG.md",
      "examples/distribution/package.json",
      "package-lock.json",
      "package.json",
    ]);
    const r = check("1.2.0", rel);
    expect(out(r)).toContain("v1.2.0-dev.1");
    expect(r.status).toBe(0);
  });

  it("a candidate with changes/ fragments: the release commit removes them and passes; one left behind fails, named", () => {
    write("changes/1703-a.md", "### Fixed\n\n- a fix\n");
    commitAll("work with a fragment");
    candidate(1);
    git("rm", "-q", "changes/1703-a.md");
    expect(check("1.2.0", releaseCommit()).status).toBe(0);
    git("reset", "-q", "--hard", "v1.2.0-dev.1");
    const r = check("1.2.0", releaseCommit());
    expect(r.status).toBe(1);
    expect(out(r)).toContain("changes/1703-a.md");
  });

  it("a kit bump in the release commit, as the dry run plans it: passes", () => {
    candidate(1);
    expect(check("1.2.0", releaseCommit({ kit: "0.6.0" })).status).toBe(0);
  });

  it("work merged after the candidate was tagged: fails, naming the file", () => {
    candidate(1);
    write("gate.js", "load hold\n");
    commitAll("a pull request straight to main");
    const r = check("1.2.0", releaseCommit());
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/::error::.*v1\.2\.0-dev\.1.*gate\.js/);
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
    const r = check(
      "1.2.0",
      releaseCommit({ extra: '\n  "main": "other.js",' }),
    );
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/::error::.*package\.json/);
  });

  it("a dependency's version line alone changes in the lockfile: fails", () => {
    candidate(1);
    const r = check("1.2.0", releaseCommit({ dep: "1.0.1" }));
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/::error::.*package-lock\.json/);
  });

  it("Den's version set to something other than the release's: fails", () => {
    candidate(1);
    const r = check("1.2.0", releaseCommit({ den: "1.2.1" }));
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/::error::.*package\.json/);
  });

  it("the example's dependency set to something other than the release's: fails", () => {
    candidate(1);
    const r = check("1.2.0", releaseCommit({ example: "1.2.0-dev.1" }));
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/::error::.*examples\/distribution\/package\.json/);
  });

  it("another change in the example distribution's package.json: fails", () => {
    candidate(1);
    releaseCommit();
    write(
      "examples/distribution/package.json",
      read("examples/distribution/package.json").replace(
        '"example"',
        '"other"',
      ),
    );
    const r = check("1.2.0", commitAll("Den 1.2.0, and a renamed example"));
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/::error::.*examples\/distribution\/package\.json/);
  });

  it("no candidate for this version: warns and passes, as the ancestry check does", () => {
    git("tag", "v1.3.0-dev.0");
    const r = check("1.2.0", releaseCommit());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning::/);
  });

  it("leaves no worktree behind", () => {
    candidate(1);
    check("1.2.0", releaseCommit());
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("bad arguments: exit 2", () => {
    expect(check("", "HEAD").status).toBe(2);
    expect(check("1.2.0", "").status).toBe(2);
    expect(check("1.2.0;rm", "HEAD").status).toBe(2);
  });
});
