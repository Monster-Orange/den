/**
 * D65 v2: POST /api/workspaces/:ws/agents/:id/link {repo}: the repo of its
 * project an agent works on (null: none), on its record. A person's only:
 * an agent could list itself under any service. GET /api/personas?workspace=
 * lists the repos the Start dialog and Change offer. The agents' route
 * handler on a rig (nothing runs). Invented names only.
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

const LINK = "/api/workspaces/north/agents/scout/link";

async function api() {
  let ws: (w: string) => string = () => "";
  const r = await rig({
    workspaceServices: (w) =>
      w === "north"
        ? [
            { address: "notes/api", path: path.join(ws("north"), "notes") },
            { address: "shop", path: path.join(ws("north"), "shop") },
          ]
        : [],
  });
  ws = r.wsDir;
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
    async get(p: string) {
      const res = await fetch(`http://localhost:${port}${p}`);
      return (await res.json()) as Record<string, unknown>;
    },
    async post(body: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(`http://localhost:${port}${LINK}`, {
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

describe("D65 v2: POST .../agents/:id/link", () => {
  it("links a repo of its project, and none (null); the answer is the link now", async () => {
    const a = await api();
    const r = await a.post({ repo: "notes" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ project: "north", repo: "notes" });
    expect(a.record()).toMatchObject({ project: "north", repo: "notes" });
    const none = await a.post({ repo: null });
    expect(none.json.repo).toBeNull();
    expect("repo" in a.record()).toBe(false);
    expect(a.record().project).toBe("north");
  });

  it("refuses an unknown field, no repo, a bad name, or a repo the project hasn't", async () => {
    const a = await api();
    expect((await a.post({ add: ["notes"] })).status).toBe(400);
    expect((await a.post({})).status).toBe(400);
    expect((await a.post({ repo: "../x" })).status).toBe(400);
    expect((await a.post({ repo: "blog" })).status).toBe(404);
    expect("repo" in a.record()).toBe(false);
  });

  it("GET /api/personas?workspace= lists the workspace's repos", async () => {
    const a = await api();
    expect((await a.get("/api/personas?workspace=north")).repos).toEqual([
      "notes",
      "shop",
    ]);
  });

  it("a person's only: an agent's claim is refused, nothing written", async () => {
    const a = await api();
    const r = await a.post(
      { repo: "notes" },
      {
        "x-den-actor": "agent",
        "x-den-mcp-client": "jest",
        "x-den-mcp-agent": "agent:scout",
        "x-den-mcp-workspace": "north",
      },
    );
    expect(r.status).toBe(403);
    expect(String(r.json.error)).toMatch(/only a person can link/);
    expect("repo" in a.record()).toBe(false);
  });

  it("is a known route, and an agent's token never reaches it", () => {
    const cls = routeClass("POST", LINK);
    expect(cls).not.toBeNull();
    expect(
      agentRefusal(
        { actor: "agent:scout" } as never,
        "POST",
        LINK,
        cls as never,
      ),
    ).not.toBeNull();
  });
});
