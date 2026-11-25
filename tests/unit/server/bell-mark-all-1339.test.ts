/**
 * Issue 1339: "Mark all read" in the bell took seconds with about 76
 * entries. The route marked each shown entry with its own markRead({id}),
 * and each one read, parsed and rewrote notifications.json whole.
 *
 *   1. markReadMany(ids) marks exactly those ids, in one read and one write.
 *   2. POST /api/notifications/read {all: true} on 100 unread entries
 *      writes the store once and answers well under 1 s.
 *   3. It still marks only what is shown (a kind that is off stays unread),
 *      and the badge number it answers is right.
 *   4. Clear read writes once too.
 *
 * Invented names only.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  NotificationStore,
  type NotificationKind,
} from "../../../src/shared/notifications.js";
import { Attention } from "../../../src/ui/server/attention.js";
import { handleNotificationRoutes } from "../../../src/ui/server/notification-routes.js";
import {
  setPrincipal,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

let dir = "";
let store: NotificationStore;
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url!, "http://x").pathname;
    setPrincipal(req, {
      kind: "person-browser",
      session: "sess-1339",
    } as Principal);
    void (async () => {
      const attention = new Attention({
        store,
        outputMark: async () => "m",
        nameOf: (a) => a,
        hooked: () => true,
        tell: async () => true,
      });
      if (
        await handleNotificationRoutes(req, res, pathname, { store, attention })
      )
        return;
      res.writeHead(404);
      res.end();
    })();
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1339-"));
  store = new NotificationStore(dir);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * `n` unread entries, each its own agent (so none fold into another),
 * oldest first. Issue 1385: written to the store's file at once. 100
 * add() calls were 100 whole-file reads and writes (about 0.5 s alone, and
 * past jest's 10 s under a full suite's load); the store's own add is
 * tested elsewhere.
 */
function fill(n: number, kinds: NotificationKind[] = ["waiting", "service"]) {
  const now = Date.now();
  const items = Array.from({ length: n }, (_, i) => ({
    id: `n1339-${i}`,
    source: "den",
    kind: kinds[i % kinds.length],
    subject: `agent:a${i}`,
    scope: "workspace/north",
    text: `Entry ${i} says something a person might read in the bell.`,
    at: new Date(now - (n - i) * 1000).toISOString(),
    read: false,
  }));
  fs.writeFileSync(
    path.join(dir, "notifications.json"),
    `${JSON.stringify({ items, mutes: [] })}\n`,
    { mode: 0o600 },
  );
}

/**
 * Issue 1385: runs `check`, and a failure says where the time went (the
 * fill, the POST), so a slow CI run can be read from its message.
 */
function saysTimes(times: Record<string, number>, check: () => void): void {
  try {
    check();
  } catch (e) {
    const said = Object.entries(times)
      .map(([k, ms]) => `${k} ${ms.toFixed(1)} ms`)
      .join(", ");
    if (e instanceof Error) e.message += `\n\nTimes: ${said}`;
    throw e;
  }
}

/** Counts the store's whole-file writes from here on. */
function countWrites(): () => number {
  const proto = NotificationStore.prototype as unknown as {
    write: (...a: unknown[]) => void;
  };
  const spy = jest.spyOn(proto, "write");
  return () => spy.mock.calls.length;
}

const post = async (p: string, body: unknown) => {
  const r = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    json: (await r.json()) as { changed?: number; unread?: number },
  };
};

describe("markReadMany (issue 1339)", () => {
  it("marks exactly the given ids, in one write", () => {
    fill(6);
    const ids = store.list().map((n) => n.id);
    const writes = countWrites();
    expect(store.markReadMany([ids[1], ids[4], "no-such-id"])).toBe(2);
    expect(writes()).toBe(1);
    const read = store
      .list()
      .filter((n) => n.read)
      .map((n) => n.id)
      .sort();
    expect(read).toEqual([ids[1], ids[4]].sort());
  });

  it("no change, no write", () => {
    fill(2);
    const ids = store.list().map((n) => n.id);
    store.markReadMany(ids);
    const writes = countWrites();
    expect(store.markReadMany(ids)).toBe(0);
    expect(store.markReadMany([])).toBe(0);
    expect(writes()).toBe(0);
  });
});

describe("POST /api/notifications/read {all: true} (issue 1339)", () => {
  it("100 unread: one write, well under 1 s, all marked", async () => {
    let t0 = performance.now();
    fill(100);
    const fillMs = performance.now() - t0;
    const writes = countWrites();
    t0 = performance.now();
    const r = await post("/api/notifications/read", { all: true });
    const ms = performance.now() - t0;
    saysTimes({ fill: fillMs, POST: ms }, () => {
      expect(r.status).toBe(200);
      expect(r.json.changed).toBe(100);
      expect(r.json.unread).toBe(0);
      expect(writes()).toBe(1);
      // The one write is the proof; the bound only catches a gross slowdown.
      expect(ms).toBeLessThan(1_000);
      expect(store.list().every((n) => n.read)).toBe(true);
    });
  });

  it("a kind that is off stays unread (marks what is shown)", async () => {
    fill(4, ["waiting", "finished"]);
    const r = await post("/api/notifications/read", { all: true });
    expect(r.json.changed).toBe(2);
    const left = store.list().filter((n) => !n.read);
    expect(left.map((n) => n.kind)).toEqual(["finished", "finished"]);
  });
});

describe("Clear read (issue 1339)", () => {
  it("one write for all the read entries", async () => {
    fill(50);
    store.markReadMany(store.list().map((n) => n.id));
    const writes = countWrites();
    const r = await post("/api/notifications/clear", {});
    expect(r.json.changed).toBe(50);
    expect(writes()).toBe(1);
    expect(store.list()).toEqual([]);
  });
});
