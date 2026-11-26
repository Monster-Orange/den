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
import { pinDoctorText } from "../../../src/shared/pin-record.js";

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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1745-")));
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
  git(root, "remote", "add", "origin", GH_URL);
  git(root, "config", `url.${remote}.insteadOf`, GH_URL);
  git(root, "push", "-q", "-u", "origin", "main");
  fs.rmSync(path.join(tmp, "pushed.log"), { force: true });
  fs.writeFileSync(path.join(root, "package.json"), pkgJson("1.1.0"));
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lock":"1.1.0"}\n');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

const heads = () =>
  git(
    tmp,
    "--git-dir",
    remote,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
  )
    .split("\n")
    .filter(Boolean);

const blockDen = () => {
  git(root, "push", "-q", "origin", "HEAD:refs/heads/den");
  fs.rmSync(path.join(tmp, "pushed.log"), { force: true });
};

describe("issue 1745: the pin's branch name never clashes with the remote's branches", () => {
  it("a `den` branch on the remote: the pin goes to den-pin-<v>, and the step, the record, the bell and doctor say why", async () => {
    blockDen();
    const gh = fakeGh("fail");
    const step = await commitPin("1.1.0", deps(gh.argv, { mode: "pr" }));
    expect(step).toMatchObject({
      did: "pr",
      branch: "den-pin-1.1.0",
      branchWhy: expect.stringMatching(/`den` branch/),
    });
    expect(heads()).toContain("refs/heads/den-pin-1.1.0");
    expect(readPinRecord(stateDir)).toMatchObject({
      state: "pr_opened",
      branch: "den-pin-1.1.0",
      branchWhy: expect.stringMatching(/`den` branch/),
    });
    const bell = pinBellMessage(step, "Den");
    expect(bell?.text).toMatch(/den-pin-1\.1\.0/);
    expect(bell?.text).toMatch(/`den` branch/);
    expect(pinDoctorText(readPinRecord(stateDir))).toMatch(
      /den-pin-1\.1\.0.*`den` branch/,
    );
  });

  it("den/pin-<v> already taken by another commit: the next free name", async () => {
    git(root, "push", "-q", "origin", "HEAD:refs/heads/den/pin-1.1.0");
    const gh = fakeGh("fail");
    const step = await commitPin("1.1.0", deps(gh.argv, { mode: "pr" }));
    expect(step).toMatchObject({
      did: "pr",
      branch: "den-pin-1.1.0",
      branchWhy: expect.stringMatching(/den\/pin-1\.1\.0 is taken/),
    });
  });

  it("nothing in the way: den/pin-<v> as before, and no reason given", async () => {
    const gh = fakeGh("fail");
    const step = await commitPin("1.1.0", deps(gh.argv, { mode: "pr" }));
    expect(step).toMatchObject({ did: "pr", branch: "den/pin-1.1.0" });
    expect((step as { branchWhy?: string }).branchWhy).toBeUndefined();
  });

  it("the remote can't be listed and the push is refused for a clash: one retry on the free name (backstop)", async () => {
    blockDen();
    const gh = fakeGh("fail");
    const first = await commitPin(
      "1.1.0",
      deps(gh.argv, {
        mode: "pr",
        git: (args, e) =>
          args[0] === "ls-remote"
            ? Promise.resolve({ code: 128, out: "offline" })
            : pinGit(root, { env })(args, e),
      }),
    );
    expect(first).toMatchObject({ did: "pr", branch: "den-pin-1.1.0" });
  });

  it("a stranded record from before this fix (den/pin-<v>, push_failed) is pushed under a free name", async () => {
    blockDen();
    const sha = git(
      root,
      "commit-tree",
      "-m",
      "pin",
      `${git(root, "write-tree")}`,
      "-p",
      "HEAD",
    );
    fs.mkdirSync(path.join(stateDir, "server-agent", "update"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(stateDir, "server-agent", "update", "pin.json"),
      JSON.stringify({
        version: "1.1.0",
        state: "push_failed",
        sha,
        branch: "den/pin-1.1.0",
        why: "git push to origin den/pin-1.1.0: ! [remote rejected] (directory file conflict)",
        noted: true,
        at: "2026-11-20T10:00:00.000Z",
      }),
    );
    const gh = fakeGh("fail");
    const step = await commitPin("1.1.0", deps(gh.argv, { mode: "pr" }));
    expect(step).toMatchObject({ did: "pr", branch: "den-pin-1.1.0", sha });
    expect(heads()).toContain("refs/heads/den-pin-1.1.0");
  });

  it("a failed pin push rings one bell with its reason (guard)", () => {
    const bell = pinBellMessage(
      {
        did: "push_failed",
        version: "1.1.0",
        sha: "0123456789abcdef",
        why: "git push to origin den-pin-1.1.0: offline",
        first: true,
      },
      "Den",
    );
    expect(bell?.key).toBe("bell.m.pinPushFailed");
    expect(bell?.text).toMatch(
      /push failed: git push to origin den-pin-1\.1\.0: offline/,
    );
  });
});
