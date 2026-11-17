/**
 * Issue 338 (slice 1 of the always-on accounts design, issue 163): an
 * agent's sign-in is data on its runtime's catalog entry (`signIn`):
 *
 *   env           the variable its CLI signs in from
 *   command       the one command a person runs to make the credential
 *   lastsDays     how long the credential lasts
 *   limitPattern  how the CLI words a usage limit (pattern data only)
 *
 * Claude Code moves onto it with no change in behaviour. A vendor added in
 * agents.runtime_catalog with sign-in data gets its own token, under its
 * own variable, in its own agents' env only. An entry with none gets no
 * token, and doctor says plainly that its agents cannot sign in after
 * logout and will stop. Codex, Gemini and Grok ship with none.
 *
 * The store is in memory; bins are `#!/bin/sh` shims; invented tokens only.
 * Nothing reaches this machine's keychain, secrets store or launchd.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type {
  SecretRef,
  SecretsProvider,
} from "../../../src/shared/secrets/types.js";
import {
  BUILTIN_CATALOG,
  builtinEntry,
  validateCatalogEntry,
} from "../../../src/shared/agents/catalog.js";
import { denClaude } from "../../../src/shared/agents/den-claude.js";
import { getRuntime } from "../../../src/shared/agents/runtimes.js";
import {
  AGENT_TOKEN_REF_NAME,
  agentTokenRefName,
  agentsWithoutSignIn,
  DEFAULT_TOKEN_WARN_DAYS,
  TOKEN_MAKE_HINT,
} from "../../../src/shared/agents/signin-token.js";
import {
  clearVersionCache,
  resetInteractivePath,
} from "../../../src/shared/agents/runtime-search.js";
import {
  resolveAgentsDeps,
  startAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { whereRows } from "../../../src/ui/cli/doctor-where.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  resetInteractivePath();
  clearVersionCache();
  await cleanupRigs();
});

const CLAUDE_TOKEN = "fake-claude-token-0123456789abcdef";
const MINE_TOKEN = "fake-mine-token-fedcba9876543210";

/** An in-memory store keyed by the named ref asked for; counts reads. */
class MemStore implements SecretsProvider {
  readonly name = "1password" as const;
  reads: string[] = [];
  constructor(public values: Record<string, string>) {}
  async isReady() {
    return true;
  }
  async get(ref: SecretRef): Promise<string> {
    const v = await this.tryGet(ref);
    if (!v) throw new Error("not found");
    return v;
  }
  async tryGet(ref: SecretRef): Promise<string | null> {
    this.reads.push(ref.item);
    return this.values[ref.item] ?? null;
  }
  async set(): Promise<void> {}
  async preflight() {
    return { ok: true };
  }
  runPrefix() {
    return [];
  }
}

const mineEntry = (signIn?: Record<string, unknown>) => ({
  id: "mine-cli",
  vendor: "Someone",
  name: "Mine CLI",
  bins: ["mine-cli"],
  version: { args: ["--version"], identity: { output: "mine-cli" } },
  dirs: [],
  launch: { argv: ["{bin}"] },
  ...(signIn ? { signIn } : {}),
});

/** A rig under the always-on service, with a persona, a store per ref. */
async function alwaysOnRig(store: MemStore): Promise<Rig> {
  const r = await rig({
    // The ref's name is its item here, so the store answers per vendor.
    signInStore: (name: string) => ({
      provider: store,
      ref: { vault: "V", item: name, field: "pw" },
    }),
  });
  fs.writeFileSync(
    path.join(r.stateDir, "sessions-host-job.json"),
    JSON.stringify({ label: "local.acme.sessions", mode: "always" }) + "\n",
  );
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  for (const p of ["planner", "reviewer"])
    fs.writeFileSync(
      path.join(packs, `${p}.md`),
      `---\nname: ${p}\n---\nYou ${p}.\n`,
    );
  r.config.personaPacks = ["personas"];
  const fake = (b: string) =>
    fs.writeFileSync(
      path.join(path.dirname(r.claude), b),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${b} 1.0.0"; exit 0; fi\nexit 1\n`,
      { mode: 0o755 },
    );
  fake("mine-cli");
  fake("codex");
  return r;
}

/** Every file under `dir`, as text. */
function allText(dir: string): string {
  let out = "";
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out += allText(p);
    else if (e.isFile()) out += fs.readFileSync(p, "latin1");
  }
  return out;
}

describe("sign-in is data on the catalog entry", () => {
  it("Claude Code's entry carries it, and den-claude reads it from there", () => {
    const e = builtinEntry("den-claude")!;
    expect(e.signIn).toMatchObject({
      env: "CLAUDE_CODE_OAUTH_TOKEN",
      command: "claude setup-token",
      lastsDays: 365,
    });
    expect(
      new RegExp(e.signIn!.limitPattern!, "i").test(
        "You've hit your limit · resets 3pm",
      ),
    ).toBe(true);
    expect(denClaude.signInTokenEnv).toBe(e.signIn!.env);
    expect(TOKEN_MAKE_HINT).toBe(e.signIn!.command);
    // No change in behaviour: the old default warning age.
    expect(DEFAULT_TOKEN_WARN_DAYS).toBe(330);
    expect(agentTokenRefName("den-claude")).toBe(AGENT_TOKEN_REF_NAME);
  });

  it("Codex, Gemini and Grok ship with none", () => {
    for (const id of ["codex", "gemini", "grok"]) {
      expect(builtinEntry(id)!.signIn).toBeUndefined();
      expect(getRuntime(id)!.signInTokenEnv).toBeUndefined();
    }
    expect(BUILTIN_CATALOG.filter((e) => e.signIn).map((e) => e.id)).toEqual([
      "den-claude",
    ]);
  });

  it("a user entry's sign-in data is checked by the same validator", () => {
    const at = "agents.runtime_catalog[0]";
    expect(
      validateCatalogEntry(
        mineEntry({
          env: "MINE_TOKEN",
          command: "mine-cli auth token",
          lastsDays: 90,
          limitPattern: "rate limit reached",
        }),
        at,
      ).signIn,
    ).toEqual({
      env: "MINE_TOKEN",
      command: "mine-cli auth token",
      lastsDays: 90,
      limitPattern: "rate limit reached",
    });
    expect(
      validateCatalogEntry(mineEntry({ env: "MINE_TOKEN" }), at).signIn,
    ).toEqual({ env: "MINE_TOKEN" });
    expect(validateCatalogEntry(mineEntry(), at).signIn).toBeUndefined();
    for (const [bad, msg] of [
      [{}, /signIn\.env: must be/],
      [{ env: "lower" }, /signIn\.env/],
      [{ env: "PATH" }, /signIn\.env: "PATH" is a variable Den sets/],
      [{ env: "DEN_AGENT" }, /signIn\.env: "DEN_AGENT" is a variable Den sets/],
      [{ env: "X_T", lastsDays: 0 }, /signIn\.lastsDays/],
      [{ env: "X_T", limitPattern: "(" }, /signIn\.limitPattern/],
      [{ env: "X_T", command: "a\nb" }, /signIn\.command/],
      [{ env: "X_T", other: 1 }, /signIn\.other: unknown key/],
    ] as const)
      expect(() =>
        validateCatalogEntry(mineEntry(bad as Record<string, unknown>), at),
      ).toThrow(msg);
  });
});

describe("each vendor's token reaches its own agents only", () => {
  it("Claude Code's token still reaches only its own agent; a user.yml vendor gets its own, under its own variable", async () => {
    const store = new MemStore({
      [AGENT_TOKEN_REF_NAME]: CLAUDE_TOKEN,
      agent_signin_token_mine_cli: MINE_TOKEN,
    });
    const r = await alwaysOnRig(store);
    r.userCatalog = [mineEntry({ env: "MINE_TOKEN" })];
    // A caller's own value of either never passes.
    r.deps.env = {
      ...r.deps.env,
      MINE_TOKEN: "caller-own-mine",
      CLAUDE_CODE_OAUTH_TOKEN: "caller-own-claude",
    };
    const d = resolveAgentsDeps(r.deps);
    await startAgent(d, { workspace: "north", persona: "planner" });
    const claudeEnv = r.made.at(-1)!.opts.env as Record<string, string>;
    expect(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_TOKEN);
    expect(claudeEnv.MINE_TOKEN).toBeUndefined();

    await startAgent(d, {
      workspace: "south",
      persona: "reviewer",
      runtime: "mine-cli",
    });
    const mineEnv = r.made.at(-1)!.opts.env as Record<string, string>;
    expect(mineEnv.MINE_TOKEN).toBe(MINE_TOKEN);
    expect(mineEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(store.reads).toEqual([
      AGENT_TOKEN_REF_NAME,
      "agent_signin_token_mine_cli",
    ]);
  });

  it("a vendor with no sign-in gets no token, and the store is not read", async () => {
    const store = new MemStore({ [AGENT_TOKEN_REF_NAME]: CLAUDE_TOKEN });
    const r = await alwaysOnRig(store);
    const d = resolveAgentsDeps(r.deps);
    await startAgent(d, {
      workspace: "north",
      persona: "planner",
      runtime: "codex",
    });
    const env = r.made.at(-1)!.opts.env as Record<string, string>;
    expect(Object.values(env)).not.toContain(CLAUDE_TOKEN);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(store.reads).toEqual([]);
  });

  it("no token is ever in argv, a record, output, a log or any state file", async () => {
    const store = new MemStore({
      [AGENT_TOKEN_REF_NAME]: CLAUDE_TOKEN,
      agent_signin_token_mine_cli: MINE_TOKEN,
    });
    const r = await alwaysOnRig(store);
    r.userCatalog = [mineEntry({ env: "MINE_TOKEN" })];
    const d = resolveAgentsDeps(r.deps);
    await startAgent(d, { workspace: "north", persona: "planner" });
    await startAgent(d, {
      workspace: "south",
      persona: "reviewer",
      runtime: "mine-cli",
    });
    const text = [
      JSON.stringify(r.made.map((p) => [p.file, p.args])),
      ...r.out,
      ...r.err,
      allText(r.stateDir),
    ].join("\n");
    for (const t of [CLAUDE_TOKEN, MINE_TOKEN]) expect(text).not.toContain(t);
  });
});

describe("doctor: an agent whose runtime has no sign-in", () => {
  const svc = () => ({
    state: "loaded" as const,
    mode: "always" as const,
    plist: "/x.plist",
    domain: "system",
  });

  it("lists the agents on a runtime with no sign-in data, nothing for one with it", () => {
    const entries = [
      ...BUILTIN_CATALOG,
      validateCatalogEntry(mineEntry({ env: "MINE_TOKEN" }), "x"),
    ];
    expect(
      agentsWithoutSignIn(
        [
          { id: "a", runtime: "den-claude" },
          { id: "b", runtime: "codex" },
          { id: "c", runtime: "codex" },
          { id: "d", runtime: "mine-cli" },
          { id: "e", runtime: "generic" },
        ],
        entries,
      ),
    ).toEqual([{ name: "Codex CLI", agents: ["b", "c"] }]);
  });

  it("under the always-on service: says plainly they cannot sign in after logout and will stop", async () => {
    const rows = await whereRows({
      cli: "acme",
      platform: "darwin",
      server: async () => ({ launchd: "Background" }),
      host: async () => ({ launchd: "Background" }),
      service: svc,
      noSignIn: () => [{ name: "Codex CLI", agents: ["b", "c"] }],
    });
    const row = rows.find((x) => x.what === "runtime sign-in")!;
    expect(row.status).toBe("warn");
    expect(row.detail).toBe(
      "Codex CLI (agents b, c): this agent cannot sign in after logout; it will stop. Its runtime has no sign-in data (agents.runtime_catalog, signIn)",
    );
  });

  it("nothing to say with none, or in login mode", async () => {
    const at = async (mode: "always" | "login", list: unknown[]) =>
      (
        await whereRows({
          cli: "acme",
          platform: "darwin",
          server: async () => ({ launchd: "Background" }),
          host: async () => ({ launchd: "Background" }),
          service: () => ({ ...svc(), mode }),
          noSignIn: () => list as { name: string; agents: string[] }[],
        })
      ).find((x) => x.what === "runtime sign-in");
    expect(await at("always", [])).toBeUndefined();
    expect(
      await at("login", [{ name: "Codex CLI", agents: ["b"] }]),
    ).toBeUndefined();
  });
});
