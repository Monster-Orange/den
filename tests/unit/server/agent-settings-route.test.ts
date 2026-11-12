/**
 * D59: POST /api/workspaces/:ws/agents/:id/settings, an agent's own
 * "Resume after a restart" (on, off, or null for its persona's). A
 * person's only: an agent could keep itself running across every restart.
 * The agents' route handler on a rig (nothing runs). Invented names only.
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
import { routeClass } from "../../../src/ui/server/route-classes.js";
import { cleanupRigs, rig } from "../agents/helpers/rig.js";
import { seedScout } from "../agents/helpers/seed-helpers.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const SETTINGS = "/api/workspaces/north/agents/scout/settings";

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
      const res = await fetch(`http://localhost:${port}${SETTINGS}`, {
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

describe("D59: POST .../agents/:id/settings", () => {
  it("sets on and off, and null goes back to the persona's", async () => {
    const a = await api();
    expect((await a.post({ resumeOnRestart: true })).status).toBe(200);
    expect(a.record().resumeOnRestart).toBe(true);
    expect((await a.post({ resumeOnRestart: false })).status).toBe(200);
    expect(a.record().resumeOnRestart).toBe(false);
    expect((await a.post({ resumeOnRestart: null })).status).toBe(200);
    expect("resumeOnRestart" in a.record()).toBe(false);
  });

  it("refuses an unknown field or a value that isn't true, false or null", async () => {
    const a = await api();
    expect((await a.post({ colour: "red" })).status).toBe(400);
    expect((await a.post({ resumeOnRestart: "on" })).status).toBe(400);
    expect("resumeOnRestart" in a.record()).toBe(false);
  });

  it("a person's only: an agent's claim is refused, nothing written", async () => {
    const a = await api();
    const r = await a.post(
      { resumeOnRestart: true },
      {
        "x-den-actor": "agent",
        "x-den-mcp-client": "jest",
        "x-den-mcp-agent": "agent:scout",
        "x-den-mcp-workspace": "north",
      },
    );
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/only a person can change/);
    expect("resumeOnRestart" in a.record()).toBe(false);
  });

  it("is a known route", () => {
    expect(routeClass("POST", SETTINGS)).not.toBeNull();
  });
});
