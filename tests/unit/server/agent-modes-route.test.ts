/**
 * Issue 225: /api/workspaces/:ws/agent-modes. GET: the project's mode and
 * each agent's actual mode with where it comes from. POST { mode } sets
 * the project's mode; { follow: true } makes every agent with its own
 * setting follow it, one audit row each. A person's only: an agent's
 * direct write is refused (it asks with project_mode). The agents' route
 * handler on a rig (nothing runs). Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import { recentActions } from "../../../src/ui/server/audit.js";
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

const URL_ = "/api/workspaces/north/agent-modes";

/** Project north on edits; scout has its own setting (ask), lead follows. */
async function api() {
  const r = await rig();
  const home = path.join(r.dir, "home");
  r.deps.env = { ...r.deps.env, HOME: home };
  seedScout(r.stateDir, r.wsDir("north"), home);
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, "builder.md"),
    "---\nname: builder\n---\nYou build.\n",
  );
  r.config.personaPacks = ["personas"];
  const file = (id: string) => path.join(r.stateDir, "agents", `${id}.json`);
  const rec = JSON.parse(fs.readFileSync(file("scout"), "utf-8"));
  writeRecord(r.stateDir, {
    ...rec,
    permission: "ask",
    overrides: ["permission"],
  });
  writeRecord(r.stateDir, {
    ...rec,
    id: "lead",
    session: { ...rec.session, id: "lead-session" },
    permission: "edits",
  });
  r.wsPermission.north = "edits";
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
  const record = (id: string) =>
    JSON.parse(fs.readFileSync(file(id), "utf-8")) as Record<string, unknown>;
  const call = async (
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`http://localhost:${port}${URL_}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
  const base = `http://localhost:${port}`;
  return { r, record, call, base };
}

const AGENT = {
  "x-den-actor": "agent",
  "x-den-mcp-client": "jest",
  "x-den-mcp-agent": "agent:lead",
  "x-den-mcp-workspace": "north",
};

describe("issue 225: /api/workspaces/:ws/agent-modes", () => {
  it("GET: each agent's mode and where it comes from", async () => {
    const a = await api();
    const g = await a.call("GET");
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ project: "north", mode: "edits", own: 1 });
    expect(
      (g.json.agents as { agent: string; mode: string; source: string }[]).map(
        (x) => [x.agent, x.mode, x.source],
      ),
    ).toEqual([
      ["lead", "edits", "project"],
      ["scout", "ask", "own"],
    ]);
  });

  it("POST mode: the project's mode is saved and audited; own settings stay", async () => {
    const a = await api();
    const p = await a.call("POST", { mode: "auto" });
    expect(p.status).toBe(200);
    expect(a.r.wsPermission.north).toBe("auto");
    expect(p.json).toMatchObject({ ok: true, mode: "auto", own: 1 });
    expect(a.record("scout").overrides).toContain("permission");
    expect(recentActions().map((x) => x.detail)).toContain(
      "set project north's mode: edits → auto",
    );
  });

  it("POST follow: every agent with its own setting follows; one audit row each", async () => {
    const a = await api();
    const p = await a.call("POST", { mode: "auto", follow: true });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ ok: true, followed: ["scout"], own: 0 });
    expect(a.record("scout").overrides ?? []).not.toContain("permission");
    expect(
      (p.json.agents as { agent: string; source: string }[]).map((x) => [
        x.agent,
        x.source,
      ]),
    ).toEqual([
      ["lead", "project"],
      ["scout", "project"],
    ]);
    expect(recentActions().map((x) => x.detail)).toContain(
      "scout follows project north's mode now (its own setting, ask, cleared)",
    );
  });

  it("refuses an unknown field, a bad mode and an empty body; nothing changed", async () => {
    const a = await api();
    expect((await a.call("POST", { mode: "auto", x: 1 })).status).toBe(400);
    expect((await a.call("POST", { mode: "root" })).status).toBe(400);
    expect((await a.call("POST", {})).status).toBe(400);
    expect((await a.call("POST", { follow: false })).status).toBe(400);
    expect(a.r.wsPermission.north).toBe("edits");
    expect(a.record("scout").overrides).toContain("permission");
  });

  it("an agent's direct write is refused, nothing changed", async () => {
    const a = await api();
    const p = await a.call("POST", { mode: "all", follow: true }, AGENT);
    expect(p.status).toBe(403);
    expect(String(p.json.error)).toMatch(/only a person.*project_mode/);
    expect(a.r.wsPermission.north).toBe("edits");
    expect(a.record("scout").overrides).toContain("permission");
  });

  it("a project that isn't there: 404", async () => {
    const a = await api();
    const res = await fetch(`${a.base}/api/workspaces/nowhere/agent-modes`);
    expect(res.status).toBe(404);
  });

  it("is a known route, and an agent's token never writes through it", () => {
    expect(routeClass("GET", URL_)).not.toBeNull();
    const cls = routeClass("POST", URL_);
    expect(cls).not.toBeNull();
    expect(
      agentRefusal(
        { actor: "agent:lead" } as never,
        "POST",
        URL_,
        cls as never,
      ),
    ).not.toBeNull();
  });
});
