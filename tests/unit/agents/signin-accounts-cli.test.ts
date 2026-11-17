/**
 * Issue 339: `<cli> agents accounts` (list, add, set-token, order, remove).
 *
 *   - The token is read from stdin or a hidden prompt, never argv, and is
 *     never printed: not in an answer, an error, a list or a state file.
 *   - Order and names persist, as a new CLI process reads them.
 *   - A person's only: an agent's session is refused.
 *
 * The store is in memory; invented tokens only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type {
  SecretRef,
  SecretsProvider,
} from "../../../src/shared/secrets/types.js";
import {
  ACCOUNTS_FILE,
  listAccounts,
} from "../../../src/shared/agents/signin-accounts.js";
import {
  cmdAgents,
  type AgentsDeps,
} from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const TOKEN = "fake-account-two-0123456789abcdef";

class MemStore implements SecretsProvider {
  readonly name = "1password" as const;
  values: Record<string, string> = {};
  deleted: string[] = [];
  async isReady() {
    return true;
  }
  async get(ref: SecretRef): Promise<string> {
    return this.values[ref.item] ?? "";
  }
  async tryGet(ref: SecretRef): Promise<string | null> {
    return this.values[ref.item] ?? null;
  }
  async set(ref: SecretRef, v: string): Promise<void> {
    this.values[ref.item] = v;
  }
  async delete(ref: SecretRef): Promise<void> {
    this.deleted.push(ref.item);
    delete this.values[ref.item];
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

/** A rig whose accounts store is in memory; refs are kept per name. */
async function acctRig(store: MemStore, input = TOKEN) {
  const r = await rig();
  const refs: Record<string, Partial<SecretRef>> = {};
  const deps: AgentsDeps = {
    ...r.deps,
    tokenInput: async () => input,
    accountDeps: {
      provider: () => store,
      status,
      ref: (name: string) =>
        refs[name]
          ? { vault: "V", item: String(refs[name]!.item), field: "password" }
          : null,
      saveRefAs: (name: string, ref: Partial<SecretRef>) => (refs[name] = ref),
      userRef: (name: string) => refs[name],
      dropRef: (name: string) => delete refs[name],
    },
  };
  const run = (...args: string[]) => cmdAgents(["accounts", ...args], deps);
  return { r, run, refs, deps };
}

/** Everything the CLI printed, and every file in the state dir. */
function everything(r: Rig): string {
  let s = [...r.out, ...r.err].join("\n");
  for (const f of fs.readdirSync(r.stateDir))
    if (fs.statSync(path.join(r.stateDir, f)).isFile())
      s += fs.readFileSync(path.join(r.stateDir, f), "utf-8");
  return s;
}

describe("agents accounts", () => {
  it("list: one account with no file, as today (Claude Code account A)", async () => {
    const { r, run } = await acctRig(new MemStore());
    expect(await run("list")).toBe(0);
    const out = r.out.join("\n");
    expect(out).toMatch(/Claude Code/);
    expect(out).toMatch(/1\s+Claude Code account A/);
    expect(out).toMatch(/no token/);
    expect(fs.existsSync(path.join(r.stateDir, ACCOUNTS_FILE))).toBe(false);
  });

  it("add, set-token, order, list, remove: the token is never printed or kept in a file", async () => {
    const store = new MemStore();
    const { r, run, refs } = await acctRig(store);
    expect(await run("add", "--name", "Work")).toBe(0);
    expect(r.out.join("\n")).toMatch(/added Claude Code account 2 \(Work\)/);
    expect(await run("set-token", "Work")).toBe(0);
    expect(r.out.join("\n")).toMatch(/saved in 1Password/);
    expect(Object.keys(refs)).toEqual(["agent_signin_token__2"]);
    expect(Object.values(store.values)).toEqual([TOKEN]);
    expect(await run("order", "2", "1")).toBe(0);
    expect(listAccounts(r.stateDir, "den-claude").map((a) => a.id)).toEqual([
      "2",
      "1",
    ]);
    r.out.length = 0;
    expect(await run("list")).toBe(0);
    const out = r.out.join("\n");
    expect(out.indexOf("Work")).toBeLessThan(
      out.indexOf("Claude Code account A"),
    );
    expect(out).toMatch(/Work.*token set/);
    expect(await run("remove", "2", "--yes")).toBe(0);
    expect(store.deleted).toHaveLength(1);
    expect(listAccounts(r.stateDir, "den-claude").map((a) => a.id)).toEqual([
      "1",
    ]);
    expect(everything(r)).not.toContain(TOKEN);
  });

  it("set-token refuses a token on the command line, never echoing it", async () => {
    const { r, run } = await acctRig(new MemStore());
    expect(await run("set-token", "1", TOKEN)).toBe(2);
    expect(r.err.join("\n")).toMatch(/never on the command line/);
    expect(everything(r)).not.toContain(TOKEN);
  });

  it("a store error never carries the token", async () => {
    const store = new MemStore();
    store.set = async (_ref, v) => {
      throw new Error(`Command failed: op item edit x=${v}\nop refused ${v}`);
    };
    const { r, run } = await acctRig(store);
    expect(await run("set-token", "1")).toBe(1);
    expect(r.err.join("\n")).toMatch(/op refused/);
    expect(everything(r)).not.toContain(TOKEN);
  });

  it("an email as a name is refused; a bad order is refused", async () => {
    const { r, run } = await acctRig(new MemStore());
    expect(await run("add", "--name", "a@b.example")).toBe(2);
    expect(r.err.join("\n")).toMatch(/not an email/);
    expect(await run("add")).toBe(0);
    expect(await run("order", "2")).toBe(2);
    expect(r.err.join("\n")).toMatch(/every Claude Code account/);
    r.err.length = 0;
    expect(everything(r)).not.toContain("@");
  });

  it("an agent's session can't change them", async () => {
    const { r, deps } = await acctRig(new MemStore());
    const env = { ...deps.env, DEN_ACTOR_TOKEN: "fake-actor-token" };
    expect(await cmdAgents(["accounts", "add"], { ...deps, env })).toBe(1);
    expect(r.err.join("\n")).toMatch(/only a person/);
  });

  it("a runtime with no sign-in data has no accounts", async () => {
    const { r, run } = await acctRig(new MemStore());
    expect(await run("list", "--runtime", "codex")).toBe(2);
    expect(r.err.join("\n")).toMatch(/no sign-in data/);
  });
});
