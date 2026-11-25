/**
 * Issue 615: the release dry run on every dev tag (scripts/release-dry-run.mjs).
 * Three releases failed only in the release run, after their candidate had
 * passed: a test that depended on the release commit's version bumps.
 *
 *   plan <tag>   which versions the release will carry: Den's without
 *                `-dev.N`, and the kit's (packages/den-ui), decided at the
 *                dev tag. A kit changed since the version npm has, with that
 *                version unchanged, fails: the candidate bumps it, never the
 *                release commit.
 *   apply <den> <kit> <date>
 *                the release commit's edits, in the runner only: the
 *                versions, and the changelog entry's date.
 *
 * A temp git repo and an `npm` shim first on PATH: no network, no real npm.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.resolve(__dirname, "../../../scripts/release-dry-run.mjs");
const DEN = "@scope-x/pkg";
const KIT = "@scope-x/kit";

let repo: string;
let bin: string;

// The shim reads what npm "has" from $NPM_FAKE: lines "<name>@<version> <gitHead>",
// "<name> missing" (the package isn't on npm), or "down" (the registry errors).
const NPM_SHIM = `#!/bin/bash
spec="$2"; field="$3"
if grep -qx down "$NPM_FAKE"; then echo "npm error code ETIMEDOUT" >&2; exit 1; fi
if [ "$1" != view ]; then echo "npm shim: unexpected npm $*" >&2; exit 2; fi
case "\${spec:1}" in *@*) name="\${spec%@*}";; *) name="$spec";; esac
if grep -qx "$name missing" "$NPM_FAKE"; then echo "npm error code E404" >&2; exit 1; fi
if [ "$field" = name ]; then echo "$name"; exit 0; fi
line=$(grep "^$spec " "$NPM_FAKE" | head -n 1)
if [ -z "$line" ]; then echo "npm error code E404" >&2; echo "npm error 404 No match found for version" >&2; exit 1; fi
if [ "$field" = version ]; then echo "\${spec##*@}"; exit 0; fi
if [ "$field" = gitHead ]; then head="\${line#* }"; [ "$head" = "-" ] || echo "$head"; exit 0; fi
echo "npm shim: unexpected field $field" >&2; exit 2
`;

const env = (): NodeJS.ProcessEnv => ({
  PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
    path.delimiter,
  ),
  HOME: repo,
  NPM_FAKE: path.join(repo, "..", "npm-fake"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
});

const git = (...args: string[]): string => {
  const r = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd: repo, env: env(), encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const read = (rel: string): string =>
  fs.readFileSync(path.join(repo, rel), "utf8");

const pkgJson = (name: string, version: string): string =>
  `{\n  "name": "${name}",\n  "version": "${version}",\n  "license": "MIT",\n  "files": ["a", "b"]\n}\n`;

const lockJson = (den: string, kit: string): string =>
  `{
  "name": "${DEN}",
  "version": "${den}",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "${DEN}",
      "version": "${den}",
      "license": "MIT",
      "workspaces": [
        "packages/*"
      ]
    },
    "node_modules/${KIT}": {
      "resolved": "packages/den-ui",
      "link": true
    },
    "node_modules/other": {
      "version": "9.9.9"
    },
    "packages/den-ui": {
      "name": "${KIT}",
      "version": "${kit}",
      "license": "MIT"
    }
  }
}
`;

const distJson = (den: string): string =>
  `{\n  "name": "acme",\n  "version": "0.0.0",\n  "private": true,\n  "dependencies": {\n    "${DEN}": "${den}"\n  }\n}\n`;

const CHANGELOG = (den: string, when: string): string =>
  `# Changelog\n\nIntro.\n\n## [${den}] - ${when}\n\n### Fixed\n\n- a fix\n\n## [0.0.1] - 2020-01-01\n\n- old\n`;

/** A candidate: Den at <den>, the kit at <kit>, committed. */
function candidate(den: string, kit: string, lockKit = kit): string {
  write("package.json", pkgJson(DEN, den));
  write("package-lock.json", lockJson(den, lockKit));
  write("examples/distribution/package.json", distJson(den));
  write("packages/den-ui/package.json", pkgJson(KIT, kit));
  write("packages/den-ui/src/kit.js", "export const kit = 1;\n");
  write("CHANGELOG.md", CHANGELOG(den.replace(/-.*$/, ""), "unreleased"));
  git("add", ".");
  git("commit", "-q", "-m", `candidate ${den}`);
  return git("rev-parse", "HEAD");
}

const npmHas = (...lines: string[]): void =>
  fs.writeFileSync(path.join(repo, "..", "npm-fake"), lines.join("\n") + "\n");

const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    env: env(),
    encoding: "utf8",
  });

/** The plan's GITHUB_OUTPUT lines, as a map. */
const outputs = (stdout: string): Record<string, string> =>
  Object.fromEntries(
    stdout
      .split("\n")
      .filter((l) => /^[a-z]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

let top: string;
beforeEach(() => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), "den-dry-run-"));
  repo = path.join(top, "repo");
  bin = path.join(top, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), NPM_SHIM, { mode: 0o755 });
  git("init", "-q", "-b", "main");
  npmHas();
});
afterEach(() => fs.rmSync(top, { recursive: true, force: true }));

describe("release-dry-run.mjs plan", () => {
  it("refuses a tag that isn't v<version>-dev.N", () => {
    candidate("1.2.3-dev.4", "0.5.0");
    for (const tag of ["v1.2.3", "1.2.3-dev.4", "v1.2-dev.1", "v1.2.3-rc.1"]) {
      const r = run("plan", tag);
      expect([tag, r.status]).toEqual([tag, 2]);
    }
  });

  it("Den's version is the tag's without -dev.N; the kit's is its own when npm doesn't have it yet", () => {
    candidate("1.2.3-dev.4", "0.5.0");
    npmHas(`${KIT}@0.4.0 -`);
    const r = run("plan", "v1.2.3-dev.4");
    expect(r.status).toBe(0);
    const o = outputs(r.stdout);
    expect(o.den).toBe("1.2.3");
    expect(o.kit).toBe("0.5.0");
    expect(o.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the kit not on npm at all: its own version", () => {
    candidate("1.2.3-dev.1", "0.5.0");
    npmHas(`${KIT} missing`);
    const r = run("plan", "v1.2.3-dev.1");
    expect(r.status).toBe(0);
    expect(outputs(r.stdout).kit).toBe("0.5.0");
  });

  it("the kit on npm at its version and unchanged since npm's commit: passes, nothing new to publish", () => {
    const at = candidate("1.2.3-dev.1", "0.5.0");
    npmHas(`${KIT}@0.5.0 ${at}`);
    write("src/den.js", "den work\n");
    git("add", ".");
    git("commit", "-q", "-m", "Den work, the kit untouched");
    const r = run("plan", "v1.2.3-dev.2");
    expect(r.status).toBe(0);
    expect(outputs(r.stdout).kit).toBe("0.5.0");
  });

  it("the kit changed since npm's commit but its version is on npm: fails, and says to bump it in the candidate", () => {
    const at = candidate("1.2.3-dev.1", "0.5.0");
    npmHas(`${KIT}@0.5.0 ${at}`);
    write("packages/den-ui/src/kit.js", "export const kit = 2;\n");
    git("add", ".");
    git("commit", "-q", "-m", "kit work, version not bumped");
    const r = run("plan", "v1.2.3-dev.2");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/::error::/);
    expect(r.stdout + r.stderr).toContain("packages/den-ui/src/kit.js");
    expect(r.stdout + r.stderr).toMatch(/bump/i);
    expect(r.stdout + r.stderr).toContain("CONTRIBUTING");
    expect(outputs(r.stdout).kit).toBeUndefined();
  });

  it("no gitHead on npm: compares with the commit that set the kit's version", () => {
    candidate("1.2.3-dev.1", "0.5.0");
    npmHas(`${KIT}@0.5.0 -`);
    write("packages/den-ui/src/kit.js", "export const kit = 3;\n");
    git("add", ".");
    git("commit", "-q", "-m", "kit work, version not bumped");
    expect(run("plan", "v1.2.3-dev.2").status).toBe(1);
  });

  it("the kit's version bumped in the candidate: passes with the new version", () => {
    const at = candidate("1.2.3-dev.1", "0.5.0");
    npmHas(`${KIT}@0.5.0 ${at}`);
    write("packages/den-ui/src/kit.js", "export const kit = 2;\n");
    candidate("1.2.3-dev.2", "0.6.0");
    const r = run("plan", "v1.2.3-dev.2");
    expect(r.status).toBe(0);
    expect(outputs(r.stdout).kit).toBe("0.6.0");
  });

  it("the lock file's kit version differs from the kit's package.json: fails", () => {
    candidate("1.2.3-dev.1", "0.6.0", "0.5.0");
    const r = run("plan", "v1.2.3-dev.1");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("package-lock.json");
  });

  it("the registry errors (not a 404): fails rather than guess", () => {
    candidate("1.2.3-dev.1", "0.5.0");
    npmHas("down");
    expect(run("plan", "v1.2.3-dev.1").status).toBe(1);
  });
});

describe("release-dry-run.mjs plan: the kit against next/queue (issue 1508)", () => {
  /** next/queue: a branch from the candidate with these kit files. */
  const queue = (name: string, kitJs: string, kit = "0.5.0") => {
    const back = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", name);
    write("packages/den-ui/package.json", pkgJson(KIT, kit));
    write("packages/den-ui/src/kit.js", kitJs);
    git("add", ".");
    git("commit", "-q", "--allow-empty", "-m", `queue ${name}`);
    git("checkout", "-q", back);
  };
  const plan = (queueRef: string, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [SCRIPT, "plan", "v1.2.3-dev.1"], {
      cwd: repo,
      env: { ...env(), KIT_QUEUE_REF: queueRef, ...extra },
      encoding: "utf8",
    });

  it("next/queue shares the kit's version with other kit files: fails, and says to bump next/queue's den-ui", () => {
    candidate("1.2.3-dev.1", "0.5.0");
    npmHas(`${KIT}@0.4.0 -`);
    queue("q-diff", "export const kit = 2;\n");
    const r = plan("q-diff");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/::error::/);
    expect(r.stdout + r.stderr).toContain(
      "bump next/queue's den-ui before promoting",
    );
    expect(r.stdout + r.stderr).toContain("packages/den-ui/src/kit.js");
    expect(outputs(r.stdout).kit).toBeUndefined();
  });

  it("identical kit files, or a bumped version on next/queue: passes", () => {
    candidate("1.2.3-dev.1", "0.5.0");
    npmHas(`${KIT}@0.4.0 -`);
    queue("q-same", "export const kit = 1;\n");
    expect(plan("q-same").status).toBe(0);
    queue("q-bumped", "export const kit = 2;\n", "0.6.0");
    expect(plan("q-bumped").status).toBe(0);
  });

  it("the release doesn't publish the kit (npm has it, unchanged): next/queue isn't asked", () => {
    const at = candidate("1.2.3-dev.1", "0.5.0");
    npmHas(`${KIT}@0.5.0 ${at}`);
    queue("q-diff", "export const kit = 2;\n");
    expect(plan("q-diff").status).toBe(0);
  });

  it("in CI, a next/queue missing from the clone fails rather than guess", () => {
    candidate("1.2.3-dev.1", "0.5.0");
    npmHas(`${KIT}@0.4.0 -`);
    const r = plan("no-such-queue", { GITHUB_ACTIONS: "true" });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("no-such-queue");
  });
});

describe("release-dry-run.mjs apply", () => {
  it("makes the release commit's edits: Den's and the kit's versions, and the changelog's date", () => {
    candidate("1.2.3-dev.4", "0.5.0");
    const r = run("apply", "1.2.3", "0.6.0", "2026-11-19");
    expect(r.status).toBe(0);
    expect(read("package.json")).toBe(pkgJson(DEN, "1.2.3"));
    expect(read("package-lock.json")).toBe(lockJson("1.2.3", "0.6.0"));
    expect(read("examples/distribution/package.json")).toBe(distJson("1.2.3"));
    expect(read("packages/den-ui/package.json")).toBe(pkgJson(KIT, "0.6.0"));
    expect(read("CHANGELOG.md")).toBe(CHANGELOG("1.2.3", "2026-11-19"));
  });

  it("lines 3 and 9 of the lock file carry Den's version, and nothing else in it moves", () => {
    candidate("1.2.3-dev.4", "0.5.0");
    const before = read("package-lock.json").split("\n");
    run("apply", "1.2.3", "0.5.0", "2026-11-19");
    const after = read("package-lock.json").split("\n");
    const moved = after
      .map((l, i) => (l === before[i] ? -1 : i + 1))
      .filter((n) => n > 0);
    expect(moved).toEqual([3, 9]);
    expect(after[2]).toBe('  "version": "1.2.3",');
    expect(after[8]).toBe('      "version": "1.2.3",');
  });

  it("refuses a version that isn't X.Y.Z, and changes nothing", () => {
    candidate("1.2.3-dev.4", "0.5.0");
    const r = run("apply", "1.2.3-dev.4", "0.5.0", "2026-11-19");
    expect(r.status).toBe(2);
    expect(read("package.json")).toBe(pkgJson(DEN, "1.2.3-dev.4"));
  });

  it("a file without the line it edits: fails, and names it", () => {
    candidate("1.2.3-dev.4", "0.5.0");
    write("examples/distribution/package.json", '{\n  "name": "acme"\n}\n');
    const r = run("apply", "1.2.3", "0.5.0", "2026-11-19");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("examples/distribution/package.json");
  });
});
