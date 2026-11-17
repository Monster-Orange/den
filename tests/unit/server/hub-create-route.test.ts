/**
 * Issue 271: POST /api/workspaces/:ws/hub-create {name} asks Hub for a new
 * project for Den project `ws` (Hub's project plan path, held for an
 * owner), and GET /api/workspaces/:ws/hub-project says what became of it:
 * the ask while it waits, whether this install's person is an owner (so
 * Settings shows Hub's Allow in place, or says who must allow it), and the
 * link once an owner allowed it. A person's only; an agent asks with the
 * held write. A stub Hub on localhost plays Hub; the projects file is a
 * map. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  hubCreateRoute,
  HUB_CREATE_ROUTE,
} from "../../../src/ui/server/hub-create-routes.js";
import {
  hubProjectRoute,
  HUB_PROJECT_ROUTE,
} from "../../../src/ui/server/hub-project-routes.js";
import { AUDIT_HEADERS } from "../../../src/shared/agent-actor.js";
import {
  settleHubCreate,
  type HubCreate,
  type HubCreateDeps,
} from "../../../src/shared/hub-project-create.js";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";

const TOKEN = "hubi_TESTONLYabc987";
const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function listen(s: http.Server): Promise<string> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

/** A stub Hub: plan asks, their outcome (`state`), whoami (`role`). */
async function stubHub(role: string) {
  const hub = { base: "", state: "pending", role, asks: 0 };
  hub.base = await listen(
    http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const send = (status: number, b: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(b));
        };
        if (req.method === "POST" && req.url === "/api/projects/plan") {
          hub.asks++;
          return send(201, {
            held: "held_1",
            state: "pending",
            url: `${hub.base}/acme/held/held_1`,
          });
        }
        if (req.url === "/api/projects/plan/held_1")
          return send(200, {
            held: "held_1",
            state: hub.state,
            projects: [
              {
                id: hub.state === "applied" ? "proj_north1" : null,
                slug: "north-star",
                name: "North Star",
                url: null,
              },
            ],
          });
        send(404, { error: "no route" });
      });
    }),
  );
  return hub;
}

async function serve(role = "owner") {
  const hub = await stubHub(role);
  const kept = new Map<string, HubCreate | null>();
  const links = new Map<string, HubProjectLink | null>();
  const d: HubCreateDeps = {
    exists: (ws) => ws === "north",
    linked: (ws) => links.get(ws) ?? null,
    asked: (ws) => kept.get(ws) ?? null,
    hub: async () => ({ url: hub.base, token: TOKEN }),
    taken: async () => [],
    keep: (ws, c) => void kept.set(ws, c),
    link: (ws, l) => void links.set(ws, l),
    changed: () => undefined,
    now: () => new Date("2026-11-17T17:00:00.000Z"),
  };
  const base = await listen(
    http.createServer((req, res) => {
      const p = new URL(req.url!, "http://x").pathname;
      const c = HUB_CREATE_ROUTE.exec(p);
      if (c) return void hubCreateRoute(req, res, c[1], d);
      const h = HUB_PROJECT_ROUTE.exec(p);
      if (h)
        return void hubProjectRoute(req, res, h[1], {
          exists: d.exists,
          read: (ws) => links.get(ws) ?? null,
          write: () => undefined,
          uncovered: () => [],
          changed: () => undefined,
          choices: async () => ({ suggestions: [], projects: [] }),
          name: () => "North Star",
          whoami: async () => ({ role: hub.role, company: "Acme Co" }),
          create: async (ws) => {
            await settleHubCreate(d, ws);
            return d.asked(ws);
          },
        });
      res.writeHead(404).end();
    }),
  );
  return { hub, kept, links, base: `${base}/api/workspaces` };
}

const post = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const get = async (url: string) =>
  (await (await fetch(url)).json()) as Record<string, unknown>;

describe("POST /api/workspaces/:ws/hub-create", () => {
  it("asks Hub, keeps the ask; GET shows it waiting, with Hub's Allow for an owner", async () => {
    const s = await serve("owner");
    const r = await post(`${s.base}/north/hub-create`, {
      name: " North Star ",
    });
    expect(r.status).toBe(200);
    const ask = {
      held: "held_1",
      name: "North Star",
      slug: "north-star",
      url: `${s.hub.base}/acme/held/held_1`,
      askedAt: "2026-11-17T17:00:00.000Z",
      by: "person",
    };
    expect(await r.json()).toEqual({ ok: true, project: "north", ask });
    const g = await get(`${s.base}/north/hub-project`);
    expect(g).toMatchObject({
      hub: null,
      name: "North Star",
      owner: true,
      company: "Acme Co",
      create: ask,
    });
  });

  it("not an owner: GET says so (who must allow it), still waiting", async () => {
    const s = await serve("developer");
    await post(`${s.base}/north/hub-create`, { name: "North Star" });
    expect(await get(`${s.base}/north/hub-project`)).toMatchObject({
      owner: false,
      company: "Acme Co",
      create: { held: "held_1" },
    });
  });

  it("an owner allows it in Hub: the next GET links it, by the new project's id", async () => {
    const s = await serve("developer");
    await post(`${s.base}/north/hub-create`, { name: "North Star" });
    s.hub.state = "applied";
    const g = await get(`${s.base}/north/hub-project`);
    expect(g).toMatchObject({
      hub: { id: "proj_north1", slug: "north-star", name: "North Star" },
      create: null,
    });
    expect(s.links.get("north")?.id).toBe("proj_north1");
  });

  it("declined: GET says so; a new ask may be made", async () => {
    const s = await serve();
    await post(`${s.base}/north/hub-create`, { name: "North Star" });
    s.hub.state = "declined";
    expect(await get(`${s.base}/north/hub-project`)).toMatchObject({
      hub: null,
      create: { outcome: "declined" },
    });
    s.hub.state = "pending";
    const again = await post(`${s.base}/north/hub-create`, { name: "N" });
    expect(again.status).toBe(200);
    expect(s.hub.asks).toBe(2);
  });

  it("refusals: an agent, a bad name, an ask waiting; Hub asked once", async () => {
    const s = await serve();
    const a = await post(
      `${s.base}/north/hub-create`,
      { name: "North" },
      { [AUDIT_HEADERS.actor]: "agent", [AUDIT_HEADERS.agent]: "planner" },
    );
    expect(a.status).toBe(403);
    expect((await a.json()).code).toBe("person_only");
    expect(
      (await post(`${s.base}/north/hub-create`, { name: "" })).status,
    ).toBe(400);
    expect(
      (await post(`${s.base}/ghost/hub-create`, { name: "G" })).status,
    ).toBe(404);
    expect(
      (await post(`${s.base}/north/hub-create`, { name: "North" })).status,
    ).toBe(200);
    const w = await post(`${s.base}/north/hub-create`, { name: "North" });
    expect(w.status).toBe(409);
    expect((await w.json()).code).toBe("waiting");
    const m = await fetch(`${s.base}/north/hub-create`);
    expect(m.status).toBe(405);
    expect(s.hub.asks).toBe(1);
  });
});
