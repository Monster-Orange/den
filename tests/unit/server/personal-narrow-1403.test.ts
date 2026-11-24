/**
 * Issue 1403 (Den Builder, after issue 1391): on a personal install, a
 * held write that only narrows what agents may do, or can be undone, is
 * routine (the person told). Each change is in the write's own check,
 * which stops saying personOnly on personal; strict is as it was.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import { criticalWhy, policyFor } from "../../../src/shared/approval-policy.js";
import { sandboxOnHeldOp } from "../../../src/shared/agents/sandbox-rollout.js";
import {
  checkPersonaCreate,
  checkPersonaUpdate,
  createPersona,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { gateBoxOps } from "../../../src/ui/server/gate-routes.js";
import { hostRestartOp } from "../../../src/ui/server/host-restart-held.js";
import { selfUpdateAsks } from "../../../src/ui/server/server-restart.js";
import { cleanupRigs, rig } from "../agents/helpers/rig.js";

afterEach(cleanupRigs);

/** Routine on personal; their checks no longer say personOnly there. */
const ROUTINE = [
  "den_sandbox_on",
  "den_update",
  "gate_box_remove",
  "host_restart",
  "hub_link",
  "persona_create",
  "persona_update",
  "project_mcp_remove",
];
/** Credentials, exposure, data leaving the machine, or acting on others. */
const KEEP = [
  "approval_policy",
  "embed_key_create",
  "embed_key_revoke",
  "gate_box_set",
  "gate_runner_token_create",
  "hub_connect",
  "project_mcp_add",
  "project_mcp_update",
  "test_person_setup",
  "verify_run",
  "web_url_set",
];

describe("the policy (issue 1403)", () => {
  it.each(ROUTINE)("%s is routine on personal, the person told", (w) => {
    expect([w, policyFor(w, { mode: "personal" }).kind]).toEqual([w, "notify"]);
  });
  it.each(ROUTINE.filter((w) => w !== "den_sandbox_on"))(
    "%s still asks on strict",
    (w) => {
      expect([w, policyFor(w, { mode: "strict" }).kind]).toEqual([w, "ask"]);
    },
  );
  it.each(KEEP)("%s still asks on personal", (w) => {
    expect([w, policyFor(w, { mode: "personal" }).kind]).toEqual([w, "ask"]);
  });
  it("a placed write's name never makes it critical; its placement does", () => {
    expect(criticalWhy("project_mcp_remove", false, [], "personal")).toBeNull();
    expect(criticalWhy("gate_box_remove", false, [], "personal")).toBeNull();
    expect(criticalWhy("project_mcp_remove", false, [], "strict")).toBe(
      "critical",
    );
    // Placed with its area: still critical on personal.
    expect(criticalWhy("gate_runner_token_create", false, [], "personal")).toBe(
      "critical: secrets",
    );
  });
  it("a write no one placed is still judged by its name", () => {
    expect(criticalWhy("files_delete", false, [], "personal")).toBe(
      "critical: deletes",
    );
    expect(criticalWhy("vault_secret_read", false, [], "personal")).toBe(
      "critical: secrets",
    );
  });
});

describe("den_sandbox_on's check (issue 1403)", () => {
  const op = (personal?: boolean) =>
    sandboxOnHeldOp({
      count: () => 2,
      turnOn: () => undefined,
      ...(personal === undefined ? {} : { personal: () => personal }),
    });
  it("personal: no personOnly (it narrows)", () => {
    const c = op(true).check({});
    expect(c.ok && c.personOnly).toBeFalsy();
  });
  it("strict, or the mode unknown: personOnly", () => {
    expect(op(false).check({})).toMatchObject({ ok: true, personOnly: true });
    expect(op().check({})).toMatchObject({ ok: true, personOnly: true });
  });
});

describe("gate_box_remove's check (issue 1403)", () => {
  const store = { boxes: () => [{ name: "b1" }] } as never;
  it("personal: no personOnly (a box can be added back)", () => {
    const c = gateBoxOps({
      store: () => store,
      personal: () => true,
    }).remove.check({ name: "b1" }) as { ok: boolean; personOnly?: boolean };
    expect(c.ok).toBe(true);
    expect(c.personOnly).toBeFalsy();
  });
  it("strict, or the mode unknown: personOnly", () => {
    for (const ops of [
      gateBoxOps({ store: () => store, personal: () => false }),
      gateBoxOps({ store: () => store }),
    ])
      expect(ops.remove.check({ name: "b1" })).toMatchObject({
        ok: true,
        personOnly: true,
      });
  });
});

describe("host_restart's check (issue 1403)", () => {
  const op = (personal: boolean | undefined, running: () => Promise<boolean>) =>
    hostRestartOp({
      refreshing: () => false,
      waitSeconds: () => 60,
      start: async () => null,
      turnsRunning: running,
      ...(personal === undefined ? {} : { personal: () => personal }),
    });
  it("personal, no agent turn running: no personOnly", async () => {
    const c = await op(true, async () => false).check({});
    expect(c.ok && (c as { personOnly?: boolean }).personOnly).toBeFalsy();
  });
  it("personal, a turn running that it would cut: personOnly", async () => {
    expect(await op(true, async () => true).check({})).toMatchObject({
      ok: true,
      personOnly: true,
    });
  });
  it("personal, the turns can't be read: personOnly", async () => {
    expect(
      await op(true, async () => {
        throw new Error("no host");
      }).check({}),
    ).toMatchObject({ ok: true, personOnly: true });
  });
  it("strict, or the mode unknown: personOnly", async () => {
    for (const p of [false, undefined])
      expect(await op(p, async () => false).check({})).toMatchObject({
        ok: true,
        personOnly: true,
      });
  });
});

describe("den_update follows server_agent.self_update, as den_restart (issue 1403)", () => {
  const ask = { selfUpdate: "ask" as const, selfUpdateFrom: "user" as const };
  const unset = {
    selfUpdate: "ask" as const,
    selfUpdateFrom: "default" as const,
  };
  it.each(["den_update", "den_restart"])("%s: an explicit ask asks", (w) => {
    expect(selfUpdateAsks(w, () => ask)).toBe(true);
    expect(selfUpdateAsks(w, () => unset)).toBe(false);
    expect(
      selfUpdateAsks(w, () => {
        throw new Error("bad yml");
      }),
    ).toBe(true);
  });
  it("other writes: never", () => {
    expect(selfUpdateAsks("repo_add", () => ask)).toBe(false);
  });
});

describe("persona_create and persona_update's checks (issue 1403)", () => {
  const persona = {
    displayName: "Copy checker",
    role: "reviewer",
    category: "marketing",
    description: "Checks copy for tone and typos.",
    instructions: "Read the changed copy.",
    runtime: "den-claude",
    model: "sonnet",
    version: "latest",
    permission: "ask",
    allowedCommands: ["git diff"],
  };
  const deps = async (cfg: Record<string, unknown>) => {
    const d = resolveAgentsDeps((await rig()).deps);
    const base = d.agentsConfig();
    return { ...d, agentsConfig: () => ({ ...base, ...cfg }) } as typeof d;
  };
  const only = (c: { ok: boolean }) =>
    (c as { personOnly?: boolean }).personOnly === true;
  it("personal, sandbox off and none in it: no personOnly", async () => {
    const d = await deps({ mode: "personal", sandbox: false, agents: {} });
    const c = checkPersonaCreate(d, persona);
    expect(c.ok).toBe(true);
    expect(only(c)).toBe(false);
    if (c.ok) createPersona(d, c.args);
    const u = checkPersonaUpdate(d, { id: "copy-checker", description: "x" });
    expect(u.ok).toBe(true);
    expect(only(u)).toBe(false);
  });
  it("personal with an agent sandboxed, or the default on: personOnly", async () => {
    for (const cfg of [
      { mode: "personal", sandbox: false, agents: { a: { sandbox: true } } },
      { mode: "personal", sandbox: true, agents: {} },
    ]) {
      const d = await deps(cfg);
      expect(only(checkPersonaCreate(d, persona))).toBe(true);
    }
  });
  it("strict: personOnly", async () => {
    const d = await deps({ mode: "strict", sandbox: false, agents: {} });
    expect(only(checkPersonaCreate(d, persona))).toBe(true);
  });
});
