/**
 * Issue 750: GET /api/hub/groups, for the agents page's By group view.
 * Den reads the install's groups from Hub (a stub here) and adds each
 * group's links into Hub (Open, Message group: Hub's composer) from Den's
 * own Hub connection (its URL, the company's slug). Den stores no groups:
 * at most a copy in memory for hub.groups_cache_seconds.
 * - no Hub connected: state "none" (the page's quiet line, no group UI);
 * - 403 groups_not_in_plan: state "unavailable" (the same line);
 * - any other 403: state "refused" with Hub's words.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { PassThrough } from "stream";
import {
  hubGroupsRoute,
  type HubGroupsDeps,
} from "../../../src/ui/server/hub-groups-routes.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
});

const GROUPS = {
  team: "acme",
  rule: "advise",
  groups: [
    {
      name: "Web Delivery",
      slug: "web-delivery",
      all: "web-delivery/all",
      address: "web-delivery/lead",
      lead: {
        name: "Web Planner",
        kind: "agent",
        of: "pat",
        install: "Bench",
        agent_id: "planner",
      },
      escalates_to: "pat",
      members: [
        {
          role: "planner",
          address: "web-delivery/planner",
          name: "Web Planner",
          kind: "agent",
          of: "pat",
          install: "Bench",
          agent_id: "planner",
        },
      ],
    },
  ],
};

async function stubHub(answer: () => [number, unknown]) {
  let calls = 0;
  const s = http.createServer((_req, res) => {
    calls++;
    const [status, json] = answer();
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    calls: () => calls,
  };
}

async function call(d: HubGroupsDeps, method = "GET", url = "/api/hub/groups") {
  const req = Object.assign(new PassThrough(), {
    method,
    headers: {},
    url,
  }) as unknown as http.IncomingMessage;
  let status = 0;
  let body = "";
  const res = {
    setHeader: () => undefined,
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    end: (b?: string) => {
      body = b ?? "";
    },
    statusCode: 200,
    headersSent: false,
  } as unknown as http.ServerResponse;
  await hubGroupsRoute(req, res, d);
  return { status: status || 200, json: JSON.parse(body) };
}

const deps = (
  o: Partial<HubGroupsDeps> & { url?: string | null },
): HubGroupsDeps => ({
  hub: async () => (o.url ? { url: o.url, token: "tok_TESTONLY" } : null),
  company: () => "acme",
  self: async () => ({ install: "Bench", login: "pat" }),
  cacheSeconds: () => 30,
  enabled: () => true,
  cache: new Map(),
  ...o,
});

describe("issue 750: GET /api/hub/groups", () => {
  it("hub.groups off (the default): state off, and Hub is never asked", async () => {
    const hub = await stubHub(() => [200, GROUPS]);
    const r = await call(deps({ url: hub.url, enabled: () => false }));
    expect(r.json).toEqual({ ok: true, state: "off" });
    expect(hub.calls()).toBe(0);
    // No Hub connected and off: still off (no "Groups come with Den Hub").
    expect(
      (await call(deps({ url: null, enabled: () => false }))).json,
    ).toEqual({ ok: true, state: "off" });
  });

  it("a Hub with no groups route (404, or 405): state off, nothing alarming, kept in memory", async () => {
    for (const status of [404, 405]) {
      const hub = await stubHub(() => [status, { error: "not_found" }]);
      const d = deps({ url: hub.url });
      expect((await call(d)).json).toEqual({ ok: true, state: "off" });
      await call(d);
      expect(hub.calls()).toBe(1);
    }
  });

  it("no Hub connected: state none, nothing asked", async () => {
    const r = await call(deps({ url: null }));
    expect(r.json).toEqual({ ok: true, state: "none" });
  });

  it("GR-T12: Hub's groups, each with Open and Message group links into Hub", async () => {
    const hub = await stubHub(() => [200, GROUPS]);
    const r = await call(deps({ url: hub.url }));
    expect(r.json.state).toBe("ok");
    expect(r.json.rule).toBe("advise");
    expect(r.json.hub).toBe(`${hub.url}/acme`);
    expect(r.json.groupsUrl).toBe(`${hub.url}/acme/groups`);
    const g = r.json.groups[0];
    expect(g).toMatchObject({
      name: "Web Delivery",
      slug: "web-delivery",
      all: "web-delivery/all",
      lead: {
        name: "Web Planner",
        kind: "agent",
        agentId: "planner",
        here: true,
      },
      open: `${hub.url}/acme/groups/web-delivery`,
      compose: `${hub.url}/acme/groups/web-delivery?compose=1`,
    });
    expect(g.members[0]).toMatchObject({
      role: "planner",
      agentId: "planner",
      here: true,
    });
  });

  it("another person's agent with the same id is not marked here", async () => {
    const hub = await stubHub(() => [200, GROUPS]);
    const r = await call(
      deps({
        url: hub.url,
        self: async () => ({ install: "Bench", login: "sam" }),
      }),
    );
    expect(r.json.groups[0].members[0].here).toBeUndefined();
    expect(r.json.groups[0].lead.here).toBeUndefined();
  });

  it("the company's slug comes from Den's Hub connection; else Hub's team", async () => {
    const hub = await stubHub(() => [200, GROUPS]);
    const r = await call(deps({ url: hub.url, company: () => "north-co" }));
    expect(r.json.groups[0].open).toBe(
      `${hub.url}/north-co/groups/web-delivery`,
    );
    const r2 = await call(deps({ url: hub.url, company: () => null }));
    expect(r2.json.groups[0].open).toBe(`${hub.url}/acme/groups/web-delivery`);
  });

  it("kept in memory for hub.groups_cache_seconds; ?fresh=1 reads Hub now", async () => {
    const hub = await stubHub(() => [200, GROUPS]);
    const d = deps({ url: hub.url });
    await call(d);
    await call(d);
    expect(hub.calls()).toBe(1);
    await call(d, "GET", "/api/hub/groups?fresh=1");
    expect(hub.calls()).toBe(2);
    const d0 = deps({ url: hub.url, cacheSeconds: () => 0 });
    await call(d0);
    await call(d0);
    expect(hub.calls()).toBe(4);
  });

  it("GR-T19: 403 groups_not_in_plan: unavailable, with Open Hub", async () => {
    const hub = await stubHub(() => [
      403,
      { error: "Groups aren't part of this plan", code: "groups_not_in_plan" },
    ]);
    const r = await call(deps({ url: hub.url }));
    expect(r.json).toEqual({
      ok: true,
      state: "unavailable",
      hub: `${hub.url}/acme`,
    });
  });

  it("GR-T19: 403 install_refused (a guest): refused, no words of Hub's", async () => {
    const hub = await stubHub(() => [
      403,
      { error: "Guests can't read groups", code: "install_refused" },
    ]);
    const r = await call(deps({ url: hub.url }));
    expect(r.json).toEqual({ ok: true, state: "refused" });
  });

  it("a 5xx: unreachable, and asked again next time", async () => {
    const hub = await stubHub(() => [502, { error: "bad gateway" }]);
    const d = deps({ url: hub.url });
    expect((await call(d)).json).toEqual({ ok: true, state: "unreachable" });
    await call(d);
    expect(hub.calls()).toBe(2);
  });

  it("only GET", async () => {
    const r = await call(deps({ url: null }), "POST");
    expect(r.status).toBe(405);
  });
});
