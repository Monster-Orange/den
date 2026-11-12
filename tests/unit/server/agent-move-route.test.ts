/**
 * D72: POST /api/workspaces/:ws/agents/:id/move {to, when}: to another
 * workspace, same conversation. A person's only: an agent could move
 * itself out of its scope. The agents' route handler on a rig (nothing
 * runs). Invented names only.
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

const MOVE = "/api/workspaces/north/agents/scout/move";

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
      const res = await fetch(`http://localhost:${port}${MOVE}`, {
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

describe("D72: POST .../agents/:id/move", () => {
  it("moves a stopped agent at once; the answer says from and to", async () => {
    const a = await api();
    const r = await a.post({ to: "south", when: "now" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ from: "north", to: "south" });
    expect(a.record().workspace).toBe("south");
  });

  it("refuses an unknown field, no to, a bad when, a workspace that doesn't exist", async () => {
    const a = await api();
    expect((await a.post({ to: "south", where: "x" })).status).toBe(400);
    expect((await a.post({})).status).toBe(400);
    expect((await a.post({ to: "south", when: "later" })).status).toBe(400);
    expect((await a.post({ to: "nowhere" })).status).toBe(404);
    expect(a.record().workspace).toBe("north");
  });

  it("a person's only: an agent's claim is refused, nothing moved", async () => {
    const a = await api();
    const r = await a.post(
      { to: "south", when: "now" },
      {
        "x-den-actor": "agent",
        "x-den-mcp-client": "jest",
        "x-den-mcp-agent": "agent:scout",
        "x-den-mcp-workspace": "north",
      },
    );
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/only a person can move/);
    expect(a.record().workspace).toBe("north");
  });

  it("is a known route, and an agent's token never reaches it", () => {
    const cls = routeClass("POST", MOVE);
    expect(cls).not.toBeNull();
    expect(
      agentRefusal(
        { actor: "agent:scout" } as never,
        "POST",
        MOVE,
        cls as never,
      ),
    ).not.toBeNull();
  });
});
