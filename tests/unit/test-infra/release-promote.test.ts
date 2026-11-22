/**
 * Issue 922: a release publishes the exact tree of the dev tag that passed
 * its test bed, never main's HEAD. scripts/release-promote.sh decides
 * whether a commit may be promoted: it is the release's version commit,
 * whose first parent is the dev tag v<version>-dev.<n>, and it changes
 * only the version files. The dev tag is signed (GitHub verified it), and
 * its commit has the bed's PASS: a commit status `release/bed` (the
 * context is a repo variable) in state success. v<version> may tag no
 * other commit, and npm may not have the version yet.
 *
 * A temp git repo, with `gh` and `npm` shims first on PATH: no network.
 * Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "release-promote.sh");
const NAME = "@scope-x/pkg";
const V = "1.2.3";

// gh api: a tag's verification, a commit's combined status. Answers come
// from the shim's own env (GH_VERIFIED, GH_STATE), as --jq would print them.
const GH_SHIM = `#!/bin/bash
[ "$1" = api ] || { echo "gh shim: unexpected gh $*" >&2; exit 2; }
case "$2" in
  repos/*/git/tags/*) echo "\${GH_VERIFIED:-true}" ;;
  repos/*/commits/*/status) echo "\${GH_STATE:-success}" ;;
  *) echo "gh shim: unexpected api $2" >&2; exit 2 ;;
esac
`;
// npm view <name>@<v> version: E404 unless NPM_HAS names the version.
const NPM_SHIM = `#!/bin/bash
if [ "$1" = view ]; then
  if [ -n "\${NPM_HAS:-}" ] && [ "$2" = "${NAME}@\${NPM_HAS}" ]; then echo "\${NPM_HAS}"; exit 0; fi
  echo "npm error code E404" >&2; exit 1
fi
echo "npm shim: unexpected npm $*" >&2; exit 2
`;

let tmp = "";
let work = "";
let shims = "";
const sha: Record<string, string> = {};

const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: work,
    encoding: "utf-8",
    env: { ...process.env, ...gitEnv },
  }).trim();
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), text);
}

function commit(version: string, files: Record<string, string>, msg: string) {
  write(
    "package.json",
    JSON.stringify({ name: NAME, version }, null, 2) + "\n",
  );
  for (const [f, t] of Object.entries(files)) write(f, t);
  git("add", "-A");
  git("commit", "-q", "--no-gpg-sign", "-m", msg);
  return git("rev-parse", "HEAD");
}

function promote(
  at: string,
  env: Record<string, string> = {},
): { code: number; out: Record<string, string>; text: string } {
  const outFile = path.join(tmp, `out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(outFile, "");
  const r = spawnSync("sh", [SCRIPT, at], {
    cwd: work,
    encoding: "utf-8",
    env: {
      PATH: [shims, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
        path.delimiter,
      ),
      HOME: tmp,
      GITHUB_OUTPUT: outFile,
      GITHUB_REPOSITORY: "owner-x/repo-x",
      ...gitEnv,
      ...env,
    },
  });
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(outFile, "utf-8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return {
    code: r.status ?? -1,
    out,
    text: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "promote-")));
  shims = path.join(tmp, "bin");
  fs.mkdirSync(shims);
  fs.writeFileSync(path.join(shims, "gh"), GH_SHIM, { mode: 0o755 });
  fs.writeFileSync(path.join(shims, "npm"), NPM_SHIM, { mode: 0o755 });
  work = path.join(tmp, "work");
  fs.mkdirSync(work);
  git("init", "-q", "-b", "main");
  sha.base = commit(
    `${V}-dev.0`,
    { "src/a.ts": "a\n", "CHANGELOG.md": "# Changelog\n" },
    "base",
  );
  // The candidate: tagged, signed in real life (the shim says verified).
  sha.dev = commit(`${V}-dev.1`, { "src/b.ts": "b\n" }, "the candidate");
  git("tag", "-a", "-m", "items: 1", `v${V}-dev.1`, sha.dev);
  // The release's version commit on the release branch: versions only.
  git("checkout", "-q", "-b", "rel/1.2.3");
  sha.release = commit(
    V,
    { "CHANGELOG.md": "# Changelog\n## 1.2.3\n" },
    "1.2.3",
  );
  // A pull request merged to main after the dev tag.
  git("checkout", "-q", "main");
  sha.later = commit(
    `${V}-dev.1`,
    { "src/late.ts": "late\n" },
    "merged after the tag",
  );
  // A version commit on main's HEAD (not the dev tag's child).
  sha.onMain = commit(V, {}, "1.2.3 on main");
  // A version commit that also changes code.
  git("checkout", "-q", "--detach", sha.dev);
  sha.sneaky = commit(V, { "src/b.ts": "b changed\n" }, "1.2.3 and a fix");
  // A child of a lightweight-tagged candidate.
  git("checkout", "-q", "--detach", sha.base);
  sha.light = commit(`2.0.0-dev.1`, { "src/c.ts": "c\n" }, "light candidate");
  git("tag", "v2.0.0-dev.1", sha.light);
  sha.lightRelease = commit("2.0.0", {}, "2.0.0");
  git("checkout", "-q", "main");
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("release-promote.sh (issue 922)", () => {
  it("promotes the version commit whose parent is the passed, signed dev tag", () => {
    const r = promote(sha.release);
    expect(r.text).not.toMatch(/::error::/);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({
      release: "true",
      version: V,
      ref: sha.release,
      dev_tag: `v${V}-dev.1`,
      dev_sha: sha.dev,
    });
  });

  it("the promoted tree is the dev tag's, less the version files: a commit merged to main after the tag is not in it", () => {
    const changed = git("diff", "--name-only", sha.dev, sha.release)
      .split("\n")
      .sort();
    expect(changed).toEqual(["CHANGELOG.md", "package.json"]);
    expect(git("ls-tree", "-r", "--name-only", sha.release)).not.toContain(
      "src/late.ts",
    );
  });

  it("refuses main's HEAD: its parent is no dev tag", () => {
    const r = promote(sha.onMain);
    expect(r.code).toBe(1);
    expect(r.out.release).toBeUndefined();
    expect(r.text).toMatch(/::error::.*v1\.2\.3-dev\.N/);
  });

  it("refuses a dev tag with no recorded PASS (no status, or not success)", () => {
    for (const state of ["none", "pending", "failure", "error"]) {
      const r = promote(sha.release, { GH_STATE: state });
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/::error::.*release\/bed/);
    }
  });

  it("the PASS's context is a setting (RELEASE_BED_CONTEXT)", () => {
    const r = promote(sha.release, { RELEASE_BED_CONTEXT: "bed/x" });
    expect(r.code).toBe(0);
    const bad = promote(sha.release, {
      RELEASE_BED_CONTEXT: "bed/x",
      GH_STATE: "none",
    });
    expect(bad.text).toMatch(/bed\/x/);
  });

  it("refuses a dev tag that isn't signed, or is a lightweight tag", () => {
    const r = promote(sha.release, { GH_VERIFIED: "false" });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/::error::.*signed/);
    const l = promote(sha.lightRelease);
    expect(l.code).toBe(1);
    expect(l.text).toMatch(/::error::.*annotated/);
  });

  it("refuses a version commit that changes more than the version files", () => {
    const r = promote(sha.sneaky);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/::error::.*src\/b\.ts/);
  });

  it("refuses when v<version> already tags another commit (never moved, never published twice)", () => {
    git("tag", "-a", "-m", "x", `v${V}`, sha.onMain);
    try {
      const r = promote(sha.release);
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/::error::v1\.2\.3 already tags/);
    } finally {
      git("tag", "-d", `v${V}`);
    }
  });

  it("refuses a version npm already has", () => {
    const r = promote(sha.release, { NPM_HAS: V });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/::error::.*already on npm/);
  });

  it("refuses a prerelease version, and a commit that isn't one", () => {
    expect(promote(sha.dev).code).toBe(1);
    expect(promote("not-a-commit").code).toBe(2);
  });
});
