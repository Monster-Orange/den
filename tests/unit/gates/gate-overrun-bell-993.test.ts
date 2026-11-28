/**
 * Issue 993: a gate slot held past twice its estimate (the setting
 * overrun_bell_multiple, default 2) puts one line in the bell's Needs you:
 * who holds it, what it runs, since when, and the estimate, with End for
 * the person (the person-only POST /api/gate-slots/end, which records who;
 * an agent's End is refused there, gate-routes.test.ts). When the slot is
 * an agent's, Den types one line at that agent's prompt, once per slot. The
 * line leaves the bell when the slot ends, however it ends.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GATE_DEFAULTS, overrunBell } from "../../../src/shared/gates/rules.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { gateOverrunWaiting } from "../../../src/ui/server/gate-overrun-bell.js";
import { GateNotices } from "../../../src/ui/server/gate-notices.js";
import type { Delivery } from "../../../src/shared/hub/hub-delivery.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-22T16:00:00Z");
const MIN = 60_000;
const INSTALL = "/x/den-state";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate993-"));
  tmps.push(dir);
  let now = T0;
  const store = new GateStore({
    platform: "linux",
    dir,
    now: () => now,
    alive: () => true,
  });
  return {
    store,
    at: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** An agent's gate run (the CLI's: no lease), 10 min estimate. */
const agentRun = (s: GateStore, actor = "agent:coder") =>
  s.ask({
    kind: "browser",
    who: `den · north · ${actor}`,
    label: "e2e suite",
    pid: 1,
    estimateMin: 10,
    agent: true,
    actor,
  });
/** A person's gate run, 10 min estimate. */
const personRun = (s: GateStore) =>
  s.ask({
    kind: "cpu",
    who: "den · north · a person",
    label: "unit",
    pid: 1,
    estimateMin: 10,
  });

describe("the rule and its setting (issue 993)", () => {
  it("overrun_bell_multiple: default 2, a checked setting", () => {
    expect(GATE_DEFAULTS.overrunBellMultiple).toBe(2);
    expect(checkGatePatch({ overrun_bell_multiple: 3 })).toEqual({
      ok: true,
      patch: { overrun_bell_multiple: 3 },
    });
    expect(checkGatePatch({ overrun_bell_multiple: 0.5 }).ok).toBe(false);
    const t = setup();
    t.store.writeSettings({ overrun_bell_multiple: 1.5 });
    expect(t.store.settings().overrunBellMultiple).toBe(1.5);
  });

  it("at 2× plus one minute it's in the bell; at 1.9× it isn't", () => {
    const t = setup();
    const e = agentRun(t.store);
    const s = t.store.settings();
    expect(overrunBell(e, s, T0 + 19 * MIN)).toBe(false);
    expect(overrunBell(e, s, T0 + 21 * MIN)).toBe(true);
    // The multiple is the setting's.
    expect(overrunBell(e, { overrunBellMultiple: 3 }, T0 + 21 * MIN)).toBe(
      false,
    );
    // A waiter is never overrun.
    const w = agentRun(t.store, "agent:other");
    expect(w.grantedAt).toBeUndefined();
    expect(overrunBell(w, s, T0 + 60 * MIN)).toBe(false);
  });
});

describe("Needs you: one line, with what End needs (issue 993)", () => {
  it("one entry at 2× plus a minute, none at 1.9×; it leaves when the slot is released", () => {
    const t = setup();
    const e = agentRun(t.store);
    const at = (n: number) =>
      gateOverrunWaiting(t.store.list(), t.store.settings(), T0 + n * MIN);
    expect(at(19)).toEqual([]);
    expect(at(21)).toEqual([
      {
        kind: "gate_overrun",
        id: e.id,
        slot: "browser",
        who: "den · north · agent:coder",
        label: "e2e suite",
        since: new Date(T0).toISOString(),
        estimateMin: 10,
        estimateFrom: "given",
        overMin: 11,
        agent: "coder",
      },
    ]);
    t.store.release(e.id);
    expect(at(21)).toEqual([]);
  });

  it("a person's slot: the same line, no agent", () => {
    const t = setup();
    personRun(t.store);
    const [w] = gateOverrunWaiting(
      t.store.list(),
      t.store.settings(),
      T0 + 25 * MIN,
    );
    expect(w).toMatchObject({ slot: "cpu", label: "unit" });
    expect(w).not.toHaveProperty("agent");
  });
});

describe("the bell's row (issue 993)", () => {
  const g = globalThis as unknown as { window?: unknown };
  const had = g.window;
  beforeAll(() => {
    g.window = {
      denShell: {
        t: (k: string, v?: Record<string, unknown>) =>
          `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`,
      },
    };
  });
  afterAll(() => {
    g.window = had;
  });

  it("leads Needs you with who, what, since, the estimate and End", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const w = {
      kind: "gate_overrun",
      id: "g-1",
      slot: "browser",
      who: "den · north · agent:coder",
      label: "e2e suite",
      since: new Date(T0).toISOString(),
      estimateMin: 10,
      overMin: 11,
      agent: "coder",
    };
    const p = bellPanel({ groups: [], waiting: [w], unread: 0 });
    // The panel is one of two shapes (items, or sections): it has sections.
    if (!("sections" in p)) throw new Error("the bell has no sections");
    const needs = p.sections.needs as string;
    expect(needs).toContain('data-kind="gate_overrun"');
    expect(needs).toContain(
      "[bell.go.row:den · north · agent:coder|browser|e2e suite]",
    );
    expect(needs).toContain("[bell.go.sub:");
    expect(needs).toContain('data-bell="gate-end" data-slot="g-1"');
    expect(needs).toContain("[bell.go.end]");
  });

  it("End posts to the person-only end route", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/ui/server/public/bell.js"),
      "utf-8",
    );
    expect(src).toMatch(/"\/api\/gate-slots\/end"/);
  });
});

describe("the holder agent is told once (issue 993)", () => {
  function notices(t: ReturnType<typeof setup>) {
    const relayed: Delivery[] = [];
    const n = new GateNotices({
      store: () => t.store,
      install: INSTALL,
      projectOf: (a) => (a === "coder" ? "north" : null),
      relay: (dv) => {
        relayed.push(dv);
        return Promise.resolve(true);
      },
      bell: () => {},
      now: t.at,
    });
    n.start();
    return { n, relayed };
  }

  it("one prompt line past 2×, none before, and not again", async () => {
    const t = setup();
    const e = agentRun(t.store);
    const { n, relayed } = notices(t);
    t.advance(19 * MIN);
    await n.tick();
    expect(relayed).toEqual([]);
    t.advance(2 * MIN);
    await n.tick();
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ agent: "coder", project: "north" });
    expect(relayed[0]!.text).toBe(
      `Den: your browser gate slot ${e.id} ("e2e suite") is 11 min past the 10 min you gave. Release it with gate_slot_release, or let its command finish.`,
    );
    t.advance(10 * MIN);
    await n.tick();
    expect(relayed).toHaveLength(1);
  });

  it("a person's slot, or another install's agent: no line", async () => {
    const t = setup();
    personRun(t.store);
    agentRun(t.store, "agent:stranger");
    const { n, relayed } = notices(t);
    t.advance(30 * MIN);
    await n.tick();
    expect(relayed).toEqual([]);
  });
});

describe("GET /api/notifications lists it in `waiting` (issue 993)", () => {
  it("after the held writes; gone once the slot ends", async () => {
    const http = await import("http");
    const { NotificationStore } =
      await import("../../../src/shared/notifications.js");
    const { handleNotificationRoutes } =
      await import("../../../src/ui/server/notification-routes.js");
    const t = setup();
    const e = agentRun(t.store);
    t.advance(25 * MIN);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-993n-"));
    tmps.push(stateDir);
    const attention = {
      waitingNow: () => new Map(),
      waitingDetail: () => null,
    } as unknown as Parameters<typeof handleNotificationRoutes>[3]["attention"];
    const server = http.createServer((req, res) => {
      void handleNotificationRoutes(req, res, "/api/notifications", {
        store: new NotificationStore(stateDir),
        attention,
        gateOverruns: () =>
          gateOverrunWaiting(t.store.list(), t.store.settings(), t.at()),
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const get = async () =>
      (
        (await (
          await fetch(`http://127.0.0.1:${port}/api/notifications`)
        ).json()) as { waiting: { kind: string; id: string }[] }
      ).waiting;
    try {
      expect((await get()).map((w) => [w.kind, w.id])).toEqual([
        ["gate_overrun", e.id],
      ]);
      t.store.release(e.id);
      expect(await get()).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
