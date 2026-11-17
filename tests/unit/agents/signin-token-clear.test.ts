/**
 * Issue 163 (gate, 0.4.63-dev.1): `agents token clear` removes the agents'
 * sign-in token the way `agents token set` kept it.
 *
 * - A ref Den made (its own 1Password item, or its Doppler key, written to
 *   user.yml): the item or secret is deleted and the ref dropped.
 * - A ref the config names: its field or secret is deleted, the ref stays.
 * - The env backend only ever had it in this process: removed from there.
 * - No secrets store (provider none): the same no_secrets_store as set.
 *
 * The 1Password and Doppler CLIs are fakes run by their full paths (the
 * providers' `bin`); each records its argv, never a value. A person's only,
 * asks y/N unless --yes; the value is never printed.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DopplerProvider } from "../../../src/shared/secrets/doppler.js";
import { OnePasswordProvider } from "../../../src/shared/secrets/onepassword.js";
import type { SecretRef } from "../../../src/shared/secrets/types.js";
import {
  NO_SECRETS_STORE,
  NO_TOKEN_NOT_NEEDED,
  agentTokenStatus,
  clearAgentToken,
  newAgentTokenRef,
  tokenStatusLine,
} from "../../../src/shared/agents/signin-token.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

const TOKEN = "fake-oat-token-clear-0123456789abcdef";
const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
  await cleanupRigs();
});

/** A temp dir with a fake CLI `name` that records its argv; exit `code`. */
function fakeCli(name: string, code = 0) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), `den-clear-${name}-`));
  tmps.push(t);
  const bin = path.join(t, name);
  const argv = path.join(t, "argv");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> "${argv}"\n[ ${code} -ne 0 ] && echo "${name} said no" >&2\nexit ${code}\n`,
    { mode: 0o755 },
  );
  const stateDir = path.join(t, "state");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(
    path.join(stateDir, "agent-signin-token.json"),
    JSON.stringify({ setAt: "2026-11-10T10:00:00Z" }),
  );
  return {
    bin,
    stateDir,
    calls: () =>
      fs.existsSync(argv)
        ? fs.readFileSync(argv, "utf-8").trim().split("\n")
        : [],
  };
}

const status = (backend: "1password" | "doppler" | "env" | "none") => () => ({
  backend,
  label:
    backend === "1password"
      ? "1Password"
      : backend === "doppler"
        ? "Doppler"
        : backend,
  implicit: backend === "none",
  detect: { available: true },
});

const asRef = (p: Partial<SecretRef>): SecretRef => ({
  vault: "",
  item: "",
  field: "",
  ...p,
});

describe("agents token clear: the store, the way set kept it", () => {
  it("Doppler, the key Den made: `secrets delete KEY --yes`, and the ref leaves user.yml", async () => {
    const f = fakeCli("doppler");
    const made = newAgentTokenRef("doppler")!;
    let dropped = 0;
    const r = await clearAgentToken({
      provider: () => new DopplerProvider({ bin: f.bin }),
      ref: () => asRef(made),
      userRef: () => made,
      dropRef: () => dropped++,
      status: status("doppler"),
      stateDir: f.stateDir,
    });
    expect(r).toEqual({
      cleared: true,
      store: "Doppler",
      how: "deleted",
      refDropped: true,
    });
    expect(f.calls()).toEqual([`secrets delete ${made.key} --yes --silent`]);
    expect(dropped).toBe(1);
    expect(
      fs.existsSync(path.join(f.stateDir, "agent-signin-token.json")),
    ).toBe(false);
  });

  it("1Password, the item Den made: `op item delete`, and the ref leaves user.yml", async () => {
    const f = fakeCli("op");
    const made = newAgentTokenRef("1password")!;
    const ref = asRef({ ...made, vault: "Private" });
    let dropped = 0;
    const r = await clearAgentToken({
      provider: () => new OnePasswordProvider({ bin: f.bin }),
      ref: () => ref,
      userRef: () => made,
      dropRef: () => dropped++,
      status: status("1password"),
      stateDir: f.stateDir,
    });
    expect(r).toMatchObject({ cleared: true, how: "item", refDropped: true });
    expect(f.calls()).toEqual([`item delete ${made.item} --vault Private`]);
    expect(dropped).toBe(1);
  });

  it("1Password, a ref the config names: only its field is deleted; the ref stays and status says no token", async () => {
    const f = fakeCli("op");
    const ref = asRef({ vault: "Team", item: "Agents", field: "signin" });
    let dropped = 0;
    const r = await clearAgentToken({
      provider: () => new OnePasswordProvider({ bin: f.bin }),
      ref: () => ref,
      userRef: () => undefined,
      dropRef: () => dropped++,
      status: status("1password"),
      stateDir: f.stateDir,
    });
    expect(r).toMatchObject({
      cleared: true,
      how: "deleted",
      refDropped: false,
    });
    expect(f.calls()).toEqual(["item edit Agents --vault Team signin[delete]"]);
    expect(dropped).toBe(0);
    // The ref is still configured, but the value is gone: no token is set.
    const st = await agentTokenStatus({
      env: {},
      stateDir: f.stateDir,
      ref: () => ref,
      status: status("1password"),
      probe: true,
      provider: () => {
        throw new Error("not read after a clear");
      },
    });
    expect(st.configured).toBe(false);
    expect(tokenStatusLine(st, "acme").text).toBe(NO_TOKEN_NOT_NEEDED);
  });

  it("the env backend: removed from this process only", async () => {
    const f = fakeCli("unused");
    const env: NodeJS.ProcessEnv = { ACME_AGENT_SIGNIN_TOKEN: TOKEN };
    const r = await clearAgentToken({
      ref: () => asRef({ key: "ACME_AGENT_SIGNIN_TOKEN" }),
      env,
      status: status("env"),
      stateDir: f.stateDir,
    });
    expect(r).toMatchObject({ cleared: true, how: "process" });
    expect(env.ACME_AGENT_SIGNIN_TOKEN).toBeUndefined();
  });

  it("no secrets store: no_secrets_store, as for set", async () => {
    const f = fakeCli("unused");
    await expect(
      clearAgentToken({ status: status("none"), stateDir: f.stateDir }),
    ).rejects.toMatchObject({ code: NO_SECRETS_STORE });
  });

  it("no ref: nothing to remove", async () => {
    const f = fakeCli("doppler");
    const r = await clearAgentToken({
      provider: () => new DopplerProvider({ bin: f.bin }),
      ref: () => null,
      status: status("doppler"),
      stateDir: f.stateDir,
    });
    expect(r).toEqual({ cleared: false });
    expect(f.calls()).toEqual([]);
  });

  it("a store error is shown, and nothing is dropped", async () => {
    const f = fakeCli("doppler", 1);
    const made = newAgentTokenRef("doppler")!;
    let dropped = 0;
    await expect(
      clearAgentToken({
        provider: () => new DopplerProvider({ bin: f.bin }),
        ref: () => asRef(made),
        userRef: () => made,
        dropRef: () => dropped++,
        status: status("doppler"),
        stateDir: f.stateDir,
      }),
    ).rejects.toThrow(/doppler said no/);
    expect(dropped).toBe(0);
  });
});

describe("agents token clear: the command", () => {
  const result = {
    cleared: true as const,
    store: "Doppler",
    how: "deleted" as const,
    refDropped: true,
  };

  it("an agent is refused, and nothing is removed", async () => {
    const r = await rig();
    let ran = 0;
    const code = await cmdAgents(["token", "clear", "--yes"], {
      ...r.deps,
      env: { ...r.deps.env, DEN_ACTOR_TOKEN: "agent-actor-token-x" },
      tokenClear: async () => (ran++, result),
    });
    expect(code).toBe(1);
    expect(r.err.join("\n")).toMatch(/only a person clears/);
    expect(ran).toBe(0);
  });

  it("asks y/N first: N removes nothing", async () => {
    const r = await rig();
    let ran = 0;
    const asked: string[] = [];
    expect(
      await cmdAgents(["token", "clear"], {
        ...r.deps,
        tokenConfirm: async (q) => (asked.push(q), false),
        tokenClear: async () => (ran++, result),
      }),
    ).toBe(0);
    expect(asked[0]).toMatch(/\[y\/N\]/);
    expect(ran).toBe(0);
    expect(r.out.join("\n")).toMatch(/Nothing removed/);
  });

  it("y removes it; --yes doesn't ask", async () => {
    const r = await rig();
    let ran = 0;
    expect(
      await cmdAgents(["token", "clear"], {
        ...r.deps,
        tokenConfirm: async () => true,
        tokenClear: async () => (ran++, result),
      }),
    ).toBe(0);
    expect(
      await cmdAgents(["token", "clear", "--yes"], {
        ...r.deps,
        tokenConfirm: async () => {
          throw new Error("never asked under --yes");
        },
        tokenClear: async () => (ran++, result),
      }),
    ).toBe(0);
    expect(ran).toBe(2);
    expect(r.out.join("\n")).toMatch(
      /removed the agents' sign-in token from Doppler/,
    );
    expect([...r.out, ...r.err].join("\n")).not.toContain(TOKEN);
  });

  it("off a terminal with no --yes: refused, saying to add --yes", async () => {
    const r = await rig();
    expect(
      await cmdAgents(["token", "clear"], {
        ...r.deps,
        tokenConfirm: async () => null,
        tokenClear: async () => result,
      }),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(/add --yes/);
  });

  it("no secrets store: the plain no-store words, exit 1", async () => {
    const r = await rig();
    expect(
      await cmdAgents(["token", "clear", "--yes"], {
        ...r.deps,
        tokenClear: () =>
          clearAgentToken({ status: status("none"), stateDir: r.stateDir }),
      }),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(/no secrets store/);
  });
});
