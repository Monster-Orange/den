/**
 * Issue 1403 (Den Builder, after issue 1391): on a personal install, a
 * held write that only narrows what agents may do, or can be undone, is
 * routine (the person told). Each change is in the write's own check,
 * which stops saying personOnly on personal; strict is as it was.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import {
  HELD_WRITE_RISK,
  areasOf,
  criticalWhy,
  policyFor,
} from "../../../src/shared/approval-policy.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";
import { stableNotOlder } from "../../../src/ui/server/den-update.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import { checkHubLinkHeld } from "../../../src/ui/server/hub-link-held.js";
import type { HubProjectChoice } from "../../../src/shared/hub-project-link.js";
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
  it("a placed write whose name says an area lists it, or opts out of it itself (Reviewer D)", () => {
    for (const [w, e] of Object.entries(HELD_WRITE_RISK)) {
      const opt = (e as { notAreas?: readonly string[] }).notAreas ?? [];
      for (const a of areasOf(w))
        expect([w, a, (e.areas ?? []).includes(a) || opt.includes(a)]).toEqual([
          w,
          a,
          true,
        ]);
    }
  });
  it("only the two writes that narrow opt out of their name's area", () => {
    const out = Object.entries(HELD_WRITE_RISK)
      .filter(([, e]) => (e as { notAreas?: unknown[] }).notAreas?.length)
      .map(([w]) => w)
      .sort();
    expect(out).toEqual(["gate_box_remove", "project_mcp_remove"]);
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

describe("host_restart checks again right before the restart (Den Builder)", () => {
  const routine = { id: "a1", agent: "scout", decidedBy: "auto:notify" };
  const setup = (o: { turns: () => boolean; result?: unknown }) => {
    const starts: unknown[] = [];
    const held: { agent?: string; card: unknown }[] = [];
    const op = hostRestartOp({
      refreshing: () => false,
      waitSeconds: () => 60,
      start: async (s) => {
        starts.push(s ?? {});
        return (o.result ?? null) as never;
      },
      personal: () => true,
      turnsRunning: async () => o.turns(),
      hold: (card, agent) => held.push({ agent, card }),
    });
    return { op, starts, held };
  };
  it("idle at the ask, a turn starts, then: it holds for the person and cuts nothing", async () => {
    let turns = false;
    const t = setup({ turns: () => turns });
    const c = await t.op.check({});
    expect((c as { personOnly?: boolean }).personOnly).toBeFalsy();
    turns = true;
    const r = await t.op.run({}, routine);
    expect(r).toMatchObject({ ok: true, held: true });
    expect(t.starts).toEqual([]);
    expect(t.held).toEqual([
      { agent: "scout", card: expect.objectContaining({ personOnly: true }) },
    ]);
  });
  it("idle still: it restarts idle-only; a turn at the refresh's own look holds it", async () => {
    const t = setup({
      turns: () => false,
      result: { did: "held", busy: ["scout"] },
    });
    expect(await t.op.run({}, routine)).toMatchObject({
      ok: true,
      started: true,
    });
    await new Promise((res) => setImmediate(res));
    expect(t.starts).toEqual([{ idleOnly: true }]);
    expect(t.held).toHaveLength(1);
  });
  it("the person's own Allow: the restart as before (it waits, and may cut)", async () => {
    const t = setup({ turns: () => true });
    expect(
      await t.op.run({}, { id: "a2", agent: "scout", decidedBy: "person" }),
    ).toMatchObject({ ok: true, started: true });
    expect(t.starts).toEqual([{}]);
    expect(t.held).toEqual([]);
  });
});

describe("hub_link: routine on personal only to the Connect-paired Hub project", () => {
  const paired = {
    id: "h1",
    slug: "north",
    name: "north",
    why: "repo" as const,
  };
  const other = { id: "h2", slug: "someone-else", name: "someone-else" };
  const deps = (
    personal: boolean,
    suggestions: HubProjectChoice[] = [paired],
  ) => ({
    exists: () => true,
    read: () => null,
    choices: async () => ({ suggestions, projects: [paired, other] }),
    write: () => undefined,
    changed: () => undefined,
    personal: () => personal,
  });
  const only = (c: unknown) =>
    (c as { personOnly?: boolean }).personOnly === true;
  it("personal, to the paired project: routine", async () => {
    const c = await checkHubLinkHeld(deps(true), {
      project: "north",
      hub: "h1",
    });
    expect(c.ok).toBe(true);
    expect(only(c)).toBe(false);
  });
  it("personal, to another Hub project: asks (acting on others)", async () => {
    const c = await checkHubLinkHeld(deps(true), {
      project: "north",
      hub: "h2",
    });
    expect(c.ok).toBe(true);
    expect(only(c)).toBe(true);
  });
  it("personal, the pairing unclear (two suggestions): asks", async () => {
    const c = await checkHubLinkHeld(
      deps(true, [paired, { ...other, why: "name" }]),
      {
        project: "north",
        hub: "h1",
      },
    );
    expect(only(c)).toBe(true);
  });
  it("strict: as before (it asks by its kind; no personOnly)", async () => {
    const c = await checkHubLinkHeld(deps(false), {
      project: "north",
      hub: "h2",
    });
    expect(c.ok).toBe(true);
    expect(only(c)).toBe(false);
  });
});

describe("den_update on personal (Den Builder's ruling)", () => {
  it("stableNotOlder: a stable release at or above the running one", () => {
    expect(stableNotOlder("0.4.89", "0.4.88")).toBe(true);
    expect(stableNotOlder("0.4.88", "0.4.88")).toBe(true);
    expect(stableNotOlder("0.4.89", "0.4.89-dev.1")).toBe(true);
    expect(stableNotOlder("0.4.89-dev.1", "0.4.88")).toBe(false);
    expect(stableNotOlder("0.4.87", "0.4.88")).toBe(false);
    expect(stableNotOlder("0.4.88", "0.4.89-dev.1")).toBe(false);
    expect(stableNotOlder("0.10.0", "0.9.9")).toBe(true);
    expect(stableNotOlder("junk", "0.4.88")).toBe(false);
    expect(stableNotOlder("0.4.89", null)).toBe(false);
  });
  const server = { agent: "server", project: SERVER_SCOPE };
  const make = (personal: boolean) => {
    const updates: unknown[] = [];
    const held: unknown[] = [];
    const a = heldActions({
      updateDen: async (
        version: string,
        _reason: string,
        _asked: unknown,
        o?: { stableNotOlder?: boolean },
      ) => {
        updates.push({ version, ...o });
        return o?.stableNotOlder && version === "latest"
          ? {
              ok: false,
              needsPerson: true,
              from: "0.4.89-dev.1",
              to: "0.4.88",
              error: "older",
            }
          : { ok: true, restarting: true };
      },
      installPersonal: () => personal,
      denVersion: () => "0.4.88",
      holdForPerson: (action: string, card: unknown, agent?: string) =>
        held.push({ action, card, agent }),
    } as unknown as Parameters<typeof heldActions>[0]);
    return { a, updates, held };
  };
  const only = (c: unknown) =>
    (c as { personOnly?: boolean }).personOnly === true;
  const ask = (version: string) => ({ version, reason: "a fix" });
  it("the server agent, 0.4.88 → 0.4.89: routine", async () => {
    const { a } = make(true);
    expect(only(await a.den_update.check(ask("0.4.89"), server))).toBe(false);
    expect(only(await a.den_update.check(ask("latest"), server))).toBe(false);
  });
  it("the server agent, → 0.4.89-dev.1 or → 0.4.87: asks", async () => {
    const { a } = make(true);
    expect(only(await a.den_update.check(ask("0.4.89-dev.1"), server))).toBe(
      true,
    );
    expect(only(await a.den_update.check(ask("0.4.87"), server))).toBe(true);
  });
  it("a project's agent, → 0.4.89: asks", async () => {
    const { a } = make(true);
    expect(
      only(
        await a.den_update.check(ask("0.4.89"), {
          agent: "scout",
          project: "north",
        }),
      ),
    ).toBe(true);
  });
  it("strict: no personOnly from the check (critical by its placement; SRV-1a's auto stays)", async () => {
    const { a } = make(false);
    expect(only(await a.den_update.check(ask("0.4.89-dev.1"), server))).toBe(
      false,
    );
  });
  it("a routine run is told to stop below the running version or on a prerelease", async () => {
    const { a, updates } = make(true);
    await a.den_update.run(ask("0.4.89"), {
      id: "u1",
      agent: "server",
      decidedBy: "auto:notify",
    });
    expect(updates).toEqual([{ version: "0.4.89", stableNotOlder: true }]);
  });
  it('"latest" resolving lower than the running version: stops and holds for the person', async () => {
    const { a, held } = make(true);
    const r = await a.den_update.run(ask("latest"), {
      id: "u2",
      agent: "server",
      decidedBy: "auto:notify",
    });
    expect(r).toMatchObject({ ok: true, held: true });
    expect(held).toEqual([
      {
        action: "den_update",
        agent: "server",
        card: expect.objectContaining({ ok: true, personOnly: true }),
      },
    ]);
  });
  it("the person's own Allow: no stop (as before)", async () => {
    const { a, updates } = make(true);
    await a.den_update.run(ask("0.4.87"), { id: "u3", decidedBy: "person" });
    expect(updates).toEqual([{ version: "0.4.87" }]);
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
