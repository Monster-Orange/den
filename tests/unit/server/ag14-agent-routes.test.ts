/**
 * AG-14's routes: Start fresh, Remove and its Undo, Clear stopped, and
 * Resume all after a restart. Each the CLI's own operation (agent-ops.ts),
 * a person's only, audited. A real session host on a temp socket with a
 * scripted PTY (nothing runs) and a `claude` shim that must never run.
 * Never the admin password (LK-0). Invented workspaces only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import { recentActions } from "../../../src/ui/server/audit.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { verifyActorToken } from "../../../src/shared/actor-token.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { hasSudoPassword } from "../../../src/ui/server/sudo-store.js";
import { cleanupRigs, rig, settle, type Rig } from "../agents/helpers/rig.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

interface Api {
  r: Rig;
  call(
    method: string,
    p: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
}

async function api(): Promise<Api> {
  const r = await rig();
  const server = http.createServer((req, res) => {
    const id = newRequestId();
    jsonApiErrors(res, id);
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    const bearer = /^Bearer (den_at_\S+)$/.exec(
      String(req.headers.authorization ?? ""),
    );
    const rec = bearer ? verifyActorToken(r.stateDir, bearer[1]) : null;
    if (rec)
      setPrincipal(req, {
        kind: "agent",
        actor: rec.actor,
        workspace: rec.workspace,
        grants: rec.grants,
        session: rec.session,
      });
    handleAgentRoutes(req, res, p, { agents: r.deps })
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end("no such route");
        }
      })
      .catch((e: Error) => {
        res.writeHead(500);
        res.end(e.message);
      });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  return {
    r,
    async call(method, p, body, headers = {}) {
      const res = await fetch(`http://localhost:${port}${p}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    },
  };
}

const rec = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;

async function rows(a: Api, ws = "north") {
  const { json } = await a.call("GET", `/api/workspaces/${ws}/agents`);
  return json.agents as Array<Record<string, unknown>>;
}

async function started(a: Api, id: string, ws = "north"): Promise<void> {
  const { status } = await a.call("POST", `/api/workspaces/${ws}/agents`, {
    persona: id,
  });
  expect(status).toBe(200);
  const sid = (rec(a.r, id).session as { id: string }).id;
  const c = await connectHost(sessionPaths(a.r.stateDir).socket);
  c.write(sid, Buffer.from("go\r"));
  await settle();
  c.close();
}

async function stopped(a: Api, id: string, i: number): Promise<void> {
  await a.call("POST", `/api/workspaces/north/agents/${id}/stop`);
  a.r.made[i].exit(0);
  await settle();
}

describe("Remove and Undo", () => {
  it("removes a stopped agent in one call; restore brings it back", async () => {
    const a = await api();
    await started(a, "planner");
    await stopped(a, "planner", 0);
    const { status, json } = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/remove",
    );
    expect(status).toBe(200);
    expect(json.removed).toEqual([{ agent: "planner", workspace: "north" }]);
    expect(await rows(a)).toEqual([]);
    const back = await a.call("POST", "/api/agents/restore", {
      agents: ["planner"],
    });
    expect(back.json).toMatchObject({ ok: true, restored: ["planner"] });
    expect((await rows(a)).map((x) => x.agent)).toEqual(["planner"]);
    expect(
      recentActions().some((e) => e.detail === "remove planner in north"),
    ).toBe(true);
  });

  it("a running agent can't be removed: stop it first (409)", async () => {
    const a = await api();
    await started(a, "planner");
    const { status, json } = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/remove",
    );
    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/running: stop it first/);
    expect((await rows(a))[0].state).toBe("running");
  });

  it("Clear stopped removes every stopped agent of the workspaces named, never a running one", async () => {
    const a = await api();
    await started(a, "planner");
    await started(a, "reviewer");
    await started(a, "orchestrator");
    await stopped(a, "planner", 0);
    a.r.made[1].exit(1);
    await settle();
    const { json } = await a.call("POST", "/api/agents/clear-stopped", {
      workspaces: ["north"],
    });
    expect(
      (json.removed as { agent: string }[]).map((x) => x.agent).sort(),
    ).toEqual(["planner", "reviewer"]);
    expect((await rows(a)).map((x) => x.agent)).toEqual(["orchestrator"]);
    const bad = await a.call("POST", "/api/agents/clear-stopped", {
      workspaces: ["nowhere"],
    });
    expect(bad.status).toBe(404);
  });
});

describe("Start fresh and Resume all", () => {
  it("Start fresh is a new conversation, same persona and workspace", async () => {
    const a = await api();
    await started(a, "planner");
    const old = rec(a.r, "planner").resumeToken;
    await stopped(a, "planner", 0);
    const { status, json } = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/fresh",
    );
    expect(status).toBe(200);
    expect(json.agent).toMatchObject({
      id: "planner",
      persona: "planner",
      workspace: "north",
    });
    const p = a.r.made[1];
    expect(p.args[0]).toBe("--session-id");
    expect(p.args).not.toContain(old);
  });

  it("after a restart, Resume all resumes each interrupted agent with --resume <token>", async () => {
    const a = await api();
    await started(a, "planner");
    await started(a, "reviewer");
    const tokens = ["planner", "reviewer"].map(
      (id) => rec(a.r, id).resumeToken,
    );
    await a.r.restartHost();
    expect((await rows(a)).map((x) => x.state)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    const { status, json } = await a.call(
      "POST",
      "/api/agents/resume-interrupted",
      { workspaces: ["north"] },
    );
    expect(status).toBe(200);
    expect((json.resumed as { id: string }[]).map((x) => x.id).sort()).toEqual([
      "planner",
      "reviewer",
    ]);
    const resumed = a.r.made.slice(2);
    expect(resumed.map((p) => p.args.slice(0, 2)).sort()).toEqual(
      tokens.map((t) => ["--resume", t]).sort(),
    );
    expect(hasSudoPassword()).toBe(false);
  });
});

describe("an agent's token (SEC-1c)", () => {
  it("can't remove, clear or start fresh; its resume needs mcp.actions' agent_resume", async () => {
    const a = await api();
    a.r.config.agents = { orchestrator: { grants: [] } };
    await started(a, "orchestrator");
    await started(a, "planner");
    await stopped(a, "planner", 1);
    // The orchestrator's token, as its session has it.
    const tokens = JSON.parse(
      fs.readFileSync(path.join(a.r.stateDir, "actor-tokens.json"), "utf-8"),
    ) as unknown;
    expect(tokens).toBeTruthy();
    const env = a.r.made[0].opts.env as Record<string, string>;
    const auth = { authorization: `Bearer ${actorTokenOf(env) ?? ""}` };
    for (const [p, body] of [
      ["/api/workspaces/north/agents/planner/remove", undefined],
      ["/api/workspaces/north/agents/planner/fresh", undefined],
      ["/api/agents/clear-stopped", { workspaces: ["north"] }],
      ["/api/workspaces/north/agents/planner/resume", undefined],
    ] as const) {
      const { status } = await a.call("POST", p, body, auth);
      expect([p, status]).toEqual([p, 403]);
    }
    expect((await rows(a)).find((x) => x.agent === "planner")?.state).toBe(
      "stopped",
    );
  });
});

describe("the CLI agrees", () => {
  it("`agents rm` refuses a running agent; the route list shows the stopped row's why", async () => {
    const a = await api();
    await started(a, "planner");
    await stopped(a, "planner", 0);
    const [row] = await rows(a);
    expect(row).toMatchObject({ state: "stopped", resumable: true });
    expect(typeof row.stoppedAt).toBe("string");
    expect(await cmdAgents(["rm", "planner"], a.r.deps)).toBe(0);
    expect(await rows(a)).toEqual([]);
  });
});
