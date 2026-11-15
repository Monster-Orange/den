/**
 * Issue 199: POST /api/workspaces/:ws/agents/:id/mode { mode }: a mode of
 * an agent's own, or null to clear it (it follows its project's again). A
 * person's only: an agent's direct write is refused, and asks through the
 * held write agent_mode instead. The agents' route handler on a rig
 * (nothing runs). Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
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

const MODE = "/api/workspaces/north/agents/scout/mode";

async function api() {
  const r = await rig();
  const home = path.join(r.dir, "home");
  r.deps.env = { ...r.deps.env, HOME: home };
  seedScout(r.stateDir, r.wsDir("north"), home);
  const file = path.join(r.stateDir, "agents", "scout.json");
  const rec = JSON.parse(fs.readFileSync(file, "utf-8"));
  writeRecord(r.stateDir, {
    ...rec,
    permission: "auto",
    overrides: ["permission"],
  });
  r.wsPermission.north = "all";
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
    JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  return {
    record,
    async post(body: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(`http://localhost:${port}${MODE}`, {
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

describe("issue 199: POST .../agents/:id/mode", () => {
  it("a person clears an agent's own mode: it follows its project's", async () => {
    const a = await api();
    const r = await a.post({ mode: null });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, agent: "scout", mode: null });
    expect(a.record().overrides ?? []).not.toContain("permission");
  });

  it("refuses an unknown field and a bad mode", async () => {
    const a = await api();
    expect((await a.post({ mode: null, x: 1 })).status).toBe(400);
    expect((await a.post({ mode: "root" })).status).toBe(400);
    expect(a.record().overrides).toContain("permission");
  });

  it("an agent's direct write is refused, nothing changed", async () => {
    const a = await api();
    const r = await a.post(
      { mode: null },
      {
        "x-den-actor": "agent",
        "x-den-mcp-client": "jest",
        "x-den-mcp-agent": "agent:lead",
        "x-den-mcp-workspace": "north",
      },
    );
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/only a person.*agent_mode/);
    expect(a.record().overrides).toContain("permission");
  });

  it("is a known route, and an agent's token never reaches it", () => {
    const cls = routeClass("POST", MODE);
    expect(cls).not.toBeNull();
    expect(
      agentRefusal(
        { actor: "agent:lead" } as never,
        "POST",
        MODE,
        cls as never,
      ),
    ).not.toBeNull();
  });
});
