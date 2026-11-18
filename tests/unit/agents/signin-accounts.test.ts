/**
 * Issue 339 (slice 2 of the always-on accounts design, issue 163): for
 * each vendor (a runtime with sign-in data), a list of accounts, each with
 * a name ("Claude account A" unless named), its own sign-in token in its own item
 * of the install's secrets store, and an order the person can change.
 *
 *   - The single token that exists today is account one: an install with
 *     one account behaves exactly as before (the same token reaches the
 *     agent, nothing is written on the upgrade).
 *   - A second account's token is its own item, never the first's.
 *   - The order persists; until slice 3 picks per agent, agents get the
 *     first account's token.
 *   - No email in a name, an item or a ref.
 *
 * The store is in memory; invented tokens only. Nothing reaches this
 * machine's keychain, secrets store or launchd.
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
  validateCatalogEntry,
} from "../../../src/shared/agents/catalog.js";
import { syncConfiguredRuntimes } from "../../../src/shared/agents/runtimes.js";
import {
  ACCOUNTS_FILE,
  accountsView,
  accountLabel,
  accountRefName,
  addAccount,
  firstAccountRefName,
  listAccounts,
  saveAccountToken,
  setAccountOrder,
} from "../../../src/shared/agents/signin-accounts.js";
import { newAgentTokenRef } from "../../../src/shared/agents/signin-token.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const TOKEN_A = "fake-account-a-0123456789abcdef";
const TOKEN_B = "fake-account-b-fedcba9876543210";

/** An in-memory store keyed by item; records each write's item. */
class MemStore implements SecretsProvider {
  readonly name = "1password" as const;
  writes: { item: string }[] = [];
  constructor(public values: Record<string, string> = {}) {}
  async isReady() {
    return true;
  }
  async get(ref: SecretRef): Promise<string> {
    const v = await this.tryGet(ref);
    if (!v) throw new Error("not found");
    return v;
  }
  async tryGet(ref: SecretRef): Promise<string | null> {
    return this.values[ref.item] ?? null;
  }
  async set(ref: SecretRef, v: string): Promise<void> {
    this.writes.push({ item: ref.item });
    this.values[ref.item] = v;
  }
  async preflight() {
    return { ok: true };
  }
  runPrefix() {
    return [];
  }
}

const status = () => ({
  backend: "1password" as const,
  label: "1Password",
  implicit: false,
  detect: { available: true },
});

/** A rig under the always-on service; the ref's name is its item. */
async function alwaysOn(store: MemStore): Promise<Rig> {
  const r = await rig({
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
  fs.writeFileSync(
    path.join(packs, "planner.md"),
    "---\nname: planner\n---\nYou plan.\n",
  );
  r.config.personaPacks = ["personas"];
  return r;
}

const startedToken = async (r: Rig) => {
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  return (r.made.at(-1)!.opts.env as Record<string, string>)
    .CLAUDE_CODE_OAUTH_TOKEN;
};

describe("an install with one token upgrades with no change", () => {
  it("the token that exists today is account one, and reaches the agent as before", async () => {
    const store = new MemStore({ agent_signin_token: TOKEN_A });
    const r = await alwaysOn(store);
    const list = listAccounts(r.stateDir, "den-claude");
    expect(list.map((a) => a.id)).toEqual(["1"]);
    expect(accountLabel(list[0]!, "Claude")).toBe("Claude account A");
    expect(accountRefName("den-claude", "1")).toBe("agent_signin_token");
    expect(firstAccountRefName(r.stateDir, "den-claude")).toBe(
      "agent_signin_token",
    );
    expect(await startedToken(r)).toBe(TOKEN_A);
    // Nothing written on the upgrade.
    expect(fs.existsSync(path.join(r.stateDir, ACCOUNTS_FILE))).toBe(false);
  });
});

describe("a second account", () => {
  it("is stored as its own item, never the first's, and its ref goes to user.yml under its own name", async () => {
    const r = await rig();
    const store = new MemStore();
    const b = addAccount(r.stateDir, "den-claude");
    expect(b.id).toBe("2");
    expect(accountLabel(b, "Claude")).toBe("Claude account B");
    const saved: Record<string, unknown> = {};
    const res = await saveAccountToken(TOKEN_B, {
      runtimeId: "den-claude",
      accountId: b.id,
      provider: () => store,
      ref: () => null,
      status,
      saveRefAs: (name, ref) => (saved[name] = ref),
      stateDir: r.stateDir,
    });
    expect(res.ref).toBe("created");
    expect(Object.keys(saved)).toEqual(["agent_signin_token__2"]);
    expect(store.writes).toHaveLength(1);
    const item = store.writes[0]!.item;
    expect(item).toMatch(/agent sign-in/);
    expect(item).not.toBe(newAgentTokenRef("1password")!.item);
    expect(item).toMatch(/\(den-claude, 2\)/);
    // Account one's record is untouched; the token is in no file.
    expect(
      fs.existsSync(path.join(r.stateDir, "agent-signin-token.json")),
    ).toBe(false);
    const file = fs.readFileSync(path.join(r.stateDir, ACCOUNTS_FILE), "utf-8");
    expect(file).not.toContain(TOKEN_B);
    expect(file).toMatch(/"setAt"/);
    expect(fs.statSync(path.join(r.stateDir, ACCOUNTS_FILE)).mode & 0o777).toBe(
      0o600,
    );
  });

  it("a name is kept, and an email is refused as a name", async () => {
    const r = await rig();
    expect(
      accountLabel(addAccount(r.stateDir, "den-claude", "Work"), "Claude"),
    ).toBe("Work");
    expect(() =>
      addAccount(r.stateDir, "den-claude", "someone@example.com"),
    ).toThrow(/email/);
    expect(
      fs.readFileSync(path.join(r.stateDir, ACCOUNTS_FILE), "utf-8"),
    ).not.toContain("@");
  });

  it("only a runtime with sign-in data has accounts", async () => {
    const r = await rig();
    expect(() => addAccount(r.stateDir, "codex")).toThrow(/sign-in/);
  });
});

describe("the order", () => {
  it("persists, and agents get the first account's token", async () => {
    const store = new MemStore({
      agent_signin_token: TOKEN_A,
      agent_signin_token__2: TOKEN_B,
    });
    const r = await alwaysOn(store);
    addAccount(r.stateDir, "den-claude");
    setAccountOrder(r.stateDir, "den-claude", ["2", "1"]);
    // Read back from disk, as a new process would.
    expect(listAccounts(r.stateDir, "den-claude").map((a) => a.id)).toEqual([
      "2",
      "1",
    ]);
    expect(firstAccountRefName(r.stateDir, "den-claude")).toBe(
      "agent_signin_token__2",
    );
    expect(await startedToken(r)).toBe(TOKEN_B);
    setAccountOrder(r.stateDir, "den-claude", ["1", "2"]);
    expect(await startedToken(r)).toBe(TOKEN_A);
  });

  it("must name every account once", async () => {
    const r = await rig();
    addAccount(r.stateDir, "den-claude");
    expect(() => setAccountOrder(r.stateDir, "den-claude", ["2"])).toThrow(
      /every Claude account/,
    );
    expect(() =>
      setAccountOrder(r.stateDir, "den-claude", ["2", "2", "1"]),
    ).toThrow(/every Claude account/);
    expect(listAccounts(r.stateDir, "den-claude").map((a) => a.id)).toEqual([
      "1",
      "2",
    ]);
  });
});

describe("an account is named for the vendor, not the CLI", () => {
  afterEach(() => syncConfiguredRuntimes([]));

  it('Claude Code\'s rows read "Claude account A"', async () => {
    const r = await rig();
    addAccount(r.stateDir, "den-claude");
    expect(
      accountsView(r.stateDir, "den-claude", () => null).map((a) => a.label),
    ).toEqual(["Claude account A", "Claude account B"]);
  });

  it("each built-in runtime with or without sign-in says whose account it is", () => {
    expect(
      Object.fromEntries(BUILTIN_CATALOG.map((e) => [e.id, e.accountName])),
    ).toEqual({
      "den-claude": "Claude",
      codex: "ChatGPT",
      gemini: "Google",
      grok: "xAI",
    });
  });

  it("a config-added runtime with no accountName falls back to its name", async () => {
    const r = await rig();
    const at = "agents.runtime_catalog[0]";
    const entry = {
      id: "mine-cli",
      vendor: "Someone",
      name: "Mine CLI",
      bins: ["mine-cli"],
      version: { args: ["--version"], identity: { output: "mine-cli" } },
      dirs: [],
      launch: { argv: ["{bin}"] },
      signIn: { env: "MINE_TOKEN" },
    };
    syncConfiguredRuntimes([validateCatalogEntry(entry, at)]);
    expect(accountsView(r.stateDir, "mine-cli", () => null)[0]!.label).toBe(
      "Mine CLI account A",
    );
    syncConfiguredRuntimes([
      validateCatalogEntry({ ...entry, accountName: "Mine" }, at),
    ]);
    expect(accountsView(r.stateDir, "mine-cli", () => null)[0]!.label).toBe(
      "Mine account A",
    );
    expect(() =>
      validateCatalogEntry({ ...entry, accountName: "a@b.example" }, at),
    ).toThrow(/accountName/);
  });
});
