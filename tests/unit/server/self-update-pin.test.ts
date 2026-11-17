/**
 * #176: after Den updates itself, the distribution's new pin is committed
 * and pushed by Den's own update check, not left to the server agent. On
 * 2026-11-16 a freshly resumed server agent never committed it and a
 * person pushed the pin by hand.
 *
 * Real git, in temp dirs only: a bare repo as the distribution's remote, a
 * checkout as the distribution. HOME and the global config point into the
 * temp dir and GIT_CONFIG_NOSYSTEM is set, so no real key or config is
 * read. npm, the Den CLI, the watch and the restart are faked as in
 * den-update.test.ts. Invented versions and an invented package name.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readUpdateState,
  updateDen,
  updateStateFile,
  type UpdateDeps,
} from "../../../src/ui/server/den-update.js";
import {
  commitPin,
  compareLink,
  pinGit,
  readPinRecord,
  type PinCommitDeps,
} from "../../../src/ui/server/pin-commit.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import {
  HELD_WRITE_RISK,
  policyFor,
} from "../../../src/shared/approval-policy.js";
import {
  updateCheck,
  type UpdateCheckDeps,
  type UpdateWait,
} from "../../../src/ui/server/update-check.js";

const NAME = "@example/den";
let tmp: string;
let remote: string;
let root: string;
let engine: string;
let stateDir: string;
let env: NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, env, encoding: "utf8" },
  ).replace(/\n+$/, "");

const pkgJson = (v: string) =>
  JSON.stringify({ name: "dist", dependencies: { [NAME]: v } }, null, 2) + "\n";

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-pin-")));
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
  engine = path.join(root, "node_modules", "@example", "den");
  stateDir = path.join(tmp, "state");
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(tmp, "init", "-q", "-b", "main", root);
  fs.writeFileSync(path.join(root, "package.json"), pkgJson("1.0.0"));
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lock":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "notes.md"), "notes\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the distribution");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  fs.mkdirSync(path.join(engine, "src/ui/server"), { recursive: true });
  fs.writeFileSync(
    path.join(engine, "src/ui/server/update-watch.mjs"),
    "// the watch\n",
  );
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The old Den's self-update to 1.1.0, npm and the watch faked. */
async function selfUpdate(): Promise<void> {
  const deps: UpdateDeps = {
    root,
    engine,
    stateDir,
    pkg: { name: NAME, version: "1.0.0" },
    npmView: async () => "1.1.0",
    npm: ["npm"],
    cli: ["den"],
    // Fake npm: --save-exact writes the new pin, as npm would.
    run: async (argv) => {
      if (argv.includes("--save-exact")) {
        fs.writeFileSync(path.join(root, "package.json"), pkgJson("1.1.0"));
        fs.writeFileSync(
          path.join(root, "package-lock.json"),
          '{"lock":"1.1.0"}\n',
        );
        return { code: 0, out: "" };
      }
      return { code: 0, out: JSON.stringify({ checks: [] }) };
    },
    watch: () => 4242,
    note: (reason) => ({
      path: path.join(stateDir, "restart.json"),
      marker: { reason },
    }),
    restart: () => undefined,
    port: 7000,
    pid: 1111,
    waitMs: 180_000,
  };
  const r = await updateDen("latest", deps);
  expect(r.ok).toBe(true);
  // The watch saw 1.1.0 answer from a new pid: verified.
  const s = readUpdateState(stateDir)!;
  fs.writeFileSync(
    updateStateFile(stateDir),
    JSON.stringify({ ...s, state: "good", pid: 2222 }) + "\n",
  );
}

/** The new Den's update check (1.1.0 runs), its git real, in temp dirs. */
function newDen(
  over: Partial<UpdateCheckDeps> = {},
  pin: Partial<PinCommitDeps> = {},
) {
  const bell: string[] = [];
  const logs: string[] = [];
  const d: UpdateCheckDeps = {
    running: () => "1.1.0",
    latest: async () => "1.1.0",
    pinned: () =>
      JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
        .dependencies[NAME],
    role: () => "lead",
    mode: () => "auto",
    cantUpdate: () => null,
    last: () => readUpdateState(stateDir),
    idle: async () => true,
    update: async () => ({ ok: true }),
    ask: () => true,
    notice: (v, text) => bell.push(`notice ${v}: ${text}`),
    log: (l) => logs.push(l),
    pinCommit: (v: string) =>
      commitPin(v, { root, stateDir, git: pinGit(root, { env }), ...pin }),
    pinNotice: (s: { did: string; version: string }) =>
      bell.push(`pin ${s.did} ${s.version}`),
    ...over,
  } as UpdateCheckDeps;
  return { check: updateCheck(d), bell, logs };
}

/** The remote's main: its newest commit's message and files. */
function remoteHead(): { subject: string; files: string[] } {
  const subject = git(remote, "log", "-1", "--format=%s", "main");
  const files = git(remote, "show", "--name-only", "--format=", "main").split(
    "\n",
  );
  return { subject, files };
}

/** The server agent, as Den's update check sees it. */
const AGENT: Record<string, () => Promise<UpdateWait | null>> = {
  // Resumed after a logout: its session is replaying, mid-turn.
  "(a) freshly resumed": async () => "busy",
  // Between turns, at its prompt.
  "(b) idle": async () => null,
  // Not running at all: nothing can wait on it, and nothing can commit.
  "(c) not running": async () => null,
};

describe("#176: Den commits and pushes the pin after its self-update", () => {
  it.each(Object.keys(AGENT))(
    "server agent %s: the pin commit reaches the remote, with only the pin files",
    async (state) => {
      await selfUpdate();
      // Something else dirty, and something else staged: neither goes in.
      fs.appendFileSync(path.join(root, "notes.md"), "a person's edit\n");
      fs.writeFileSync(path.join(root, "draft.md"), "staged draft\n");
      git(root, "add", "draft.md");

      const { check } = newDen({ waitWhy: AGENT[state] });
      await check.tick();

      const head = remoteHead();
      expect(head.subject).toBe("Den 1.1.0: pin the distribution to Den 1.1.0");
      expect(head.files.sort()).toEqual(["package-lock.json", "package.json"]);
      expect(
        JSON.parse(git(remote, "show", "main:package.json")).dependencies[NAME],
      ).toBe("1.1.0");
      // The other changes are where the person left them.
      expect(git(root, "status", "--porcelain").split("\n").sort()).toEqual([
        " M notes.md",
        "A  draft.md",
      ]);
      expect(git(root, "rev-parse", "HEAD")).toBe(
        git(remote, "rev-parse", "main"),
      );
    },
  );

  it("a push that fails keeps the commit, is tried again at the next check, and the bell says it once", async () => {
    await selfUpdate();
    const before = git(remote, "rev-parse", "main");
    git(root, "remote", "set-url", "origin", path.join(tmp, "offline.git"));
    const { check, bell } = newDen();

    await check.tick();
    const sha = git(root, "rev-parse", "HEAD");
    expect(git(root, "log", "-1", "--format=%s")).toBe(
      "Den 1.1.0: pin the distribution to Den 1.1.0",
    );
    expect(readPinRecord(stateDir)).toMatchObject({
      version: "1.1.0",
      state: "push_failed",
      sha,
    });
    await check.tick();
    expect(bell).toEqual(["pin push_failed 1.1.0"]);
    expect(git(remote, "rev-parse", "main")).toBe(before);

    // Back online: the next check pushes the same commit.
    git(root, "remote", "set-url", "origin", remote);
    await check.tick();
    expect(git(remote, "rev-parse", "main")).toBe(sha);
    expect(bell).toEqual(["pin push_failed 1.1.0", "pin pushed 1.1.0"]);
    // Done: later checks leave it alone.
    await check.tick();
    expect(bell).toHaveLength(2);
    expect(git(root, "rev-list", "--count", "HEAD")).toBe("2");
  });

  it("a follower install never commits the pin", async () => {
    await selfUpdate();
    const before = git(remote, "rev-parse", "main");
    const { check } = newDen({ role: () => "follower" });
    await check.tick();
    expect(git(remote, "rev-parse", "main")).toBe(before);
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
    expect(git(root, "status", "--porcelain").split("\n").sort()).toEqual([
      " M package-lock.json",
      " M package.json",
    ]);
  });

  it("a version that isn't verified yet (the watch still waits) isn't committed", async () => {
    await selfUpdate();
    const s = readUpdateState(stateDir)!;
    fs.writeFileSync(
      updateStateFile(stateDir),
      JSON.stringify({ ...s, state: "watching" }) + "\n",
    );
    const before = git(remote, "rev-parse", "main");
    await newDen().check.tick();
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("signed with agents.git.signing_key when set, never prompting", async () => {
    const key = path.join(tmp, "home", "agent_key");
    const kg = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-f", key, "-C", "agent"],
      { env },
    );
    expect(kg.status).toBe(0);
    await selfUpdate();
    const step = await commitPin("1.1.0", {
      root,
      stateDir,
      git: pinGit(root, { env, signingKey: key }),
    });
    expect(step).toMatchObject({ did: "pushed", version: "1.1.0" });
    const raw = git(root, "cat-file", "commit", "HEAD");
    expect(raw).toMatch(/-----BEGIN SSH SIGNATURE-----/);
  });

  it("no signing key set: an unsigned commit, even when the person's config asks to sign", async () => {
    fs.writeFileSync(
      path.join(tmp, "home", ".gitconfig"),
      "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n",
    );
    await selfUpdate();
    const step = await commitPin("1.1.0", {
      root,
      stateDir,
      git: pinGit(root, { env }),
    });
    expect(step).toMatchObject({ did: "pushed", version: "1.1.0" });
    expect(git(root, "cat-file", "commit", "HEAD")).not.toMatch(/gpgsig/);
  });

  /**
   * A fake gh, by its full path: it records its arguments and answers as
   * `answer` says (a pull request's address, or a failure).
   */
  function fakeGh(answer: "ok" | "fail"): {
    argv: string[];
    calls: () => string[][];
  } {
    const log = path.join(tmp, "gh-calls.jsonl");
    const script = path.join(tmp, "fake-gh.cjs");
    fs.writeFileSync(
      script,
      `const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (fs.existsSync(${JSON.stringify(path.join(tmp, "gh-fails"))})) {
  process.stderr.write("gh: not logged in\\n");
  process.exit(1);
}
process.stdout.write("https://example.invalid/acme/dist/pull/7\\n");
`,
    );
    if (answer === "fail") fs.writeFileSync(path.join(tmp, "gh-fails"), "");
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

  describe("server_agent.pin_commit: pr", () => {
    it("the pin goes on its own branch, gh opens the pull request, and the checkout's branch and index stay put", async () => {
      await selfUpdate();
      fs.writeFileSync(path.join(root, "draft.md"), "staged draft\n");
      git(root, "add", "draft.md");
      const head = git(root, "rev-parse", "HEAD");
      const gh = fakeGh("ok");
      const { check, bell } = newDen({}, { mode: "pr", gh: gh.argv });

      await check.tick();

      const branch = "den/pin-1.1.0";
      expect(git(remote, "log", "-1", "--format=%s", branch)).toBe(
        "Den 1.1.0: pin the distribution to Den 1.1.0",
      );
      expect(
        git(remote, "show", "--name-only", "--format=", branch)
          .split("\n")
          .sort(),
      ).toEqual(["package-lock.json", "package.json"]);
      expect(git(remote, "rev-parse", `${branch}~1`)).toBe(head);
      expect(git(remote, "rev-parse", "main")).toBe(head);
      // The checkout: same commit, same index, the pin still in its files.
      expect(git(root, "rev-parse", "HEAD")).toBe(head);
      expect(git(root, "status", "--porcelain").split("\n").sort()).toEqual([
        " M package-lock.json",
        " M package.json",
        "A  draft.md",
      ]);
      expect(gh.calls()).toHaveLength(1);
      expect(gh.calls()[0]).toEqual(
        expect.arrayContaining([
          "pr",
          "create",
          "--head",
          branch,
          "--base",
          "main",
        ]),
      );
      expect(bell).toEqual(["pin pr 1.1.0"]);
      expect(readPinRecord(stateDir)).toMatchObject({
        state: "pr_opened",
        url: "https://example.invalid/acme/dist/pull/7",
      });
      // Done: no second pull request.
      await check.tick();
      expect(gh.calls()).toHaveLength(1);
      expect(bell).toHaveLength(1);
    });

    it("gh can't open it: the branch is pushed, the bell says so once, and the next check tries gh again", async () => {
      await selfUpdate();
      const gh = fakeGh("fail");
      const { check, bell } = newDen({}, { mode: "pr", gh: gh.argv });
      await check.tick();
      await check.tick();
      expect(git(remote, "log", "-1", "--format=%s", "den/pin-1.1.0")).toMatch(
        /^Den 1\.1\.0: pin/,
      );
      expect(bell).toEqual(["pin branch_pushed 1.1.0"]);
      expect(gh.calls()).toHaveLength(2);
      fs.rmSync(path.join(tmp, "gh-fails"));
      await check.tick();
      expect(bell).toEqual(["pin branch_pushed 1.1.0", "pin pr 1.1.0"]);
    });

    it("a GitHub remote gives the compare page to open it by hand", () => {
      expect(
        compareLink("git@github.com:acme/dist.git", "main", "den/pin-1.1.0"),
      ).toBe(
        "https://github.com/acme/dist/compare/main...den/pin-1.1.0?expand=1",
      );
      expect(compareLink("/tmp/remote.git", "main", "x")).toBeNull();
    });
  });

  describe("the approval policy (issue 160)", () => {
    it("den_pin_commit is a placed, routine held write: the default runs it, ask holds it", () => {
      expect(HELD_WRITE_RISK.den_pin_commit.risk).toBe("routine");
      expect(
        Object.keys(heldActions({} as Parameters<typeof heldActions>[0])),
      ).toContain("den_pin_commit");
      expect(policyFor("den_pin_commit", {}).kind).toBe("notify");
      expect(
        policyFor("den_pin_commit", {
          install: { writes: { den_pin_commit: "ask" } },
        }).kind,
      ).toBe("ask");
    });

    it("the policy says ask: nothing is committed, one held Allow and one bell item; the Allow commits and pushes", async () => {
      await selfUpdate();
      const before = git(remote, "rev-parse", "main");
      const asked: string[] = [];
      const { check, bell } = newDen(
        {},
        { allow: () => "ask", ask: (v) => (asked.push(v), true) },
      );
      await check.tick();
      await check.tick();
      expect(asked).toEqual(["1.1.0"]);
      expect(bell).toEqual(["pin held 1.1.0"]);
      expect(git(root, "rev-parse", "HEAD")).toBe(before);
      expect(git(remote, "rev-parse", "main")).toBe(before);
      // The person's Allow runs it (no policy on that run).
      const step = await commitPin("1.1.0", {
        root,
        stateDir,
        git: pinGit(root, { env }),
      });
      expect(step).toMatchObject({ did: "pushed", version: "1.1.0" });
      expect(git(remote, "log", "-1", "--format=%s", "main")).toBe(
        "Den 1.1.0: pin the distribution to Den 1.1.0",
      );
    });

    it("the policy says run (notify, auto): it commits and pushes at once", async () => {
      await selfUpdate();
      const asked: string[] = [];
      const { check } = newDen(
        {},
        { allow: () => "run", ask: (v) => (asked.push(v), true) },
      );
      await check.tick();
      expect(asked).toEqual([]);
      expect(git(remote, "log", "-1", "--format=%s", "main")).toBe(
        "Den 1.1.0: pin the distribution to Den 1.1.0",
      );
    });
  });
});
