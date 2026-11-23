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
  checkAgentSigning,
  ensureAgentSigningKey,
  gitSigningBlock,
  resolveAgentSigning,
  signingReadFiles,
} from "../../../src/shared/agents/git-signing.js";
import {
  agentSandboxPolicy,
  sandboxFor,
  sandboxHidesFile,
} from "../../../src/shared/agents/sandbox.js";
import { agentSandboxInput } from "../../../src/ui/cli/agent-ops.js";
import { signingInSandbox } from "../../../src/ui/cli/doctor-command.js";
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

/** A key the person set by hand at `rel` in the state dir. */
function keyInState(stateDir: string, rel: string) {
  const key = path.join(stateDir, rel);
  fs.mkdirSync(path.dirname(key), { recursive: true });
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  return key;
}
const OWN_KEY = path.join("agent-signing", "mine", "den-agents_ed25519");
/** State files that hold secrets, and a folder of the person's own. */
const NOT_A_KEY_PLACE = [
  "push-vapid.json",
  path.join("hub", "unrevoked", "x.token"),
  path.join("backup", "y.bad"),
  "web.secret",
  path.join("git-signing", "den-agents_ed25519"),
];

describe("issue 1316: agents.git.signing_key in the state dir", () => {
  it("only under agent-signing/ is it read back; every other state file is refused, and why", () => {
    const ins = install();
    const key = keyInState(ins.stateDir, OWN_KEY);
    const bad = NOT_A_KEY_PLACE.map((r) => keyInState(ins.stateDir, r));
    fs.symlinkSync(key, path.join(base, "link"));
    const p = agentSandboxPolicy({
      ...ins,
      readableFiles: [key, `${key}.pub`, ...bad, path.join(ins.stateDir, "hub"), path.join(base, "link")],
    });
    const real = (f: string) => fs.realpathSync(f);
    expect(p.readableFiles).toContain(real(key));
    expect(p.readableFiles).toContain(real(`${key}.pub`));
    for (const f of bad) {
      expect(p.readableFiles).not.toContain(real(f));
      expect(sandboxHidesFile(f, ins)).toMatch(/is in Den's state folder, hidden from agents: put the key in .*agent-signing/);
    }
    expect(sandboxHidesFile(path.join(ins.stateDir, "hub"), ins)).toMatch(/not a file/);
    expect(sandboxHidesFile(path.join(base, "link"), ins)).toMatch(/is a link/);
    expect(signingReadFiles({ signingKey: key })).toEqual([key, `${key}.pub`]);
    expect(signingReadFiles({ off: true })).toEqual([]);
  });

  it("outside state: never in an edge's key folder or another install's state (a * matches one name)", () => {
    const ins = install();
    const other = path.join(base, "other-state");
    const edge = path.join(base, "share", "acme", "edge");
    const outside = path.join(base, "keys");
    const k1 = keyInState(other, "k");
    const k2 = keyInState(edge, path.join("ca", "k"));
    const k3 = keyInState(outside, "k");
    const i = { ...ins, keyRefusedDirs: [other, path.join(base, "share", "*", "edge")] };
    expect(sandboxHidesFile(k1, i)).toMatch(/hidden from agents/);
    expect(sandboxHidesFile(k2, i)).toMatch(/hidden from agents/);
    expect(sandboxHidesFile(k3, i)).toBeNull();
    // A linked data folder: the * pattern is matched on its real path.
    fs.symlinkSync(path.join(base, "share"), path.join(base, "share-link"));
    expect(
      sandboxHidesFile(k2, { ...ins, keyRefusedDirs: [path.join(base, "share-link", "*", "edge")] }),
    ).toMatch(/hidden from agents/);
    const p = agentSandboxPolicy({ ...i, readableFiles: [k1, k2, k3] });
    expect(p.readableFiles).toEqual(expect.arrayContaining([fs.realpathSync(k3)]));
    expect(p.readableFiles).not.toContain(fs.realpathSync(k1));
    expect(p.readableFiles).not.toContain(fs.realpathSync(k2));
  });

  onMac("named as signing_key, a state secret stays unreadable in the real sandbox", () => {
    const ins = install();
    const bad = NOT_A_KEY_PLACE.map((r) => keyInState(ins.stateDir, r));
    const box = sandboxFor(
      ["/bin/sh", "-c", bad.map((f, n) => `cat ${f} >/dev/null 2>&1; echo f${n}=$?`).join("; ")],
      { ...ins, readableFiles: bad.flatMap((f) => [f, `${f}.pub`]) },
      { platform: "darwin", on: true },
    );
    const out = spawnSync(box.argv[0], box.argv.slice(1), { encoding: "utf8" }).stdout;
    bad.forEach((_, n) => expect(out).toMatch(new RegExp(`^f${n}=[1-9]`, "m")));
  });

  onMac("a key under agent-signing/ signs in the real sandbox; a private sibling and its folder stay unreadable", () => {
    const p = person(true);
    const ins = install();
    const key = keyInState(ins.stateDir, OWN_KEY);
    fs.writeFileSync(path.join(ins.stateDir, "push-vapid.json"), "private\n");
    const git = gitSigningBlock({ signing_key: key });
    const s = resolveAgentSigning({ git, stateDir: ins.stateDir, cwd: p.repo, env: p.env });
    const input = { ...ins, readableFiles: signingReadFiles(git) };
    const script = [
      "git commit -q --allow-empty -m t; echo commit=$?",
      `cat ${ins.stateDir}/push-vapid.json >/dev/null 2>&1; echo sibling=$?`,
      `ls ${ins.stateDir} >/dev/null 2>&1; echo state=$?`,
      `echo x >> ${key} 2>/dev/null; echo write=$?`,
    ].join("; ");
    const box = sandboxFor(["/bin/sh", "-c", script], input, { platform: "darwin", on: true });
    const env = { ...p.env, ...agentGitEnv(s), ...box.env };
    const out = spawnSync(box.argv[0], box.argv.slice(1), { cwd: p.repo, env, encoding: "utf8" });
    expect(out.stdout).toMatch(/^commit=0$/m);
    for (const k of ["sibling", "state", "write"])
      expect(out.stdout).toMatch(new RegExp(`^${k}=[1-9]`, "m"));
    expect(fs.existsSync(p.marker)).toBe(false);
  });

  onMac("a key elsewhere in state: the commit fails in the sandbox, and doctor says why", () => {
    const p = person(true);
    const ins = install();
    const key = keyInState(ins.stateDir, path.join("git-signing", "den-agents_ed25519"));
    const git = gitSigningBlock({ signing_key: key });
    const s = resolveAgentSigning({ git, stateDir: ins.stateDir, cwd: p.repo, env: p.env });
    const box = sandboxFor(
      ["git", "commit", "-q", "--allow-empty", "-m", "u"],
      { ...ins, readableFiles: signingReadFiles(git) },
      { platform: "darwin", on: true },
    );
    const r = spawnSync(box.argv[0], box.argv.slice(1), {
      cwd: p.repo,
      env: { ...p.env, ...agentGitEnv(s), ...box.env },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    const o = { stateDir: ins.stateDir, distRoot: ins.distRoot, env: p.env, on: true, tmp: base };
    const d = signingInSandbox({ signingKey: key }, o);
    expect(d.ok).toBe(false);
    expect(d.detail).toMatch(/agents can't read their signing key: .*is in Den's state folder.*agent-signing/);
  });

  onMac("doctor checks inside the sandbox: a key under agent-signing/ passes; each state secret fails, naming why", () => {
    const p = person(true);
    const ins = install();
    const o = { stateDir: ins.stateDir, distRoot: ins.distRoot, env: p.env, on: true, tmp: base };
    expect(signingInSandbox({ signingKey: keyInState(ins.stateDir, OWN_KEY) }, o)).toMatchObject({ ok: true });
    for (const r of NOT_A_KEY_PLACE) {
      const d = signingInSandbox({ signingKey: keyInState(ins.stateDir, r) }, o);
      expect([r, d.ok]).toEqual([r, false]);
      expect(d.detail).toMatch(/is in Den's state folder, hidden from agents/);
    }
  });

  onMac("doctor's sandboxed check fails where the session would (the key unreadable there)", () => {
    const p = person(true);
    const ins = install();
    const key = keyInState(ins.stateDir, path.join("git-signing", "k"));
    const r = checkAgentSigning(
      { signingKey: key },
      {
        tmp: base,
        env: p.env,
        wrap: (argv) => {
          const w = sandboxFor(argv, ins, { platform: "darwin", on: true });
          return { argv: w.argv, env: w.env };
        },
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe("issue 1316: a key folder missing a file", () => {
  it("is moved aside and a whole key is made", () => {
    const ins = install();
    const first = ensureAgentSigningKey(ins.stateDir);
    fs.rmSync(`${first.signingKey}.pub`);
    const next = ensureAgentSigningKey(ins.stateDir);
    expect(next.made).toBe(true);
    expect(fs.existsSync(`${next.signingKey}.pub`)).toBe(true);
    const left = fs.readdirSync(path.join(ins.stateDir, AGENT_SIGNING_DIR));
    expect(left.filter((f) => f.startsWith(".incomplete-"))).toHaveLength(1);
  });
});

describe("issue 1316: Den's launch passes the key's files to the sandbox", () => {
  it("agentSandboxInput carries readableFiles; none when unset", () => {
    const ins = install();
    const key = keyInState(ins.stateDir, OWN_KEY);
    const o = { stateDir: ins.stateDir, distRoot: ins.distRoot, env: { HOME: base }, agentId: "a1" };
    const withKey = agentSandboxInput({ ...o, readableFiles: signingReadFiles({ signingKey: key }) });
    expect(withKey.readableFiles).toEqual([key, `${key}.pub`]);
    expect(Array.isArray(withKey.keyRefusedDirs)).toBe(true);
    expect("readableFiles" in agentSandboxInput(o)).toBe(false);
  });
});
