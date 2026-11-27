import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { handleNotificationRoutes } from "../../../src/ui/server/notification-routes.js";
import {
  setPrincipal,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { AlertHandoff } from "../../../src/ui/server/alert-handoff.js";
import {
  PushSubscriptions,
  pushEach,
  vapidKeys,
} from "../../../src/ui/server/web-push.js";

const MINE = "https://push.example/mine";
const THEIRS = "https://push.example/theirs";
const KEYS = {
  p256dh:
    "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-774-routes-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Caller = string | Principal | undefined;

function req(method: string, url: string, body: unknown, who: Caller) {
  const r = new PassThrough() as unknown as http.IncomingMessage & PassThrough;
  Object.assign(r, { method, url, headers: {} });
  if (typeof who === "string")
    setPrincipal(r, { kind: "person", actor: who as `person:${string}` });
  else if (who) setPrincipal(r, who);
  (r as PassThrough).end(body === undefined ? "" : JSON.stringify(body));
  return r;
}

function res() {
  const out = { status: 0, body: "", chunks: [] as string[], ended: false };
  const r = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (s: number) => {
      out.status = s;
      return r;
    },
    write: (c: string) => {
      out.chunks.push(String(c));
      return true;
    },
    end: (b?: string) => {
      out.body = b ?? "";
      out.ended = true;
    },
    on: () => r,
  } as unknown as http.ServerResponse;
  return { r, out };
}

const events = (chunks: string[]) =>
  chunks
    .join("")
    .split("\n\n")
    .filter((c) => c.startsWith("data: "))
    .map((c) => JSON.parse(c.slice(6)) as Record<string, unknown>);

function rig() {
  const subs = new PushSubscriptions(dir);
  subs.add({ endpoint: MINE, ...KEYS, person: "person:a" });
  subs.add({ endpoint: THEIRS, ...KEYS, person: "person:b" });
  const handoff = new AlertHandoff({
    windowMs: () => 3000,
    maxTabs: () => 20,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  const deps = {
    store: new NotificationStore(dir),
    push: { subs, publicKey: () => "k" },
    handoff,
  } as never;
  const call = async (m: string, url: string, body: unknown, who: Caller) => {
    const q = req(m, url, body, who);
    const s = res();
    await handleNotificationRoutes(q, s.r, url.split("?")[0], deps);
    return { ...s.out, req: q };
  };
  const stream = async (who: Caller) => {
    const r = await call("GET", "/api/alerts/stream", undefined, who);
    const first = events(r.chunks)[0] as { type?: string; tab?: string };
    return { ...r, tab: first?.tab ?? "" };
  };
  return { subs, handoff, call, stream };
}

const agent: Principal = {
  kind: "agent",
  actor: "agent:builder",
  workspace: "north",
  grants: [],
  session: { name: "s" },
} as Principal;
const fixture: Principal = {
  kind: "person-browser",
  session: "f1",
  fixture: true,
} as Principal;

describe("774 row 7b: GET /api/alerts/stream", () => {
  it("is an event stream whose first event names the tab", async () => {
    const r = rig();
    const s = await r.stream("person:a");
    expect(s.status).toBe(200);
    expect(s.tab).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(r.handoff.tabCount()).toBe(1);
  });

  it("closing it ends the tab (its id dies)", async () => {
    const r = rig();
    const s = await r.stream("person:a");
    s.req.emit("close");
    expect(r.handoff.tabCount()).toBe(0);
    const p = await r.call(
      "POST",
      "/api/alerts/presence",
      { tab: s.tab, visible: true },
      "person:a",
    );
    expect(p.status).toBe(403);
  });

  it("refuses an agent's token and the fixture session", async () => {
    for (const who of [agent, fixture]) {
      const r = rig();
      const s = await r.call("GET", "/api/alerts/stream", undefined, who);
      expect(s.status).toBe(403);
      expect(r.handoff.tabCount()).toBe(0);
    }
  });
});

describe("774 row 7b: POST /api/alerts/presence", () => {
  it("a tab claims its person's own subscription", async () => {
    const r = rig();
    const s = await r.stream("person:a");
    const p = await r.call(
      "POST",
      "/api/alerts/presence",
      { tab: s.tab, endpoint: MINE, visible: true },
      "person:a",
    );
    expect(p.status).toBe(200);
    expect(JSON.parse(p.body)).toEqual({ ok: true, claimed: true });
  });

  it("another person's subscription: refused, and the push isn't touched", async () => {
    const r = rig();
    const s = await r.stream("person:a");
    const p = await r.call(
      "POST",
      "/api/alerts/presence",
      { tab: s.tab, endpoint: THEIRS, visible: true },
      "person:a",
    );
    expect(p.status).toBe(403);
    expect(JSON.parse(p.body).code).toBe("not_yours");
    const pushed: string[][] = [];
    r.handoff.deliver({ id: "x" } as never, [THEIRS], (e) => pushed.push(e));
    expect(pushed).toEqual([[THEIRS]]);
  });

  it("a subscription with no person (from before 774) is nobody's to claim", async () => {
    const r = rig();
    r.subs.add({ endpoint: "https://push.example/old", ...KEYS });
    const s = await r.stream("person:a");
    const p = await r.call(
      "POST",
      "/api/alerts/presence",
      { tab: s.tab, endpoint: "https://push.example/old", visible: true },
      "person:a",
    );
    expect(p.status).toBe(403);
  });

  it("someone else's tab: 403", async () => {
    const r = rig();
    const s = await r.stream("person:a");
    const p = await r.call(
      "POST",
      "/api/alerts/presence",
      { tab: s.tab, visible: true },
      "person:b",
    );
    expect(p.status).toBe(403);
  });

  it("refuses an agent's token and the fixture session", async () => {
    const r = rig();
    const s = await r.stream("person:a");
    for (const who of [agent, fixture]) {
      const p = await r.call(
        "POST",
        "/api/alerts/presence",
        { tab: s.tab, visible: true },
        who,
      );
      expect(p.status).toBe(403);
    }
  });
});

describe("774 row 7b: POST /api/alerts/ack", () => {
  it("acks a pending alert; a second ack has nothing pending", async () => {
    const r = rig();
    const s = await r.stream("person:a");
    await r.call(
      "POST",
      "/api/alerts/presence",
      { tab: s.tab, endpoint: MINE, visible: true },
      "person:a",
    );
    r.handoff.deliver({ id: "x1" } as never, [MINE], () => undefined);
    const a = await r.call(
      "POST",
      "/api/alerts/ack",
      { tab: s.tab, id: "x1" },
      "person:a",
    );
    expect(a.status).toBe(200);
    const again = await r.call(
      "POST",
      "/api/alerts/ack",
      { tab: s.tab, id: "x1" },
      "person:a",
    );
    expect(again.status).toBe(409);
  });

  it("someone else's tab, an agent, the fixture session: 403", async () => {
    const r = rig();
    const s = await r.stream("person:a");
    for (const who of ["person:b", agent, fixture] as Caller[]) {
      const a = await r.call(
        "POST",
        "/api/alerts/ack",
        { tab: s.tab, id: "x1" },
        who,
      );
      expect(a.status).toBe(403);
    }
  });
});

describe("774 row 7b: subscriptions know their person; push can go to some", () => {
  it("subscribe records who added the device", async () => {
    const r = rig();
    const sub = { endpoint: "https://push.example/new", keys: KEYS };
    const s = await r.call(
      "POST",
      "/api/alerts/subscribe",
      { subscription: sub },
      "person:a",
    );
    expect(s.status).toBe(200);
    const got = r.subs.list().find((x) => x.endpoint === sub.endpoint);
    expect(got?.person).toBe("person:a");
  });

  it("pushEach sends only to the endpoints asked for", async () => {
    const r = rig();
    const hit: string[] = [];
    await pushEach(
      { title: "t", body: "b", link: "/", tag: "x" },
      {
        subs: r.subs,
        keys: () => vapidKeys(dir),
        subject: "mailto:x@example.com",
        timeoutMs: 1000,
        ttlSeconds: 60,
        only: [MINE],
        fetch: (async (u: string) => {
          hit.push(u);
          return new Response(null, { status: 201 });
        }) as never,
      },
    );
    expect(hit).toEqual([MINE]);
  });
});
