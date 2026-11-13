/**
 * H5: GET /api/hub/github (Den Hub's GitHub access, live from Hub) and
 * POST /api/hub/sync (send the projects to Hub now, answer Hub's reply).
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { ProjectSync } from "../../../src/shared/hub-project-sync.js";
import {
  handleAgentRoutes,
  type AgentRouteDeps,
} from "../../../src/ui/server/agent-routes.js";

const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function serve(deps: Partial<AgentRouteDeps>): Promise<string> {
  const s = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleAgentRoutes(req, res, p, deps as AgentRouteDeps);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "localhost", () => r()));
  return `http://localhost:${(s.address() as AddressInfo).port}`;
}

describe("H5: /api/hub/github and /api/hub/sync", () => {
  it("GET github: connected, Hub's orgs; not connected: none", async () => {
    const orgs = [
      { org: "acme-co", access: "none" as const, covered: 0, total: 2 },
    ];
    let base = await serve({ hubGithub: async () => ({ orgs }) });
    expect(await (await fetch(`${base}/api/hub/github`)).json()).toEqual({
      connected: true,
      orgs,
    });
    expect(
      (await fetch(`${base}/api/hub/github`, { method: "POST" })).status,
    ).toBe(405);
    base = await serve({ hubGithub: async () => null });
    expect(await (await fetch(`${base}/api/hub/github`)).json()).toEqual({
      connected: false,
      orgs: [],
    });
  });

  it("POST sync: sends now and answers Hub's reply", async () => {
    const sent: unknown[] = [];
    const sync = new ProjectSync({
      list: () => [
        {
          workspace: "a",
          name: "a",
          repos: ["acme-co/web"],
          hub_project: null,
          agents: [],
        },
      ],
      send: async (p) => (sent.push(p), { ok: true, setups: 1, uncovered: [] }),
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const base = await serve({ projectSync: sync });
    const r = await fetch(`${base}/api/hub/sync`, { method: "POST" });
    const b = (await r.json()) as {
      ok: boolean;
      last: { ok: boolean; setups: number };
    };
    expect(b.ok).toBe(true);
    expect(b.last).toMatchObject({ ok: true, setups: 1, uncovered: [] });
    expect(sent).toHaveLength(1);
    expect((await fetch(`${base}/api/hub/sync`)).status).toBe(405);
  });
});
