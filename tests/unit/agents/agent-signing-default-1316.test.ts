/**
 * Issue 1316: agents sign their commits with their own SSH key by default.
 *
 * A person whose git signs commits with GPG (commit.gpgsign true) had
 * agents whose commits failed: the sandbox refuses gpg's agent socket, as
 * it should. Now, when the person's own git signs commits and no
 * agents.git.signing_key is set, Den makes one ed25519 key for the
 * install's agents (in <state>/agent-signing, readable in the sandbox and
 * never writable there) and the session signs with it through
 * GIT_CONFIG_*. The person's GPG is never called.
 *
 * Real git, ssh-keygen and (on macOS) sandbox-exec in temp folders; a temp
 * HOME, never the real one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  AGENT_SIGNING_DIR,
  agentGitEnv,
  agentSigningKeyDir,
  ensureAgentSigningKey,
  gitSigningBlock,
  resolveAgentSigning,
} from "../../../src/shared/agents/git-signing.js";
import { sandboxFor } from "../../../src/shared/agents/sandbox.js";
import {
  GPG_REFUSAL_NOTE,
  refusalNote,
} from "../../../src/shared/agents/guardrails/sandbox-refusal.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

// Short: the sandbox's socket rules want short paths (macOS).
const tmpRoot = fs.realpathSync(fs.mkdtempSync("/tmp/d1316-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let base: string;
let n = 0;
beforeEach(() => {
  base = path.join(tmpRoot, String(n++));
  fs.mkdirSync(base);
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

/** A person's HOME whose git signs every commit with a stand-in gpg. */
function person(gpgsign: boolean) {
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  const marker = path.join(base, "gpg-was-called");
  const gpg = path.join(base, "gpg");
  fs.writeFileSync(gpg, `#!/bin/sh\necho "$@" >> ${marker}\nexit 2\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(home, ".gitconfig"),
    [
      "[user]",
      "\tname = person",
      "\temail = person@example.invalid",
      "\tsigningkey = PERSONS-GPG-KEY",
      "[gpg]",
      `\tprogram = ${gpg}`,
      "[commit]",
      `\tgpgsign = ${gpgsign}`,
      "",
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of Object.keys(env))
    if (k.startsWith("GIT_CONFIG_") && k !== "GIT_CONFIG_NOSYSTEM") delete env[k];
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const repo = path.join(base, "work");
  fs.mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo], { env });
  return { home, env, repo, marker };
}

/** The state dir, install root and gate store a sandbox is made from. */
function install() {
  const stateDir = path.join(base, "state");
  const distRoot = path.join(base, "root");
  const gateDir = path.join(base, "gate");
  for (const d of [
    path.join(stateDir, "agents"),
    path.join(stateDir, "agent-files", "a1"),
    path.join(distRoot, "config", "local"),
    gateDir,
  ])
    fs.mkdirSync(d, { recursive: true });
  return { stateDir, distRoot, gateDir, agentId: "a1" };
}

const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 30_000 });

const onMac =
  process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec") ? it : it.skip;

describe("issue 1316: an agent's commit, in its sandbox, signs with the agents' key", () => {
  onMac("commits, verifies with the agent key, and never calls the person's gpg", () => {
    const p = person(true);
    const ins = install();
    const signing = resolveAgentSigning({
      git: undefined,
      stateDir: ins.stateDir,
      cwd: p.repo,
      env: p.env,
    });
    expect(signing?.source).toBe("default");
    const box = sandboxFor(["git", "commit", "-q", "--allow-empty", "-m", "t"], ins, {
      platform: "darwin",
      on: true,
    });
    expect(box.applied).toBe(true);
    const env = { ...p.env, ...agentGitEnv(signing), ...box.env };
    const r = spawnSync(box.argv[0], box.argv.slice(1), {
      cwd: p.repo,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(fs.existsSync(p.marker)).toBe(false);
    // Verified with the allowed_signers Den wrote, as the session's git does.
    const v = git(["verify-commit", "HEAD"], p.repo, env);
    expect([v.status, v.stderr]).toEqual([0, expect.stringMatching(/Good "git" signature/)]);
    expect(fs.existsSync(p.marker)).toBe(false);
  });

  onMac("the key's folder is readable in the sandbox and never writable there", () => {
    const p = person(true);
    const ins = install();
    const s = resolveAgentSigning({ git: undefined, stateDir: ins.stateDir, cwd: p.repo, env: p.env })!;
    const dir = path.dirname(s.signingKey);
    const script = [
      `cat ${s.signingKey} >/dev/null 2>&1; echo read=$?`,
      `echo x > ${dir}/planted 2>/dev/null; echo plant=$?`,
      `echo x >> ${s.signingKey} 2>/dev/null; echo write=$?`,
      `rm -f ${s.signingKey}.pub 2>/dev/null; echo rm=$?`,
      `mv ${dir} ${dir}.moved 2>/dev/null; echo mv=$?`,
      `cat ${ins.stateDir}/agents/../web.secret >/dev/null 2>&1; echo other=$?`,
    ].join("; ");
    fs.writeFileSync(path.join(ins.stateDir, "web.secret"), "s\n");
    const box = sandboxFor(["/bin/sh", "-c", script], ins, { platform: "darwin", on: true });
    const out = spawnSync(box.argv[0], box.argv.slice(1), { encoding: "utf8" }).stdout;
    expect(out).toMatch(/^read=0$/m);
    for (const k of ["plant", "write", "rm", "mv", "other"])
      expect(out).toMatch(new RegExp(`^${k}=[1-9]`, "m"));
    expect(fs.existsSync(`${s.signingKey}.pub`)).toBe(true);
  });
});

describe("issue 1316: which key, and when", () => {
  it("agents.git.signing: off leaves the session's env as it was", () => {
    const p = person(true);
    const ins = install();
    const block = gitSigningBlock({ signing: "off" });
    const s = resolveAgentSigning({ git: block, stateDir: ins.stateDir, cwd: p.repo, env: p.env });
    expect(s).toBeUndefined();
    expect(agentGitEnv(s)).toEqual({});
    expect(fs.existsSync(path.join(ins.stateDir, AGENT_SIGNING_DIR))).toBe(false);
  });

  it("a signing_key that is set wins over the default key", () => {
    const p = person(true);
    const ins = install();
    const own = path.join(base, "own_key");
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", own]);
    const s = resolveAgentSigning({
      git: gitSigningBlock({ signing_key: own }),
      stateDir: ins.stateDir,
      cwd: p.repo,
      env: p.env,
    });
    expect(s).toMatchObject({ signingKey: own, source: "setting" });
    expect(agentGitEnv(s)).toMatchObject({ GIT_CONFIG_VALUE_1: own });
    expect(fs.existsSync(path.join(ins.stateDir, AGENT_SIGNING_DIR))).toBe(false);
  });

  it("the person's git doesn't sign: nothing changes, and no key is made", () => {
    const p = person(false);
    const ins = install();
    const s = resolveAgentSigning({ git: undefined, stateDir: ins.stateDir, cwd: p.repo, env: p.env });
    expect(s).toBeUndefined();
    expect(agentGitEnv(s)).toEqual({});
    expect(fs.existsSync(path.join(ins.stateDir, AGENT_SIGNING_DIR))).toBe(false);
  });

  it("a repo's own commit.gpgsign true turns it on (the global is off)", () => {
    const p = person(false);
    git(["config", "commit.gpgsign", "true"], p.repo, p.env);
    const ins = install();
    const s = resolveAgentSigning({ git: undefined, stateDir: ins.stateDir, cwd: p.repo, env: p.env });
    expect(s?.source).toBe("default");
  });

  it("the default env names the key, ssh format, and its allowed_signers", () => {
    const p = person(true);
    const ins = install();
    const s = resolveAgentSigning({ git: undefined, stateDir: ins.stateDir, cwd: p.repo, env: p.env })!;
    const env = agentGitEnv(s);
    const pairs = Object.fromEntries(
      Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [
        env[`GIT_CONFIG_KEY_${i}`],
        env[`GIT_CONFIG_VALUE_${i}`],
      ]),
    );
    expect(pairs).toEqual({
      "gpg.format": "ssh",
      "user.signingkey": s.signingKey,
      "commit.gpgsign": "true",
      "gpg.ssh.allowedSignersFile": s.allowedSigners,
    });
    expect(path.dirname(s.signingKey)).toBe(agentSigningKeyDir(ins.stateDir));
    expect(fs.statSync(s.signingKey).mode & 0o077).toBe(0);
  });
});

describe("issue 1316: the key is made once", () => {
  it("two resolves that race make one key; the loser uses the winner's", () => {
    const ins = install();
    let inner: ReturnType<typeof ensureAgentSigningKey> | undefined;
    // The first is about to move its key into place when the second runs
    // all the way through and wins.
    const outer = ensureAgentSigningKey(ins.stateDir, {
      beforePlace: () => {
        inner = ensureAgentSigningKey(ins.stateDir);
      },
    });
    expect(inner).toBeDefined();
    expect(outer.signingKey).toBe(inner!.signingKey);
    const pub = fs.readFileSync(`${outer.signingKey}.pub`, "utf8");
    expect(fs.readFileSync(outer.allowedSigners!, "utf8")).toContain(pub.split(/\s+/)[1]);
    // No half-made folders left behind.
    const left = fs.readdirSync(path.join(ins.stateDir, AGENT_SIGNING_DIR));
    expect(left).toEqual([path.basename(agentSigningKeyDir(ins.stateDir))]);
    // A third finds it and makes nothing.
    const again = ensureAgentSigningKey(ins.stateDir, {
      beforePlace: () => {
        throw new Error("made a key again");
      },
    });
    expect(again.signingKey).toBe(outer.signingKey);
    expect(fs.readFileSync(`${again.signingKey}.pub`, "utf8")).toBe(pub);
  });
});

describe("issue 1316: agents start", () => {
  afterEach(cleanupRigs);

  it("the person's git signs: the session gets the default key; the start line gives gh's line once", async () => {
    const p = person(true);
    const r = await rig();
    r.deps.env = { ...r.deps.env, HOME: p.home };
    expect(await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps)).toBe(0);
    const env = r.made[0].opts.env;
    const keyFile = path.join(agentSigningKeyDir(r.deps.stateDir!()), "id_ed25519");
    expect(env.GIT_CONFIG_COUNT).toBe("4");
    expect(env.GIT_CONFIG_VALUE_1).toBe(keyFile);
    const said = [...r.out, ...r.err].join("\n");
    expect(said).toContain(`gh ssh-key add "${keyFile}.pub" --type signing`);
    // The second start finds the key: same key, no line.
    r.out.length = 0;
    r.err.length = 0;
    expect(await cmdAgents(["start", "-w", "south", "--persona", "planner"], r.deps)).toBe(0);
    expect(r.made[1].opts.env.GIT_CONFIG_VALUE_1).toBe(keyFile);
    expect([...r.out, ...r.err].join("\n")).not.toContain("gh ssh-key add");
  });

  it("the person's git doesn't sign: no GIT_CONFIG_*, no line", async () => {
    const p = person(false);
    const r = await rig();
    r.deps.env = { ...r.deps.env, HOME: p.home };
    expect(await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps)).toBe(0);
    expect("GIT_CONFIG_COUNT" in r.made[0].opts.env).toBe(false);
    expect([...r.out, ...r.err].join("\n")).not.toContain("gh ssh-key add");
  });
});

describe("issue 1316: a refused GPG signing gets its own note", () => {
  const inBox = { DEN_AGENT_SANDBOX: "1" };
  it("gpg's IPC error: says why, and forbids the API commit", () => {
    for (const error of [
      "error: gpg failed to sign the data:\ngpg: signing failed: IPC connect call failed\nfatal: failed to write commit object",
      "gpg: can't connect to the agent: IPC connect call failed",
    ]) {
      const n = refusalNote({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", error }, inBox);
      expect(n?.hookSpecificOutput.additionalContext).toBe(GPG_REFUSAL_NOTE);
    }
    expect(GPG_REFUSAL_NOTE).toMatch(/never commit through the GitHub API/);
    // Outside the sandbox: nothing.
    expect(
      refusalNote({ hook_event_name: "PostToolUseFailure", error: "IPC connect call failed" }, {}),
    ).toBeNull();
  });

  it("the agents' instructions forbid committing through an API with the person's token", () => {
    const text = fs.readFileSync(
      path.join(__dirname, "../../../src/shared/agents/guardrails/instructions.md"),
      "utf8",
    );
    expect(text).toMatch(/never commit[^.]*through (?:the GitHub|an) API[^.]*person's token/i);
  });
});
