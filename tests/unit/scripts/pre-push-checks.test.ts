/**
 * Issue 185: the pre-push hook (.husky/pre-push, through
 * scripts/pre-push-checks.mjs) refuses a push CI would fail on: a
 * CHANGELOG section with no version bump (version-sync), the CLI's
 * no-localhost lint, the words gate, and a new commit that closes a
 * still-open issue by keyword. A normal push passes in under 20 s.
 *
 * Real pushes: a shared clone of this checkout at its HEAD, pushing
 * scratch branches to a bare repository next to it (never to GitHub), with
 * a stand-in `gh` that says whether an issue is open. No org names are
 * configured (a scratch HOME), so only issue 185's checks speak.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");
const CHECKS = path.join(ROOT, "scripts", "pre-push-checks.mjs");
let dir = "";
let clone = "";
let env: NodeJS.ProcessEnv = {};

const git = (...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: clone, encoding: "utf-8", env },
  ).trim();

/** A scratch branch off HEAD with one commit: `files` written, `msg`. */
function branch(name: string, files: Record<string, string>, msg: string) {
  git("checkout", "-q", "--detach", "start");
  git("checkout", "-q", "-b", name);
  for (const [rel, text] of Object.entries(files))
    fs.writeFileSync(path.join(clone, rel), text);
  git("add", "-A");
  git("commit", "-q", "--no-verify", "-m", msg);
}

/** Pushes `name` to the bare remote: the hook's answer and the time. */
function push(name: string, gh = "OPEN") {
  fs.writeFileSync(path.join(dir, "gh-state"), gh);
  const t0 = Date.now();
  const r = spawnSync("git", ["push", "-q", "origin", name], {
    cwd: clone,
    encoding: "utf-8",
    env,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - t0 };
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-185-")));
  clone = path.join(dir, "clone");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // The stand-in gh: `gh issue view N --json state -q .state`.
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\ncat "${path.join(dir, "gh-state")}"\n`,
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(dir, "home"));
  env = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/^(JEST_|DEN_|GIT_)/.test(k)) env[k] = v;
  env = {
    ...env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: path.join(dir, "home"),
    XDG_CONFIG_HOME: path.join(dir, "home", ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
  execFileSync("git", ["init", "-q", "--bare", path.join(dir, "remote.git")]);
  execFileSync(
    "git",
    ["clone", "-q", "--shared", "--no-checkout", ROOT, clone],
    {
      env,
    },
  );
  git("checkout", "-q", "--detach", head);
  git("tag", "start");
  git("remote", "set-url", "origin", path.join(dir, "remote.git"));
  git("update-ref", "refs/remotes/origin/main", head);
  git("config", "core.hooksPath", ".husky");
  fs.symlinkSync(
    path.join(ROOT, "node_modules"),
    path.join(clone, "node_modules"),
  );
  // A link, not a folder: .gitignore's node_modules/ doesn't cover it.
  fs.appendFileSync(
    path.join(clone, ".git", "info", "exclude"),
    "node_modules\n",
  );
}, 120_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("issue 185: the pre-push hook", () => {
  it("refuses a CHANGELOG section with no version bump, naming version-sync", () => {
    const log = fs.readFileSync(path.join(clone, "CHANGELOG.md"), "utf-8");
    const at = log.search(/^## \[/m);
    branch(
      "scratch-version",
      {
        "CHANGELOG.md": `${log.slice(0, at)}## [99.0.0] - 2099-01-01\n\n- A section with no bump.\n\n${log.slice(at)}`,
      },
      "A CHANGELOG section with no bump",
    );
    const r = push("scratch-version");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/tests\/unit\/version-sync\.test\.ts fails/);
    // Nothing reached the remote.
    expect(
      spawnSync(
        "git",
        ["rev-parse", "--verify", "-q", "refs/heads/scratch-version"],
        {
          cwd: path.join(dir, "remote.git"),
        },
      ).status,
    ).not.toBe(0);
    git("checkout", "-q", "--detach", "start");
    git("branch", "-q", "-D", "scratch-version");
  }, 120_000);

  it("refuses a commit that closes a still-open issue, and says Refs", () => {
    branch(
      "scratch-closes",
      { "scratch-note.txt": "a note\n" },
      "A small change\n\nCloses #12345",
    );
    const r = push("scratch-closes", "OPEN");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/closes #12345, which is still open/);
    expect(r.out).toMatch(/Refs #12345/);
  }, 120_000);

  it("refuses it too when gh can't say whether the issue is open", () => {
    const r = push("scratch-closes", "");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/gh can't say/);
  }, 120_000);

  it("a normal push passes, in under 20 s", () => {
    branch(
      "scratch-normal",
      { "scratch-note.txt": "a note\n" },
      "A small change\n\nRefs #12345",
    );
    const r = push("scratch-normal");
    expect([r.code, r.out]).toEqual([0, ""]);
    expect(r.ms).toBeLessThan(20_000);
  }, 120_000);

  it("closing an issue that is already closed is fine", () => {
    const r = push("scratch-closes", "CLOSED");
    expect([r.code, r.out]).toEqual([0, ""]);
  }, 120_000);
});

describe("closingRefs: GitHub's closing keywords", () => {
  it("finds each form, and never Refs", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(CHECKS)}); console.log(JSON.stringify(m.closingRefs(process.argv[1])));`,
        "Closes #12\nfixes: #3, Resolved owner/repo#4. Fix #7 Refs #5 prefix#9 closed #12",
      ],
      { encoding: "utf-8" },
    );
    expect(JSON.parse(out)).toEqual([3, 4, 7, 12]);
  });
});
