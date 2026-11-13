/**
 * #68: link every project to Hub's suggestion in one confirm.
 *   GET  /api/hub/link-suggestions: each project, its link, and Hub's
 *        first suggestion; nothing written.
 *   POST /api/hub/link-suggestions {links: [{project, hub}]}: links each
 *        pair that is still that project's suggestion and still unlinked;
 *        the rest are skipped, saying why. One sync after. A person's only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  hubLinkAllRoute,
  HUB_LINK_ALL_PATH,
  type HubLinkAllDeps,
} from "../../../src/ui/server/hub-link-all-routes.js";
import { AUDIT_HEADERS } from "../../../src/shared/agent-actor.js";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";

const BACK = { id: "proj_back", slug: "back-office", name: "Back Office" };
const SITE = { id: "proj_site", slug: "site", name: "Site" };
const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function serve(over: Partial<HubLinkAllDeps> = {}) {
  const store = new Map<string, HubProjectLink | null>([
    ["site", { id: SITE.id, slug: SITE.slug, name: SITE.name }],
  ]);
  const sent = { n: 0 };
  const audited: string[] = [];
  const deps: HubLinkAllDeps = {
    projects: () => ["back-office", "lone", "site"],
    choices: async (ws) =>
      ws === "lone"
        ? { suggestions: [], projects: [BACK, SITE] }
        : {
            suggestions: [
              ws === "site"
                ? { ...SITE, why: "name" as const }
                : { ...BACK, why: "repo" as const },
            ],
            projects: [BACK, SITE],
          },
    read: (ws) => store.get(ws) ?? null,
    write: (ws, l) => void store.set(ws, l),
    changed: () => void sent.n++,
    audit: (line) => void audited.push(line),
    ...over,
  };
  const s = http.createServer((req, res) => {
    if (new URL(req.url!, "http://x").pathname !== HUB_LINK_ALL_PATH)
      return res.writeHead(404).end();
    void hubLinkAllRoute(req, res, deps);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}${HUB_LINK_ALL_PATH}`;
  return { url, store, sent, audited };
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

describe("#68: /api/hub/link-suggestions", () => {
  it("GET: each project, its link, Hub's suggestion; nothing written", async () => {
    const { url, store, sent } = await serve();
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      connected: true,
      projects: [
        {
          project: "back-office",
          hub: null,
          suggestion: { ...BACK, why: "repo" },
        },
        { project: "lone", hub: null, suggestion: null },
        {
          project: "site",
          hub: { id: SITE.id, slug: SITE.slug, name: SITE.name },
          suggestion: null,
        },
      ],
    });
    expect(store.get("back-office")).toBeUndefined();
    expect(sent.n).toBe(0);
  });

  it("GET, Hub not connected: says so, no suggestions", async () => {
    const { url } = await serve({ choices: async () => null });
    const j = (await (await fetch(url)).json()) as {
      connected: boolean;
      projects: { suggestion: unknown }[];
    };
    expect(j.connected).toBe(false);
    expect(j.projects.every((p) => p.suggestion === null)).toBe(true);
  });

  it("POST: links the ticked suggestions, skips the rest saying why; one sync; audited", async () => {
    const { url, store, sent, audited } = await serve();
    const r = await post(url, {
      links: [
        { project: "back-office", hub: BACK.id },
        { project: "site", hub: SITE.id },
        { project: "lone", hub: BACK.id },
        { project: "nowhere", hub: BACK.id },
      ],
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      linked: [{ project: "back-office", hub: BACK }],
      skipped: [
        { project: "site", code: "linked", why: "already linked" },
        { project: "lone", code: "stale", why: "not Hub's suggestion for it" },
        { project: "nowhere", code: "unknown", why: "no such project" },
      ],
    });
    expect(store.get("back-office")).toEqual(BACK);
    expect(sent.n).toBe(1);
    expect(audited).toEqual(["back-office → back-office"]);
  });

  it("POST nothing to link: no sync", async () => {
    const { url, sent } = await serve();
    expect((await post(url, { links: [] })).status).toBe(200);
    expect(sent.n).toBe(0);
  });

  it("an agent (or an MCP caller) is refused; a bad body is 400", async () => {
    const { url, store } = await serve();
    const r = await post(
      url,
      { links: [{ project: "back-office", hub: BACK.id }] },
      { [AUDIT_HEADERS.actor]: "agent", [AUDIT_HEADERS.agent]: "planner" },
    );
    expect(r.status).toBe(403);
    expect(store.get("back-office")).toBeUndefined();
    expect((await post(url, { links: "all" })).status).toBe(400);
  });
});
