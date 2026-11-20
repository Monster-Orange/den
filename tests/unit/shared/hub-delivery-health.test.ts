/**
 * Issue 702: Den says when Hub's comments aren't arriving. The loop keeps
 * the path's health (the stream open, its last good read, the last
 * delivery, the last trouble); after hub.delivery_alert_minutes with no
 * good read and no open stream, doctor warns and the bell says why. A
 * quiet Hub with no comments never raises it: a good read is a stream
 * that opened, any bytes on it, or a list answer, never "a delivery came".
 * Issue 703: Hub sends a keep-alive every 25 s and ends the stream itself
 * after a while. A keep-alive is a good read; no bytes for
 * hub.delivery_stream_silence_seconds closes and reopens the stream (and
 * reads the list once); a clean end after a long stream reopens at once.
 * A fake Hub only; invented names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deliveryAlert,
  readDeliveryHealth,
  SeenDeliveries,
  writeDeliveryHealth,
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
  HUB_COMMENTS_KEYS,
} from "../../../src/ui/server/hub-comments-bell";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-dhealth-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;
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
  body: `comment ${id}`,
  created_at: "2026-11-12T18:00:00Z",
});

function setup(o: { silenceMs?: number } = {}) {
  let clock = 10_000_000;
  const logs: string[] = [];
  const notes: DeliveryHealth[] = [];
  const hub: DeliveryHub = {
    stream: () => {
      throw Object.assign(new Error("no stream"), { kind: "refused" });
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
    onHealth: (h) => notes.push(h),
    ...(o.silenceMs !== undefined ? { silenceMs: () => o.silenceMs! } : {}),
  });
  return {
    loop,
    hub,
    ctl,
    logs,
    notes,
    now: () => clock,
    tick: (ms: number) => (clock += ms),
  };
}

const fail = (kind: string, msg = kind) =>
  Object.assign(new Error(msg), { kind });

describe("a quiet Hub never raises it", () => {
  it("the stream open for hours with no comments: no alert", async () => {
    const s = setup();
    let during: unknown = "unset";
    s.hub.stream = () =>
      (async function* () {
        yield ""; // opened
        s.tick(5 * 60 * MIN);
        during = deliveryAlert(s.loop.health(), s.now(), 15);
        s.ctl.abort();
      })();
    await s.loop.run(s.ctl.signal);
    expect(during).toBeNull();
    expect(s.loop.health().lastDeliveryAt).toBeNull();
  });

  it("no stream (404), the list answers empty for hours: no alert", async () => {
    const s = setup();
    let n = 0;
    (s.loop as unknown as { d: Record<string, unknown> }).d.sleep =
      async () => {
        s.tick(30 * MIN);
        if (++n >= 10) s.ctl.abort();
      };
    await s.loop.run(s.ctl.signal);
    expect(deliveryAlert(s.loop.health(), s.now(), 15)).toBeNull();
  });
});

describe("a dead path is said, with its reason", () => {
  it("Hub doesn't take the token (401) on the stream and the list: rejected, after N minutes", async () => {
    const s = setup();
    s.hub.stream = () => {
      throw fail("rejected", "Hub did not accept the token");
    };
    s.hub.list = async () => {
      throw fail("rejected", "Hub did not accept the token");
    };
    const seen: (string | null)[] = [];
    (s.loop as unknown as { d: Record<string, unknown> }).d.sleep = async (
      ms: number,
    ) => {
      s.tick(ms);
      seen.push(deliveryAlert(s.loop.health(), s.now(), 15));
      if (s.now() - 10_000_000 > 20 * MIN) s.ctl.abort();
    };
    await s.loop.run(s.ctl.signal);
    expect(seen[0]).toBeNull(); // not before the minutes are up
    expect(seen[seen.length - 1]).toBe("rejected");
    // Said in the log once, not on every retry.
    expect(s.logs.filter((l) => /token/.test(l))).toHaveLength(1);
  });

  it("a failed stream still reads the list: comments arrive, no alert", async () => {
    const s = setup();
    s.hub.stream = () => {
      throw fail("unreachable", "connection reset");
    };
    const pages = [[dv("d1")]];
    s.hub.list = async () => pages.shift() ?? [];
    let n = 0;
    (s.loop as unknown as { d: Record<string, unknown> }).d.sleep = async (
      ms: number,
    ) => {
      s.tick(Math.max(ms, 5 * MIN));
      if (++n >= 8) s.ctl.abort();
    };
    await s.loop.run(s.ctl.signal);
    const h = s.loop.health();
    expect(h.lastDeliveryAt).not.toBeNull();
    expect(deliveryAlert(h, s.now(), 15)).toBeNull();
  });

  it("the list's own failure (403) is kept, never swallowed", async () => {
    const s = setup();
    s.hub.list = async () => {
      throw fail("forbidden", "Hub refused");
    };
    let n = 0;
    (s.loop as unknown as { d: Record<string, unknown> }).d.sleep =
      async () => {
        s.tick(10 * MIN);
        if (++n >= 3) s.ctl.abort();
      };
    await s.loop.run(s.ctl.signal);
    expect(s.loop.health().trouble).toBe("forbidden");
    expect(deliveryAlert(s.loop.health(), s.now(), 15)).toBe("forbidden");
    expect(s.logs.some((l) => /Hub refused/.test(l))).toBe(true);
  });

  it("a good read clears it; 0 minutes turns it off", async () => {
    const h: DeliveryHealth = {
      since: 0,
      streamOpen: false,
      lastOkAt: null,
      lastDeliveryAt: null,
      trouble: "unreachable",
      troubleAt: 50 * MIN,
    };
    expect(deliveryAlert(h, 60 * MIN, 15)).toBe("unreachable");
    expect(deliveryAlert(h, 60 * MIN, 0)).toBeNull();
    expect(deliveryAlert({ ...h, lastOkAt: 55 * MIN }, 60 * MIN, 15)).toBeNull();
    expect(deliveryAlert({ ...h, streamOpen: true }, 60 * MIN, 15)).toBeNull();
  });

  it("health is handed on when it changes, not on every byte", async () => {
    const s = setup();
    s.hub.stream = () =>
      (async function* () {
        yield "";
        for (let i = 0; i < 50; i++) {
          s.tick(1000);
          yield ": keep-alive\n\n";
        }
        s.ctl.abort();
      })();
    await s.loop.run(s.ctl.signal);
    expect(s.notes.length).toBeGreaterThan(0);
    expect(s.notes.length).toBeLessThan(5);
    expect(s.notes[0].streamOpen).toBe(true);
  });
});

describe("the health file, for doctor", () => {
  it("written and read back with the stream's URL; a broken file reads as none", () => {
    const f = path.join(dir, "hub", "deliveries-health.json");
    const h: DeliveryHealth = {
      since: 1,
      streamOpen: true,
      lastOkAt: 2,
      lastDeliveryAt: null,
      trouble: null,
      troubleAt: null,
    };
    writeDeliveryHealth(f, h, "https://hub.example.test");
    expect(readDeliveryHealth(f)).toEqual({
      ...h,
      url: "https://hub.example.test",
    });
    fs.writeFileSync(f, "{");
    expect(readDeliveryHealth(f)).toBeNull();
  });

  it("doctor: ok with the URL and the last read; warns with the reason", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    const ok = hubDeliveryLines(
      {
        since: now - 120 * MIN,
        streamOpen: true,
        lastOkAt: now - 3 * MIN,
        lastDeliveryAt: null,
        trouble: null,
        troubleAt: null,
        url: "https://hub.example.test",
      },
      now,
      15,
    );
    expect(ok.check?.status).toBe("ok");
    expect(ok.check?.detail).toContain("https://hub.example.test");
    expect(ok.check?.detail).toMatch(/last good read 3 min ago/);
    expect(ok.check?.detail).toMatch(/no comment yet/);
    const bad = hubDeliveryLines(
      {
        since: now - 120 * MIN,
        streamOpen: false,
        lastOkAt: now - 60 * MIN,
        lastDeliveryAt: now - 90 * MIN,
        trouble: "rejected",
        troubleAt: now - MIN,
        url: "https://hub.example.test",
      },
      now,
      15,
    );
    expect(bad.check?.status).toBe("warn");
    expect(bad.check?.detail).toMatch(/Hub comments aren't arriving/);
    expect(bad.check?.detail).toMatch(/token/);
    expect(bad.problem).toBe(false);
    expect(hubDeliveryLines(null, now, 15).lines).toEqual([]);
  });
});

describe("the bell line", () => {
  it("added once with its reason's key, withdrawn on the next good read", () => {
    const added: { subject: string; msg?: { key: string } ; text: string}[] = [];
    const gone: string[] = [];
    const store = {
      add: (n: { subject: string; msg?: { key: string }; text: string }) => {
        added.push(n);
        return n;
      },
      withdraw: (subject: string) => {
        gone.push(subject);
        return true;
      },
    };
    const bell = hubCommentsBell(store);
    bell("unreachable");
    bell("unreachable");
    expect(added).toHaveLength(1);
    expect(added[0].subject).toBe(HUB_COMMENTS_SUBJECT);
    expect(added[0].text).toMatch(/^Hub comments aren't arriving: /);
    expect(added[0].msg?.key).toBe(HUB_COMMENTS_KEYS.unreachable);
    bell("rejected");
    expect(added).toHaveLength(2);
    bell(null);
    expect(gone).toEqual([HUB_COMMENTS_SUBJECT]);
    bell(null);
    expect(gone).toHaveLength(1);
  });

  it("every reason's line is in en, es and ja", () => {
    const pub = path.join(__dirname, "../../../src/ui/server/public");
    const files = ["shell.js", "i18n/es.js", "i18n/ja.js"].map((f) =>
      fs.readFileSync(path.join(pub, f), "utf-8"),
    );
    for (const key of Object.values(HUB_COMMENTS_KEYS))
      for (const f of files) expect(f).toContain(`"${key}":`);
  });
});

describe("the setting", () => {
  const cfg = (v: unknown) =>
    readHubConfig(
      { hub: { url: "https://hub.example.test", delivery_alert_minutes: v } },
      {},
      () => ({}) as never,
    );
  it("hub.delivery_alert_minutes: default 15, 0 turns it off, a bad value throws", () => {
    expect(cfg(undefined)?.deliveryAlertMinutes).toBe(15);
    expect(cfg(0)?.deliveryAlertMinutes).toBe(0);
    expect(cfg(120)?.deliveryAlertMinutes).toBe(120);
    expect(() => cfg(-1)).toThrow(/hub.delivery_alert_minutes/);
  });
});

describe("issue 703: keep-alives, silence, and Hub's own end", () => {
  const until = (sig: AbortSignal) =>
    new Promise<void>((r) => sig.addEventListener("abort", () => r(), { once: true }));

  it("keep-alives, then silence: the stream is closed and reopened, and the list read once", async () => {
    const s = setup({ silenceMs: 40 });
    let opened = 0;
    let polled = 0;
    const okAt: (number | null)[] = [];
    s.hub.list = async () => {
      polled++;
      return [];
    };
    s.hub.stream = (_last, sig) => {
      opened++;
      if (opened === 2) {
        s.ctl.abort();
        return (async function* () {})();
      }
      return (async function* () {
        yield "";
        s.tick(25_000);
        yield ": keep-alive\n\n";
        okAt.push(s.loop.health().lastOkAt);
        await until(sig); // silent from here: Den gives up on it
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      })();
    };
    const slept: number[] = [];
    (s.loop as unknown as { d: Record<string, unknown> }).d.sleep = async (
      ms: number,
    ) => {
      slept.push(ms);
    };
    await s.loop.run(s.ctl.signal);
    expect(opened).toBe(2);
    expect(polled).toBe(1);
    expect(slept).toEqual([]); // reopened at once
    expect(okAt[0]).toBe(s.now()); // the keep-alive counted as a read
    expect(s.logs.some((l) => /no bytes/.test(l))).toBe(true);
  });

  it("Hub ends the stream after 10 minutes: reopened at once, not a failure", async () => {
    const s = setup();
    let opened = 0;
    s.hub.stream = () => {
      opened++;
      if (opened === 2) s.ctl.abort();
      return (async function* () {
        yield "";
        s.tick(10 * MIN);
        yield ": keep-alive\n\n";
      })();
    };
    const slept: number[] = [];
    (s.loop as unknown as { d: Record<string, unknown> }).d.sleep = async (
      ms: number,
    ) => {
      slept.push(ms);
    };
    await s.loop.run(s.ctl.signal);
    expect(opened).toBe(2);
    expect(slept).toEqual([]);
    expect(s.loop.health().trouble).toBeNull();
    expect(s.logs).toEqual([]);
  });

  it("a stream that ends as soon as it opens backs off and is said as closing", async () => {
    const s = setup();
    s.hub.stream = () =>
      (async function* () {
        yield "";
      })();
    const slept: number[] = [];
    (s.loop as unknown as { d: Record<string, unknown> }).d.sleep = async (
      ms: number,
    ) => {
      slept.push(ms);
      if (slept.length >= 3) s.ctl.abort();
    };
    await s.loop.run(s.ctl.signal);
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(s.loop.health().trouble).toBe("closed");
  });

  it("hub.delivery_stream_silence_seconds: default 75, 0 turns it off, under 5 throws", () => {
    const cfg = (v: unknown) =>
      readHubConfig(
        {
          hub: {
            url: "https://hub.example.test",
            delivery_stream_silence_seconds: v,
          },
        },
        {},
        () => ({}) as never,
      );
    expect(cfg(undefined)?.deliveryStreamSilenceSeconds).toBe(75);
    expect(cfg(0)?.deliveryStreamSilenceSeconds).toBe(0);
    expect(cfg(300)?.deliveryStreamSilenceSeconds).toBe(300);
    expect(() => cfg(2)).toThrow(/hub.delivery_stream_silence_seconds/);
  });
});
