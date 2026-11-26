/**
 * Issue 271: create a Hub project for a Den project, and link it once an
 * owner allows it in Hub. One piece of code for Settings and for the
 * server agent's held write: askHubCreate asks Hub (its project plan path)
 * and keeps the ask next to the project (<ws>.hub_create); settleHubCreate
 * reads Hub's outcome and, when applied, links by the new project's hidden
 * id. 1:1 (0.4.45): a linked project, or one with an ask waiting, is
 * refused. A stub Hub on localhost plays Hub; the projects file is a map.
 * Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  askHubCreate,
  parseHubCreate,
  settleHubCreate,
  type HubCreate,
  type HubCreateDeps,
} from "../../../src/shared/hub/hub-project-create.js";
import type { HubProjectLink } from "../../../src/shared/hub/hub-project-link.js";

const TOKEN = "hubi_TESTONLYabc987";
const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

/** A stub Hub that holds asks and answers outcomes from `state`. */
async function stubHub() {
  const hub = {
    base: "",
    asks: [] as { slug: string; name: string; reason: string }[],
    state: "pending" as string,
    outcomes: 0,
  };
  const s = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`)
        return send(401, { error: "no" });
      if (req.method === "POST" && req.url === "/api/projects/plan") {
        const b = JSON.parse(raw) as {
          changes: { slug: string; name: string }[];
          reason: string;
        };
        hub.asks.push({ ...b.changes[0], reason: b.reason });
        return send(201, {
          held: "held_1",
          state: "pending",
          summary: "1 project change",
          url: `${hub.base}/acme/held/held_1`,
        });
      }
      if (req.method === "GET" && req.url === "/api/projects/plan/held_1") {
        hub.outcomes++;
        const a = hub.asks[0];
        return send(200, {
          held: "held_1",
          state: hub.state,
          decided_at: hub.state === "pending" ? null : "2026-11-17T18:00:00Z",
          projects: [
            {
              id: hub.state === "applied" ? "proj_north1" : null,
              slug: a.slug,
              name: a.name,
              url: null,
            },
          ],
        });
      }
      send(404, { error: "no route" });
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  hub.base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return hub;
}

async function setup(
  over: Partial<HubCreateDeps> = {},
  links: Record<string, HubProjectLink> = {},
) {
  const hub = await stubHub();
  const kept = new Map<string, HubCreate | null>();
  const linked = new Map<string, HubProjectLink>(Object.entries(links));
  let changed = 0;
  const d: HubCreateDeps = {
    exists: (ws) => ["north", "south"].includes(ws),
    linked: (ws) => linked.get(ws) ?? null,
    asked: (ws) => kept.get(ws) ?? null,
    hub: async () => ({ url: hub.base, token: TOKEN }),
    taken: async () => ["back-office"],
    keep: (ws, c) => void kept.set(ws, c),
    link: (ws, l) => void linked.set(ws, l),
    changed: () => void changed++,
    now: () => new Date("2026-11-17T17:00:00.000Z"),
    ...over,
  };
  return { hub, d, kept, linked, changed: () => changed };
}

describe("askHubCreate", () => {
  it("asks Hub for the project and keeps the ask; nothing is linked yet", async () => {
    const s = await setup();
    const r = await askHubCreate(s.d, {
      ws: "north",
      name: "  North   Star ",
      by: "person",
    });
    expect(r).toEqual({
      ok: true,
      ask: {
        held: "held_1",
        name: "North Star",
        slug: "north-star",
        url: `${s.hub.base}/acme/held/held_1`,
        askedAt: "2026-11-17T17:00:00.000Z",
        by: "person",
      },
    });
    expect(s.hub.asks).toEqual([
      {
        op: "create",
        slug: "north-star",
        name: "North Star",
        reason: 'Asked in Den, Settings › Project › Hub project, for "north"',
      },
    ]);
    expect(s.kept.get("north")).toEqual(r.ok && r.ask);
    expect(s.linked.size).toBe(0);
  });

  it("1:1: a linked project, or one with an ask waiting, is refused; Hub isn't asked", async () => {
    const s = await setup(
      {},
      { south: { id: "proj_s1", slug: "south", name: "South" } },
    );
    const a = await askHubCreate(s.d, { ws: "south", name: "S", by: "person" });
    expect(a).toMatchObject({ ok: false, status: 409, code: "linked" });
    await askHubCreate(s.d, { ws: "north", name: "North", by: "person" });
    const b = await askHubCreate(s.d, { ws: "north", name: "N", by: "person" });
    expect(b).toMatchObject({ ok: false, status: 409, code: "waiting" });
    expect(s.hub.asks).toHaveLength(1);
  });

  it("no such project, a bad name, Hub not connected: refused in words", async () => {
    const s = await setup();
    expect(
      await askHubCreate(s.d, { ws: "east", name: "E", by: "person" }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await askHubCreate(s.d, { ws: "north", name: " ", by: "person" }),
    ).toMatchObject({ ok: false, status: 400, code: "name" });
    expect(
      await askHubCreate(s.d, {
        ws: "north",
        name: "n".repeat(81),
        by: "person",
      }),
    ).toMatchObject({ ok: false, status: 400, code: "name" });
    const off = await setup({ hub: async () => null });
    expect(
      await askHubCreate(off.d, { ws: "north", name: "N", by: "person" }),
    ).toMatchObject({ ok: false, status: 409, code: "offline" });
    expect(s.hub.asks).toHaveLength(0);
  });

  it("an agent's ask (the held write) says which agent, for Hub's answer to reach it", async () => {
    const s = await setup();
    const r = await askHubCreate(s.d, {
      ws: "north",
      name: "North",
      by: "agent",
      agent: { id: "agt_den1", name: "Den" },
    });
    expect(r.ok && r.ask).toMatchObject({ by: "agent", agent: "agt_den1" });
    expect(s.hub.asks[0].reason).toBe(
      'Asked by the agent Den in Den, for project "north"',
    );
  });
});

describe("settleHubCreate", () => {
  it("pending: nothing changes; applied: links by the new project's hidden id, once", async () => {
    const s = await setup();
    await askHubCreate(s.d, { ws: "north", name: "North Star", by: "person" });
    expect(await settleHubCreate(s.d, "north")).toEqual({ state: "pending" });
    expect(s.linked.size).toBe(0);
    s.hub.state = "applied";
    expect(await settleHubCreate(s.d, "north")).toEqual({
      state: "applied",
      hub: { id: "proj_north1", slug: "north-star", name: "North Star" },
    });
    expect(s.linked.get("north")).toEqual({
      id: "proj_north1",
      slug: "north-star",
      name: "North Star",
    });
    expect(s.kept.get("north")).toBeNull();
    expect(s.changed()).toBe(1);
    // Done: no more asking Hub.
    const n = s.hub.outcomes;
    expect(await settleHubCreate(s.d, "north")).toEqual({ state: "none" });
    expect(s.hub.outcomes).toBe(n);
  });

  it("declined or superseded: the ask is kept with its outcome, nothing linked", async () => {
    for (const st of ["declined", "superseded"]) {
      const s = await setup();
      await askHubCreate(s.d, { ws: "north", name: "North", by: "person" });
      s.hub.state = st;
      expect(await settleHubCreate(s.d, "north")).toEqual({ state: st });
      expect(s.linked.size).toBe(0);
      expect(s.kept.get("north")).toMatchObject({
        held: "held_1",
        outcome: st,
      });
      // Settled: Hub isn't asked again, and a new ask may be made.
      const n = s.hub.outcomes;
      expect(await settleHubCreate(s.d, "north")).toEqual({ state: st });
      expect(s.hub.outcomes).toBe(n);
      expect(
        (await askHubCreate(s.d, { ws: "north", name: "N", by: "person" })).ok,
      ).toBe(true);
    }
  });

  it("linked meanwhile (a person picked another): the ask is dropped, nothing relinked", async () => {
    const s = await setup();
    await askHubCreate(s.d, { ws: "north", name: "North", by: "person" });
    s.linked.set("north", { id: "proj_x1", slug: "x", name: "X" });
    s.hub.state = "applied";
    expect(await settleHubCreate(s.d, "north")).toEqual({ state: "none" });
    expect(s.linked.get("north")?.id).toBe("proj_x1");
    expect(s.kept.get("north")).toBeNull();
  });

  it("Hub unreachable: still pending, the ask kept", async () => {
    const s = await setup();
    await askHubCreate(s.d, { ws: "north", name: "North", by: "person" });
    const off = { ...s.d, hub: async () => null };
    expect(await settleHubCreate(off, "north")).toEqual({ state: "pending" });
    expect(s.kept.get("north")).toMatchObject({ held: "held_1" });
  });
});

describe("parseHubCreate", () => {
  it("reads a kept ask defensively; a link that isn't http(s) is dropped", () => {
    expect(parseHubCreate(null)).toBeNull();
    expect(parseHubCreate({ held: "h" })).toBeNull();
    expect(
      parseHubCreate({
        held: "held_1",
        name: "North",
        slug: "north",
        url: "javascript:x",
        askedAt: "2026-11-17T17:00:00.000Z",
        by: "person",
        outcome: "weird",
      }),
    ).toEqual({
      held: "held_1",
      name: "North",
      slug: "north",
      askedAt: "2026-11-17T17:00:00.000Z",
      by: "person",
    });
  });
});
