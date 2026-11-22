/**
 * Issue 922: a release publishes the exact tree of the dev tag that passed
 * its test bed, never main's HEAD. scripts/release-promote.sh decides
 * whether a commit may be promoted: it is the release's version commit,
 * whose first parent is the dev tag v<version>-dev.<n>, and it changes
 * only the version: Den's version in package.json and the lockfile, the
 * example's pin, and new CHANGELOG lines (its heading's date aside). The
 * dev tag is signed by a key in the allowed-signers file, and its commit
 * has the bed's PASS: its newest commit status `release/bed` (the context
 * is a repo variable) is success, set by a tester the repo variable
 * RELEASE_BED_CREATORS lists. v<version> may tag no other commit, and npm
 * may not have the version yet.
 *
 * A temp git repo, SSH-signed tags, and `gh` and `npm` shims first on
 * PATH: no network. The gh shim answers by commit, with GitHub's whole
 * status list, so the script's own filter is what's tested. Invented
 * names only.
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

// gh api repos/<repo>/commits/<sha>/status: GitHub's combined status for
// that commit, from $GH_STATUS_DIR/<sha>.json (none: no statuses).
const GH_SHIM = `#!/bin/bash
[ "$1" = api ] || { echo "gh shim: unexpected gh $*" >&2; exit 2; }
case "$2" in
  repos/owner-x/repo-x/commits/*/status)
    s=\${2#repos/owner-x/repo-x/commits/}; s=\${s%/status}
    f="$GH_STATUS_DIR/$s.json"
    if [ -f "$f" ]; then cat "$f"; else echo '{"statuses":[]}'; fi ;;
  *) echo "gh shim: unexpected api $2" >&2; exit 2 ;;
esac
`;
// npm view <name>@<v> version: E404 unless NPM_HAS names the version;
// NPM_DOWN: npm can't be asked.
const NPM_SHIM = `#!/bin/bash
if [ "$1" = view ]; then
  if [ -n "\${NPM_DOWN:-}" ]; then echo "npm error code ECONNRESET" >&2; exit 1; fi
  if [ -n "\${NPM_HAS:-}" ] && [ "$2" = "${NAME}@\${NPM_HAS}" ]; then echo "\${NPM_HAS}"; exit 0; fi
  echo "npm error code E404" >&2; exit 1
fi
echo "npm shim: unexpected npm $*" >&2; exit 2
`;

let tmp = "";
let work = "";
let shims = "";
let statusDir = "";
let signers = "";
let key = "";
let otherKey = "";
const sha: Record<string, string> = {};
const TESTER = "tester-x";

/** GitHub's status list for `commit`, newest first. */
function statuses(
  commit: string,
  list: { context: string; state: string; creator?: string }[],
): void {
  fs.writeFileSync(
    path.join(statusDir, `${commit}.json`),
    JSON.stringify({
      statuses: list.map((x) => ({
        context: x.context,
        state: x.state,
        creator: { login: x.creator ?? TESTER },
      })),
    }),
  );
}
const PASS = [{ context: "release/bed", state: "success" }];

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

function signedTag(name: string, at: string, k: string): void {
  git(
    "-c",
    "gpg.format=ssh",
    "-c",
    `user.signingkey=${k}`,
    "tag",
    "-s",
    "-m",
    "items: 1",
    name,
    at,
  );
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  fs.writeFileSync(path.join(work, file), text);
}

const pkgJson = (version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: NAME, version, ...extra }, null, 2) + "\n";
const lockJson = (version: string, integrity = "sha512-aaa") =>
  JSON.stringify(
    {
      name: NAME,
      version,
      lockfileVersion: 3,
      packages: {
        "": { name: NAME, version },
        "node_modules/dep-x": { version: "1.0.0", integrity },
      },
    },
    null,
    2,
  ) + "\n";
const exampleJson = (version: string) =>
  JSON.stringify(
    { name: "example-x", version: "0.0.0", dependencies: { [NAME]: version } },
    null,
    2,
  ) + "\n";
const LOG = "# Changelog\n\n## [1.2.3] - unreleased\n\n- A change.\n";
const LOG_DATED = LOG.replace("unreleased", "2026-01-02");

function commit(
  version: string,
  files: Record<string, string>,
  msg: string,
  pkg?: string,
) {
  write("package.json", pkg ?? pkgJson(version));
  if (!("package-lock.json" in files))
    write("package-lock.json", lockJson(version));
  if (!("examples/dist/package.json" in files))
    write("examples/dist/package.json", exampleJson(version));
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
      GH_STATUS_DIR: statusDir,
      RELEASE_SIGNERS: signers,
      RELEASE_BED_CREATORS: TESTER,
      RELEASE_EXAMPLE: "examples/dist/package.json",
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
  statusDir = path.join(tmp, "statuses");
  fs.mkdirSync(statusDir);
  // The allowed signer's key, and another key the file doesn't list.
  key = path.join(tmp, "signer");
  otherKey = path.join(tmp, "other");
  for (const k of [key, otherKey])
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "",
      "-f",
      k,
    ]);
  signers = path.join(tmp, "allowed-signers");
  fs.writeFileSync(
    signers,
    `signer-x namespaces="git" ${fs.readFileSync(`${key}.pub`, "utf8").trim()}\n`,
  );
  work = path.join(tmp, "work");
  fs.mkdirSync(work);
  git("init", "-q", "-b", "main");
  sha.base = commit(
    `${V}-dev.0`,
    { "src/a.ts": "a\n", "CHANGELOG.md": LOG },
    "base",
  );
  // The candidate: a tag signed with the allowed key.
  sha.dev = commit(`${V}-dev.1`, { "src/b.ts": "b\n" }, "the candidate");
  signedTag(`v${V}-dev.1`, sha.dev, key);
  statuses(sha.dev, PASS);
  // The release's version commit on the release branch: versions only.
  git("checkout", "-q", "-b", "rel/1.2.3");
  sha.release = commit(
    V,
    {
      "CHANGELOG.md": LOG_DATED.replace(
        "- A change.",
        "- A change.\n- One more line.",
      ),
    },
    "1.2.3",
  );
  // Version commits that change more than the version, on the same tag.
  const onDev = (name: string, f: () => string) => {
    git("checkout", "-q", "--detach", sha.dev);
    sha[name] = f();
  };
  onDev("script", () =>
    commit(
      V,
      {},
      "1.2.3 and a script",
      pkgJson(V, { scripts: { postinstall: "node x.js" } }),
    ),
  );
  onDev("lock", () =>
    commit(
      V,
      { "package-lock.json": lockJson(V, "sha512-bbb") },
      "1.2.3 and a lockfile",
    ),
  );
  onDev("logCut", () =>
    commit(
      V,
      { "CHANGELOG.md": LOG_DATED.replace("- A change.\n", "") },
      "1.2.3 cuts a line",
    ),
  );
  onDev("spaced", () =>
    commit(V, { "src/a b.ts": "x\n" }, "1.2.3 and a spaced file"),
  );
  // Tags this key file doesn't allow, on candidates of their own.
  git("checkout", "-q", "--detach", sha.base);
  sha.otherDev = commit(
    `3.0.0-dev.1`,
    { "src/d.ts": "d\n" },
    "other-key candidate",
  );
  signedTag("v3.0.0-dev.1", sha.otherDev, otherKey);
  statuses(sha.otherDev, PASS);
  sha.otherRelease = commit("3.0.0", {}, "3.0.0");
  git("checkout", "-q", "--detach", sha.base);
  sha.plainDev = commit(
    `4.0.0-dev.1`,
    { "src/e.ts": "e\n" },
    "unsigned candidate",
  );
  git("tag", "-a", "-m", "items: 4", "v4.0.0-dev.1", sha.plainDev);
  statuses(sha.plainDev, PASS);
  sha.plainRelease = commit("4.0.0", {}, "4.0.0");
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
  statuses(sha.light, PASS);
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
    expect(changed).toEqual([
      "CHANGELOG.md",
      "examples/dist/package.json",
      "package-lock.json",
      "package.json",
    ]);
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
    for (const state of ["pending", "failure", "error"]) {
      statuses(sha.dev, [{ context: "release/bed", state }]);
      const r = promote(sha.release);
      expect([state, r.code]).toEqual([state, 1]);
      expect(r.text).toMatch(/::error::.*release\/bed/);
    }
    statuses(sha.dev, []);
    expect(promote(sha.release).code).toBe(1);
    statuses(sha.dev, PASS);
  });

  it("reads the dev tag's own commit: a PASS on the version commit doesn't count", () => {
    statuses(sha.dev, []);
    statuses(sha.release, PASS);
    try {
      const r = promote(sha.release);
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/::error::.*status is none/);
    } finally {
      statuses(sha.dev, PASS);
      fs.rmSync(path.join(statusDir, `${sha.release}.json`));
    }
  });

  it("reads only the bed's context, and its newest status", () => {
    statuses(sha.dev, [{ context: "ci/other", state: "success" }]);
    expect(promote(sha.release).text).toMatch(/::error::.*status is none/);
    statuses(sha.dev, [
      { context: "release/bed", state: "failure" },
      { context: "release/bed", state: "success" },
    ]);
    expect(promote(sha.release).text).toMatch(/::error::.*status is failure/);
    statuses(sha.dev, PASS);
  });

  it("the PASS's context is a setting (RELEASE_BED_CONTEXT)", () => {
    statuses(sha.dev, [{ context: "bed/x", state: "success" }]);
    try {
      expect(promote(sha.release, { RELEASE_BED_CONTEXT: "bed/x" }).code).toBe(
        0,
      );
      const bad = promote(sha.release);
      expect(bad.code).toBe(1);
      expect(bad.text).toMatch(/release\/bed/);
    } finally {
      statuses(sha.dev, PASS);
    }
  });

  it("only a listed tester's PASS counts (RELEASE_BED_CREATORS); none listed refuses", () => {
    statuses(sha.dev, [
      { context: "release/bed", state: "success", creator: "intruder-x" },
    ]);
    try {
      const r = promote(sha.release);
      expect(r.code).toBe(1);
      expect(r.text).toMatch(/::error::.*intruder-x/);
    } finally {
      statuses(sha.dev, PASS);
    }
    expect(
      promote(sha.release, { RELEASE_BED_CREATORS: "a-x, tester-x" }).code,
    ).toBe(0);
    const none = promote(sha.release, { RELEASE_BED_CREATORS: "" });
    expect(none.code).toBe(1);
    expect(none.text).toMatch(/::error::.*RELEASE_BED_CREATORS/);
  });

  it("refuses a dev tag signed by a key the allowed-signers file doesn't list, unsigned, or lightweight", () => {
    const o = promote(sha.otherRelease);
    expect(o.code).toBe(1);
    expect(o.text).toMatch(/::error::.*v3\.0\.0-dev\.1.*signed/);
    const p = promote(sha.plainRelease);
    expect(p.code).toBe(1);
    expect(p.text).toMatch(/::error::.*v4\.0\.0-dev\.1.*signed/);
    const l = promote(sha.lightRelease);
    expect(l.code).toBe(1);
    expect(l.text).toMatch(/::error::.*annotated/);
    const gone = promote(sha.release, {
      RELEASE_SIGNERS: path.join(tmp, "none"),
    });
    expect(gone.code).toBe(1);
    expect(gone.text).toMatch(/::error::no allowed-signers file/);
  });

  it("refuses a version commit that changes package.json beyond its version", () => {
    const r = promote(sha.script);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/::error::.*package\.json/);
  });

  it("refuses a lockfile change beyond Den's own version", () => {
    const r = promote(sha.lock);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/::error::.*package-lock\.json/);
  });

  it("refuses a CHANGELOG that loses a line (dating its heading aside)", () => {
    const r = promote(sha.logCut);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/::error::.*CHANGELOG\.md/);
  });

  it("refuses a file whose name has a space", () => {
    const r = promote(sha.spaced);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/::error::.*src\/a b\.ts/);
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

  it("refuses when npm can't be asked, and leaves no file behind", () => {
    const r = promote(sha.release, { NPM_DOWN: "1" });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/::error::.*npm couldn't be asked/);
    expect(fs.existsSync(path.join(work, "npm-view.err"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("refuses a prerelease version, and a commit that isn't one", () => {
    expect(promote(sha.dev).code).toBe(1);
    expect(promote("not-a-commit").code).toBe(2);
  });
});
