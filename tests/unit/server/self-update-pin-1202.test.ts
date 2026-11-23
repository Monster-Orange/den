/**
 * Issue 1202: since issue 1195 the pin commit is built on the remote's tip.
 * A checkout BEHIND that tip passed the ahead check, so Den pushed the pin,
 * but its branch stayed where it was with the pin files changed, and its
 * next `git pull` stopped on "local changes would be overwritten". Now,
 * after the pin is pushed, a branch that is behind fast-forwards to the
 * pin commit; when git can't (other local changes in the way), the
 * checkout is left exactly as it was and doctor says to pull.
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
  pinBellMessage,
  pinGit,
  readPinRecord,
} from "../../../src/ui/server/pin-commit.js";
import { pinDoctorText } from "../../../src/shared/pin-record.js";

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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1202-")));
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

/** Someone else pushes a commit the checkout hasn't fetched: it is behind. */
function someoneElsePushes(file = "notes.md", text = "someone else\n"): string {
  const other = path.join(tmp, "other");
  if (!fs.existsSync(other)) git(tmp, "clone", "-q", remote, other);
  fs.writeFileSync(path.join(other, file), text);
  git(other, "add", file);
  git(other, "commit", "-q", "-m", "someone else's change");
  git(other, "push", "-q", "origin", "main");
  return git(remote, "rev-parse", "main");
}

/** The self-update wrote the new pin into the checkout. */
function newPin(): void {
  fs.writeFileSync(path.join(root, "package.json"), pkgJson("1.1.0"));
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lock":"1.1.0"}\n');
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

describe("issue 1202: a checkout behind its remote catches up to the pushed pin", () => {
  it("behind, nothing else changed: the branch fast-forwards to the pin, the tree is clean, and a pull has nothing to do", async () => {
    someoneElsePushes();
    newPin();

    const step = await commitPin("1.1.0", deps());

    expect(step).toMatchObject({ did: "pushed" });
    const pushed = git(remote, "rev-parse", "main");
    expect(git(root, "rev-parse", "HEAD")).toBe(pushed);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(root, "notes.md"), "utf8")).toBe(
      "someone else\n",
    );
    expect(() => git(root, "pull", "-q", "--ff-only")).not.toThrow();
    expect(git(root, "rev-parse", "HEAD")).toBe(pushed);
  });

  it("behind, a staged file of the person's own: kept staged, the branch still catches up", async () => {
    someoneElsePushes();
    fs.writeFileSync(path.join(root, "draft.md"), "staged draft\n");
    git(root, "add", "draft.md");
    newPin();

    const step = await commitPin("1.1.0", deps());

    expect(step).toMatchObject({ did: "pushed" });
    expect(git(root, "rev-parse", "HEAD")).toBe(
      git(remote, "rev-parse", "main"),
    );
    expect(git(root, "status", "--porcelain")).toBe("A  draft.md");
  });

  it("behind, a local change git won't overwrite: the checkout is left as it was, and doctor says to pull", async () => {
    // The incoming commit changes notes.md, which the person is editing.
    fs.writeFileSync(path.join(root, "notes.md"), "base\n");
    git(root, "add", "notes.md");
    git(root, "commit", "-q", "-m", "notes");
    git(root, "push", "-q", "origin", "main");
    someoneElsePushes("notes.md", "theirs\n");
    fs.writeFileSync(path.join(root, "notes.md"), "mine, not saved yet\n");
    const before = git(root, "rev-parse", "HEAD");
    newPin();

    const step = await commitPin("1.1.0", deps());

    expect(step).toMatchObject({ did: "pushed" });
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
    expect(fs.readFileSync(path.join(root, "notes.md"), "utf8")).toBe(
      "mine, not saved yet\n",
    );
    // The new pin stays in the checkout's files, as before.
    expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(
      pkgJson("1.1.0"),
    );
    expect(pinDoctorText(readPinRecord(stateDir))).toMatch(
      /^pin 1\.1\.0: pushed \([0-9a-f]{12}\); the checkout is behind and has local changes, so pull to get the pin$/,
    );
    // And the bell says it too.
    expect(pinBellMessage(step, "Den")).toMatchObject({
      key: "bell.m.pinPushedBehind",
      text: expect.stringMatching(
        /^Den updated to 1\.1\.0: its pin is pushed \([0-9a-f]{12}\), but the checkout is behind and has local changes, so pull to get the pin$/,
      ),
    });
  });

  it("on the tip, as before: the branch takes the pin, and doctor has nothing to add", async () => {
    newPin();

    const step = await commitPin("1.1.0", deps());

    expect(step).toMatchObject({ did: "pushed" });
    expect(git(root, "rev-parse", "HEAD")).toBe(
      git(remote, "rev-parse", "main"),
    );
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(pinDoctorText(readPinRecord(stateDir))).toBeNull();
    expect(pinBellMessage(step, "Den")).toMatchObject({
      key: "bell.m.pinPushed",
    });
  });
});
