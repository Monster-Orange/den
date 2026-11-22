/**
 * Issue 459: one app event feed, read against a fake app: resume after a
 * cut (Last-Event-ID, then the list form fills the gap), a reset, a
 * duplicate id, the cursor across a restart, back-off, a missing secret,
 * the size and rate limits (never a silent drop), and a mid-turn hold
 * through the real delivery loop. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AppFeedReader,
  type AppFeedReaderDeps,
  type FeedCursor,
} from "../../../src/shared/app-feed-reader";
import { feedDelivery } from "../../../src/shared/agents/app-feeds";
import { SeenDeliveries } from "../../../src/shared/hub-delivery";
import {
  DeliveryLoop,
  type AgentState,
} from "../../../src/shared/hub-delivery-loop";

const sse = (id: string | null, data: string, event?: string) =>
  `${event ? `event: ${event}\n` : ""}${id !== null ? `id: ${id}\n` : ""}data: ${data}\n\n`;

/** One connection: chunks it sends then ends, or an error it throws. */
type Conn = { chunks: string[] } | { error: Error };

function setup(
  conns: Conn[],
  o: {
    list?: (after: string | null) => unknown;
    cursor?: FeedCursor | null;
    limits?: { eventMaxKb: number; perMinute: number };
    deliver?: AppFeedReaderDeps["deliver"];
  } = {},
) {
  const ctl = new AbortController();
  const opened: (string | null)[] = [];
  const listed: (string | null)[] = [];
  const waits: number[] = [];
  const delivered: { key: string; text: string }[] = [];
  const notices: { code: string; detail: string }[] = [];
  const logs: string[] = [];
  let saved: FeedCursor | null = o.cursor ?? null;
  let clock = 1_000_000;
  const left = [...conns];
  const deps: AppFeedReaderDeps = {
    feed: { project: "north", name: "chat", agent: "north-helper" },
    open: (lastId) =>
      (async function* () {
        opened.push(lastId);
        const c = left.shift();
        if (!c) {
          ctl.abort();
          return;
        }
        if ("error" in c) throw c.error;
        for (const ch of c.chunks) yield ch;
      })(),
    list: async (after) => {
      listed.push(after);
      return o.list ? o.list(after) : [];
    },
    deliver:
      o.deliver ??
      (async (key, text) => {
        delivered.push({ key, text });
        return "held";
      }),
    load: () => saved,
    save: (c) => (saved = c),
    limits: () => o.limits ?? { eventMaxKb: 32, perMinute: 600 },
    notice: (code, detail) => notices.push({ code, detail }),
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
    },
    retryMs: { first: 1000, max: 8000 },
    log: (l) => logs.push(l),
  };
  const reader = new AppFeedReader(deps);
  return {
    reader,
    deps,
    ctl,
    opened,
    listed,
    waits,
    delivered,
    notices,
    logs,
    saved: () => saved,
    tick: (ms: number) => (clock += ms),
    run: () => reader.run(ctl.signal),
  };
}

describe("app feed: the stream", () => {
  it("each event is handed on with Den's text, and the cursor is saved", async () => {
    const s = setup([{ chunks: [sse("e1", '{"text":"hi"}'), sse("e2", "x")] }]);
    await s.run();
    expect(s.delivered.map((d) => d.key)).toEqual(["e1", "e2"]);
    expect(s.delivered[0].text).toMatch(
      /^Den: an event from the app feed "chat"/,
    );
    expect(s.saved()?.cursor).toBe("e2");
    expect(s.reader.status().state).toBe("stopped");
  });

  it("resumes after a cut: Last-Event-ID, and the list form fills the gap", async () => {
    const s = setup(
      [
        { chunks: [sse("e1", "one")] },
        { error: new Error("socket hang up") },
        { chunks: [sse("e3", "three")] },
      ],
      { list: (after) => (after === "e1" ? [{ id: "e2", data: "two" }] : []) },
    );
    await s.run();
    // After the cut the list form is read from the last id, then the
    // stream opens from the last id it filled.
    expect(s.listed.slice(0, 2)).toEqual(["e1", "e2"]);
    expect(s.opened.slice(0, 3)).toEqual([null, "e2", "e2"]);
    expect(s.delivered.map((d) => d.key)).toEqual(["e1", "e2", "e3"]);
  });

  it("backs off on errors, doubling up to the cap, and starts over after a good stream", async () => {
    const err = () => ({ error: new Error("refused") });
    const s = setup([err(), err(), err(), err(), err()]);
    await s.run();
    expect(s.waits.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(s.logs.join("\n")).toContain("refused; trying again");
  });

  it("a reset event: reopened at once (no wait), the list form read first", async () => {
    const s = setup(
      [
        {
          chunks: [
            sse("e1", "one"),
            sse(null, "{}", "reset"),
            sse("e9", "never"),
          ],
        },
        { chunks: [sse("e2", "two")] },
      ],
      { list: () => [] },
    );
    await s.run();
    expect(s.delivered.map((d) => d.key)).toEqual(["e1", "e2"]);
    // No back-off between the reset and the reopen.
    expect(s.opened.slice(0, 2)).toEqual([null, "e1"]);
    expect(s.waits[0]).toBe(1000); // only after the second stream ended
    expect(s.waits).toHaveLength(1);
    expect(s.listed).toEqual(["e1", "e2"]);
    expect(s.logs.join("\n")).toContain("reset its stream");
  });

  it("a duplicate id (the stream and the list both sent it) is handed on once", async () => {
    const s = setup(
      [{ chunks: [sse("e1", "one"), sse("e1", "one again")] }, { chunks: [] }],
      { list: () => [{ id: "e1", data: "one" }] },
    );
    await s.run();
    expect(s.delivered.map((d) => d.key)).toEqual(["e1"]);
  });

  it("the cursor survives a restart: the next reader opens from it", async () => {
    const a = setup([{ chunks: [sse("e7", "seven")] }]);
    await a.run();
    const b = setup([{ chunks: [] }], { cursor: a.saved() });
    await b.run();
    expect(b.opened[0]).toBe("e7");
    expect(b.listed[0]).toBe("e7");
    expect(b.reader.status().lastEventAt).toBe(a.saved()?.lastEventAt);
  });

  it("an event the loop saw before a restart is not typed again", async () => {
    const seen = new Set(["e1"]);
    const typed: string[] = [];
    const s = setup([{ chunks: [sse("e1", "one"), sse("e2", "two")] }], {
      deliver: async (key) => {
        if (seen.has(key)) return "seen";
        typed.push(key);
        return "held";
      },
    });
    await s.run();
    expect(typed).toEqual(["e2"]);
    expect(s.saved()?.cursor).toBe("e2");
  });
});

describe("app feed: a missing secret", () => {
  it("says so once (state no_secret, a notice), and keeps trying", async () => {
    const miss = () => ({
      error: Object.assign(new Error("secrets.refs.chat_token is not set"), {
        kind: "no_secret" as const,
      }),
    });
    let states: string[] = [];
    const s = setup([miss(), miss()]);
    s.deps.onStatus = (st) => states.push(st.state);
    await s.run();
    expect(states).toContain("no_secret");
    expect(s.notices.filter((n) => n.code === "no_secret")).toHaveLength(1);
    expect(s.opened.length).toBeGreaterThanOrEqual(2);
    states = [];
  });
});

describe("app feed: limits are never a silent drop", () => {
  it("an event over the size limit: the agent is told it came, without its data", async () => {
    const big = JSON.stringify({ text: "y".repeat(3000) });
    const s = setup([{ chunks: [sse("e1", big)] }], {
      limits: { eventMaxKb: 1, perMinute: 600 },
    });
    await s.run();
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0].text).toContain("over the event size limit (1 KB");
    expect(s.delivered[0].text).not.toContain("yyyy");
    expect(s.notices.map((n) => n.code)).toEqual(["too_big"]);
  });

  it("a line past the stream buffer: still told, never skipped without a word", async () => {
    const s = setup(
      [{ chunks: [`id: e1\ndata: ${"z".repeat(9000)}`, "\n\n"] }],
      {
        limits: { eventMaxKb: 1, perMinute: 600 },
      },
    );
    await s.run();
    expect(s.delivered.map((d) => d.text).join("\n")).toContain(
      "larger than the event size limit",
    );
    expect(s.notices.some((n) => n.code === "too_big")).toBe(true);
  });

  it("over the rate: the rest wait (said once) and go when the minute moves on", async () => {
    const s = setup(
      [{ chunks: [sse("e1", "a"), sse("e2", "b"), sse("e3", "c")] }],
      {
        limits: { eventMaxKb: 32, perMinute: 2 },
      },
    );
    await s.run();
    expect(s.delivered.map((d) => d.key)).toEqual(["e1", "e2"]);
    expect(s.reader.status().waiting).toBe(1);
    expect(s.notices.filter((n) => n.code === "over_rate")).toHaveLength(1);
    // The cursor stays before what waits: a restart reads it again.
    expect(s.saved()?.cursor).toBe("e2");
    s.tick(60_000);
    await s.reader.drain();
    expect(s.delivered.map((d) => d.key)).toEqual(["e1", "e2", "e3"]);
    expect(s.reader.status().waiting).toBe(0);
    expect(s.saved()?.cursor).toBe("e3");
  });

  it("Den not ready yet: the event waits, and goes on the next drain", async () => {
    let ready = false;
    const got: string[] = [];
    const s = setup([{ chunks: [sse("e1", "a")] }], {
      deliver: async (key) => {
        if (!ready) return "not_ready";
        got.push(key);
        return "held";
      },
    });
    await s.run();
    expect(got).toEqual([]);
    expect(s.reader.status().waiting).toBe(1);
    ready = true;
    await s.reader.drain();
    expect(got).toEqual(["e1"]);
  });
});

describe("app feed: through the delivery loop", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-feed-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("held while the agent is mid-turn, typed once it is idle, never twice", async () => {
    const states: Record<string, AgentState> = { "north-helper": "busy" };
    const typed: { agent: string; text: string }[] = [];
    const loop = new DeliveryLoop({
      hub: {
        stream: () => {
          throw new Error("no hub");
        },
        list: async () => [],
        ack: async () => undefined,
      },
      agents: {
        state: async (a) => states[a] ?? "missing",
        type: async (agent, text) => {
          typed.push({ agent, text });
          return true;
        },
      },
      owner: () => null,
      seen: new SeenDeliveries(path.join(dir, "seen.json")),
    });
    const feed = { project: "north", name: "chat", agent: "north-helper" };
    const s = setup(
      [{ chunks: [sse("e1", '{"text":"hello"}'), sse("e1", "again")] }],
      {
        deliver: async (key, text, at) => {
          const dv = feedDelivery(feed, key, text, at);
          if (loop.seenLocal(dv.id)) return "seen";
          return (await loop.takeLocal(dv)) ? "held" : "seen";
        },
      },
    );
    await s.run();
    expect(typed).toEqual([]);
    expect(loop.work("north-helper")?.queued).toBe(1);
    states["north-helper"] = "idle";
    await loop.pump();
    expect(typed).toHaveLength(1);
    expect(typed[0].text).toMatch(/^Den: an event from the app feed "chat"/);
    expect(typed[0].text).toContain("> {");
    await loop.pump();
    expect(typed).toHaveLength(1);
  });
});
