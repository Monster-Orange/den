/**
 * Issue 754: GET /api/hub/work (the home page's Work in Hub card) and
 * GET /api/hub/agents-current (the Agents page's rows): Den's server asks
 * Hub with the install token and answers the page; GET only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
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

describe("issue 754: /api/hub/work and /api/hub/agents-current", () => {
  it("passes the projects and agents the page asks for", async () => {
    const asked: unknown[] = [];
    const base = await serve({
      hubWork: {
        projectWork: async (names) => {
          asked.push(["work", names]);
          return { hub: "ok", projects: [] };
        },
        agentsCurrent: async (ids) => {
          asked.push(["agents", ids]);
          return { hub: "none" };
        },
      },
    });
    expect(
      await (await fetch(`${base}/api/hub/work?projects=den,web`)).json(),
    ).toEqual({ hub: "ok", projects: [] });
    expect(
      await (await fetch(`${base}/api/hub/agents-current?agents=a1,a2`)).json(),
    ).toEqual({ hub: "none" });
    expect(asked).toEqual([
      ["work", ["den", "web"]],
      ["agents", ["a1", "a2"]],
    ]);
    expect(
      (await fetch(`${base}/api/hub/work?projects=den`, { method: "POST" }))
        .status,
    ).toBe(405);
  });
});
