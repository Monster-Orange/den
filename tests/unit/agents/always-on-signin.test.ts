/**
 * Issue 163 (b), (c): agents started under the always-on service sign in
 * with the CLI's long-lived token from the install's secrets store, never
 * the desktop keychain.
 *
 *   - mode always (the host job file, or the web job's DEN_AGENT_SIGNIN):
 *     the agent's spawn env carries CLAUDE_CODE_OAUTH_TOKEN, read from the
 *     store at the start; never argv, the record, or anything printed.
 *   - mode login: the store is never read and no token is passed.
 *   - mode always with no token: the start says agents will not be able to
 *     sign in after logout (it still starts).
 *
 * The store is an in-memory SecretsProvider; the `claude` and `security`
 * on PATH are shims that only record a run (security must never run).
 * Nothing reaches this machine's keychain, secrets store or launchd.
 * Invented token values only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type {
  SecretRef,
  SecretsProvider,
} from "../../../src/shared/secrets/types.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";
import {
  agentSignInMode,
  agentTokenStatus,
  saveAgentToken,
  tokenShapeError,
  tokenStatusLine,
  readAgentToken,
} from "../../../src/shared/agents/signin-token.js";

afterEach(cleanupRigs);

const TOKEN = "fake-oat-token-0123456789abcdef";
const REF: SecretRef = { vault: "V", item: "Den agent sign-in", field: "pw" };

/** An in-memory store that counts its reads. */
class MemStore implements SecretsProvider {
  readonly name = "1password" as const;
  reads = 0;
  writes: string[] = [];
  constructor(public value: string | null = null) {}
  async isReady() {
    return true;
  }
  async get(): Promise<string> {
    this.reads++;
    if (!this.value) throw new Error("not found");
    return this.value;
  }
  async tryGet(): Promise<string | null> {
    this.reads++;
    return this.value;
  }
  async set(_ref: SecretRef, v: string): Promise<void> {
    this.writes.push(v);
    this.value = v;
  }
  async preflight() {
    return { ok: true };
  }
  runPrefix() {
    return [];
  }
}

/** A rig whose host is the always-on service's (or login's). */
async function serviceRig(
  mode: "always" | "login",
  store: MemStore,
  ref: SecretRef | null = REF,
): Promise<{ r: Rig; securityRan: string }> {
  const r = await rig({
    signInStore: () => ({ provider: store, ref }),
  });
  fs.writeFileSync(
    path.join(r.stateDir, "sessions-host-job.json"),
    JSON.stringify({ label: "local.acme.sessions", mode }) + "\n",
  );
  // A `security` that only records a run: the keychain is never asked.
  const securityRan = path.join(r.dir, "security-ran");
  fs.writeFileSync(
    path.join(r.dir, "bin", "security"),
    `#!/bin/sh\necho "$@" >> "${securityRan}"\nexit 1\n`,
    { mode: 0o755 },
  );
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, "planner.md"),
    "---\nname: planner\n---\nYou plan.\n",
  );
  r.config.personaPacks = ["personas"];
  return { r, securityRan };
}

const start = (r: Rig) =>
  cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps);

describe("agents under the always-on service sign in with the token from the store", () => {
  it("mode always: the spawn env carries CLAUDE_CODE_OAUTH_TOKEN from the store; never argv, the record or output", async () => {
    const store = new MemStore(TOKEN);
    const { r, securityRan } = await serviceRig("always", store);
    expect(await start(r)).toBe(0);
    expect(r.made).toHaveLength(1);
    const p = r.made[0]!;
    const env = p.opts.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(store.reads).toBe(1);
    // Never argv, the agent record, or anything printed.
    expect(JSON.stringify([p.file, p.args])).not.toContain(TOKEN);
    const rec = fs.readFileSync(
      path.join(r.stateDir, "agents", "planner.json"),
      "utf-8",
    );
    expect(rec).not.toContain(TOKEN);
    expect([...r.out, ...r.err].join("\n")).not.toContain(TOKEN);
    // The keychain is never consulted.
    expect(fs.existsSync(securityRan)).toBe(false);
    expect(fs.existsSync(r.ran)).toBe(false);
  });

  it("the web job's DEN_AGENT_SIGNIN=token says so too, with no host job file", async () => {
    const store = new MemStore(TOKEN);
    const { r } = await serviceRig("login", store);
    r.deps.env = { ...r.deps.env, DEN_AGENT_SIGNIN: "token" };
    expect(await start(r)).toBe(0);
    expect(
      (r.made[0]!.opts.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN,
    ).toBe(TOKEN);
  });

  it("a caller's own CLAUDE_CODE_OAUTH_TOKEN never reaches an agent: only the store's", async () => {
    const store = new MemStore(TOKEN);
    const { r } = await serviceRig("always", store);
    r.deps.env = { ...r.deps.env, CLAUDE_CODE_OAUTH_TOKEN: "caller-own-xyz" };
    expect(await start(r)).toBe(0);
    expect(
      (r.made[0]!.opts.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN,
    ).toBe(TOKEN);
  });

  it("mode login: the store is never read and no token is passed", async () => {
    const store = new MemStore(TOKEN);
    const { r } = await serviceRig("login", store);
    r.deps.env = { ...r.deps.env, CLAUDE_CODE_OAUTH_TOKEN: "caller-own-xyz" };
    expect(await start(r)).toBe(0);
    const env = r.made[0]!.opts.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(store.reads).toBe(0);
  });

  it("mode always with no token: the start says agents will not be able to sign in after logout", async () => {
    const store = new MemStore(null);
    const { r } = await serviceRig("always", store);
    expect(await start(r)).toBe(0);
    expect(
      (r.made[0]!.opts.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN,
    ).toBeUndefined();
    expect(r.err.join("\n")).toMatch(
      /agents will not be able to sign in after logout.*claude setup-token, then acme agents token set/,
    );
  });

  it("mode always with no ref configured: the same warning, and the store is not read", async () => {
    const store = new MemStore(TOKEN);
    const { r } = await serviceRig("always", store, null);
    expect(await start(r)).toBe(0);
    expect(store.reads).toBe(0);
    expect(r.err.join("\n")).toMatch(
      /agents will not be able to sign in after logout/,
    );
  });
});

describe("the sign-in mode", () => {
  it("env first, then the host job file; desktop otherwise", async () => {
    const r = await rig();
    expect(agentSignInMode({}, r.stateDir)).toBe("desktop");
    fs.writeFileSync(
      path.join(r.stateDir, "sessions-host-job.json"),
      JSON.stringify({ mode: "always" }),
    );
    expect(agentSignInMode({}, r.stateDir)).toBe("token");
    expect(agentSignInMode({ DEN_AGENT_SIGNIN: "desktop" }, r.stateDir)).toBe(
      "desktop",
    );
    expect(agentSignInMode({ DEN_AGENT_SIGNIN: "token" }, "/nonexistent")).toBe(
      "token",
    );
  });
});

describe("agents token set: the store, never argv or output", () => {
  const status = (backend: "1password" | "env" | "none" = "1password") => ({
    backend,
    label: backend === "1password" ? "1Password" : backend,
    implicit: false,
    detect: { available: true },
  });

  it("a configured ref: written there, and when it was set is kept (not the token)", async () => {
    const r = await rig();
    const store = new MemStore();
    const res = await saveAgentToken(`  ${TOKEN}\n`, {
      provider: () => store,
      ref: () => REF,
      status: () => status(),
      stateDir: r.stateDir,
      now: () => new Date("2026-11-16T10:00:00Z"),
    });
    expect(res).toEqual({ ref: "configured", store: "1Password" });
    expect(store.writes).toEqual([TOKEN]);
    const meta = fs.readFileSync(
      path.join(r.stateDir, "agent-signin-token.json"),
      "utf-8",
    );
    expect(meta).toContain("2026-11-16T10:00:00");
    expect(meta).not.toContain(TOKEN);
    expect(
      fs.statSync(path.join(r.stateDir, "agent-signin-token.json")).mode &
        0o777,
    ).toBe(0o600);
  });

  it("no ref and a backend that keeps secrets: creates the item, then writes the ref to user.yml", async () => {
    const r = await rig();
    const store = new MemStore();
    const saved: unknown[] = [];
    const res = await saveAgentToken(TOKEN, {
      provider: () => store,
      ref: () => null,
      status: () => status(),
      saveRef: (x) => saved.push(x),
      stateDir: r.stateDir,
    });
    expect(res.ref).toBe("created");
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
  });

  it("the env backend is refused: a daemon never sees it", async () => {
    const r = await rig();
    await expect(
      saveAgentToken(TOKEN, {
        provider: () => new MemStore(),
        ref: () => null,
        status: () => status("env"),
        stateDir: r.stateDir,
      }),
    ).rejects.toThrow(/keeps nothing a daemon can read/);
  });

  it("a store error never carries the token", async () => {
    const r = await rig();
    const store = new MemStore();
    store.set = async (_r, v) => {
      throw new Error(
        `Command failed: op item edit x password=${v}\nop said no to ${v}`,
      );
    };
    let msg = "";
    try {
      await saveAgentToken(TOKEN, {
        provider: () => store,
        ref: () => REF,
        status: () => status(),
        stateDir: r.stateDir,
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/op said no/);
    expect(msg).not.toContain(TOKEN);
    expect(
      fs.existsSync(path.join(r.stateDir, "agent-signin-token.json")),
    ).toBe(false);
  });

  it("refuses an empty or spaced value, never echoing it", () => {
    expect(tokenShapeError("   ")).toMatch(/no token/);
    expect(tokenShapeError("abc def ghi jkl mno pqr")).toMatch(/one word/);
    expect(tokenShapeError("short")).toMatch(/too short/);
    expect(tokenShapeError(TOKEN)).toBeNull();
  });

  it("readAgentToken: null with why when not set", async () => {
    expect(await readAgentToken({ ref: () => null })).toEqual({
      token: null,
      reason: "not set",
    });
  });
});

describe("what doctor and Settings say about the token", () => {
  const base = async (stateDir: string, over = {}) =>
    agentTokenStatus({
      env: { DEN_AGENT_SIGNIN: "token" },
      stateDir,
      status: () => ({
        backend: "1password" as const,
        label: "1Password",
        implicit: false,
        detect: { available: true },
      }),
      warnDays: () => 330,
      now: () => new Date("2026-11-16T10:00:00Z"),
      ...over,
    });

  it("always-on with no token: agents will not be able to sign in after logout", async () => {
    const r = await rig();
    const st = await base(r.stateDir, { ref: () => null });
    const l = tokenStatusLine(st, "acme");
    expect(l.status).toBe("warn");
    expect(l.text).toContain(
      "no sign-in token is configured: agents will not be able to sign in after logout",
    );
    expect(l.text).toContain("claude setup-token, then acme agents token set");
  });

  it("a ref whose value isn't in the store (doctor probes): the same warning", async () => {
    const r = await rig();
    const st = await base(r.stateDir, {
      ref: () => REF,
      provider: () => new MemStore(null),
      probe: true,
    });
    expect(tokenStatusLine(st, "acme").status).toBe("warn");
  });

  it("set: says when (the expiry isn't in the token), and warns once it's old", async () => {
    const r = await rig();
    fs.writeFileSync(
      path.join(r.stateDir, "agent-signin-token.json"),
      JSON.stringify({ setAt: "2026-11-01T10:00:00Z", store: "1Password" }),
    );
    const fresh = await base(r.stateDir, { ref: () => REF });
    const ok = tokenStatusLine(fresh, "acme");
    expect(ok.status).toBe("ok");
    expect(ok.text).toBe(
      "agents sign in with the token set 2026-11-01 (in 1Password)",
    );
    fs.writeFileSync(
      path.join(r.stateDir, "agent-signin-token.json"),
      JSON.stringify({ setAt: "2025-12-01T10:00:00Z" }),
    );
    const old = tokenStatusLine(
      await base(r.stateDir, { ref: () => REF }),
      "acme",
    );
    expect(old.status).toBe("warn");
    expect(old.text).toMatch(/set 350 days ago .*lasts about a year/);
  });
});

/**
 * Issue 163 (b), lead's answer 3: the store's own credential (the
 * 1Password service-account token) referenced as keychain: may not be
 * reachable from the always-on service. doctor's sign-in row warns.
 */
describe("the store's credential in the login keychain", () => {
  const CRED_WARN =
    "the store's credential is in the login keychain, which the always-on service may not reach; use file: or env: (see docs/always-on-gate.md)";
  const st = async (stateDir: string, source: string | undefined) =>
    agentTokenStatus({
      env: { DEN_AGENT_SIGNIN: "token" },
      stateDir,
      ref: () => REF,
      status: () => ({
        backend: "1password" as const,
        label: "1Password",
        implicit: false,
        detect: { available: true },
      }),
      credSource: () => source,
      warnDays: () => 330,
      now: () => new Date("2026-11-16T10:00:00Z"),
    });

  it("keychain: warns, even with a token set", async () => {
    const r = await rig();
    fs.writeFileSync(
      path.join(r.stateDir, "agent-signin-token.json"),
      JSON.stringify({ setAt: "2026-11-10T10:00:00Z" }),
    );
    const s = await st(r.stateDir, "keychain:op-den");
    expect(s.credInKeychain).toBe(true);
    const l = tokenStatusLine(s, "acme");
    expect(l.status).toBe("warn");
    expect(l.text).toContain(CRED_WARN);
  });

  it("no token and keychain: both warnings", async () => {
    const r = await rig();
    const s = await st(r.stateDir, "keychain:op-den");
    const l = tokenStatusLine({ ...s, configured: false }, "acme");
    expect(l.text).toMatch(/agents will not be able to sign in after logout/);
    expect(l.text).toContain(CRED_WARN);
  });

  it.each([
    ["file:/x/op-token"],
    ["env:OP_SERVICE_ACCOUNT_TOKEN"],
    [undefined],
  ])("%s: no such warning", async (source) => {
    const r = await rig();
    fs.writeFileSync(
      path.join(r.stateDir, "agent-signin-token.json"),
      JSON.stringify({ setAt: "2026-11-10T10:00:00Z" }),
    );
    const s = await st(r.stateDir, source);
    expect(s.credInKeychain).toBe(false);
    expect(tokenStatusLine(s, "acme").status).toBe("ok");
  });
});

/**
 * Issue 163 (gate, 0.4.63-dev.1): `agents token status` says what is true
 * for the mode in effect. Not under the always-on service, no token is
 * not a warning.
 */
describe("agents token status, per mode", () => {
  const fakeStatus = () => ({
    backend: "1password" as const,
    label: "1Password",
    implicit: false,
    detect: { available: true },
  });
  const NOT_NEEDED =
    "no sign-in token set; needed only under Keep agents running after logout";

  it("no host job (not in mode always), no token: says so plainly, rc 0", async () => {
    const r = await rig();
    expect(
      await cmdAgents(["token", "status"], {
        ...r.deps,
        tokenDeps: { ref: () => null, status: fakeStatus },
      }),
    ).toBe(0);
    expect(r.out.join("\n")).toContain(NOT_NEEDED);
    expect(r.err.join("\n")).not.toMatch(/will not be able to sign in/);
  });

  it("mode always, no token: the warning, rc 1", async () => {
    const r = await rig();
    fs.writeFileSync(
      path.join(r.stateDir, "sessions-host-job.json"),
      JSON.stringify({ label: "local.acme.sessions", mode: "always" }) + "\n",
    );
    expect(
      await cmdAgents(["token", "status"], {
        ...r.deps,
        tokenDeps: { ref: () => null, status: fakeStatus },
      }),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /Keep agents running after logout is on, but no sign-in token is configured/,
    );
  });

  it("a token set, not in mode always: the ✓ line", async () => {
    const r = await rig();
    fs.writeFileSync(
      path.join(r.stateDir, "agent-signin-token.json"),
      JSON.stringify({ setAt: "2026-11-10T10:00:00Z", store: "1Password" }),
    );
    expect(
      await cmdAgents(["token", "status"], {
        ...r.deps,
        tokenDeps: {
          ref: () => REF,
          provider: () => new MemStore(TOKEN),
          status: fakeStatus,
        },
      }),
    ).toBe(0);
    expect(r.out.join("\n")).toMatch(/^✓ agents sign in with the token set /m);
    expect([...r.out, ...r.err].join("\n")).not.toContain(TOKEN);
  });

  it("tokenStatusLine: desktop mode with no token is ok, not a warning", async () => {
    const r = await rig();
    const st = await agentTokenStatus({
      env: {},
      stateDir: r.stateDir,
      ref: () => null,
      status: fakeStatus,
    });
    expect(tokenStatusLine(st, "acme")).toEqual({
      status: "ok",
      text: NOT_NEEDED,
    });
  });
});
