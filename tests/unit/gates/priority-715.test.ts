/**
 * Issue 715: `gate run --priority release --reason "<why>"`. A release run
 * a person waits on goes to the front of its kind's queue, never ahead of
 * a holder; at most `priority_max` (default 1) such runs per kind hold
 * priority at a time, and a second waits behind the first; an unmarked run
 * never jumps; a waiter past `priority_pass_limit_minutes` is not passed
 * again; every jump is in the slot log (who, why, what it passed).
 * The store lives in a temp dir; no Den runs and no suite runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GATE_DEFAULTS,
  grants,
  queueOrder,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import {
  GatePriorityRefused,
  GateStore,
  checkGatePatch,
} from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate715-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-20T06:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const at = (min: number) => T0 + min * 60_000;
const entry = (
  id: string,
  kind: "browser" | "cpu",
  askedMin: number,
  o: { granted?: number; reason?: string } = {},
): GateEntry => ({
  id,
  kind,
  who: id,
  label: id,
  pid: 1,
  askedAt: iso(askedMin),
  estimateMin: 10,
  ...(o.granted !== undefined ? { grantedAt: iso(o.granted) } : {}),
  ...(o.reason
    ? { priority: { for: "release" as const, reason: o.reason } }
    : {}),
});
const ids = (es: GateEntry[]) => es.map((e) => e.id);

describe("the queue rules (issue 715)", () => {
  it("a marked run goes to the front of its kind's queue", () => {
    const q = [
      entry("h", "browser", 0, { granted: 0 }),
      entry("a", "browser", 1),
      entry("b", "browser", 2),
      entry("p", "browser", 3, { reason: "the person waits" }),
    ];
    expect(ids(queueOrder(q, GATE_DEFAULTS, at(4)))).toEqual(["p", "a", "b"]);
    // Never ahead of a holder: the holder keeps its slot.
    expect(grants(q, GATE_DEFAULTS, at(4))).toEqual([]);
    const free = q.filter((e) => e.id !== "h");
    expect(grants(free, GATE_DEFAULTS, at(4))).toEqual(["p"]);
  });

  it("a second marked run waits behind the first", () => {
    const q = [
      entry("h", "browser", 0, { granted: 0 }),
      entry("a", "browser", 1),
      entry("p1", "browser", 2, { reason: "first" }),
      entry("p2", "browser", 3, { reason: "second" }),
    ];
    expect(ids(queueOrder(q, GATE_DEFAULTS, at(4)))).toEqual(["p1", "a", "p2"]);
    // Once the first holds its slot, the second takes priority.
    const next = [
      entry("p1", "browser", 2, { granted: 5, reason: "first" }),
      entry("a", "browser", 1),
      entry("p2", "browser", 3, { reason: "second" }),
    ];
    expect(ids(queueOrder(next, GATE_DEFAULTS, at(6)))).toEqual(["p2", "a"]);
  });

  it("an unmarked run never jumps", () => {
    const q = [
      entry("h", "browser", 0, { granted: 0 }),
      entry("a", "browser", 1),
      entry("b", "browser", 2),
      entry("c", "browser", 3),
    ];
    expect(ids(queueOrder(q, GATE_DEFAULTS, at(4)))).toEqual(["a", "b", "c"]);
  });

  it("jumps only its own kind", () => {
    const q = [
      entry("h", "browser", 0, { granted: 0 }),
      entry("c", "cpu", 1),
      entry("a", "browser", 2),
      entry("p", "browser", 3, { reason: "r" }),
    ];
    const own = { ...GATE_DEFAULTS, releasePassOtherKindMinutes: 0 };
    expect(ids(queueOrder(q, own, at(4)))).toEqual(["c", "p", "a"]);
  });

  // Issue 751: a plain waiter is passed however long it has waited; the
  // pass limit applies only between marked runs (cpu-backfill-751.test.ts).
  it("passes a plain run however long it has waited (issue 751)", () => {
    const q = [
      entry("h", "browser", 0, { granted: 0 }),
      entry("old", "browser", 0),
      entry("a", "browser", 50),
      entry("p", "browser", 61, { reason: "r" }),
    ];
    expect(ids(queueOrder(q, GATE_DEFAULTS, at(61)))).toEqual([
      "p",
      "old",
      "a",
    ]);
    expect(
      ids(
        queueOrder(
          q,
          { ...GATE_DEFAULTS, priorityPassLimitMinutes: 120 },
          at(61),
        ),
      ),
    ).toEqual(["p", "old", "a"]);
  });

  it("the cap is a setting (default 1; 0 turns priority off)", () => {
    expect(GATE_DEFAULTS.priorityMax).toBe(1);
    expect(GATE_DEFAULTS.priorityPassLimitMinutes).toBe(0);
    expect(GATE_DEFAULTS.priorityAgents).toBe(true);
    const q = [
      entry("h", "browser", 0, { granted: 0 }),
      entry("a", "browser", 1),
      entry("p1", "browser", 2, { reason: "first" }),
      entry("p2", "browser", 3, { reason: "second" }),
    ];
    expect(
      ids(queueOrder(q, { ...GATE_DEFAULTS, priorityMax: 2 }, at(4))),
    ).toEqual(["p1", "p2", "a"]);
    expect(
      ids(queueOrder(q, { ...GATE_DEFAULTS, priorityMax: 0 }, at(4))),
    ).toEqual(["a", "p1", "p2"]);
  });
});

describe("the store's audit (issue 715)", () => {
  // A clock that moves a second per look: asks keep their order.
  const store = () => {
    let now = at(10);
    return new GateStore({
      platform: "linux",
      dir: tmp(),
      alive: () => true,
      now: () => (now += 1000),
    });
  };
  const ask = (
    s: GateStore,
    label: string,
    o: { reason?: string; agent?: boolean; actor?: string } = {},
  ) =>
    s.ask({
      kind: "browser",
      who: `Den · repo · ${o.actor ?? "a person"}`,
      label,
      pid: 1,
      estimateMin: 10,
      ...(o.agent ? { agent: true } : {}),
      ...(o.actor ? { actor: o.actor } : {}),
      ...(o.reason ? { priority: { reason: o.reason } } : {}),
    });

  it("a marked ask writes who, why and what it passed", () => {
    const s = store();
    const h = ask(s, "holder");
    const a = ask(s, "a");
    const b = ask(s, "b");
    const p = ask(s, "rc", { reason: "the person waits on 0.4.78" });
    expect(h.grantedAt).toBeDefined();
    expect(p.grantedAt).toBeUndefined();
    const row = s.events().find((e) => e.event === "priority");
    expect(row).toMatchObject({
      id: p.id,
      who: "Den · repo · a person",
      reason: "the person waits on 0.4.78",
      passed: [a.id, b.id],
    });
    expect(s.list().map((e) => e.id)).toEqual([h.id, p.id, a.id, b.id]);
    // The holder ends: the marked run starts next.
    s.release(h.id);
    expect(s.get(p.id)?.grantedAt).toBeDefined();
    expect(s.get(a.id)?.grantedAt).toBeUndefined();
  });

  it("a second marked ask waits behind the first, and says so", () => {
    const s = store();
    const h = ask(s, "holder");
    const a = ask(s, "a");
    const p1 = ask(s, "rc1", { reason: "first" });
    const p2 = ask(s, "rc2", { reason: "second" });
    const waits = s.events().find((e) => e.event === "priority-waits");
    expect(waits).toMatchObject({
      id: p2.id,
      behind: [p1.id],
      reason: "second",
    });
    expect(s.events().filter((e) => e.event === "priority")).toHaveLength(1);
    expect(s.list().map((e) => e.id)).toEqual([h.id, p1.id, a.id, p2.id]);
    s.release(h.id);
    // p1 holds; p2 now takes priority, and the log says what it passed.
    expect(s.list().map((e) => e.id)).toEqual([p1.id, p2.id, a.id]);
    const rows = s.events().filter((e) => e.event === "priority");
    expect(rows.map((r) => r.id)).toEqual([p1.id, p2.id]);
    expect(rows[1]).toMatchObject({ passed: [a.id] });
  });

  it("an agent's priority ask is refused when only people may ask", () => {
    const s = store();
    s.writeSettings({ priority_agents: 0 });
    expect(() =>
      ask(s, "rc", { reason: "r", agent: true, actor: "agent:coder" }),
    ).toThrow(GatePriorityRefused);
    expect(s.list()).toEqual([]);
    // A person still may.
    expect(ask(s, "rc", { reason: "r" }).priority?.reason).toBe("r");
  });

  it("the view shows the priority holder and its reason", () => {
    const s = store();
    ask(s, "holder");
    ask(s, "a");
    const p1 = ask(s, "rc1", { reason: "first" });
    const p2 = ask(s, "rc2", { reason: "second" });
    const v = gateView(s, at(10));
    expect(v.slots.find((x) => x.id === p1.id)?.priority).toEqual({
      reason: "first",
      holds: true,
    });
    expect(v.slots.find((x) => x.id === p2.id)?.priority).toEqual({
      reason: "second",
      holds: false,
    });
    expect(v.settings.priorityMax).toBe(1);
  });

  it("the settings check takes the three new keys", () => {
    expect(
      checkGatePatch({
        priority_max: 2,
        priority_pass_limit_minutes: 30,
        priority_agents: 0,
      }),
    ).toEqual({
      ok: true,
      patch: {
        priority_max: 2,
        priority_pass_limit_minutes: 30,
        priority_agents: 0,
      },
    });
    expect(checkGatePatch({ priority_agents: 2 }).ok).toBe(false);
  });
});

function deps(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: GateDeps = {
    store: new GateStore({
      platform: "linux",
      dir: tmp(),
      alive: () => true,
    }),
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: () => ({ pid: 5151, kill: () => {}, done: Promise.resolve(0) }),
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
  };
  return { d, out, err };
}

describe("gate run --priority (issue 715)", () => {
  it("needs --priority release and a reason", async () => {
    const t = deps();
    expect(
      await cmdGate(["run", "--priority", "release", "--", "true"], t.d),
    ).toBe(2);
    expect(t.err.join("\n")).toMatch(/--reason/);
    expect(
      await cmdGate(
        ["run", "--priority", "urgent", "--reason", "x", "--", "true"],
        t.d,
      ),
    ).toBe(2);
    expect(t.d.store.events()).toEqual([]);
  });

  it("runs, and the slot log has the priority row with its reason", async () => {
    const t = deps();
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "browser",
          "--priority",
          "release",
          "--reason",
          "the person waits",
          "--",
          "true",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(t.d.store.events().map((e) => e.event)).toEqual([
      "asked",
      "priority",
      "granted",
      "released",
    ]);
    expect(t.d.store.events()[1]).toMatchObject({
      reason: "the person waits",
      by: "a person",
    });
  });

  it("is refused for an agent when only people may ask", async () => {
    const t = deps({ DEN_AGENT: "agent:coder" });
    t.d.store.writeSettings({ priority_agents: 0 });
    expect(
      await cmdGate(
        ["run", "--priority", "release", "--reason", "x", "--", "true"],
        t.d,
      ),
    ).toBe(2);
    expect(t.err.join("\n")).toMatch(/only a person/);
  });

  it("gate status shows the priority holder and why", async () => {
    const t = deps();
    const s = t.d.store;
    s.ask({
      kind: "browser",
      who: "h",
      label: "holder",
      pid: 1,
      estimateMin: 10,
    });
    s.ask({ kind: "browser", who: "a", label: "a", pid: 1, estimateMin: 10 });
    s.ask({
      kind: "browser",
      who: "p",
      label: "rc",
      pid: 1,
      estimateMin: 10,
      priority: { reason: "the person waits" },
    });
    expect(await cmdGate(["status"], t.d)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toMatch(/release priority.*"the person waits"/i);
    // The marked run is listed ahead of the one it passed.
    expect(text.indexOf('"rc"')).toBeLessThan(text.indexOf('"a"'));
    t.out.length = 0;
    expect(await cmdGate(["status", "--json"], t.d)).toBe(0);
    const v = JSON.parse(t.out.join("\n")) as {
      slots: { label: string; priority?: unknown }[];
    };
    expect(v.slots.find((x) => x.label === "rc")?.priority).toEqual({
      reason: "the person waits",
      holds: true,
    });
  });

  it("gate settings sets the cap and the pass limit (a person's only)", async () => {
    const t = deps();
    expect(
      await cmdGate(
        [
          "settings",
          "--priority-max",
          "2",
          "--priority-pass-limit-minutes",
          "30",
          "--priority-agents",
          "0",
        ],
        t.d,
      ),
    ).toBe(0);
    expect(t.d.store.settings()).toMatchObject({
      priorityMax: 2,
      priorityPassLimitMinutes: 30,
      priorityAgents: false,
    });
  });
});

describe("gate_slot_request with priority (issue 715)", () => {
  const api = {
    baseUrl: "http://localhost:47003",
    async get(p: string) {
      if (p === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      throw new Error(`no API call expected: ${p}`);
    },
  } as unknown as DenApi;
  const ctx = (store: GateStore): ToolContext => ({
    api,
    cfg: {
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: true,
    } as unknown as ToolContext["cfg"],
    cli: "acme",
    scope: { workspace: "north", actor: "agent:coder" },
    gates: store,
  });

  it("takes priority with a reason, and refuses one without", async () => {
    const store = new GateStore({
      platform: "linux",
      dir: tmp(),
      alive: () => true,
    });
    store.ask({
      kind: "browser",
      who: "h",
      label: "h",
      pid: 1,
      estimateMin: 10,
    });
    const no = await callTool(
      "gate_slot_request",
      { kind: "browser", priority: "release" },
      ctx(store),
    );
    expect(no.isError).toBe(true);
    const r = await callTool(
      "gate_slot_request",
      {
        kind: "browser",
        priority: "release",
        reason: "the person reported it",
      },
      ctx(store),
    );
    const v = JSON.parse(r.text) as { priority?: unknown };
    expect(v.priority).toEqual({
      reason: "the person reported it",
      holds: true,
    });
    expect(store.events().find((e) => e.event === "priority")).toMatchObject({
      by: "agent:coder",
      reason: "the person reported it",
    });
  });
});
