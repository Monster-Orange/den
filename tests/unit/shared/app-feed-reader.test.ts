/**
 * Issue 459: one app event feed, read against a fake app and a fake store:
 * resume after a cut (Last-Event-ID, then the list form fills the gap), a
 * reset, a duplicate id, the cursor across a restart, back-off, a missing
 * secret, the size limit (kept without its data), the cap on one event's
 * data: lines, the rate (the stream waits; nothing is dropped) and a
 * Last-Event-ID that isn't a legal header value. Invented names only.
 */
import {
  AppFeedReader,
  type AppFeedReaderDeps,
  type FeedCursor,
  type FeedStore,
  type StoredEvent,
} from "../../../src/shared/app-feed-reader";
import { SseReader } from "../../../src/shared/hub-delivery";

const sse = (id: string | null, data: string, event?: string) =>
  `${event ? `event: ${event}\n` : ""}${id !== null ? `id: ${id}\n` : ""}data: ${data}\n\n`;

/** One connection: chunks it sends then ends, or an error it throws. */
type Conn = { chunks: string[] } | { error: Error };

function memStore(): FeedStore & {
  events: (Omit<StoredEvent, "seq"> & { key: string })[];
} {
  const events: (Omit<StoredEvent, "seq"> & { key: string })[] = [];
  return {
    events,
    has: (key) => events.some((e) => e.key === key),
    add: (key, ev) => {
      events.push({ key, ...ev });
      return { dropped: 0 };
    },
  };
}

function setup(
  conns: Conn[],
  o: {
    list?: (after: string | null) => unknown;
    cursor?: FeedCursor | null;
    limits?: { eventMaxKb: number; perMinute: number };
    store?: FeedStore & { events: unknown[] };
  } = {},
) {
  const ctl = new AbortController();
  const opened: (string | null)[] = [];
  const listed: (string | null)[] = [];
  const waits: number[] = [];
  const notices: { code: string; detail: string }[] = [];
  const logs: string[] = [];
  let storedCalls = 0;
  let saved: FeedCursor | null = o.cursor ?? null;
  let clock = 1_000_000;
  const left = [...conns];
  const store = o.store ?? memStore();
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
    store,
    stored: () => void storedCalls++,
    load: () => saved,
    save: (c) => (saved = c),
    limits: () => o.limits ?? { eventMaxKb: 32, perMinute: 600 },
    notice: (code, detail) => notices.push({ code, detail }),
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    retryMs: { first: 1000, max: 8000 },
    log: (l) => logs.push(l),
  };
  const reader = new AppFeedReader(deps);
  const events = (
    store as unknown as {
      events: { key: string; data: string | null; bytes: number | null }[];
    }
  ).events;
  return {
    reader,
    deps,
    ctl,
    opened,
    listed,
    waits,
    notices,
    logs,
    events,
    keys: () => events.map((e) => e.key),
    storedCalls: () => storedCalls,
    saved: () => saved,
    run: () => reader.run(ctl.signal),
  };
}

describe("app feed: the stream", () => {
  it("each event goes into the store, the service is told, and the cursor is saved", async () => {
    const s = setup([{ chunks: [sse("e1", '{"text":"hi"}'), sse("e2", "x")] }]);
    await s.run();
    expect(s.keys()).toEqual(["e1", "e2"]);
    expect(s.events[0].data).toBe('{"text":"hi"}');
    expect(s.storedCalls()).toBeGreaterThan(0);
    expect(s.saved()?.cursor).toBe("e2");
    expect(s.reader.status().state).toBe("stopped");
  });

  it("resumes after a cut: the list form fills the gap, then Last-Event-ID", async () => {
    const s = setup(
      [
        { chunks: [sse("e1", "one")] },
        { error: new Error("socket hang up") },
        { chunks: [sse("e3", "three")] },
      ],
      { list: (after) => (after === "e1" ? [{ id: "e2", data: "two" }] : []) },
    );
    await s.run();
    expect(s.listed.slice(0, 2)).toEqual(["e1", "e2"]);
    expect(s.opened.slice(0, 3)).toEqual([null, "e2", "e2"]);
    expect(s.keys()).toEqual(["e1", "e2", "e3"]);
  });

  it("backs off on errors, doubling up to the cap", async () => {
    const err = () => ({ error: new Error("refused") });
    const s = setup([err(), err(), err(), err(), err()]);
    await s.run();
    expect(s.waits.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(s.logs.join("\n")).toContain("refused; trying again");
  });

  it("a reset event: reopened at once (no wait), the list form read first", async () => {
    const s = setup([
      {
        chunks: [
          sse("e1", "one"),
          sse(null, "{}", "reset"),
          sse("e9", "never"),
        ],
      },
      { chunks: [sse("e2", "two")] },
    ]);
    await s.run();
    expect(s.keys()).toEqual(["e1", "e2"]);
    expect(s.opened.slice(0, 2)).toEqual([null, "e1"]);
    expect(s.waits).toEqual([1000]);
    expect(s.listed).toEqual(["e1", "e2"]);
    expect(s.logs.join("\n")).toContain("reset its stream");
  });

  it("a duplicate id (the stream and the list both sent it) is kept once", async () => {
    const s = setup(
      [{ chunks: [sse("e1", "one"), sse("e1", "one again")] }, { chunks: [] }],
      { list: () => [{ id: "e1", data: "one" }] },
    );
    await s.run();
    expect(s.keys()).toEqual(["e1"]);
  });

  it("the cursor and the store survive a restart: no event is kept twice", async () => {
    const store = memStore();
    const a = setup([{ chunks: [sse("e7", "seven")] }], { store });
    await a.run();
    const b = setup([{ chunks: [sse("e7", "seven"), sse("e8", "eight")] }], {
      cursor: a.saved(),
      store,
    });
    await b.run();
    expect(b.opened[0]).toBe("e7");
    expect(b.listed[0]).toBe("e7");
    expect(store.events.map((e) => e.key)).toEqual(["e7", "e8"]);
  });

  it("a cursor that isn't a legal header value is never sent as Last-Event-ID", async () => {
    const s = setup([{ chunks: [] }, { chunks: [] }], {
      cursor: { cursor: "bad idé", lastEventAt: null },
    });
    await s.run();
    expect(s.opened[0]).toBeNull();
    expect(s.listed[0]).toBe("bad idé");
  });
});

describe("app feed: a missing secret", () => {
  it("says so once (state no_secret, a notice), and keeps trying", async () => {
    const miss = () => ({
      error: Object.assign(new Error("secrets.refs.chat_token is not set"), {
        kind: "no_secret" as const,
      }),
    });
    const states: string[] = [];
    const s = setup([miss(), miss()]);
    s.deps.onStatus = (st) => states.push(st.state);
    await s.run();
    expect(states).toContain("no_secret");
    expect(s.notices.filter((n) => n.code === "no_secret")).toHaveLength(1);
    expect(s.opened.length).toBeGreaterThanOrEqual(2);
  });
});

describe("app feed: limits", () => {
  it("an event over the size limit is kept without its data, and said", async () => {
    const big = JSON.stringify({ text: "y".repeat(3000) });
    const s = setup([{ chunks: [sse("e1", big)] }], {
      limits: { eventMaxKb: 1, perMinute: 600 },
    });
    await s.run();
    expect(s.events).toHaveLength(1);
    expect(s.events[0].data).toBeNull();
    expect(s.events[0].bytes).toBe(Buffer.byteLength(big));
    expect(s.notices.map((n) => n.code)).toEqual(["too_big"]);
  });

  it("many short data: lines in one event: capped, kept as a note, memory never grows past it", async () => {
    const lines = Array.from({ length: 5000 }, () => "data: abcdefgh\n").join(
      "",
    );
    const s = setup([{ chunks: [`id: e1\n${lines}`, "\n", sse("e2", "ok")] }], {
      limits: { eventMaxKb: 1, perMinute: 600 },
    });
    await s.run();
    expect(s.events.some((e) => e.data === null)).toBe(true);
    expect(s.events.find((e) => e.key === "e2")?.data).toBe("ok");
    expect(s.events.every((e) => (e.data ?? "").length < 2048)).toBe(true);
    expect(s.notices.some((n) => n.code === "too_big")).toBe(true);
  });

  it("over the rate: reading waits for the minute (said once), and every event is kept", async () => {
    const s = setup(
      [
        {
          chunks: [
            sse("e1", "a"),
            sse("e2", "b"),
            sse("e3", "c"),
            sse("e4", "d"),
          ],
        },
      ],
      { limits: { eventMaxKb: 32, perMinute: 2 } },
    );
    await s.run();
    expect(s.keys()).toEqual(["e1", "e2", "e3", "e4"]);
    expect(s.waits[0]).toBe(60_000);
    expect(s.notices.filter((n) => n.code === "over_rate")).toHaveLength(1);
  });
});

describe("SseReader: one event's data: lines are capped together", () => {
  it("past maxEvent: the event's data goes (said once), the next event reads", () => {
    let over = 0;
    const r = new SseReader({ maxEvent: 1024, onOverflow: () => void over++ });
    const out = [
      ...r.feed("id: e1\n"),
      ...r.feed(
        Array.from({ length: 5000 }, () => "data: abcdefgh\n").join(""),
      ),
      ...r.feed("\n"),
      ...r.feed("id: e2\ndata: ok\n\n"),
    ];
    expect(over).toBe(1);
    expect(out).toEqual([{ id: "e2", event: "message", data: "ok" }]);
  });
});
