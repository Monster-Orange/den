/**
 * release.yml's check decides whether a push to main publishes. npm takes
 * 20-60 minutes to show a new version, so "not on npm yet" alone would
 * publish the same version again from any later commit pushed in that
 * window, carrying unreleased code. Only the commit that set the version
 * releases: its first parent has another version, and no tag v<version>
 * names a different commit.
 *
 * The check step's own script runs here with bash, in a temp git repo with
 * a bare temp origin and an `npm` shim first on PATH: no network, no real npm.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = process.cwd();
const NAME = "@scope-x/pkg";
const VERSION = "1.2.3";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

function checkSteps(): Step[] {
  const doc = yaml.parse(
    fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "release.yml"),
      "utf-8",
    ),
  ) as { jobs: Record<string, { steps?: Step[] }> };
  return doc.jobs.check?.steps ?? [];
}

function checkScript(): string {
  const step = checkSteps().find((s) => s.id === "check");
  if (!step?.run) throw new Error("release.yml: no check step with a run:");
  return step.run;
}

// npm view <name>@<ver> version: not there yet (E404). npm view <name> name: the package exists.
const NPM_SHIM = `#!/bin/bash
if [ "$1" = view ] && [ "$3" = name ]; then echo "$2"; exit 0; fi
if [ "$1" = view ]; then
  echo "npm error code E404" >&2
  echo "npm error 404 No match found for version $2" >&2
  exit 1
fi
echo "npm shim: unexpected npm $*" >&2
exit 2
`;

let tmp: string;
let work: string;
let shimDir: string;
let script: string;
const sha: Record<string, string> = {};

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: work,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function commit(version: string, file: string, message: string): string {
  fs.writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify({ name: NAME, version }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(work, file), message + "\n");
  git("add", "package.json", file);
  git("commit", "-q", "--no-gpg-sign", "-m", message);
  return git("rev-parse", "HEAD");
}

function check(at: string): string {
  git("checkout", "-q", "--detach", at);
  const out = path.join(tmp, `out-${at}`);
  fs.writeFileSync(out, "");
  // as GitHub runs a run: script
  execFileSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
    {
      cwd: work,
      encoding: "utf-8",
      env: {
        PATH: [
          shimDir,
          path.dirname(process.execPath),
          "/usr/bin",
          "/bin",
        ].join(path.delimiter),
        HOME: tmp,
        GITHUB_OUTPUT: out,
        GITHUB_EVENT_NAME: "push",
        NPM_SCOPE: "@scope-x",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  const m = /^release=(.*)$/m.exec(fs.readFileSync(out, "utf-8"));
  if (!m) throw new Error("the check wrote no release= line");
  return m[1];
}

beforeAll(() => {
  script = checkScript();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "release-check-"));
  shimDir = path.join(tmp, "bin");
  fs.mkdirSync(shimDir);
  fs.writeFileSync(path.join(shimDir, "npm"), NPM_SHIM, { mode: 0o755 });
  const origin = path.join(tmp, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  work = path.join(tmp, "work");
  fs.mkdirSync(work);
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", origin);
  sha.dev = commit(`${VERSION}-dev.1`, "a.txt", "work toward 1.2.3");
  sha.release = commit(VERSION, "b.txt", "set 1.2.3"); // commit 1
  sha.later = commit(VERSION, "c.txt", "a merge after the release"); // commit 2
  // a commit off the dev one that sets the same version again: only the tag tells it apart
  git("checkout", "-q", "--detach", sha.dev);
  sha.again = commit(VERSION, "d.txt", "set 1.2.3 again elsewhere");
  git("push", "-q", "origin", `${sha.later}:refs/heads/main`);
  git("push", "-q", "origin", `${sha.again}:refs/heads/other`);
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("release.yml check: only the commit that set the version releases", () => {
  it("checks out the parent too", () => {
    const co = checkSteps().find((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    expect(Number(co?.with?.["fetch-depth"])).toBeGreaterThanOrEqual(2);
  });

  it("the commit that set the version, not on npm yet: release=true", () => {
    expect(check(sha.release)).toBe("true");
  });

  it("a later commit with the same version: release=false", () => {
    expect(check(sha.later)).toBe("false");
  });

  describe("with the tag v1.2.3 on the release commit", () => {
    beforeAll(() => {
      git("tag", "-a", "-m", "v1.2.3", `v${VERSION}`, sha.release);
      git("push", "-q", "origin", `refs/tags/v${VERSION}`);
    });

    it("a later commit with the same version: release=false", () => {
      expect(check(sha.later)).toBe("false");
    });

    it("another commit that set the same version: release=false", () => {
      expect(check(sha.again)).toBe("false");
    });

    it("the tagged commit itself: release=true", () => {
      expect(check(sha.release)).toBe("true");
    });
  });
});
