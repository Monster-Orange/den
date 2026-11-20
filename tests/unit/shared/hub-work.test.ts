/**
 * Issue 754: Den reads what Hub knows about the work, through the install
 * token, against a stub Hub (Hub's two routes are not built yet: the
 * contract is src/shared/hub-work.ts). Nothing is stored on disk.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  HubWorkReader,
  readAgentsCurrent,
  readProjectWork,
} from "../../../src/shared/hub-work.js";

const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

interface Seen {
  path: string;
  auth?: string;
}

async function stubHub(
  answer: (path: string) => { status: number; body: unknown },
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    const a = answer(req.url ?? "");
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(JSON.stringify(a.body));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    seen,
  };
}

const WORK = {
  needs_you: { count: 2, url: "https://hub.example/p/needs" },
  building: { count: 5, url: "https://hub.example/p/building" },
  blocked: { count: 1, url: "https://hub.example/p/blocked" },
  visions: [
    {
      id: "v1",
      title: "Den shows the work",
      url: "https://hub.example/v/v1",
      done: 3,
      total: 8,
    },
  ],
};

describe("readProjectWork (contract per den#754)", () => {
  it("keeps the counts, their links and each vision's progress", () => {
    expect(readProjectWork(WORK)).toEqual({
      needsYou: { count: 2, url: "https://hub.example/p/needs" },
      building: { count: 5, url: "https://hub.example/p/building" },
      blocked: { count: 1, url: "https://hub.example/p/blocked" },
      visions: [
        {
          id: "v1",
          title: "Den shows the work",
          url: "https://hub.example/v/v1",
          done: 3,
          total: 8,
        },
      ],
    });
  });
  it("drops links that aren't http(s) and clamps done to total", () => {
    const w = readProjectWork({
      ...WORK,
      needs_you: { count: 1, url: "javascript:alert(1)" },
      visions: [{ id: "v", title: "x", url: "data:x", done: 9, total: 4 }],
    });
    expect(w?.needsYou).toEqual({ count: 1, url: null });
    expect(w?.visions[0]).toMatchObject({ url: null, done: 4, total: 4 });
  });
  it("is null for an answer that isn't the shape", () => {
    expect(readProjectWork(null)).toBeNull();
    expect(readProjectWork([])).toBeNull();
  });
});

describe("readAgentsCurrent (contract per den#754)", () => {
  it("maps each agent id to its item, vision, source and since", () => {
    const m = readAgentsCurrent([
      {
        agent_id: "ag-1",
        item: {
          id: "i1",
          title: "Card",
          kind: "story",
          url: "https://hub.example/i/1",
        },
        vision: { id: "v1", title: "V", url: "https://hub.example/v/1" },
        source: "working",
        since: "2026-11-20T10:00:00Z",
      },
      {
        agent_id: "ag-2",
        item: null,
        vision: null,
        source: "recent",
        since: null,
      },
      { agent_id: "ag-3", item: { id: "x", title: "t" }, source: "bogus" },
    ]);
    expect(m["ag-1"]).toEqual({
      item: {
        id: "i1",
        title: "Card",
        kind: "story",
        url: "https://hub.example/i/1",
      },
      vision: { id: "v1", title: "V", url: "https://hub.example/v/1" },
      source: "working",
      since: "2026-11-20T10:00:00Z",
    });
    expect(m["ag-2"]).toEqual({
      item: null,
      vision: null,
      source: "recent",
      since: null,
    });
    // A source Den doesn't know shows nothing.
    expect(m["ag-3"]).toBeUndefined();
  });
});

describe("HubWorkReader against a stub Hub", () => {
  it("no Hub connected: state none, Hub never asked", async () => {
    const r = new HubWorkReader({ hub: async () => null });
    expect(await r.projectWork(["den"])).toEqual({ hub: "none" });
    expect(await r.agentsCurrent(["ag-1"])).toEqual({ hub: "none" });
  });

  it("asks GET /api/projects/:project/work with the install token", async () => {
    const hub = await stubHub(() => ({ status: 200, body: WORK }));
    const r = new HubWorkReader({
      hub: async () => ({ url: hub.url, token: "tok-1" }),
      projectOf: (ws) =>
        ws === "den" ? { id: "proj_abc", slug: "den", name: "Den" } : null,
    });
    const got = await r.projectWork(["den", "unlinked"]);
    expect(got).toEqual({
      hub: "ok",
      projects: [
        { project: "den", work: readProjectWork(WORK) },
        { project: "unlinked", work: null, linked: false },
      ],
    });
    expect(hub.seen).toEqual([
      { path: "/api/projects/proj_abc/work", auth: "Bearer tok-1" },
    ]);
  });

  it("a 403 plan refusal: state refused, no card", async () => {
    const hub = await stubHub(() => ({
      status: 403,
      body: { error: "groups_not_in_plan", message: "Not in your plan" },
    }));
    const r = new HubWorkReader({
      hub: async () => ({ url: hub.url, token: "t" }),
      projectOf: () => ({ id: "proj_a", slug: "a", name: "A" }),
    });
    expect(await r.projectWork(["a"])).toEqual({
      hub: "refused",
      code: "groups_not_in_plan",
    });
    expect(await r.agentsCurrent(["ag-1"])).toEqual({
      hub: "refused",
      code: "groups_not_in_plan",
    });
  });

  it("asks GET /api/agents/current once for the page's agents", async () => {
    const hub = await stubHub(() => ({
      status: 200,
      body: [
        {
          agent_id: "ag-1",
          item: { id: "i", title: "T", kind: "bug", url: "https://h/i" },
          vision: null,
          source: "recent",
          since: "2026-11-19T00:00:00Z",
        },
      ],
    }));
    const r = new HubWorkReader({
      hub: async () => ({ url: hub.url, token: "t" }),
    });
    const got = await r.agentsCurrent(["ag-1", "bad id!", "ag-2"]);
    expect(got).toEqual({
      hub: "ok",
      agents: {
        "ag-1": {
          item: { id: "i", title: "T", kind: "bug", url: "https://h/i" },
          vision: null,
          source: "recent",
          since: "2026-11-19T00:00:00Z",
        },
      },
    });
    expect(hub.seen.map((s) => s.path)).toEqual([
      "/api/agents/current?agent_ids=ag-1%2Cag-2",
    ]);
  });

  it("Hub briefly unreachable: the last answer stays (memory only)", async () => {
    let up = true;
    const hub = await stubHub(() =>
      up ? { status: 200, body: WORK } : { status: 502, body: {} },
    );
    const r = new HubWorkReader({
      hub: async () => ({ url: hub.url, token: "t" }),
      projectOf: () => ({ id: "proj_a", slug: "a", name: "A" }),
    });
    const first = await r.projectWork(["a"]);
    up = false;
    expect(await r.projectWork(["a"])).toEqual(first);
  });

  it("an older Hub without the route (404): no card, not a refusal", async () => {
    const hub = await stubHub(() => ({
      status: 404,
      body: { error: "not_found" },
    }));
    const r = new HubWorkReader({
      hub: async () => ({ url: hub.url, token: "t" }),
      projectOf: () => ({ id: "proj_a", slug: "a", name: "A" }),
    });
    expect(await r.projectWork(["a"])).toEqual({
      hub: "ok",
      projects: [{ project: "a", work: null }],
    });
    expect(await r.agentsCurrent(["ag-1"])).toEqual({ hub: "ok", agents: {} });
  });
});
