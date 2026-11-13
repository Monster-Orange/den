/**
 * agents.git.signing_key: agents Den starts sign their commits with an SSH
 * key of their own, through GIT_CONFIG_* in their env. The person's git
 * config is never written. Real git and ssh-keygen in temp folders; a
 * temp HOME and GIT_CONFIG_GLOBAL, never the real ones.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentGitEnv,
  checkAgentSigning,
  gitSigningBlock,
  signingKeyAddLine,
} from "../../../src/shared/agents/git-signing.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";
import { agentSessionEnv } from "../../../src/shared/agents/runtimes.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig } from "./helpers/rig.js";
import { signingLines } from "../../../src/ui/cli/doctor-command.js";

let dir: string;
let key: string;
let globalCfg: string;
const GLOBAL_TEXT = "[user]\n\tname = person\n\tsigningkey = PERSONS-OWN\n[commit]\n\tgpgsign = false\n";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gitsign-"));
  key = path.join(dir, "den_agents");
  const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "den agents", "-f", key]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  globalCfg = path.join(dir, "home", ".gitconfig");
  fs.mkdirSync(path.dirname(globalCfg));
  fs.writeFileSync(globalCfg, GLOBAL_TEXT);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("agents.git.signing_key: the setting", () => {
  it("~ expands; a relative path, a non-string or another key is refused, naming it", () => {
    expect(gitSigningBlock({ signing_key: "~/.ssh/den_agents" }, "/h")).toEqual({
      signingKey: "/h/.ssh/den_agents",
    });
    expect(gitSigningBlock(undefined)).toBeUndefined();
    expect(() => gitSigningBlock({ signing_key: "keys/x" })).toThrow(
      /agents\.git\.signing_key: must be an absolute path/,
    );
    expect(() => gitSigningBlock({ signing_key: 3 })).toThrow(/agents\.git\.signing_key/);
    expect(() => gitSigningBlock({ signing_key: "/k", gpg: 1 })).toThrow(
      /agents\.git\.gpg: unknown key/,
    );
  });

  it("readAgentsConfig takes it; an agent called git with grants stays an agent", () => {
    const cfg = readAgentsConfig({ agents: { git: { signing_key: key } } } as never);
    expect(cfg.git).toEqual({ signingKey: key });
    expect(cfg.agents.git).toBeUndefined();
    const old = readAgentsConfig({ agents: { git: { grants: ["north"] } } } as never);
    expect(old.git).toBeUndefined();
    expect(old.agents.git).toEqual({ grants: ["north"] });
    expect(readAgentsConfig({} as never).git).toBeUndefined();
  });

  it("gate 0.4.44-dev.0: user.yml's (per machine) is read, and wins over the org's; a bad one names user.yml", () => {
    const org = { agents: { git: { signing_key: "/org/key" } } } as never;
    expect(readAgentsConfig({} as never, { agents: { git: { signing_key: key } } }).git).toEqual({
      signingKey: key,
    });
    expect(readAgentsConfig(org, { agents: { git: { signing_key: key } } }).git).toEqual({
      signingKey: key,
    });
    expect(readAgentsConfig(org, {}).git).toEqual({ signingKey: "/org/key" });
    let err: unknown;
    try {
      readAgentsConfig({} as never, { agents: { git: { signing_key: "rel/x" } } });
    } catch (e) {
      err = e;
    }
    expect((err as { issues: { file: string; key: string }[] }).issues[0]).toMatchObject({
      file: "config/local/user.yml",
      key: "agents.git.signing_key",
    });
  });

  it("gh's line names the .pub, as a signing key", () => {
    expect(signingKeyAddLine({ signingKey: "/k/den_agents" })).toBe(
      'gh ssh-key add "/k/den_agents.pub" --type signing --title "Den agents"',
    );
  });
});

describe("an agent's env", () => {
  it("unset: nothing of git's", () => {
    expect(agentGitEnv(undefined)).toEqual({});
    const env = agentSessionEnv({ PATH: "/bin", HOME: "/h" }, {}, {}, "a1");
    expect(Object.keys(env).filter((k) => k.startsWith("GIT_"))).toEqual([]);
  });

  it("set: gpg.format ssh, the key, commit.gpgsign true, past every scrub", () => {
    const g = agentGitEnv({ signingKey: key });
    expect(g).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "gpg.format",
      GIT_CONFIG_VALUE_0: "ssh",
      GIT_CONFIG_KEY_1: "user.signingkey",
      GIT_CONFIG_VALUE_1: key,
      GIT_CONFIG_KEY_2: "commit.gpgsign",
      GIT_CONFIG_VALUE_2: "true",
    });
    const env = agentSessionEnv({ PATH: "/bin", HOME: "/h" }, {}, {}, "a1", undefined, [], g);
    for (const [k, v] of Object.entries(g)) expect(env[k]).toBe(v);
  });
});

describe("a commit made with that env", () => {
  it("verifies, and the person's global config is untouched", () => {
    const repo = path.join(dir, "repo");
    const env = {
      PATH: process.env.PATH,
      HOME: path.dirname(globalCfg),
      GIT_CONFIG_GLOBAL: globalCfg,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "agent",
      GIT_AUTHOR_EMAIL: "agent@example.test",
      GIT_COMMITTER_NAME: "agent",
      GIT_COMMITTER_EMAIL: "agent@example.test",
      ...agentGitEnv({ signingKey: key }),
    };
    const git = (args: string[], cwd = repo) =>
      spawnSync("git", args, { cwd, env, encoding: "utf8" });
    expect(git(["init", "-q", repo], dir).status).toBe(0);
    const c = git(["commit", "-q", "--allow-empty", "-m", "agent work"]);
    expect(c.stderr).toBe("");
    expect(c.status).toBe(0);
    const allowed = path.join(dir, "allowed");
    const pub = fs.readFileSync(`${key}.pub`, "utf8").trim().split(/\s+/);
    fs.writeFileSync(allowed, `agent@example.test namespaces="git" ${pub[0]} ${pub[1]}\n`);
    const v = git(["-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", "HEAD"]);
    expect(v.status).toBe(0);
    expect(v.stderr).toMatch(/Good "git" signature/);
    expect(fs.readFileSync(globalCfg, "utf8")).toBe(GLOBAL_TEXT);
    // Without the env, the person's own config holds: commit.gpgsign false.
    const { GIT_CONFIG_COUNT: _n, ...without } = env;
    const p = spawnSync("git", ["config", "commit.gpgsign"], { cwd: repo, env: without, encoding: "utf8" });
    expect(p.stdout.trim()).toBe("false");
  });
});

describe("doctor's check", () => {
  it("a good key: signs and verifies", () => {
    const r = checkAgentSigning({ signingKey: key }, { tmp: dir });
    expect(r).toEqual({ ok: true, detail: `commits sign with ${key} and verify` });
  });

  it("no key, or no .pub: says which", () => {
    expect(checkAgentSigning({ signingKey: path.join(dir, "nope") }, { tmp: dir })).toEqual({
      ok: false,
      detail: `no key at ${path.join(dir, "nope")}`,
    });
    fs.rmSync(`${key}.pub`);
    expect(checkAgentSigning({ signingKey: key }, { tmp: dir }).detail).toMatch(/no public key at/);
  });

  it("a .pub that isn't the key's: the check fails, naming the step", () => {
    const other = path.join(dir, "other");
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", other]);
    fs.copyFileSync(`${other}.pub`, `${key}.pub`);
    const r = checkAgentSigning({ signingKey: key }, { tmp: dir });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^(a signed commit|git verify-commit) failed/);
  });
});

describe("agents start", () => {
  afterEach(cleanupRigs);

  it("an agent Den starts gets the key's GIT_CONFIG_*; unset, none", async () => {
    const r = await rig();
    r.config.git = { signingKey: key };
    expect(await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps)).toBe(0);
    const env = r.made[0].opts.env;
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_VALUE_1).toBe(key);
    expect(env.GIT_CONFIG_VALUE_2).toBe("true");
    const r2 = await rig();
    expect(await cmdAgents(["start", "-w", "north", "--persona", "planner"], r2.deps)).toBe(0);
    expect("GIT_CONFIG_COUNT" in r2.made[0].opts.env).toBe(false);
  });
});

describe("doctor's signing row", () => {
  it("unset: no row", () => {
    expect(signingLines("Acme", () => undefined)).toEqual({ lines: [], problem: false, checks: [] });
  });

  it("a key that signs: ✓, and the gh line", () => {
    const r = signingLines("Acme", () => ({ signingKey: key }), (g) => checkAgentSigning(g, { tmp: dir }));
    expect(r.problem).toBe(false);
    expect(r.lines.join("\n")).toContain(`signing  ✓  commits sign with ${key} and verify`);
    expect(r.lines.join("\n")).toContain(`gh ssh-key add "${key}.pub" --type signing`);
    expect(r.lines.join("\n")).toContain("admin:ssh_signing_key");
    expect(r.checks).toEqual([
      expect.objectContaining({ id: "agents:signing", status: "ok", fix: signingKeyAddLine({ signingKey: key }) }),
    ]);
  });

  it("one that doesn't: ✗, a problem", () => {
    const r = signingLines("Acme", () => ({ signingKey: path.join(dir, "gone") }), (g) => checkAgentSigning(g, { tmp: dir }));
    expect(r.problem).toBe(true);
    expect(r.checks[0]).toMatchObject({ status: "fail", detail: `no key at ${path.join(dir, "gone")}` });
  });
});
