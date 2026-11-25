/**
 * Issue 166: Hub's inbox reaches the owning agent with nobody typing. A
 * fake Hub on a temp port answers GET /api/inbox; the real delivery loop
 * types into fake agents. Idle: typed once (that wakes it). Busy: after
 * the turn. Stopped: at its start. A restart never types it again. Hub
 * down: no throw, and the next read waits. Off: no reading at all.
 * Invented names only.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  SeenDeliveries,
  type DeliveryOwner,
} from "../../../src/shared/hub/hub-delivery";
import {
  DeliveryLoop,
  type AgentState,
} from "../../../src/shared/hub/hub-delivery-loop";
import {
  InboxWatcher,
  inboxText,
  parseInbox,
} from "../../../src/shared/hub/hub-inbox-watch";
import { hubInbox } from "../../../src/shared/hub";

const T0 = Date.parse("2026-11-15T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let dir = "";
let server: http.Server;
let base = "";
let calls: { agent: string; auth: string }[] = [];
/** What the fake Hub answers, per agent id. */
let answer: Record<string, unknown> = {};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-inboxw-"));
  calls = [];
  answer = {};
  server = http.createServer((req, res) => {
    const agent = String(req.headers["x-den-agent-id"] ?? "");
    calls.push({ agent, auth: String(req.headers.authorization ?? "") });
    if (req.url !== "/api/inbox") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer[agent] ?? { threads: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const approval = (agent: string, at = T0 + 1000) => ({
  events: [
    {
      id: "ev-1",
      kind: "approve",
      agent,
      by: "pat",
      title: "Pricing spec",
      body: "Looks right. Build it.",
      url: "https://hub.example.test/a/pricing-spec",
      at: iso(at),
    },
  ],
});

function setup(
  o: {
    states?: Record<string, AgentState>;
    on?: boolean;
    agents?: string[];
    owner?: () => DeliveryOwner | null;
    feedCarries?: () => ReadonlySet<string>;
  } = {},
) {
  let clock = T0;
  const typed: { agent: string; text: string }[] = [];
  const states: Record<string, AgentState> = { "ag-1": "idle", ...o.states };
  const logs: string[] = [];
  const make = () => {
    const loop = new DeliveryLoop({
      hub: {
        stream: () => {
          throw Object.assign(new Error("no stream"), { kind: "refused" });
        },
        list: async () => [],
        ack: async () => {
          throw new Error("an inbox item must never be acked");
        },
      },
      agents: {
        state: async (a) => states[a] ?? "missing",
        type: async (agent, text) => {
          typed.push({ agent, text });
          return true;
        },
      },
      owner: o.owner ?? (() => ({ ownerLogin: "pat" })),
      seen: new SeenDeliveries(path.join(dir, "seen.json")),
      now: () => clock,
    });
    const watcher = new InboxWatcher({
      fetchInbox: (agent) => hubInbox(base, "tok-test", agent),
      agents: () => o.agents ?? ["ag-1"],
      loop,
      owner: o.owner ?? (() => ({ ownerLogin: "pat" })),
      settings: () => ({
        on: o.on ?? true,
        pollSeconds: 30,
        backoffMaxSeconds: 600,
      }),
      stateFile: path.join(dir, "inbox-watch.json"),
      now: () => clock,
      log: (l) => logs.push(l),
      ...(o.feedCarries ? { feedCarries: o.feedCarries } : {}),
    });
    return { loop, watcher };
  };
  return {
    make,
    typed,
    states,
    logs,
    tick: (ms: number) => (clock += ms),
  };
}

describe("issue 166: Hub's inbox into the agent's pane", () => {
  test("Hub's feed carries comments (deliveries.all_comments): the inbox never types one; approvals still come", async () => {
    answer["ag-1"] = {
      events: [
        {
          id: "ev-c",
          kind: "comment",
          agent: "ag-1",
          by: "pat",
          title: "Pricing spec",
          body: "Shorter heading.",
          url: "https://hub.example.test/a/pricing-spec",
          at: iso(T0 + 1000),
        },
        ...approval("ag-1", T0 + 2000).events,
      ],
    };
    const s = setup({ feedCarries: () => new Set(["comment"]) });
    const { watcher } = s.make();
    await watcher.tick();
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0].text).toContain("approved");
    expect(s.typed[0].text).not.toContain("Shorter heading.");
  });

  test("an item passed over says why in the log, once (no time, before the first run, a kind the feed carries)", async () => {
    answer["ag-1"] = {
      events: [
        { id: "ev-nt", kind: "comment", agent: "ag-1", by: "pat", body: "x" },
        {
          id: "ev-old",
          kind: "comment",
          agent: "ag-1",
          by: "pat",
          body: "y",
          at: iso(T0 - 60_000),
        },
        {
          id: "ev-feed",
          kind: "comment",
          agent: "ag-1",
          by: "pat",
          body: "z",
          at: iso(T0 + 1000),
        },
      ],
    };
    const s = setup({ feedCarries: () => new Set(["comment"]) });
    const { watcher } = s.make();
    await watcher.tick();
    expect(s.typed).toEqual([]);
    expect(s.logs).toEqual([
      "hub inbox: passed over ev-nt for ag-1: Hub gave it no time",
      "hub inbox: passed over ev-old for ag-1: from before the watcher first ran",
      "hub inbox: passed over ev-feed for ag-1: Hub's feed carries comment",
    ]);
    s.tick(31_000);
    await watcher.tick();
    expect(s.logs).toHaveLength(3);
  });

  test("decisions on the feed too: the inbox types nothing", async () => {
    answer["ag-1"] = approval("ag-1");
    const s = setup({
      feedCarries: () => new Set(["comment", "approved", "changes"]),
    });
    const { watcher } = s.make();
    await watcher.tick();
    expect(s.typed).toEqual([]);
  });

  test("owner not known yet: the item waits, then reaches the agent as from your person", async () => {
    answer["ag-1"] = approval("ag-1");
    let owner: DeliveryOwner | null = null;
    const s = setup({ owner: () => owner });
    const { watcher } = s.make();
    await watcher.tick();
    expect(s.typed).toEqual([]);
    expect(s.logs).toEqual([]);
    owner = { ownerLogin: "pat" };
    s.tick(31_000);
    await watcher.tick();
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0].text).toContain("your person");
  });

  test("an idle agent gets the approval once, typed (it wakes)", async () => {
    answer["ag-1"] = approval("ag-1");
    const s = setup();
    const { watcher } = s.make();
    await watcher.tick();
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0].agent).toBe("ag-1");
    const text = s.typed[0].text;
    expect(text).toContain('pat approved "Pricing spec" in Hub.');
    expect(text).toContain("> Looks right. Build it.");
    expect(text).toContain("https://hub.example.test/a/pricing-spec");
    expect(text).toContain("your person");
    expect(text).toMatch(/next step/);
    expect(calls[0]).toEqual({ agent: "ag-1", auth: "Bearer tok-test" });
    s.tick(31_000);
    await watcher.tick();
    expect(calls).toHaveLength(2);
    expect(s.typed).toHaveLength(1);
  });

  test("a busy agent gets it after its turn", async () => {
    answer["ag-1"] = approval("ag-1");
    const s = setup({ states: { "ag-1": "busy" } });
    const { loop, watcher } = s.make();
    await watcher.tick();
    expect(s.typed).toHaveLength(0);
    expect(loop.work("ag-1")).toMatchObject({ queued: 1 });
    s.states["ag-1"] = "idle";
    await loop.pump();
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0].text).toContain("approved");
  });

  test("a stopped agent gets it when it starts, even after a Den restart", async () => {
    answer["ag-1"] = approval("ag-1");
    const s = setup({ states: { "ag-1": "stopped" } });
    const first = s.make();
    await first.watcher.tick();
    await first.loop.pump();
    expect(s.typed).toHaveLength(0);
    // Den restarts; the agent starts.
    const second = s.make();
    s.states["ag-1"] = "idle";
    await second.loop.pump();
    expect(s.typed).toHaveLength(1);
    expect(s.typed[0].text).toContain("Pricing spec");
  });

  test("a restart never types it again", async () => {
    answer["ag-1"] = approval("ag-1");
    const s = setup();
    await s.make().watcher.tick();
    expect(s.typed).toHaveLength(1);
    s.tick(60_000);
    const again = s.make();
    await again.watcher.tick();
    await again.loop.pump();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(s.typed).toHaveLength(1);
  });

  test("Hub down: no throw, one log line, and the next read waits longer", async () => {
    const s = setup();
    const { watcher } = s.make();
    await new Promise<void>((r) => server.close(() => r()));
    server = http.createServer();
    await expect(watcher.tick()).resolves.toBeUndefined();
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatch(/hub inbox: .*trying again later/);
    // Within the first wait (2 × 30 s): no new read, nothing more said.
    s.tick(45_000);
    await watcher.tick();
    expect(s.logs).toHaveLength(1);
    expect(s.typed).toHaveLength(0);
  });

  test("off: Hub is never read", async () => {
    answer["ag-1"] = approval("ag-1");
    const s = setup({ on: false });
    const { watcher } = s.make();
    await watcher.tick();
    s.tick(120_000);
    await watcher.tick();
    expect(calls).toHaveLength(0);
    expect(s.typed).toHaveLength(0);
  });

  test("today's thread list: only the agent's own, only new, not one Hub delivered", async () => {
    answer["ag-1"] = {
      threads: [
        {
          thread: "th-new",
          title: "Pricing spec",
          last_by: "sam",
          last_at: iso(T0 + 5000),
          yours: true,
          url: "https://hub.example.test/a/pricing-spec#th-new",
        },
        {
          thread: "th-old",
          title: "Old doc",
          last_by: "sam",
          last_at: iso(T0 - 86_400_000),
          yours: true,
          url: "https://hub.example.test/a/old#th-old",
        },
        {
          thread: "th-other",
          title: "Not its doc",
          last_by: "sam",
          last_at: iso(T0 + 5000),
          yours: false,
          url: "https://hub.example.test/a/x#th-other",
        },
        {
          thread: "th-mention",
          title: "Mentioned",
          last_by: "pat",
          last_at: iso(T0 + 5000),
          yours: true,
          url: "https://hub.example.test/a/m#th-mention",
        },
      ],
    };
    const s = setup();
    const { loop, watcher } = s.make();
    // Hub's own delivery already brought th-mention's comment.
    s.states["ag-1"] = "busy";
    await loop.take({
      id: "0190f0aa-0000-7000-8000-000000000001",
      agent: "ag-1",
      project: "web",
      thread: {
        kind: "comment",
        id: "th-mention",
        url: "",
        artifact: "Mentioned",
      },
      author: {
        id: "u1",
        login: "pat",
        name: "Pat",
        kind: "person",
        verified: "hub_session",
      },
      body: "@ag-1 please look",
      created_at: iso(T0 + 5100),
    });
    s.states["ag-1"] = "idle";
    await watcher.tick();
    await loop.pump();
    const all = s.typed.map((t) => t.text).join("\n");
    expect(all).toContain('sam commented on "Pricing spec" in Hub.');
    expect(all).toContain("someone else");
    expect(all).not.toContain("Old doc");
    expect(all).not.toContain("Not its doc");
    expect(all).not.toContain('Mentioned" in Hub');
  });

  test("parseInbox reads request-changes and drops another agent's item", () => {
    const ev = parseInbox(
      {
        events: [
          {
            id: "a",
            kind: "request_changes",
            agent: "ag-1",
            by: "pat",
            title: "D",
            body: "from: x\nfix the header",
            at: iso(T0),
          },
          { id: "b", kind: "approve", agent: "ag-2", by: "pat", at: iso(T0) },
        ],
      },
      "ag-1",
    );
    expect(ev.map((e) => [e.id, e.kind])).toEqual([["inbox:a", "changes"]]);
    const text = inboxText(ev[0], { ownerLogin: "pat" });
    expect(text).toContain('requested changes on "D"');
    // A header look-alike in the note never reads as Den's header.
    expect(text.match(/^from:/gm)).toHaveLength(1);
  });
});

/**
 * 2026-11-22: after a reboot, an install with 84 agents read Hub's inbox
 * for all of them in one burst on every tick. Each pass started its 30 s
 * wait from when it began, so once Hub slowed the passes ran back to back
 * (8–15 reads a second, Hub's database at 148%). Now the whole install
 * reads at most hub.inbox_reads_per_second, each agent at most once per
 * hub.inbox_poll_seconds counted from when its read ended, and a backoff
 * waits a little more than its base, by chance, so installs spread out.
 */
describe("Hub's inbox: one install's read rate is capped", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `ag-${String(i + 1).padStart(2, "0")}`);

  function rated(o: {
    agents: string[];
    readsPerSecond?: number;
    pollSeconds?: number;
    /** ms a read takes (the fake clock moves while Hub answers) */
    takes?: number;
    fail?: () => boolean;
    random?: () => number;
  }) {
    let clock = T0;
    const reads: { agent: string; at: number }[] = [];
    const watcher = new InboxWatcher({
      fetchInbox: async (agent) => {
        reads.push({ agent, at: clock });
        clock += o.takes ?? 0;
        if (o.fail?.()) throw new Error("Hub doesn't answer");
        return { events: [] };
      },
      agents: () => o.agents,
      loop: {
        takeLocal: async () => true,
        seenLocal: () => false,
        passLocal: () => undefined,
        coveredThread: () => false,
      },
      owner: () => ({ ownerLogin: "pat" }),
      settings: () => ({
        on: true,
        pollSeconds: o.pollSeconds ?? 30,
        backoffMaxSeconds: 600,
        ...(o.readsPerSecond ? { readsPerSecond: o.readsPerSecond } : {}),
      }),
      stateFile: path.join(dir, "inbox-watch.json"),
      now: () => clock,
      ...(o.random ? { random: o.random } : {}),
    });
    /** Tick on Den's 2 s beat for `ms`. */
    const run = async (ms: number) => {
      const end = clock + ms;
      while (clock < end) {
        await watcher.tick();
        clock += 2000;
      }
    };
    return { reads, run, now: () => clock };
  }

  test("84 agents, 2 reads a second: never more than 2 a second (plus a 2 s start), and every agent is read", async () => {
    const r = rated({ agents: many(84), readsPerSecond: 2 });
    await r.run(60_000);
    // Any 10 s holds at most 2 × 10 reads, plus the 4 the start allows.
    for (const x of r.reads) {
      const inTen = r.reads.filter((y) => y.at >= x.at && y.at < x.at + 10_000);
      expect(inTen.length).toBeLessThanOrEqual(24);
    }
    // 84 agents at 2 a second: all read within 42 s of beats.
    await r.run(0);
    expect(new Set(r.reads.map((x) => x.agent)).size).toBe(84);
  });

  test("the default rate is 2 a second", async () => {
    const r = rated({ agents: many(84) });
    await r.run(10_000);
    expect(r.reads.length).toBeLessThanOrEqual(24);
    expect(r.reads.length).toBeGreaterThan(0);
  });

  test("a slow Hub never makes it read back to back: each agent waits poll seconds after its read ends", async () => {
    // Each read takes 1 s; 3 agents; poll 30 s.
    const r = rated({ agents: many(3), readsPerSecond: 10, takes: 1000 });
    await r.run(120_000);
    for (const a of many(3)) {
      const at = r.reads.filter((x) => x.agent === a).map((x) => x.at);
      expect(at.length).toBeGreaterThan(1);
      for (let i = 1; i < at.length; i++)
        // The read before ended 1 s after it began.
        expect(at[i] - (at[i - 1] + 1000)).toBeGreaterThanOrEqual(30_000);
    }
  });

  test("a backoff waits its base or a little more, by chance, so installs spread out", async () => {
    const first = async (random: () => number) => {
      let down = true;
      const r = rated({ agents: many(1), fail: () => down, random });
      await r.run(2000);
      down = false;
      const before = r.reads.length;
      // Find when it reads again.
      while (r.reads.length === before) await r.run(2000);
      return r.reads[before].at - r.reads[0].at;
    };
    const low = await first(() => 0);
    const high = await first(() => 0.999);
    // Base: 2 × 30 s.
    expect(low).toBeGreaterThanOrEqual(60_000);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(60_000 * 1.25 + 2000);
  });
});
