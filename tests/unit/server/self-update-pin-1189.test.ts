/**
 * Issue 1189: with server_agent.pin_commit at its default "push", a branch
 * whose rules need a status check or a pull request rejected the pin's
 * push, and the pin sat unpushed until a person opened a pull request by
 * hand. Now Den asks GitHub for the branch's rules first and goes straight
 * to a pull request when they need one; a push a branch rule still
 * rejects falls back to a pull request; and both say so in the bell and in
 * doctor. Other push failures (offline, auth) keep the commit and retry.
 *
 * Real git, in temp dirs only. The remote is a bare repo reached through a
 * GitHub-looking address (url.<path>.insteadOf), so Den sees a GitHub
 * remote; its pre-receive hook answers a protected branch the way GitHub
 * does (GH006). gh is a stand-in script: `gh api` answers the branch rules
 * from a file, `gh pr create` prints a pull request's address. HOME and
 * the global config point into the temp dir; no real key or config is
 * read. Invented names only.
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
  type PinCommitDeps,
} from "../../../src/ui/server/pin-commit.js";
import { selfUpdateLines } from "../../../src/ui/cli/doctor-command.js";

const GH_URL = "https://github.com/acme/dist.git";
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1189-")));
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
  // GitHub's answer to a push onto a protected branch, when `protect` is there.
  const hook = path.join(remote, "hooks", "pre-receive");
  fs.writeFileSync(
    hook,
    `#!/bin/sh
while read old new ref; do
  echo "$ref" >> "${tmp}/pushed.log"
  if [ "$ref" = "refs/heads/main" ] && [ -f "${tmp}/protect" ]; then
    echo "error: GH006: Protected branch update failed for refs/heads/main." >&2
    echo "error: Required status check \\"ci\\" is expected." >&2
    exit 1
  fi
done
exit 0
`,
  );
  fs.chmodSync(hook, 0o755);
  git(tmp, "init", "-q", "-b", "main", root);
  fs.writeFileSync(path.join(root, "package.json"), pkgJson("1.0.0"));
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lock":"1.0.0"}\n');
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the distribution");
  // The remote looks like GitHub to Den; git reaches the bare repo.
  git(root, "remote", "add", "origin", GH_URL);
  git(root, "config", `url.${remote}.insteadOf`, GH_URL);
  git(root, "push", "-q", "-u", "origin", "main");
  fs.rmSync(path.join(tmp, "pushed.log"), { force: true });
  // The self-update wrote the new pin.
  fs.writeFileSync(path.join(root, "package.json"), pkgJson("1.1.0"));
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lock":"1.1.0"}\n');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** gh, faked: its calls, and `gh api`'s answer (rules JSON, or a failure). */
function fakeGh(rules: unknown[] | "fail") {
  const log = path.join(tmp, "gh.log");
  const answer = path.join(tmp, "rules.json");
  if (rules === "fail") fs.rmSync(answer, { force: true });
  else fs.writeFileSync(answer, JSON.stringify(rules));
  const script = path.join(tmp, "gh.mjs");
  fs.writeFileSync(
    script,
    `import * as fs from "fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  if (!fs.existsSync(${JSON.stringify(answer)})) {
    process.stderr.write("gh: Not Found (HTTP 404)\\n");
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(${JSON.stringify(answer)}, "utf8"));
  process.exit(0);
}
process.stdout.write("https://github.com/acme/dist/pull/7\\n");
`,
  );
  return {
    argv: [process.execPath, script],
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as string[])
        : [],
  };
}

const deps = (gh: string[], extra: Partial<PinCommitDeps> = {}) => ({
  root,
  stateDir,
  git: pinGit(root, { env }),
  gh,
  run: (argv: string[], cwd: string) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      try {
        const out = execFileSync(argv[0], argv.slice(1), {
          cwd,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        resolve({ code: 0, out });
      } catch (e) {
        const x = e as { status?: number; stdout?: string; stderr?: string };
        resolve({
          code: x.status ?? 1,
          out: `${x.stdout ?? ""}${x.stderr ?? ""}`,
        });
      }
    }),
  ...extra,
});

const pushed = () =>
  fs.existsSync(path.join(tmp, "pushed.log"))
    ? fs.readFileSync(path.join(tmp, "pushed.log"), "utf8").trim().split("\n")
    : [];

describe("issue 1189: a pin push a branch rule rejects goes to a pull request", () => {
  it("a branch whose rules need a check: a pull request, and no push to the branch tried", async () => {
    const head = git(root, "rev-parse", "HEAD");
    const gh = fakeGh([
      { type: "required_status_checks", ruleset_id: 1 },
      { type: "deletion", ruleset_id: 1 },
    ]);
    const step = await commitPin("1.1.0", deps(gh.argv));

    expect(step).toMatchObject({
      did: "pr",
      branch: "den/pin-1.1.0",
      url: "https://github.com/acme/dist/pull/7",
      via: "rules",
    });
    // The rules were asked for the branch the pin goes to.
    expect(gh.calls()[0]).toEqual([
      "api",
      "repos/acme/dist/rules/branches/main",
    ]);
    expect(gh.calls()[1]).toEqual(
      expect.arrayContaining(["pr", "create", "--head", "den/pin-1.1.0"]),
    );
    // Only the pin's own branch was pushed; main was never tried.
    expect(pushed()).toEqual(["refs/heads/den/pin-1.1.0"]);
    // The checkout's branch didn't move; the pin is still in its files.
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readPinRecord(stateDir)).toMatchObject({
      state: "pr_opened",
      via: "rules",
    });
  });

  it("a branch rule of a pull request counts too", async () => {
    const gh = fakeGh([{ type: "pull_request", ruleset_id: 2 }]);
    const step = await commitPin("1.1.0", deps(gh.argv));
    expect(step).toMatchObject({ did: "pr", via: "rules" });
    expect(pushed()).toEqual(["refs/heads/den/pin-1.1.0"]);
  });

  it("a push rejected with a protected-branch message: den/pin-<version> and a pull request; the bell and doctor say so", async () => {
    const head = git(root, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(tmp, "protect"), "");
    // The rules API says nothing (classic branch protection isn't in it).
    const gh = fakeGh([]);
    const step = await commitPin("1.1.0", deps(gh.argv));

    expect(step).toMatchObject({
      did: "pr",
      branch: "den/pin-1.1.0",
      via: "rejected",
    });
    expect(pushed()).toEqual(["refs/heads/main", "refs/heads/den/pin-1.1.0"]);
    expect(git(remote, "rev-parse", "main")).toBe(head);
    expect(git(remote, "log", "-1", "--format=%s", "den/pin-1.1.0")).toBe(
      "Den 1.1.0: pin the distribution to Den 1.1.0",
    );
    expect(git(remote, "rev-parse", "den/pin-1.1.0~1")).toBe(head);
    // The checkout is back on the commit it was on, the pin in its files,
    // so it doesn't sit one commit ahead of a branch it can't push to.
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "status", "--porcelain").split("\n").sort()).toEqual([
      " M package-lock.json",
      " M package.json",
    ]);
    expect(readPinRecord(stateDir)).toMatchObject({
      state: "pr_opened",
      via: "rejected",
      url: "https://github.com/acme/dist/pull/7",
    });

    // The bell: one item, saying the branch needs a pull request, and which.
    const bell = pinBellMessage(step, "Den");
    expect(bell).toMatchObject({
      key: "bell.m.pinPrFallback",
      vars: { branch: "den/pin-1.1.0", n: "7" },
      link: "https://github.com/acme/dist/pull/7",
    });
    expect(bell!.text).toBe(
      "Den updated to 1.1.0: the branch needs a pull request; opened #7 for its pin (den/pin-1.1.0)",
    );

    // Doctor, from what the pin step recorded.
    const doc = selfUpdateLines("Den", {
      config: () => ({
        selfUpdate: "auto",
        selfUpdateFrom: "user",
        updateCheckMs: 3_600_000,
      }),
      state: () => null,
      orgFile: "config/den.yml",
      pin: () => readPinRecord(stateDir),
    });
    expect(doc.lines.join("\n")).toContain(
      "pin 1.1.0: the branch needs a pull request; opened #7 (https://github.com/acme/dist/pull/7)",
    );
  });

  it("an explicit push falls back the same way, and says so each time", async () => {
    fs.writeFileSync(path.join(tmp, "protect"), "");
    const gh = fakeGh([]);
    const step = await commitPin("1.1.0", deps(gh.argv, { mode: "push" }));
    expect(step).toMatchObject({ did: "pr", via: "rejected" });
    expect(pinBellMessage(step, "Den")?.key).toBe("bell.m.pinPrFallback");
  });

  it("an offline push: no pull request, the commit kept, tried again at the next check", async () => {
    // Offline: the remote can't be reached (the rules can't be asked either).
    git(
      root,
      "config",
      `url.${path.join(tmp, "offline.git")}.insteadOf`,
      GH_URL,
    );
    git(root, "config", "--unset", `url.${remote}.insteadOf`);
    const gh = fakeGh("fail");
    const step = await commitPin("1.1.0", deps(gh.argv));

    expect(step).toMatchObject({ did: "push_failed", first: true });
    const sha = git(root, "rev-parse", "HEAD");
    expect(readPinRecord(stateDir)).toMatchObject({
      state: "push_failed",
      sha,
    });
    expect(gh.calls().filter((c) => c[0] === "pr")).toEqual([]);
    expect(pinBellMessage(step, "Den")?.key).toBe("bell.m.pinPushFailed");

    // Back online: the same commit is pushed.
    git(root, "config", `url.${remote}.insteadOf`, GH_URL);
    git(
      root,
      "config",
      "--unset",
      `url.${path.join(tmp, "offline.git")}.insteadOf`,
    );
    const again = await commitPin("1.1.0", deps(gh.argv));
    expect(again).toMatchObject({ did: "pushed", sha });
    expect(git(remote, "rev-parse", "main")).toBe(sha);
  });

  it("rules GitHub can't answer: the push goes ahead as before", async () => {
    const gh = fakeGh("fail");
    const step = await commitPin("1.1.0", deps(gh.argv));
    expect(step).toMatchObject({ did: "pushed" });
    expect(pushed()).toEqual(["refs/heads/main"]);
  });
});
