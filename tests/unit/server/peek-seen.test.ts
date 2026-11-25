/**
 * The mock's "Seen" rule: opening a peek counts as looking. The
 * bell's one read call says so (`seen: true` with the agent's subject):
 * its items are read, and the person's seen mark (subject +
 * version + person) is recorded, so a Done agent becomes Idle for them.
 * A plain read (the row's Open in Agents link, Mark read) records no mark.
 * The route without a server: fake request and response, a temp store.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import type * as http from "http";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { handleNotificationRoutes } from "../../../src/ui/server/notification-routes.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-791-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function req(body: unknown): http.IncomingMessage {
  const r = Readable.from([JSON.stringify(body)]) as unknown as Record<
    string,
    unknown
  >;
  r.method = "POST";
  r.headers = { "content-type": "application/json" };
  r.url = "/api/notifications/read";
  return r as unknown as http.IncomingMessage;
}

function res() {
  const out = { status: 0, body: "" };
  const r = {
    writeHead(s: number) {
      out.status = s;
      return r;
    },
    setHeader() {},
    end(b?: string) {
      out.body = b ?? "";
    },
  };
  return { r: r as unknown as http.ServerResponse, out };
}

/** Bell v6's kinds turned off (none: every kind shown). */
function rig(off: string[] = []) {
  const store = new NotificationStore(dir);
  store.add({
    kind: "waiting",
    subject: "agent:planner",
    scope: "workspace/north",
    text: "planner needs your permission",
  });
  store.add({
    kind: "finished",
    subject: "agent:planner",
    scope: "workspace/north",
    text: "planner finished",
  });
  const seen: string[] = [];
  const deps = {
    store,
    attention: {} as never,
    prefs: () => ({ off, foldDays: 7 }) as never,
    // The seen-mark store: only markSeen is asked for here.
    seen: {
      markSeen: (k: { subject: string; person: string }) => {
        seen.push(k.subject);
        return true;
      },
    } as never,
  };
  return { store, seen, deps };
}

describe("issue 791: a peek is a look (the seen mark)", () => {
  it("read with seen: every item of the agent's the bell shows is read, and its seen mark is recorded", async () => {
    const { store, seen, deps } = rig();
    const { r, out } = res();
    await handleNotificationRoutes(
      req({ subject: "agent:planner", seen: true }),
      r,
      "/api/notifications/read",
      deps,
    );
    expect(out.status).toBe(200);
    expect(store.list().every((n) => n.read)).toBe(true);
    expect(seen).toEqual(["agent:planner"]);
  });

  it("a kind the person turned off stays unread: a peek marks only what it showed", async () => {
    const { store, seen, deps } = rig(["finished"]);
    const { r, out } = res();
    await handleNotificationRoutes(
      req({ subject: "agent:planner", seen: true }),
      r,
      "/api/notifications/read",
      deps,
    );
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).changed).toBe(1);
    const byKind = Object.fromEntries(
      store.list().map((n) => [n.kind, n.read]),
    );
    expect(byKind).toEqual({ waiting: true, finished: false });
    expect(seen).toEqual(["agent:planner"]);
  });

  it("a plain read (Open in Agents, Mark read) records no seen mark", async () => {
    const { seen, deps } = rig();
    const { r } = res();
    await handleNotificationRoutes(
      req({ subject: "agent:planner" }),
      r,
      "/api/notifications/read",
      deps,
    );
    expect(seen).toEqual([]);
  });

  it("seen is for an agent's subject only", async () => {
    const { seen, deps } = rig();
    const { r } = res();
    await handleNotificationRoutes(
      req({ subject: "record:x", seen: true }),
      r,
      "/api/notifications/read",
      deps,
    );
    expect(seen).toEqual([]);
  });

  it("the peek's read says seen: true (bell.js)", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/ui/server/public/bell.js"),
      "utf8",
    );
    expect(src).toMatch(
      /target\s*\?\s*\{\s*subject: `agent:\$\{target\.agent\}`,\s*seen: true\s*\}/,
    );
  });
});
