/**
 * Issue 1195: the self-update's pin commit was built on the checkout's
 * local HEAD, so commits not yet pushed rode along: pr mode's
 * den/pin-<version> and its pull request carried them, and push mode
 * pushed them onto the branch. Now the pin commit's only parent is the
 * branch's tip on the remote, fetched first; its tree is that tip's with
 * only the pin files changed. The checkout's branch takes the pin commit
 * only when it was on that tip (nothing unpushed); else it stays as it is.
 *
 * Real git, in temp dirs only: a bare repo as the remote, a checkout as
 * the distribution, a second clone as someone else pushing. HOME and the
 * global config point into the temp dir. Invented names only.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  commitPin,
  pinGit,
  readPinRecord,
} from "../../../src/ui/server/pin-commit.js";

let tmp: string;
let remote: string;
let root: string;
let stateDir: string;
let env: NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, env, encoding: "utf8" },
  ).replace(/\n+$/, "");

const pkgJson = (v: string) =>
  JSON.stringify({ name: "dist", dependencies: { "@example/den": v } }) + "\n";

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1195-")));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  };
  remote = path.join(tmp, "remote.git");
  root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "state");
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(tmp, "init", "-q", "-b", "main", root);
  fs.writeFileSync(path.join(root, "package.json"), pkgJson("1.0.0"));
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lock":"1.0.0"}\n');
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the distribution");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A commit in the checkout that isn't pushed (a person's own work). */
function unpushedWork(): string {
  fs.writeFileSync(path.join(root, "work.md"), "not published yet\n");
  git(root, "add", "work.md");
  git(root, "commit", "-q", "-m", "local work, not pushed");
  return git(root, "rev-parse", "HEAD");
}

/** The self-update wrote the new pin into the checkout. */
function newPin(): void {
  fs.writeFileSync(path.join(root, "package.json"), pkgJson("1.1.0"));
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lock":"1.1.0"}\n');
}

/** A fake gh that opens a pull request (its calls in gh.log). */
function fakeGh(): string[] {
  const script = path.join(tmp, "gh.mjs");
  fs.writeFileSync(
    script,
    `import * as fs from "fs";
fs.appendFileSync(${JSON.stringify(path.join(tmp, "gh.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("https://example.invalid/acme/dist/pull/9\\n");
`,
  );
  return [process.execPath, script];
}

const deps = (extra: Record<string, unknown> = {}) => ({
  root,
  stateDir,
  git: pinGit(root, { env }),
  run: (argv: string[], cwd: string) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      try {
        resolve({
          code: 0,
          out: execFileSync(argv[0], argv.slice(1), {
            cwd,
            env,
            encoding: "utf8",
          }),
        });
      } catch (e) {
        resolve({ code: 1, out: String(e) });
      }
    }),
  ...extra,
});

/** A commit's parents and the files it changed. */
const shape = (cwd: string, rev: string) => ({
  parents: git(cwd, "rev-list", "--parents", "-n", "1", rev)
    .split(" ")
    .slice(1),
  files: git(cwd, "show", "--name-only", "--format=", rev)
    .split("\n")
    .filter(Boolean)
    .sort(),
});

describe("issue 1195: the pin commit is built on the remote's tip, never local HEAD", () => {
  it("push mode, a commit not pushed yet: the pin's only parent is the remote tip, and only the pin goes out", async () => {
    const tip = git(remote, "rev-parse", "main");
    const local = unpushedWork();
    newPin();

    const step = await commitPin("1.1.0", deps());

    expect(step).toMatchObject({ did: "pushed" });
    const pushed = git(remote, "rev-parse", "main");
    expect(shape(remote, pushed)).toEqual({
      parents: [tip],
      files: ["package-lock.json", "package.json"],
    });
    // The person's work never left the machine.
    expect(() => git(remote, "cat-file", "-e", local)).toThrow();
    expect(() => git(remote, "show", "main:work.md")).toThrow();
    // Their branch stays where it was, their work on it.
    expect(git(root, "rev-parse", "HEAD")).toBe(local);
  });

  it("pr mode, a commit not pushed yet: den/pin-<version> and the pull request hold only the pin", async () => {
    const tip = git(remote, "rev-parse", "main");
    const local = unpushedWork();
    newPin();

    const step = await commitPin("1.1.0", deps({ mode: "pr", gh: fakeGh() }));

    expect(step).toMatchObject({ did: "pr", branch: "den/pin-1.1.0" });
    expect(shape(remote, "den/pin-1.1.0")).toEqual({
      parents: [tip],
      files: ["package-lock.json", "package.json"],
    });
    expect(() => git(remote, "cat-file", "-e", local)).toThrow();
    expect(git(root, "rev-parse", "HEAD")).toBe(local);
  });

  it("the remote moved on: the pin is built on its new tip, fetched, and the push goes through", async () => {
    // Someone else pushes a commit the checkout hasn't fetched.
    const other = path.join(tmp, "other");
    git(tmp, "clone", "-q", remote, other);
    fs.writeFileSync(path.join(other, "notes.md"), "someone else\n");
    git(other, "add", "notes.md");
    git(other, "commit", "-q", "-m", "someone else's change");
    git(other, "push", "-q", "origin", "main");
    const tip = git(remote, "rev-parse", "main");
    const before = git(root, "rev-parse", "HEAD");
    newPin();

    const step = await commitPin("1.1.0", deps());

    expect(step).toMatchObject({ did: "pushed" });
    const pushed = git(remote, "rev-parse", "main");
    expect(shape(remote, pushed)).toEqual({
      parents: [tip],
      files: ["package-lock.json", "package.json"],
    });
    // Someone else's change is kept, not undone by the pin.
    expect(git(remote, "show", "main:notes.md")).toBe("someone else");
    // The checkout was behind: its branch stays; a pull brings both.
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("nothing unpushed: as before, the checkout's branch is the pushed pin commit", async () => {
    fs.writeFileSync(path.join(root, "draft.md"), "staged draft\n");
    git(root, "add", "draft.md");
    newPin();

    const step = await commitPin("1.1.0", deps());

    expect(step).toMatchObject({ did: "pushed" });
    expect(git(root, "rev-parse", "HEAD")).toBe(
      git(remote, "rev-parse", "main"),
    );
    // The person's staged file stays staged, and isn't in the pin.
    expect(git(root, "status", "--porcelain")).toBe("A  draft.md");
    expect(shape(remote, "main").files).toEqual([
      "package-lock.json",
      "package.json",
    ]);
  });

  it("the remote can't be reached and its tip was never fetched: nothing is committed, tried again next check", async () => {
    unpushedWork();
    newPin();
    git(root, "remote", "set-url", "origin", path.join(tmp, "offline.git"));
    git(root, "update-ref", "-d", "refs/remotes/origin/main");

    const step = await commitPin("1.1.0", deps());

    expect(step).toMatchObject({ did: "commit_failed", first: true });
    expect(readPinRecord(stateDir)).toMatchObject({ state: "commit_failed" });
    expect(git(root, "log", "-1", "--format=%s")).toBe(
      "local work, not pushed",
    );
  });
});
