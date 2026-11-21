/**
 * Issue 714: a gate slot an agent holds over MCP. The MCP server's process
 * outlives the agent's work, so "process gone" never takes it back.
 *   Part 1: when a queued agent's slot is granted, Den tells the agent (the
 *   relayed-message path, typed only at its prompt). Granted but unclaimed
 *   for gates claim_minutes, it passes to the next in line (logged
 *   passed-unclaimed), and the agent is put back in line and told.
 *   Part 2: a lease. gate_slot_request with the id renews it; one not
 *   renewed for the lapse time AND past its estimate plus a grace is taken
 *   back (taken-back-lapsed); the agent's next tool call says so, and the
 *   bell names it. Slots held through `gate run` are unchanged.
 * Temp dirs and a moving fake clock; no Den runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GATE_DEFAULTS } from "../../../src/shared/gates/rules.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import { GateNotices } from "../../../src/ui/server/gate-notices.js";
import type { Delivery } from "../../../src/shared/hub-delivery.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate714-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-20T06:00:00Z");
const MIN = 60_000;
const INSTALL = "/x/den-state";

function setup(dir = tmp()) {
  let now = T0;
  const store = new GateStore({ dir, now: () => now, alive: () => true });
  return {
    dir,
    store,
    at: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const local = (s: GateStore, label: string, estimateMin = 10) =>
  s.ask({ kind: "browser", who: label, label, pid: 1, estimateMin });
const agent = (s: GateStore, actor = "agent:coder", estimateMin = 10) =>
  s.ask({
    kind: "browser",
    who: `${actor} · north`,
    label: "e2e",
    pid: 1,
    estimateMin,
    agent: true,
    actor,
    mcp: { install: INSTALL },
  });

describe("the settings (issue 714)", () => {
  it("claim, renew, lapse and grace are settings with permissive defaults", () => {
    expect(GATE_DEFAULTS.claimMinutes).toBe(3);
    expect(GATE_DEFAULTS.mcpRenewMinutes).toBe(5);
    expect(GATE_DEFAULTS.mcpLapseMinutes).toBe(15);
    expect(GATE_DEFAULTS.mcpGraceMinutes).toBe(15);
    const patch = {
      claim_minutes: 5,
      mcp_renew_minutes: 2,
      mcp_lapse_minutes: 30,
      mcp_grace_minutes: 60,
    };
    expect(checkGatePatch(patch)).toEqual({ ok: true, patch });
    expect(checkGatePatch({ claim_minutes: 0 }).ok).toBe(false);
    const { store } = setup();
    store.writeSettings(patch);
    expect(store.settings()).toMatchObject({
      claimMinutes: 5,
      mcpRenewMinutes: 2,
      mcpLapseMinutes: 30,
      mcpGraceMinutes: 60,
    });
  });
});

describe("granted, then claimed or passed on (issue 714, part 1)", () => {
  it("an MCP ask granted at once is claimed: the agent is right there", () => {
    const { store } = setup();
    const e = agent(store);
    expect(e.grantedAt).toBeDefined();
    expect(e.mcp?.claimBy).toBeUndefined();
  });

  it("a queued MCP ask granted later waits for its claim; the log row says until when and whose", () => {
    const t = setup();
    const h = local(t.store, "holder");
    const a = agent(t.store);
    t.advance(MIN);
    t.store.release(h.id);
    const g = t.store.get(a.id)!;
    expect(g.grantedAt).toBeDefined();
    expect(g.mcp?.claimBy).toBe(new Date(t.at() + 3 * MIN).toISOString());
    const row = t.store
      .events()
      .find((r) => r.event === "granted" && r.id === a.id);
    expect(row).toMatchObject({
      actor: "agent:coder",
      install: INSTALL,
      claimBy: g.mcp?.claimBy,
    });
  });

  it("claimed with gate_slot_request's id (renewMcp), it holds", () => {
    const t = setup();
    const h = local(t.store, "holder");
    const a = agent(t.store);
    t.store.release(h.id);
    t.advance(MIN);
    expect(t.store.renewMcp(a.id)?.mcp?.claimBy).toBeUndefined();
    local(t.store, "next");
    t.advance(10 * MIN);
    expect(t.store.get(a.id)?.grantedAt).toBeDefined();
  });

  it("0. unclaimed past claim_minutes, it passes to the next in line and goes back in line (passed-unclaimed)", () => {
    const t = setup();
    const h = local(t.store, "holder");
    const a = agent(t.store);
    t.advance(1000);
    const n = local(t.store, "next");
    t.store.release(h.id);
    expect(t.store.get(a.id)?.grantedAt).toBeDefined();
    t.advance(3 * MIN + 1000);
    const list = t.store.list();
    expect(list.map((e) => [e.id, !!e.grantedAt])).toEqual([
      [n.id, true],
      [a.id, false],
    ]);
    const row = t.store.events().find((r) => r.event === "passed-unclaimed");
    expect(row).toMatchObject({
      id: a.id,
      actor: "agent:coder",
      install: INSTALL,
    });
    expect(t.store.get(a.id)?.mcp?.claimBy).toBeUndefined();
  });

  it("with nobody waiting, an unclaimed slot is not passed on (nobody gains)", () => {
    const t = setup();
    const h = local(t.store, "holder");
    const a = agent(t.store);
    t.store.release(h.id);
    t.advance(10 * MIN);
    expect(t.store.get(a.id)?.grantedAt).toBeDefined();
    expect(t.store.events().some((r) => r.event === "passed-unclaimed")).toBe(
      false,
    );
  });

  it("claim_minutes is read from the settings", () => {
    const t = setup();
    t.store.writeSettings({ claim_minutes: 10 });
    const h = local(t.store, "holder");
    const a = agent(t.store);
    t.advance(1000);
    local(t.store, "next");
    t.store.release(h.id);
    t.advance(5 * MIN);
    expect(t.store.get(a.id)?.grantedAt).toBeDefined();
  });
});

describe("the lease (issue 714, part 2)", () => {
  it("1. not renewed and past its estimate plus grace, it lapses within the lapse time; the next starts", () => {
    const t = setup();
    const a = agent(t.store, "agent:coder", 10);
    const n = local(t.store, "next");
    // 10 min estimate + 15 grace = 25; lapse 15 after the last renew (0).
    t.advance(24 * MIN);
    expect(t.store.get(a.id)?.grantedAt).toBeDefined();
    t.advance(2 * MIN);
    expect(t.store.get(a.id)).toBeNull();
    expect(t.store.get(n.id)?.grantedAt).toBeDefined();
    expect(
      t.store.events().find((r) => r.event === "taken-back-lapsed"),
    ).toMatchObject({ id: a.id, actor: "agent:coder", install: INSTALL });
  });

  it("2. renewed, it keeps holding past its estimate", () => {
    const t = setup();
    const a = agent(t.store, "agent:coder", 10);
    local(t.store, "next");
    for (let i = 0; i < 12; i++) {
      t.advance(5 * MIN);
      expect(t.store.renewMcp(a.id)).not.toBeNull();
    }
    expect(t.store.get(a.id)?.grantedAt).toBeDefined();
  });

  it("not renewed but within its estimate plus grace, it keeps holding", () => {
    const t = setup();
    const a = agent(t.store, "agent:coder", 60);
    t.advance(70 * MIN);
    expect(t.store.get(a.id)?.grantedAt).toBeDefined();
  });

  it("a gate run holder (no MCP) is unchanged: no claim, no lease", () => {
    const t = setup();
    const h = local(t.store, "holder");
    const l = local(t.store, "run", 5);
    t.store.release(h.id);
    expect(t.store.get(l.id)?.mcp).toBeUndefined();
    local(t.store, "next");
    t.advance(300 * MIN);
    expect(t.store.get(l.id)?.grantedAt).toBeDefined();
  });
});

const api: DenApi = {
  baseUrl: "http://localhost:47003",
  async get(p: string) {
    if (p === "/api/workspaces")
      return { active: ["north"], workspaces: { north: {} } };
    throw new Error(`no API call expected: ${p}`);
  },
} as unknown as DenApi;
const ctx = (store: GateStore, actor = "agent:coder"): ToolContext => ({
  api,
  cfg: {
    actions: [],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  } as unknown as ToolContext["cfg"],
  cli: "acme",
  scope: { workspace: "north", actor },
  gates: store,
  install: INSTALL,
});
const json = (r: { text: string }) =>
  JSON.parse(r.text) as Record<string, unknown>;

describe("gate_slot_request over MCP (issue 714)", () => {
  it("records the install and the agent; asking again with the id claims and renews", async () => {
    const t = setup();
    const h = local(t.store, "holder");
    const c = ctx(t.store);
    const r = json(await callTool("gate_slot_request", { kind: "browser" }, c));
    const id = String(r.id);
    expect(t.store.get(id)?.mcp).toEqual({ install: INSTALL });
    t.store.release(h.id);
    expect(t.store.get(id)?.mcp?.claimBy).toBeDefined();
    t.advance(MIN);
    const again = json(await callTool("gate_slot_request", { id }, c));
    expect(again).toMatchObject({ id, granted: true });
    expect(again.renewEveryMinutes).toBe(5);
    expect(t.store.get(id)?.mcp?.claimBy).toBeUndefined();
    expect(t.store.get(id)?.mcp?.renewedAt).toBe(
      new Date(t.at()).toISOString(),
    );
  });

  it("the description tells agents to claim and renew while they work", async () => {
    const { toolsFor } = await import("../../../src/ui/mcp/tools.js");
    const d = toolsFor(ctx(setup().store).cfg).find(
      (x) => x.name === "gate_slot_request",
    )!.description;
    expect(d).toMatch(/renew/i);
    expect(d).toMatch(/claim/i);
  });

  it("3. after a lapse, the agent's next tool call says so (once)", async () => {
    const t = setup();
    const c = ctx(t.store, "agent:lapser");
    const r = json(
      await callTool(
        "gate_slot_request",
        { kind: "browser", estimate_minutes: 1 },
        c,
      ),
    );
    t.advance(60 * MIN);
    const next = await callTool("gate_slot_status", {}, c);
    expect(next.text).toMatch(
      new RegExp(`Your gate slot ${String(r.id)} lapsed`),
    );
    const after = await callTool("gate_slot_status", {}, c);
    expect(after.text).not.toMatch(/lapsed/);
  });
});

describe("Den tells the agent (issue 714)", () => {
  function notices(t: ReturnType<typeof setup>) {
    const relayed: Delivery[] = [];
    const bells: { subject: string; text: string; msg?: unknown }[] = [];
    const n = new GateNotices({
      store: () => t.store,
      install: INSTALL,
      projectOf: (a) => (a === "coder" ? "north" : null),
      relay: (dv) => {
        relayed.push(dv);
        return Promise.resolve(true);
      },
      bell: (b) => {
        bells.push(b);
      },
    });
    n.start();
    return { n, relayed, bells };
  }

  it("0. a granted, unclaimed slot: the agent is told its id and the claim time", async () => {
    const t = setup();
    const h = local(t.store, "holder");
    const a = agent(t.store);
    const { n, relayed } = notices(t);
    t.store.release(h.id);
    await n.tick();
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ agent: "coder", project: "north" });
    expect(relayed[0]!.text).toBe(
      `Den: your browser slot is granted: ${a.id}. Call gate_slot_request with this id to start; it passes to the next in line after 3 min.`,
    );
    await n.tick();
    expect(relayed).toHaveLength(1);
  });

  it("not told when it was claimed already, nor for another install's agent", async () => {
    const t = setup();
    const h = local(t.store, "holder");
    const a = agent(t.store);
    const other = t.store.ask({
      kind: "browser",
      who: "x",
      label: "x",
      pid: 1,
      estimateMin: 1,
      agent: true,
      actor: "agent:coder",
      mcp: { install: "/elsewhere" },
    });
    const { n, relayed } = notices(t);
    t.store.release(h.id);
    t.store.renewMcp(a.id);
    await n.tick();
    t.store.release(a.id);
    await n.tick();
    expect(t.store.get(other.id)?.grantedAt).toBeDefined();
    expect(relayed).toEqual([]);
  });

  it("0. passed on unclaimed: the agent is told it is back in line", async () => {
    const t = setup();
    const h = local(t.store, "holder");
    const a = agent(t.store);
    t.advance(1000);
    local(t.store, "next");
    const { n, relayed } = notices(t);
    t.store.release(h.id);
    await n.tick();
    t.advance(4 * MIN);
    await n.tick();
    expect(relayed.map((d) => d.text)).toEqual([
      expect.stringContaining("is granted"),
      `Den: your browser slot ${a.id} passed to the next in line: it wasn't claimed within 3 min. You are back in line (place 1); Den tells you when it is yours again.`,
    ]);
  });

  it("a relay that isn't ready is tried again on the next tick", async () => {
    const t = setup();
    const h = local(t.store, "holder");
    agent(t.store);
    let ready = false;
    const relayed: Delivery[] = [];
    const n = new GateNotices({
      store: () => t.store,
      install: INSTALL,
      projectOf: () => "north",
      relay: (dv) => {
        if (!ready) return Promise.resolve(false);
        relayed.push(dv);
        return Promise.resolve(true);
      },
      bell: () => {},
    });
    n.start();
    t.store.release(h.id);
    await n.tick();
    ready = true;
    await n.tick();
    expect(relayed).toHaveLength(1);
  });

  it("3. a lapse rings the bell, naming the slot and the agent", async () => {
    const t = setup();
    const a = agent(t.store, "agent:coder", 1);
    const { n, bells, relayed } = notices(t);
    t.advance(60 * MIN);
    await n.tick();
    expect(relayed).toEqual([]);
    expect(bells).toHaveLength(1);
    expect(bells[0]).toMatchObject({
      kind: "service",
      subject: `record:gate-lapsed-${a.id}`,
      scope: "workspace/north",
      msg: {
        key: "bell.m.gateLapsed",
        vars: { name: "coder", kind: "browser", label: "e2e" },
      },
    });
    expect(bells[0]!.text).toMatch(/coder's browser gate slot "e2e" lapsed/);
  });
});
