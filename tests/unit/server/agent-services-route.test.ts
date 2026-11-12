/**
 * D65: POST /api/workspaces/:ws/agents/:id/services {add, remove}: the
 * services an agent works on, on its record. A person's only: an agent
 * could list itself under any service. The agents' route handler on a
 * rig (nothing runs). Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { agentRefusal } from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import { cleanupRigs, rig } from "../agents/helpers/rig.js";
import { seedScout } from "../agents/helpers/seed-helpers.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const SERVICES = "/api/workspaces/north/agents/scout/services";

async function api() {
  const r = await rig();
  const home = path.join(r.dir, "home");
  r.deps.env = { ...r.deps.env, HOME: home };
  seedScout(r.stateDir, r.wsDir("north"), home);
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleAgentRoutes(req, res, p, { agents: r.deps }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  const record = () =>
    JSON.parse(
      fs.readFileSync(path.join(r.stateDir, "agents", "scout.json"), "utf-8"),
    ) as Record<string, unknown>;
  return {
    record,
    async post(body: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(`http://localhost:${port}${SERVICES}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    },
  };
}

describe("D65: POST .../agents/:id/services", () => {
  it("adds and removes; the answer is the list now", async () => {
    const a = await api();
    const r = await a.post({ add: ["notes", "shop/api"] });
    expect(r.status).toBe(200);
    expect(r.json.services).toEqual(["notes", "shop/api"]);
    expect(a.record().services).toEqual(["notes", "shop/api"]);
    expect((await a.post({ remove: ["notes", "shop/api"] })).status).toBe(200);
    expect("services" in a.record()).toBe(false);
  });

  it("refuses an unknown field or a name that isn't a service's", async () => {
    const a = await api();
    expect((await a.post({ set: ["notes"] })).status).toBe(400);
    expect((await a.post({ add: ["../x"] })).status).toBe(400);
    expect((await a.post({ add: "notes" })).status).toBe(400);
    expect("services" in a.record()).toBe(false);
  });

  it("a person's only: an agent's claim is refused, nothing written", async () => {
    const a = await api();
    const r = await a.post(
      { add: ["notes"] },
      {
        "x-den-actor": "agent",
        "x-den-mcp-client": "jest",
        "x-den-mcp-agent": "agent:scout",
        "x-den-mcp-workspace": "north",
      },
    );
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/only a person can link/);
    expect("services" in a.record()).toBe(false);
  });

  it("is a known route, and an agent's token never reaches it", () => {
    const cls = routeClass("POST", SERVICES);
    expect(cls).not.toBeNull();
    expect(
      agentRefusal(
        { actor: "agent:scout" } as never,
        "POST",
        SERVICES,
        cls as never,
      ),
    ).not.toBeNull();
  });
});
