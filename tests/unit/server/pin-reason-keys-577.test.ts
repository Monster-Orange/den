/**
 * Issue 577: the pin commit's reasons reach the person in their language.
 * Den's own words in a reason get a key and vars; git's and gh's own
 * output stays as they say it, in a var of its own.
 *
 *   - skipped (not a git checkout, no branch): whyKey, for the Allow
 *     toast when the person's Allowed pin commit can't run.
 *   - push_failed: the remote and branch apart from git's output, so the
 *     bell's note is a key with vars (bell.m.pinPushFailedTo), not text
 *     with English baked into {why}.
 *   - pinBellMsg: the bell's note for each step, its key and vars.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  commitPin,
  pinBellMsg,
  pinRefusalKey,
  type GitRun,
  type PinStep,
} from "../../../src/ui/server/pin-commit.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function root(): { root: string; stateDir: string } {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "den-577-pin-"));
  dirs.push(r);
  fs.writeFileSync(path.join(r, "package.json"), "{}\n");
  const stateDir = path.join(r, "state");
  fs.mkdirSync(stateDir);
  return { root: r, stateDir };
}

/** git that answers each command; `say` overrides by its first argument. */
function fakeGit(say: Record<string, { code: number; out: string }>): GitRun {
  return async (args) => {
    const hit = say[args[0]];
    if (hit) return hit;
    if (args[0] === "symbolic-ref") return { code: 0, out: "main\n" };
    if (args[0] === "config") return { code: 1, out: "" };
    if (args[0] === "status") return { code: 0, out: " M package.json\n" };
    if (args[0] === "rev-parse" && args[1] === "HEAD")
      return { code: 0, out: "0123456789abcdef0123\n" };
    return { code: 0, out: "" };
  };
}

describe("issue 577: a skipped pin commit's reason has a key", () => {
  it("not a git checkout", async () => {
    const r = root();
    const step = await commitPin("1.2.3", {
      ...r,
      git: fakeGit({
        "rev-parse": { code: 128, out: "fatal: not a git repository" },
      }),
    });
    expect(step).toMatchObject({
      did: "skipped",
      whyKey: { key: "ap.err.pinNotCheckout", vars: { root: r.root } },
    });
  });

  it("no branch (detached HEAD)", async () => {
    const r = root();
    const step = await commitPin("1.2.3", {
      ...r,
      git: fakeGit({ "symbolic-ref": { code: 1, out: "" } }),
    });
    expect(step).toMatchObject({
      did: "skipped",
      whyKey: { key: "ap.err.pinDetached" },
    });
  });
});

describe("issue 577: a failed push keeps Den's words apart from git's", () => {
  it("push_failed says the remote and branch, and git's output on its own", async () => {
    const r = root();
    const step = await commitPin("1.2.3", {
      ...r,
      git: fakeGit({
        push: { code: 1, out: "fatal: could not read from remote" },
      }),
    });
    expect(step).toMatchObject({
      did: "push_failed",
      to: {
        remote: "origin",
        branch: "main",
        out: "fatal: could not read from remote",
      },
    });
  });
});

describe("issue 577: git's push output never carries a secret into the bell", () => {
  it("a remote URL with a token in it is redacted in to.out and why", async () => {
    const r = root();
    const token = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
    const step = await commitPin("1.2.3", {
      ...r,
      git: fakeGit({
        push: {
          code: 1,
          out: `fatal: unable to access 'https://x-access-token:${token}@github.com/o/r.git/'`,
        },
      }),
    });
    expect(step.did).toBe("push_failed");
    const s = step as Extract<PinStep, { did: "push_failed" }>;
    expect(s.to?.out).not.toContain(token);
    expect(s.why).not.toContain(token);
    expect(s.to?.out).toContain("fatal: unable to access");
  });
});

describe("issue 577: the bell's pin notes are keys with vars", () => {
  const T = "Den";
  it("a failed push: bell.m.pinPushFailedTo, git's output in {out}", () => {
    const step: PinStep = {
      did: "push_failed",
      version: "1.2.3",
      sha: "0123456789abcdef0123",
      why: "git push to origin main: fatal: x",
      to: { remote: "origin", branch: "main", out: "fatal: x" },
      first: true,
    };
    expect(pinBellMsg(step, T)).toEqual({
      text: "Den 1.2.3: its pin is committed (0123456789ab) but the push to origin main failed: fatal: x. Den tries again at the next update check",
      key: "bell.m.pinPushFailedTo",
      vars: {
        v: "1.2.3",
        sha: "0123456789ab",
        remote: "origin",
        branch: "main",
        out: "fatal: x",
      },
    });
  });

  it("a commit that failed keeps git's words in {why}", () => {
    const m = pinBellMsg(
      {
        did: "commit_failed",
        version: "1.2.3",
        why: "git commit: boom",
        first: true,
      },
      T,
    );
    expect(m?.key).toBe("bell.m.pinCommitFailed");
    expect(m?.vars).toEqual({ v: "1.2.3", why: "git commit: boom" });
  });

  it("nothing to say for a step with no note", () => {
    expect(pinBellMsg({ did: "done", version: "1.2.3" }, T)).toBeNull();
  });
});

describe("issue 577: an Allowed pin commit that fails says why in the page's language", () => {
  it("skipped: its whyKey", () => {
    expect(
      pinRefusalKey({
        did: "skipped",
        version: "1.2.3",
        why: "the distribution's checkout is on no branch (detached HEAD)",
        whyKey: { key: "ap.err.pinDetached" },
      }),
    ).toEqual({ key: "ap.err.pinDetached" });
  });

  it("a failed push: the push's words, git's output as a var", () => {
    expect(
      pinRefusalKey({
        did: "push_failed",
        version: "1.2.3",
        sha: "0123456789abcdef0123",
        why: "git push to origin main: fatal: x",
        to: { remote: "origin", branch: "main", out: "fatal: x" },
        first: true,
      }),
    ).toEqual({
      key: "ap.err.pinPush",
      vars: { remote: "origin", branch: "main", out: "fatal: x" },
    });
  });

  it("a pushed one: none (it worked)", () => {
    expect(
      pinRefusalKey({ did: "pushed", version: "1.2.3", sha: "x" }),
    ).toBeNull();
  });
});
