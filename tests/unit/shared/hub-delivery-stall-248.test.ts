/**
 * Issue 248: Hub deliveries could stop with no sign. The loop logs each
 * stream open and close, and each list read's result (status, count, last
 * id), one line per change of state; it keeps the last list read and the
 * cursor's age for doctor; and while the stream stays open but the cursor
 * hasn't moved for hub.delivery_stale_hours, with deliveries waiting in
 * Hub's list, it raises one "stale" alert (the bell and doctor), cleared
 * when a delivery comes on the stream. Logs carry ids and counts only.
 * A fake Hub only; invented names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deliveryAlert,
  SeenDeliveries,
  type DeliveryHealth,
} from "../../../src/shared/hub-delivery";
import {
  DeliveryLoop,
  type DeliveryHub,
} from "../../../src/shared/hub-delivery-loop";
import { readHubConfig } from "../../../src/shared/hub";
import { hubDeliveryLines } from "../../../src/ui/cli/doctor-command";
import {
  HUB_COMMENTS_SUBJECT,
  hubCommentsBell,
} from "../../../src/ui/server/hub-comments-bell";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dstall-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;
const HOUR = 60 * MIN;
const SECRET_BODY = "the body of a private comment";
const dv = (id: string) => ({
  id,
  agent: "ag-1",
  project: "web",
  thread: { kind: "comment", id: `th_${id}`, url: "", artifact: "Doc" },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: SECRET_BODY,
  created_at: "2026-11-12T18:00:00Z",
});
const sse = (id: string) =>
  `id: ${id}\nevent: delivery\ndata: ${JSON.stringify(dv(id))}\n\n`;
const fail = (kind: string, msg = kind) =>
  Object.assign(new Error(msg), { kind });

function setup(o: { staleMs?: number } = {}) {
  let clock = 10_000_000;
  const logs: string[] = [];
  const hub: DeliveryHub = {
    stream: () => {
      throw fail("refused", "no stream");
    },
    list: async () => [],
    ack: async () => undefined,
  };
  const ctl = new AbortController();
  const loop = new DeliveryLoop({
    hub,
    agents: { state: async () => "idle", type: async () => true },
    owner: () => ({ ownerId: "u_me" }),
    seen: new SeenDeliveries(path.join(dir, "seen.json")),
    now: () => clock,
    retryMs: { first: 1000, max: 60_000 },
    pollMs: 30_000,
    log: (l) => logs.push(l),
    ...(o.staleMs !== undefined ? { staleMs: () => o.staleMs! } : {}),
  });
  return {
    loop,
    hub,
    ctl,
    logs,
    now: () => clock,
    tick: (ms: number) => (clock += ms),
  };
}

/** Run the list fallback `n` times (Hub has no stream). */
function polls(s: ReturnType<typeof setup>, n: number) {
  let k = 0;
  (s.loop as unknown as { d: Record<string, unknown> }).d.sleep = async () => {
    s.tick(30_000);
    if (++k >= n) s.ctl.abort();
  };
  return s.loop.run(s.ctl.signal);
}

describe("issue 248: a list that answers 500", () => {
  it("one log line however often it fails, and the loop's state shows the error", async () => {
    const s = setup();
    s.hub.list = async () => {
      throw fail("unreachable", "Hub answered 500");
    };
    await polls(s, 5);
    expect(s.logs.filter((l) => /500/.test(l))).toHaveLength(1);
    const h = s.loop.health();
    expect(h.lastPoll).toMatchObject({ ok: false, error: "Hub answered 500" });
    // The last read, before the fake sleep's 30 s.
    expect(h.lastPoll?.at).toBe(s.now() - 30_000);
  });

  it("a good list read after it: one line with its count and last id, never a body", async () => {
    const s = setup();
    let n = 0;
    s.hub.list = async () => {
      n++;
      if (n <= 2) throw fail("unreachable", "Hub answered 500");
      return n === 3 ? [dv("d-1"), dv("d-2")] : [];
    };
    await polls(s, 5);
    const listLines = s.logs.filter((l) => /comment list/.test(l));
    expect(listLines).toEqual([
      "hub deliveries: the comment list: Hub answered 500",
      "hub deliveries: the comment list answered: 2, last d-2",
      "hub deliveries: the comment list answered: none waiting",
    ]);
    expect(s.logs.join("\n")).not.toContain(SECRET_BODY);
    expect(s.loop.health().lastPoll).toMatchObject({
      ok: true,
      count: 0,
      lastId: "d-2",
    });
  });
});

describe("issue 248: the stream's open and close are logged", () => {
  it("open, then closed: one line each, with how long it lived", async () => {
    const s = setup();
    let opens = 0;
    s.hub.stream = () =>
      (async function* () {
        opens++;
        yield ": keep-alive\n\n";
        yield ": keep-alive\n\n";
        s.tick(10 * MIN);
        if (opens >= 2) s.ctl.abort();
      })();
    await s.loop.run(s.ctl.signal);
    const lines = s.logs.filter((l) => /comment stream/.test(l));
    expect(lines.slice(0, 2)).toEqual([
      "hub deliveries: the comment stream opened",
      "hub deliveries: the comment stream closed after 600s",
    ]);
  });
});

describe("issue 248: the cursor stalls while the stream stays open", () => {
  /**
   * A stream that only keeps alive for `hours`, a keep-alive each 25 s
   * (the clock moves 25 s a byte); then `then` (more chunks), then abort.
   */
  const quiet =
    (s: ReturnType<typeof setup>, hours: number, then: string[] = []) =>
    () =>
      (async function* () {
        const end = s.now() + hours * HOUR;
        while (s.now() < end) {
          s.tick(25_000);
          yield ": keep-alive\n\n";
        }
        for (const c of then) yield c;
        s.ctl.abort();
      })();

  it("past hub.delivery_stale_hours with Hub's list waiting: stale, once; the bell says it once", async () => {
    const s = setup({ staleMs: 6 * HOUR });
    let lists = 0;
    s.hub.list = async (after) => {
      lists++;
      expect(after).toBeNull();
      return [dv("d-9"), dv("d-10")];
    };
    const added: string[] = [];
    const bell = hubCommentsBell({
      add: (n) => void added.push(n.subject),
      withdraw: () => true,
    });
    const reasons: (string | null)[] = [];
    let raisedAt: number | null = null;
    s.hub.stream = () =>
      (async function* () {
        const end = s.now() + 8 * HOUR;
        while (s.now() < end) {
          s.tick(25_000);
          yield ": keep-alive\n\n";
          const r = deliveryAlert(s.loop.health(), s.now(), 15);
          reasons.push(r);
          bell(r);
          if (r && raisedAt === null) raisedAt = s.now();
        }
        s.ctl.abort();
      })();
    await s.loop.run(s.ctl.signal);
    expect(raisedAt).not.toBeNull();
    expect(raisedAt! - 10_000_000).toBeGreaterThanOrEqual(6 * HOUR);
    expect(raisedAt! - 10_000_000).toBeLessThan(6 * HOUR + 2 * MIN);
    expect(new Set(reasons.filter(Boolean))).toEqual(new Set(["stale"]));
    expect(added).toEqual([HUB_COMMENTS_SUBJECT]);
    expect(s.logs.filter((l) => /hasn't moved/.test(l))).toHaveLength(1);
    // Read the list at most once a poll interval, never per keep-alive.
    expect(lists).toBeLessThanOrEqual((2 * HOUR) / 30_000 + 1);
  });

  it("a quiet Hub (nothing waiting in its list): never stale", async () => {
    const s = setup({ staleMs: 6 * HOUR });
    s.hub.list = async () => [];
    let seen: string | null = "unset";
    s.hub.stream = () =>
      (async function* () {
        const end = s.now() + 8 * HOUR;
        while (s.now() < end) {
          s.tick(25_000);
          yield ": keep-alive\n\n";
        }
        seen = deliveryAlert(s.loop.health(), s.now(), 15);
        s.ctl.abort();
      })();
    await s.loop.run(s.ctl.signal);
    expect(seen).toBeNull();
    expect(s.loop.health().stale ?? null).toBeNull();
  });

  it("a delivery on the stream clears it, and the bell withdraws", async () => {
    const s = setup({ staleMs: 6 * HOUR });
    s.hub.list = async () => [];
    let waiting = true;
    s.hub.list = async () => (waiting ? [dv("d-9")] : []);
    s.hub.stream = quiet(s, 7);
    const run1 = s.loop.run(s.ctl.signal);
    await run1;
    expect(deliveryAlert(s.loop.health(), s.now(), 15)).toBe("stale");
    const withdrawn: string[] = [];
    const bell = hubCommentsBell({
      add: () => undefined,
      withdraw: (subj) => (withdrawn.push(subj), true),
    });
    bell("stale");
    waiting = false;
    const ctl2 = new AbortController();
    (s as { ctl: AbortController }).ctl = ctl2;
    s.hub.stream = () =>
      (async function* () {
        yield sse("d-11");
        ctl2.abort();
      })();
    await s.loop.run(ctl2.signal);
    expect(s.loop.health().stale ?? null).toBeNull();
    const r = deliveryAlert(s.loop.health(), s.now(), 15);
    expect(r).toBeNull();
    bell(r);
    expect(withdrawn).toEqual([HUB_COMMENTS_SUBJECT]);
  });

  it("the health keeps the cursor's last move", async () => {
    const s = setup({ staleMs: 6 * HOUR });
    const at = s.now();
    s.hub.stream = () =>
      (async function* () {
        yield sse("d-1");
        s.tick(3 * HOUR);
        yield ": keep-alive\n\n";
        s.ctl.abort();
      })();
    await s.loop.run(s.ctl.signal);
    expect(s.loop.health().cursorAt).toBe(at);
  });

  it("0 turns it off", async () => {
    const s = setup({ staleMs: 0 });
    s.hub.list = async () => [dv("d-9")];
    s.hub.stream = quiet(s, 8);
    await s.loop.run(s.ctl.signal);
    expect(s.loop.health().stale ?? null).toBeNull();
  });
});

describe("issue 248: doctor", () => {
  it("warns stale, with the cursor's age and the count waiting", () => {
    const now = 100 * HOUR;
    const h: DeliveryHealth = {
      since: 0,
      streamOpen: true,
      lastOkAt: now - MIN,
      lastDeliveryAt: now - 9 * HOUR,
      trouble: null,
      troubleAt: null,
      cursorAt: now - 9 * HOUR,
      stale: { since: now - 3 * HOUR, waiting: 4 },
    };
    const r = hubDeliveryLines(h, now, 15);
    expect(r.check?.status).toBe("warn");
    expect(r.lines[0]).toContain("⚠");
    expect(r.lines[0]).toContain("4 waiting in Hub");
    expect(r.lines[0]).toMatch(/cursor moved 9 ?h/);
  });
});

describe("issue 248: hub.delivery_stale_hours", () => {
  const cfg = (v: unknown) =>
    readHubConfig(
      { hub: { url: "https://hub.example.test", delivery_stale_hours: v } },
      {},
      () => ({}) as never,
    );

  it("6 by default; 0 is off; a number of hours", () => {
    expect(cfg(undefined)?.deliveryStaleHours).toBe(6);
    expect(cfg(0)?.deliveryStaleHours).toBe(0);
    expect(cfg(1.5)?.deliveryStaleHours).toBe(1.5);
  });

  it("a negative or a word: refused with the key's name", () => {
    expect(() => cfg(-1)).toThrow(/hub\.delivery_stale_hours/);
    expect(() => cfg("soon")).toThrow(/hub\.delivery_stale_hours/);
  });
});
