/**
 * Issue 726: a Hub change, on the server. Whatever path changed hub.url
 * (Settings › Hub, POST /api/settings, the hub_connect held write, or a
 * config edit noticed at start), the old token is revoked on the Hub that
 * issued it and removed here, or kept on record for doctor when it can't
 * be (clause 3); the old Hub's bell items go (clause 4); the projects that
 * had links are offered again ("N projects need your pick", clause 1); the
 * running delivery loop drops what it held in memory before the archive
 * (clause 2). Fakes for Hub, the store and the bell; a temp state dir.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HubCallError, type HubConfig } from "../../../src/shared/hub.js";
import {
  bindHub,
  readHubBinding,
  readUnrevoked,
  recordUnrevoked,
} from "../../../src/shared/hub/hub-binding.js";
import {
  NotificationStore,
  type Notification,
} from "../../../src/shared/notifications.js";
import {
  hubChangeAtStart,
  hubUrlSaved,
  isHubBellItem,
  noteHub,
  retireHubToken,
  retryUnrevoked,
  type HubChangeDeps,
} from "../../../src/ui/server/hub-change.js";
import type { WorkspacesFile } from "../../../src/shared/types/index.js";

const OLD = "https://hub-one.example.test";
const NEW = "https://hub-two.example.test";
const TOKEN = "hubi_TESTONLY_726";

let dir: string;
let ws: WorkspacesFile;
let user: Record<string, unknown>;
let store: NotificationStore;
const log: string[] = [];

const cfgOf = (url: string, own = true): HubConfig =>
  ({
    url,
    tokenRef: null,
    tokenSource: own
      ? { kind: "file", path: path.join(dir, "hub", "token") }
      : { kind: "env", name: "SOME_HUB_TOKEN" },
    tokenFrom: "hub.token",
  }) as unknown as HubConfig;

function deps(over: Partial<HubChangeDeps> = {}): HubChangeDeps {
  return {
    stateDir: () => dir,
    now: () => new Date("2026-11-20T10:00:00.000Z"),
    readWorkspaces: () => structuredClone(ws),
    writeWorkspaces: (f) => void (ws = structuredClone(f)),
    bell: () => store,
    stopLoops: async () => void log.push("stop loops"),
    audit: (d) => void log.push(`audit ${d}`),
    readToken: async () => TOKEN,
    revoke: async (url, t) => {
      log.push(`revoke ${url} ${t === TOKEN ? "TOKEN" : t}`);
      return true;
    },
    forget: async (c) => void log.push(`forget ${c.url}`),
    owns: (c) => c.tokenSource?.kind === "file",
    config: () => null,
    readUser: () => structuredClone(user),
    writeUser: (u) => void (user = structuredClone(u)),
    ...over,
  };
}

const add = (n: Partial<Notification> & { subject: string }) =>
  store.add({
    kind: "service",
    scope: "workspace/den-server",
    text: "x",
    ...n,
  } as Parameters<NotificationStore["add"]>[0]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-change-"));
  log.length = 0;
  user = {};
  store = new NotificationStore(dir);
  ws = {
    workspaces: {
      web: { name: "web", hub_project: { id: "proj_old1", slug: "w" } },
      api: { name: "api", hub_project: { id: "proj_old2", slug: "a" } },
      docs: { name: "docs" },
    },
  } as unknown as WorkspacesFile;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("issue 726 clause 4: no bell item from the old Hub remains", () => {
  it("Hub's own items and Den's Hub items go; Den's other items stay", async () => {
    bindHub({ ...deps(), stateDir: dir } as never, {
      url: OLD,
      company: "one",
    });
    store.add({
      source: "hub",
      kind: "mention",
      subject: "thread:t1",
      scope: "hub/p1",
      text: "a mention on the old Hub",
    });
    add({ subject: "record:hub-comments-arriving" });
    add({ subject: "record:hub-pick", kind: "decision" });
    add({ subject: "record:not-at-prompt:a1" });
    store.add({
      kind: "answer",
      subject: "agent:a2",
      scope: "workspace/web",
      text: "a2 finished 1 Hub comment",
      msg: { key: "bell.m.hub", vars: { n: 1 } },
    });
    store.add({
      kind: "answer",
      subject: "agent:a3",
      scope: "workspace/web",
      text: "a3: 1 Hub comment typed in, no answer yet",
      msg: { key: "bell.m.hubNoAnswer", vars: { n: 1 } },
    });
    add({ subject: "agent:a4", kind: "waiting" });
    // list() is newest first: every item but the agent's own is Hub's.
    for (const n of store.list())
      expect(isHubBellItem(n)).toBe(n.subject !== "agent:a4");

    const r = await noteHub(deps(), { url: NEW });
    expect(r.kind).toBe("change");
    const left = store.list();
    expect(
      left.filter((n) => isHubBellItem(n) && n.subject !== "record:hub-pick"),
    ).toEqual([]);
    expect(left.some((n) => n.subject === "agent:a4")).toBe(true);
  });

  it("a cleared address clears the old Hub's items too, and archives nothing", async () => {
    bindHub({ ...deps(), stateDir: dir } as never, { url: OLD });
    add({ subject: "record:hub-comments-arriving" });
    const r = await noteHub(deps(), { url: null });
    expect(r.kind).toBe("cleared");
    expect(store.list()).toEqual([]);
    expect(ws.workspaces.web.hub_project).toBeTruthy();
  });
});

describe("issue 726 clause 1: the picks are offered again", () => {
  it("the bell says how many projects need a pick; the loop stopped before the archive", async () => {
    bindHub({ ...deps(), stateDir: dir } as never, { url: OLD });
    const r = await noteHub(deps(), { url: NEW });
    expect(r).toMatchObject({ kind: "change", repick: 2 });
    const pick = store
      .list()
      .find((n) => n.subject === "record:hub-pick" && !n.read);
    expect(pick?.msg).toEqual({ key: "bell.m.pick", vars: { n: 2 } });
    expect(log[0]).toBe("stop loops");
    expect(log.join("\n")).toMatch(/audit .*hub-one.*hub-two.*2 projects/);
    expect(Object.values(ws.workspaces).every((c) => !c.hub_project)).toBe(
      true,
    );
  });

  it("no project had a link: no pick item", async () => {
    ws = { workspaces: { docs: { name: "docs" } } } as never;
    bindHub({ ...deps(), stateDir: dir } as never, { url: OLD });
    expect((await noteHub(deps(), { url: NEW })).repick).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("the same Hub: nothing stops, nothing goes", async () => {
    bindHub({ ...deps(), stateDir: dir } as never, { url: OLD });
    add({ subject: "record:hub-comments-arriving" });
    expect((await noteHub(deps(), { url: OLD })).kind).toBe("same");
    expect(log).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });
});

describe("issue 726 clause 3: revoke on every path, or doctor names it", () => {
  it("retire: revoked on the Hub that issued it, then removed here", async () => {
    const r = await retireHubToken(deps(), cfgOf(OLD));
    expect(r).toEqual({ revoked: true, recorded: false });
    expect(log).toEqual([`revoke ${OLD} TOKEN`, `forget ${OLD}`]);
    expect(readUnrevoked(dir)).toEqual([]);
  });

  it("retire: Hub unreachable: removed here, kept on record for doctor and a retry", async () => {
    const r = await retireHubToken(
      deps({
        revoke: async () => {
          throw new HubCallError("unreachable", "Hub didn't answer");
        },
      }),
      cfgOf(OLD),
    );
    expect(r).toEqual({ revoked: false, recorded: true });
    expect(log).toEqual([`forget ${OLD}`]);
    const [u] = readUnrevoked(dir);
    expect(u).toMatchObject({ url: OLD });
    expect(u.why).toMatch(/didn't answer/);
    expect(JSON.stringify(u)).not.toContain("TESTONLY");
  });

  it("a retry clears a record once that Hub revokes it (or already had)", async () => {
    recordUnrevoked(dir, { url: OLD, why: "down", token: TOKEN });
    recordUnrevoked(dir, { url: NEW, why: "down", token: TOKEN });
    const n = await retryUnrevoked(
      deps({
        revoke: async (url) => {
          if (url === NEW) throw new HubCallError("unreachable", "still down");
          return false; // already revoked there
        },
      }),
    );
    expect(n).toBe(1);
    expect(readUnrevoked(dir).map((u) => u.url)).toEqual([NEW]);
  });

  it("POST /api/settings (hubUrlSaved): a new address revokes the old token, then archives", async () => {
    bindHub({ ...deps(), stateDir: dir } as never, { url: OLD });
    await hubUrlSaved(deps(), cfgOf(OLD), NEW);
    expect(log[0]).toBe(`revoke ${OLD} TOKEN`);
    expect(log).toContain("stop loops");
    expect(readHubBinding(dir)?.origin).toBe(NEW);
  });

  it("hubUrlSaved: the page disconnected first (no token left): no second revoke", async () => {
    bindHub({ ...deps(), stateDir: dir } as never, { url: OLD });
    const c = { ...cfgOf(OLD), tokenSource: undefined } as HubConfig;
    await hubUrlSaved(deps(), c, NEW);
    expect(log.some((l) => l.startsWith("revoke"))).toBe(false);
    expect(readHubBinding(dir)?.origin).toBe(NEW);
  });

  it("hubUrlSaved: the same address keeps the token", async () => {
    bindHub({ ...deps(), stateDir: dir } as never, { url: OLD });
    await hubUrlSaved(deps(), cfgOf(OLD), `${OLD}/`);
    expect(log).toEqual([]);
  });

  it("start: a config edit to another Hub revokes Den's own token at the old one and drops it", async () => {
    bindHub({ ...deps(), stateDir: dir } as never, { url: OLD });
    user = { hub: { url: NEW, token: "file:/x", mcp_url: `${OLD}/mcp` } };
    const r = await hubChangeAtStart(deps({ config: () => cfgOf(NEW) }));
    expect(r.kind).toBe("change");
    expect(log[0]).toBe(`revoke ${OLD} TOKEN`);
    expect(user).toEqual({ hub: { url: NEW } });
    expect(ws.workspaces.web.hub_project).toBeUndefined();
  });

  it("start: a token the distribution set is not Den's to revoke or drop", async () => {
    bindHub({ ...deps(), stateDir: dir } as never, { url: OLD });
    user = { hub: { url: NEW, token: { key: "HUB" } } };
    await hubChangeAtStart(deps({ config: () => cfgOf(NEW, false) }));
    expect(log.some((l) => l.startsWith("revoke"))).toBe(false);
    expect(user).toEqual({ hub: { url: NEW, token: { key: "HUB" } } });
    expect(readHubBinding(dir)?.origin).toBe(NEW);
  });

  it("start: the same Hub retries what wasn't revoked, and binds a first-seen Hub", async () => {
    recordUnrevoked(dir, { url: OLD, why: "down", token: TOKEN });
    const r = await hubChangeAtStart(deps({ config: () => cfgOf(OLD) }));
    expect(r.kind).toBe("bind");
    expect(readUnrevoked(dir)).toEqual([]);
    expect(readHubBinding(dir)?.origin).toBe(OLD);
  });
});
