/**
 * Issue 167 (mock v6 A2, A3): POST /api/workspaces/:ws/hub-rename {name}.
 * A linked project's rename is asked of Hub as a held change; the name
 * here doesn't change. The ask is kept ({to, held, url, askedAt}) until a
 * sync brings that name. Not linked, an empty or unchanged name, an agent:
 * refused. Hub refusing or not answering: its words, nothing kept.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  hubRenameRoute,
  HUB_RENAME_ROUTE,
  type HubRenameRouteDeps,
} from "../../../src/ui/server/hub-rename-routes.js";
import { AUDIT_HEADERS } from "../../../src/shared/agent-actor.js";
import type {
  HubProjectLink,
  HubRename,
} from "../../../src/shared/hub/hub-project-link.js";

const STAR = { id: "proj_star1", slug: "north-star", name: "North Star" };
const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function serve(over: Partial<HubRenameRouteDeps> = {}) {
  const kept = new Map<string, HubRename | null>();
  const asked: { project: string; name: string; reason: string }[] = [];
  const links = new Map<string, HubProjectLink>([["north", STAR]]);
  const d: HubRenameRouteDeps = {
    exists: (ws) => ws === "north" || ws === "south",
    read: (ws) => links.get(ws) ?? null,
    plan: async (a) => {
      asked.push(a);
      return {
        held: "held_1",
        state: "pending",
        url: "https://hub.example.test/acme/held/held_1",
      };
    },
    write: (ws, r) => void kept.set(ws, r),
    now: () => new Date("2026-11-15T10:00:00.000Z"),
    ...over,
  };
  const s = http.createServer((req, res) => {
    const m = HUB_RENAME_ROUTE.exec(new URL(req.url!, "http://x").pathname);
    if (!m) return res.writeHead(404).end();
    void hubRenameRoute(req, res, m[1], d);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/workspaces`;
  return { base, kept, asked };
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

describe("POST /api/workspaces/:ws/hub-rename", () => {
  it("asks Hub for a held rename of its Hub project, and keeps the ask", async () => {
    const { base, kept, asked } = await serve();
    const r = await post(`${base}/north/hub-rename`, { name: "  Polaris " });
    expect(r.status).toBe(200);
    const pending = {
      to: "Polaris",
      held: "held_1",
      url: "https://hub.example.test/acme/held/held_1",
      askedAt: "2026-11-15T10:00:00.000Z",
    };
    expect(await r.json()).toEqual({ ok: true, project: "north", pending });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ project: "north-star", name: "Polaris" });
    expect(asked[0].reason).toMatch(/Den/);
    expect(kept.get("north")).toEqual(pending);
  });

  it("refuses: not linked (409), empty or unchanged (400), no such project (404)", async () => {
    const { base, kept, asked } = await serve();
    expect((await post(`${base}/south/hub-rename`, { name: "X" })).status).toBe(
      409,
    );
    expect(
      (await post(`${base}/north/hub-rename`, { name: "  " })).status,
    ).toBe(400);
    expect(
      (await post(`${base}/north/hub-rename`, { name: "North Star" })).status,
    ).toBe(400);
    expect(
      (await post(`${base}/north/hub-rename`, { name: "x".repeat(61) })).status,
    ).toBe(400);
    expect(
      (await post(`${base}/nowhere/hub-rename`, { name: "X" })).status,
    ).toBe(404);
    expect(asked).toEqual([]);
    expect(kept.size).toBe(0);
  });

  it("an agent (or an MCP caller) is refused", async () => {
    const { base, asked } = await serve();
    const r = await post(
      `${base}/north/hub-rename`,
      { name: "Polaris" },
      { [AUDIT_HEADERS.actor]: "agent", [AUDIT_HEADERS.agent]: "planner" },
    );
    expect(r.status).toBe(403);
    expect(asked).toEqual([]);
  });

  it("Hub refuses or isn't there: its words, nothing kept", async () => {
    const { base, kept } = await serve({
      plan: async () => {
        throw new Error("Hub could not be reached: ECONNREFUSED");
      },
    });
    const r = await post(`${base}/north/hub-rename`, { name: "Polaris" });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toContain(
      "Hub could not be reached",
    );
    expect(kept.size).toBe(0);
    const n = await serve({ plan: async () => null });
    const r2 = await post(`${n.base}/north/hub-rename`, { name: "Polaris" });
    expect(r2.status).toBe(409);
  });

  it("anything but POST: 405", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/north/hub-rename`)).status).toBe(405);
  });
});
