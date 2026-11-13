/**
 * 0.4.40 comment delivery, the loop, against a fake Hub and fake agents:
 * who gets what, and when; the acks Hub sees (delivered, queued, refused,
 * working with heartbeats, done, failed); de-dup across a restart; the
 * stream from Last-Event-ID, and the list when Hub has no stream.
 * Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeenDeliveries } from "../../../src/shared/hub-delivery";
import {
  DeliveryLoop,
  type AgentState,
  type DeliveryHub,
} from "../../../src/shared/hub-delivery-loop";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dloop-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const dv = (
  id: string,
  agent = "ag-1",
  over: Record<string, unknown> = {},
) => ({
  id,
  agent,
  project: "web",
  thread: {
    kind: "comment",
    id: `th_${id}`,
    url: `https://hub.example.test/a/doc#th_${id}`,
    artifact: "Pricing page",
  },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: `comment ${id}`,
  created_at: "2026-11-12T18:00:00Z",
  ...over,
});

function setup(o: { states?: Record<string, AgentState> } = {}) {
  const acks: { id: string; state: string; reason?: unknown }[] = [];
  const typed: { agent: string; text: string }[] = [];
  const finished: { agent: string; count: number; artifact?: string }[] = [];
  const states: Record<string, AgentState> = { "ag-1": "idle", ...o.states };
  let clock = 1_000_000;
  const hub: DeliveryHub = {
    stream: () => {
      throw Object.assign(new Error("no stream"), { kind: "refused" });
    },
    list: async () => [],
    ack: async (id, body) => {
      acks.push({ id, state: String(body.state), reason: body.reason });
    },
  };
  const seenFile = path.join(dir, "seen.json");
  const loop = new DeliveryLoop({
    hub,
    agents: {
      state: async (a) => states[a] ?? "missing",
      type: async (agent, text) => {
        typed.push({ agent, text });
        return true;
      },
    },
    owner: () => ({ ownerId: "u_me", company: "Acme" }),
    seen: new SeenDeliveries(seenFile),
    heartbeatMs: 15_000,
    now: () => clock,
    finished: (agent, w) =>
      finished.push({ agent, count: w.count, artifact: w.artifact }),
  });
  return {
    loop,
    hub,
    acks,
    typed,
    finished,
    states,
    seenFile,
    tick: (ms: number) => (clock += ms),
    of: (id: string) => acks.filter((a) => a.id === id).map((a) => a.state),
  };
}

describe("who gets a delivery, and when", () => {
  it("an agent waiting for its person: typed in, then delivered and working", async () => {
    const s = setup();
    await s.loop.take(dv("d1"));
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0].agent).toBe("ag-1");
    expect(s.typed[0].text.split("\n")[0]).toMatch(
      /^from: Pat Example \(your person · verified by Hub session\)/,
    );
    expect(s.of("d1")).toEqual(["delivered", "working"]);
    expect(s.loop.work("ag-1")).toEqual({
      working: 1,
      queued: 0,
      artifact: "Pricing page",
      url: "https://hub.example.test/a/doc#th_d1",
    });
  });

  it("no such agent here: refused, nothing typed", async () => {
    const s = setup();
    await s.loop.take(dv("d1", "ag-unknown"));
    expect(s.typed).toEqual([]);
    expect(s.of("d1")).toEqual(["refused"]);
  });

  it("a stopped agent: queued, on its card; typed in once it runs and waits", async () => {
    const s = setup({ states: { "ag-1": "stopped" } });
    await s.loop.take(dv("d1"));
    expect(s.of("d1")).toEqual(["queued"]);
    expect(s.loop.work("ag-1")).toMatchObject({ working: 0, queued: 1 });
    await s.loop.pump();
    expect(s.of("d1")).toEqual(["queued"]);
    s.states["ag-1"] = "busy";
    await s.loop.pump();
    expect(s.typed).toEqual([]);
    s.states["ag-1"] = "idle";
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
    expect(s.of("d1")).toEqual(["queued", "delivered", "working"]);
  });

  it("mid-turn: kept until the turn ends; two waiting go in together", async () => {
    const s = setup({ states: { "ag-1": "busy" } });
    await s.loop.take(dv("d1"));
    await s.loop.take(dv("d2"));
    expect(s.typed).toEqual([]);
    expect(s.acks).toEqual([]);
    s.states["ag-1"] = "idle";
    await s.loop.pump();
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0].text).toContain("2 Hub comments:");
    expect(s.typed[0].text).toContain("comment d1");
    expect(s.typed[0].text).toContain("comment d2");
    expect(s.loop.work("ag-1")?.working).toBe(2);
  });

  it("a session Den couldn't type into: kept, tried again", async () => {
    const s = setup();
    let ok = false;
    (s.loop as unknown as { d: { agents: { type: unknown } } }).d.agents.type =
      async () => ok;
    await s.loop.take(dv("d1"));
    expect(s.acks).toEqual([]);
    ok = true;
    await s.loop.pump();
    expect(s.of("d1")).toEqual(["delivered", "working"]);
  });
});

describe("progress (§4b)", () => {
  it("heartbeats every 15 s while the turn runs, then done; none after", async () => {
    const s = setup();
    await s.loop.take(dv("d1"));
    s.states["ag-1"] = "busy";
    s.tick(5_000);
    await s.loop.pump();
    expect(s.of("d1")).toEqual(["delivered", "working"]);
    s.tick(10_000);
    await s.loop.pump();
    s.tick(15_000);
    await s.loop.pump();
    expect(s.of("d1")).toEqual(["delivered", "working", "working", "working"]);
    s.states["ag-1"] = "idle";
    await s.loop.pump();
    expect(s.of("d1").at(-1)).toBe("done");
    expect(s.loop.work("ag-1")).toBeNull();
    // NT: the bell hears it once, with the count and the artifact.
    expect(s.finished).toEqual([
      { agent: "ag-1", count: 1, artifact: "Pricing page" },
    ]);
    // The turn ended: no more heartbeats.
    const n = s.acks.length;
    s.tick(60_000);
    await s.loop.pump();
    s.states["ag-1"] = "busy";
    s.tick(60_000);
    await s.loop.pump();
    expect(s.acks.length).toBe(n);
  });

  it("the agent stops mid-turn: failed, with a plain reason", async () => {
    const s = setup();
    await s.loop.take(dv("d1"));
    s.states["ag-1"] = "busy";
    await s.loop.pump();
    s.states["ag-1"] = "stopped";
    await s.loop.pump();
    const last = s.acks.at(-1)!;
    expect(last.state).toBe("failed");
    expect(String(last.reason)).toContain("stopped");
    expect(s.loop.work("ag-1")).toBeNull();
    // Failed isn't finished: the bell hears nothing.
    expect(s.finished).toEqual([]);
  });

  it("idle before the turn shows as started: waits, then done after 2 min", async () => {
    const s = setup();
    await s.loop.take(dv("d1"));
    await s.loop.pump();
    expect(s.of("d1")).toEqual(["delivered", "working"]);
    s.tick(2 * 60_000);
    await s.loop.pump();
    expect(s.of("d1").at(-1)).toBe("done");
  });
});

describe("at least once, never twice to the agent", () => {
  it("a repeat is acked again, not typed again; a restart remembers it", async () => {
    const s = setup();
    await s.loop.take(dv("d1"));
    await s.loop.take(dv("d1"));
    expect(s.typed).toHaveLength(1);
    expect(s.of("d1").slice(-1)).toEqual(["working"]);
    // A new loop over the same file (Den restarted): not typed again.
    const typed: string[] = [];
    const again = new DeliveryLoop({
      hub: s.hub,
      agents: {
        state: async () => "idle",
        type: async (_a, t) => (typed.push(t), true),
      },
      owner: () => ({}),
      seen: new SeenDeliveries(s.seenFile),
    });
    await again.take(dv("d1"));
    expect(typed).toEqual([]);
  });

  it("an ack Hub doesn't take is logged, never thrown", async () => {
    const s = setup();
    const lines: string[] = [];
    const d = (s.loop as unknown as { d: Record<string, unknown> }).d;
    d.log = (l: string) => lines.push(l);
    s.hub.ack = async () => {
      throw new Error("Hub could not be reached");
    };
    await expect(s.loop.take(dv("d1"))).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("ack delivered failed");
  });
});

describe("reading Hub", () => {
  it("the stream: deliveries in order, from Last-Event-ID; keep-alives skipped", async () => {
    const s = setup();
    const ctl = new AbortController();
    const asked: (string | null)[] = [];
    s.hub.stream = (last) => {
      asked.push(last);
      return (async function* () {
        yield ": keep-alive\n\n";
        yield `id: d1\nevent: delivery\ndata: ${JSON.stringify(dv("d1"))}\n\n`;
        yield `id: d2\nevent: delivery\ndata: ${JSON.stringify(dv("d2", "ag-2"))}\n\n`;
        ctl.abort();
      })();
    };
    await s.loop.run(ctl.signal);
    expect(asked).toEqual([null]);
    expect(s.of("d1")).toEqual(["delivered", "working"]);
    expect(s.of("d2")).toEqual(["refused"]);
    expect(new SeenDeliveries(s.seenFile).last).toBe("d2");
  });

  it("a dropped stream reconnects from the last id, waiting longer each time", async () => {
    const s = setup();
    const ctl = new AbortController();
    const asked: (string | null)[] = [];
    const waits: number[] = [];
    let n = 0;
    s.hub.stream = (last) => {
      asked.push(last);
      n++;
      return (async function* () {
        if (n === 1)
          yield `id: d1\nevent: delivery\ndata: ${JSON.stringify(dv("d1"))}\n\n`;
        throw new Error("connection reset");
      })();
    };
    const d = (s.loop as unknown as { d: Record<string, unknown> }).d;
    d.retryMs = { first: 1000, max: 4000 };
    d.sleep = async (ms: number) => {
      waits.push(ms);
      if (waits.length >= 4) ctl.abort();
    };
    await s.loop.run(ctl.signal);
    expect(asked[0]).toBeNull();
    expect(asked.slice(1)).toEqual(["d1", "d1", "d1"]);
    expect(waits).toEqual([1000, 2000, 4000, 4000]);
  });

  it("Hub has no stream (404): the list after the last id, every poll", async () => {
    const s = setup();
    const ctl = new AbortController();
    const after: (string | null)[] = [];
    const pages = [[dv("d1"), dv("d2")], []];
    s.hub.list = async (a) => {
      after.push(a);
      return pages.shift() ?? [];
    };
    const d = (s.loop as unknown as { d: Record<string, unknown> }).d;
    d.pollMs = 30_000;
    const waits: number[] = [];
    d.sleep = async (ms: number) => {
      waits.push(ms);
      if (waits.length >= 2) ctl.abort();
    };
    await s.loop.run(ctl.signal);
    expect(after).toEqual([null, "d2"]);
    expect(waits).toEqual([30_000, 30_000]);
    expect(s.typed).toHaveLength(1);
  });
});

describe("the 0.4.40 gate's delivery bugs", () => {
  it("bug 1: the tick while a paste is under way doesn't type it again", async () => {
    const typed: string[] = [];
    const waiting: (() => void)[] = [];
    const release = () => waiting.splice(0).forEach((r) => r());
    const seen = new SeenDeliveries(path.join(dir, "seen.json"));
    const loop = new DeliveryLoop({
      hub: {
        stream: () => {
          throw new Error("none");
        },
        list: async () => [],
        ack: async () => {},
      },
      agents: {
        state: async () => "idle",
        // A paste that takes a while, as a real one does (about 1.7 s).
        type: (_a, text) =>
          new Promise((r) => {
            typed.push(text);
            waiting.push(() => r(true));
          }),
      },
      owner: () => ({ ownerId: "u_me" }),
      seen,
    });
    const nap = () => new Promise((r) => setTimeout(r, 5));
    const taking = loop.take(dv("d1"));
    await nap();
    // Two ticks during the paste (not awaited: a second paste would wait too).
    const ticks = [loop.pump(), loop.pump()];
    await nap();
    expect(typed).toHaveLength(1);
    release();
    await Promise.all([taking, ...ticks]);
    await loop.pump();
    expect(typed).toHaveLength(1);
  });

  it("bug 1: a paste that fails puts the comments back, ahead of newer ones", async () => {
    const t = setup();
    let fail = true;
    const typed: string[] = [];
    const loop = new DeliveryLoop({
      hub: t.hub,
      agents: {
        state: async () => "idle",
        type: async (_a, text) => {
          typed.push(text);
          return !fail;
        },
      },
      owner: () => ({ ownerId: "u_me" }),
      seen: new SeenDeliveries(path.join(dir, "seen2.json")),
    });
    await loop.take(dv("d1"));
    fail = false;
    await loop.pump();
    expect(typed).toHaveLength(2);
    expect(typed[1]).toContain("comment d1");
    expect(loop.work("ag-1")).toMatchObject({ working: 1, queued: 0 });
  });

  it("bug 2: a comment in flight across a Den restart is settled after it", async () => {
    const t = setup();
    await t.loop.take(dv("d1"));
    expect(t.of("d1")).toEqual(["delivered", "working"]);
    // Den restarts mid-turn: a new loop on the same file.
    const acks: { id: string; state: string }[] = [];
    let state: AgentState = "busy";
    const loop2 = new DeliveryLoop({
      hub: {
        ...t.hub,
        ack: async (id, body) =>
          void acks.push({ id, state: String(body.state) }),
      },
      agents: { state: async () => state, type: async () => true },
      owner: () => ({ ownerId: "u_me" }),
      seen: new SeenDeliveries(t.seenFile),
    });
    expect(loop2.work("ag-1")).toMatchObject({ working: 1 });
    await loop2.pump();
    state = "idle";
    await loop2.pump();
    expect(acks.map((a) => a.state)).toEqual(["done"]);
    // Nothing held now: a third start has nothing to settle.
    const loop3 = new DeliveryLoop({
      hub: t.hub,
      agents: { state: async () => "idle", type: async () => true },
      owner: () => ({ ownerId: "u_me" }),
      seen: new SeenDeliveries(t.seenFile),
    });
    expect(loop3.work("ag-1")).toBeNull();
  });

  it("bug 2: a comment queued for a stopped agent survives a Den restart", async () => {
    const t = setup({ states: { "ag-1": "stopped" } });
    await t.loop.take(dv("d1"));
    expect(t.of("d1")).toEqual(["queued"]);
    const typed: string[] = [];
    const loop2 = new DeliveryLoop({
      hub: t.hub,
      agents: {
        state: async () => "idle",
        type: async (_a, text) => (typed.push(text), true),
      },
      owner: () => ({ ownerId: "u_me" }),
      seen: new SeenDeliveries(t.seenFile),
    });
    await loop2.pump();
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain("comment d1");
    expect(typed[0]).toContain("your person");
  });
});
