/**
 * H5: GET/PUT /api/workspaces/:ws/hub-project (Settings › Project setup ›
 * Hub project). GET offers Hub's suggestions and projects and writes
 * nothing; PUT links to one of the company's Hub projects, or unlinks; an
 * agent (or an MCP caller) is refused.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  hubProjectRoute,
  HUB_PROJECT_ROUTE,
  type HubProjectRouteDeps,
} from "../../../src/ui/server/hub-project-routes.js";
import { AUDIT_HEADERS } from "../../../src/shared/agent-actor.js";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";

const BACK = {
  id: "proj_backoffice",
  slug: "back-office",
  name: "Back Office",
};
const SITE = { id: "proj_site", slug: "site", name: "Site" };
const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function serve(over: Partial<HubProjectRouteDeps> = {}) {
  const store = new Map<string, HubProjectLink | null>();
  const sent = { n: 0 };
  const deps: Partial<HubProjectRouteDeps> = {
    uncovered: () => [],
    changed: () => void sent.n++,
    exists: (ws) => ws === "back-office",
    choices: async () => ({
      suggestions: [{ ...BACK, why: "repo" as const }],
      projects: [BACK, SITE],
    }),
    read: (ws) => store.get(ws) ?? null,
    write: (ws, l) => void store.set(ws, l),
    ...over,
  };
  const s = http.createServer((req, res) => {
    const m = HUB_PROJECT_ROUTE.exec(new URL(req.url!, "http://x").pathname);
    if (!m) return res.writeHead(404).end();
    void hubProjectRoute(req, res, m[1], deps);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/workspaces`;
  return { base, store, sent };
}

const put = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("H5: /api/workspaces/:ws/hub-project", () => {
  it("GET: not linked, Hub's suggestion and the company's projects; nothing written", async () => {
    const { base, store } = await serve();
    const r = await fetch(`${base}/back-office/hub-project`);
    expect(await r.json()).toEqual({
      ok: true,
      project: "back-office",
      hub: null,
      connected: true,
      suggestions: [{ ...BACK, why: "repo" }],
      uncovered: [],
      projects: [BACK, SITE],
    });
    expect(store.size).toBe(0);
  });

  it("PUT links to a company project by slug, name or id; null unlinks; anything else is refused", async () => {
    const by: string[] = [];
    const { base, store } = await serve({
      write: (ws, l, who) => {
        by.push(who ?? "");
        store.set(ws, l);
      },
    });
    const u = `${base}/back-office/hub-project`;
    expect((await put(u, { hub: "Back Office" })).status).toBe(200);
    expect(store.get("back-office")).toEqual(BACK);
    expect(await (await put(u, { hub: "proj_site" })).json()).toEqual({
      ok: true,
      project: "back-office",
      hub: SITE,
    });
    const nope = await put(u, { hub: "proj_other_company" });
    expect(nope.status).toBe(404);
    expect(store.get("back-office")).toEqual(SITE);
    expect((await put(u, { hub: null })).status).toBe(200);
    expect(store.get("back-office")).toBeNull();
    expect(
      (await put(`${base}/ghost/hub-project`, { hub: "site" })).status,
    ).toBe(404);
    // 0.4.44: each write names who asked, for the audit row.
    expect(by).toHaveLength(3);
    for (const b of by) expect(b).toMatch(/^Settings › Hub project \(/);
  });

  it("an agent's ask is refused, and nothing changes", async () => {
    const { base, store } = await serve();
    const r = await put(
      `${base}/back-office/hub-project`,
      { hub: "site" },
      { [AUDIT_HEADERS.actor]: "agent", [AUDIT_HEADERS.agent]: "planner" },
    );
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("person_only");
    expect(store.size).toBe(0);
  });

  it("Hub not connected: GET says so; PUT is refused with how to connect", async () => {
    const { base } = await serve({ choices: async () => null });
    const g = await (await fetch(`${base}/back-office/hub-project`)).json();
    expect(g).toMatchObject({ connected: false, projects: [] });
    const p = await put(`${base}/back-office/hub-project`, { hub: "site" });
    expect(p.status).toBe(409);
  });

  it("GET: the repos Den Hub can't see, from the last sync; a link sends the projects again", async () => {
    const { base, sent } = await serve({
      uncovered: (ws) =>
        ws === "back-office"
          ? [
              {
                workspace: ws,
                repo: "acme-co/web",
                org: "acme-co",
                installUrl: "https://github.com/apps/den-hub/installations/new",
              },
            ]
          : [],
    });
    const b = (await (
      await fetch(`${base}/back-office/hub-project`)
    ).json()) as { uncovered: unknown };
    expect(b.uncovered).toEqual([
      {
        workspace: "back-office",
        repo: "acme-co/web",
        org: "acme-co",
        installUrl: "https://github.com/apps/den-hub/installations/new",
      },
    ]);
    expect(sent.n).toBe(0);
    expect(
      (await put(`${base}/back-office/hub-project`, { hub: "site" })).status,
    ).toBe(200);
    expect(
      (await put(`${base}/back-office/hub-project`, { hub: null })).status,
    ).toBe(200);
    expect(sent.n).toBe(2);
  });
});
