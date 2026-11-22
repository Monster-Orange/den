/**
 * Issue 459: the server's app event feeds against a fake app (fetch): the
 * bearer goes only into the request's Authorization header (never a log,
 * the Settings view /api serves, the cursor file or the agent's text), a
 * missing secret is said, the stream limit is said in the project's
 * notifications, and a feed names one of its own project's agents.
 * Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AppFeeds,
  type AppFeedServiceDeps,
} from "../../../src/ui/server/app-feed-service";
import type { Delivery } from "../../../src/shared/hub-delivery";

const BEARER = "s3cr3t-feed-bearer-value-123";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-feedsvc-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function stream(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function setup(
  o: {
    feeds?: Record<string, unknown>;
    secret?: (ref: string) => Promise<string | null>;
    maxStreams?: number;
    respond?: (url: string, init: RequestInit) => Response | Promise<Response>;
  } = {},
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const logs: string[] = [];
  const bells: Parameters<AppFeedServiceDeps["bell"]>[0][] = [];
  const relayed: Delivery[] = [];
  const seen = new Set<string>();
  const feeds = o.feeds ?? {
    north: [
      {
        name: "chat",
        agent: "north-helper",
        url: "https://app.example.test/events",
        bearer: "chat_feed_token",
      },
    ],
  };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: { ...(init.headers as Record<string, string>) },
    });
    if (o.respond) return o.respond(url, init);
    if (url.includes("after=")) return new Response("[]", { status: 200 });
    return stream([`id: e1\ndata: {"text":"hello"}\n\n`]);
  }) as unknown as typeof fetch;
  const svc = new AppFeeds({
    projects: () => Object.keys(feeds),
    feedsOf: (ws) => feeds[ws],
    agentProject: (a) =>
      a.startsWith("north-")
        ? "north"
        : a.startsWith("south-")
          ? "south"
          : null,
    secret:
      o.secret ?? (async (ref) => (ref === "chat_feed_token" ? BEARER : null)),
    relay: async (dv) => {
      seen.add(dv.id);
      relayed.push(dv);
      return true;
    },
    seen: (id) => seen.has(id),
    limits: () => ({
      maxStreams: o.maxStreams ?? 50,
      eventMaxKb: 32,
      perMinute: 600,
    }),
    bell: (n) => bells.push(n),
    stateDir: dir,
    fetch: fakeFetch,
    log: (l) => logs.push(l),
    retryMs: { first: 5, max: 10 },
  });
  return { svc, calls, logs, bells, relayed };
}

/** Wait (a real, short one) until `f` holds. */
async function until(f: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function filesUnder(d: string): string[] {
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"));
}

describe("app feed service", () => {
  it("connects with the bearer in the Authorization header only, and hands the event on", async () => {
    const s = setup();
    s.svc.sync();
    await until(() => s.relayed.length === 1);
    s.svc.stop();
    expect(s.calls[0].headers.Authorization).toBe(`Bearer ${BEARER}`);
    expect(s.calls[0].headers.Accept).toBe("text/event-stream");
    expect(s.calls[0].url).toBe("https://app.example.test/events");
    expect(s.relayed[0].agent).toBe("north-helper");
    expect(s.relayed[0].text).toContain('"text": "hello"');
  });

  it("the bearer never appears in logs, the /api view, the cursor file or the agent's text", async () => {
    const s = setup({
      respond: (url) =>
        url.includes("after=")
          ? new Response("nope", { status: 500 })
          : stream([`id: e1\ndata: {"echo":"x"}\n\n`]),
    });
    s.svc.sync();
    await until(() => s.relayed.length === 1 && s.logs.length > 0);
    await until(() => s.calls.length >= 3);
    const view = s.svc.view("north");
    s.svc.stop();
    const everything = [
      ...s.logs,
      JSON.stringify(view),
      ...filesUnder(dir),
      ...s.relayed.map((d) => JSON.stringify(d)),
      ...s.bells.map((b) => JSON.stringify(b)),
    ].join("\n");
    expect(everything).not.toContain(BEARER);
    expect(JSON.stringify(view)).not.toContain("chat_feed_token");
    expect(view.feeds[0]).toMatchObject({
      name: "chat",
      agent: "north-helper",
      url: "https://app.example.test/events",
    });
    expect(view.feeds[0].last_event_at).not.toBeNull();
  });

  it("an error that echoes the bearer is scrubbed before it is logged", async () => {
    const s = setup({
      respond: () => {
        throw Object.assign(new Error(`boom ${BEARER}`), {
          cause: { code: `ECONN ${BEARER}` },
        });
      },
    });
    s.svc.sync();
    await until(() => s.logs.length >= 2);
    const view = s.svc.view("north");
    s.svc.stop();
    expect(s.logs.join("\n")).not.toContain(BEARER);
    expect(JSON.stringify(view)).not.toContain(BEARER);
    expect(view.feeds[0].state).toBe("retrying");
  });

  it("a missing secret: state no_secret, said in the project's notifications, nothing sent", async () => {
    const s = setup({ secret: async () => null });
    s.svc.sync();
    await until(() => s.bells.length === 1);
    const view = s.svc.view("north");
    s.svc.stop();
    expect(s.calls).toEqual([]);
    expect(view.feeds[0].state).toBe("no_secret");
    expect(s.bells[0]).toMatchObject({
      scope: "workspace/north",
      msg: { key: "bell.m.appFeed.no_secret" },
    });
  });

  it("over the stream limit: the rest aren't read, Settings says so, and the bell once", async () => {
    const s = setup({
      maxStreams: 1,
      feeds: {
        north: [
          { name: "a", agent: "north-helper", url: "https://a.example.test/e" },
          { name: "b", agent: "north-helper", url: "https://b.example.test/e" },
        ],
      },
    });
    s.svc.sync();
    s.svc.sync();
    const view = s.svc.view("north");
    s.svc.stop();
    expect(view.feeds.map((f) => f.state)).toEqual([
      "connecting",
      "over_limit",
    ]);
    expect(
      s.bells.filter((b) => b.msg?.key === "bell.m.appFeed.over_streams"),
    ).toHaveLength(1);
    expect(s.calls.every((c) => c.url.startsWith("https://a."))).toBe(true);
  });

  it("a feed for an agent of another project is never read", () => {
    const s = setup({
      feeds: {
        north: [
          { name: "x", agent: "south-helper", url: "https://x.example.test/e" },
        ],
      },
    });
    s.svc.sync();
    const view = s.svc.view("north");
    s.svc.stop();
    expect(view.feeds[0].state).toBe("no_agent");
    expect(s.calls).toEqual([]);
  });
});
