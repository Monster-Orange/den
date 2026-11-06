/**
 * The Workspaces page's agent routes (AG-4a, AG spec §5c): list, start,
 * stop, resume and personas, each the CLI's own operation (agent-ops.ts).
 * A real session host on a temp socket with a scripted PTY (nothing really
 * runs), a `claude` PATH shim that must never run, and the routes behind
 * the server's R26 frame (jsonApiErrors), as index.ts serves them.
 * Invented workspaces only (north, south).
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
import { cleanupRigs, rig, settle, type Rig } from "../agents/helpers/rig.js";

interface Api {
  r: Rig;
  /** Whether the lock (R8) is open; tests flip it. */
  lock: { open: boolean };
  call(
    method: string,
    p: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

async function api(): Promise<Api> {
  const r = await rig();
  const lock = { open: true };
  const server = http.createServer((req, res) => {
    const id = newRequestId();
    res.setHeader("X-Request-Id", id);
    jsonApiErrors(res, id);
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    handleAgentRoutes(req, res, p, {
      agents: r.deps,
      unlocked: () => lock.open,
    })
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
    lock,
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

type Row = Record<string, unknown> & { agent: string; state: string };
async function rows(a: Api, ws: string): Promise<Row[]> {
  const { status, json } = await a.call("GET", `/api/workspaces/${ws}/agents`);
  expect(status).toBe(200);
  return json.agents as Row[];
}

/** R26b: { ok: false, error, code, requestId }. */
function expectR26(json: Record<string, unknown>, code?: string): void {
  expect(json.ok).toBe(false);
  expect(typeof json.error).toBe("string");
  expect(typeof json.code).toBe("string");
  expect(json.requestId).toMatch(/^[0-9a-f]{8}$/);
  if (code) expect(json.code).toBe(code);
}

const start = (a: Api, ws: string, body: Record<string, unknown>) =>
  a.call("POST", `/api/workspaces/${ws}/agents`, body);

describe("GET /api/personas", () => {
  it("lists the default pack's personas (no role prompt) and the runtimes", async () => {
    const a = await api();
    const { status, json } = await a.call("GET", "/api/personas");
    expect(status).toBe(200);
    const personas = json.personas as Record<string, unknown>[];
    expect(personas.map((p) => p.id)).toContain("planner");
    for (const p of personas) expect(p).not.toHaveProperty("prompt");
    const runtimes = json.runtimes as Record<string, unknown>[];
    expect(runtimes.find((x) => x.id === "den-claude")).toMatchObject({
      available: true,
      resume: true,
      default: true,
    });
    expect(runtimes.find((x) => x.id === "generic")).toMatchObject({
      resume: false,
    });
  });
});

describe("GET /api/workspaces/<ws>/agents", () => {
  it("lists a workspace's own agents only: north's never under south", async () => {
    const a = await api();
    expect((await start(a, "north", { persona: "planner" })).status).toBe(200);
    expect(
      (await start(a, "south", { persona: "reviewer", id: "rev-s" })).status,
    ).toBe(200);
    const north = await rows(a, "north");
    expect(north.map((x) => x.agent)).toEqual(["planner"]);
    expect(north[0]).toMatchObject({
      persona: "planner",
      runtime: "den-claude",
      workspace: "north",
      cwd: a.r.wsDir("north"),
      state: "running",
      resumable: false,
    });
    expect(typeof north[0].startedAt).toBe("string");
    const south = await rows(a, "south");
    expect(south.map((x) => x.agent)).toEqual(["rev-s"]);
    expect(JSON.stringify(south)).not.toContain("planner");
    // The page and the CLI see the same agents: neither keeps its own.
    a.r.out.length = 0;
    await cmdAgents(["list", "-w", "north", "--json"], a.r.deps);
    expect(
      (JSON.parse(a.r.out.join("\n")) as Row[]).map((x) => x.agent),
    ).toEqual(["planner"]);
    expect(fs.existsSync(a.r.ran)).toBe(false);
  });

  it("another workspace's agent can't be stopped or resumed from this one, nor named", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    for (const verb of ["stop", "resume"]) {
      const { status, json } = await a.call(
        "POST",
        `/api/workspaces/south/agents/planner/${verb}`,
      );
      expect(status).toBe(404);
      expectR26(json, "not_found");
      expect(String(json.error)).not.toContain("north");
    }
    expect((await rows(a, "north"))[0].state).toBe("running");
    expect(a.r.made[0].signals).toEqual([]);
  });

  it("with the lock closed, another workspace's agent is still a 404 that doesn't name it (not 423)", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    a.lock.open = false;
    for (const verb of ["stop", "resume"]) {
      const { status, json } = await a.call(
        "POST",
        `/api/workspaces/south/agents/planner/${verb}`,
      );
      expect(status).toBe(404);
      expectR26(json, "not_found");
      expect(String(json.error)).not.toContain("north");
    }
    // This workspace's own agent is still behind the lock.
    const own = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/stop",
    );
    expect(own.status).toBe(423);
    expect(a.r.made[0].signals).toEqual([]);
  });

  it("asking never starts a session host: with none running, a record lists as ended", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    let started = 0;
    a.r.deps.connect = () => {
      started++;
      return Promise.reject(new Error("must not start a host"));
    };
    a.r.deps.connectExisting = async () => null;
    const [row] = await rows(a, "north");
    expect(row).toMatchObject({ agent: "planner", state: "ended" });
    expect(started).toBe(0);
  });

  it("an unknown workspace is a 404 in R26's shape", async () => {
    const a = await api();
    const { status, json } = await a.call("GET", "/api/workspaces/west/agents");
    expect(status).toBe(404);
    expectR26(json, "not_found");
    expect(await rows(a, "north")).toEqual([]);
  });
});

describe("POST /api/workspaces/<ws>/agents (start)", () => {
  it("starts the persona's runtime in the workspace's dir with the allowlisted env, and audits it as the person's", async () => {
    const a = await api();
    const { status, json } = await start(a, "north", { persona: "planner" });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      agent: {
        id: "planner",
        persona: "planner",
        runtime: "den-claude",
        workspace: "north",
        session: "acme-north:planner",
      },
    });
    expect(a.r.made).toHaveLength(1);
    const p = a.r.made[0];
    expect(p.file).toBe(a.r.claude);
    expect(p.opts.cwd).toBe(a.r.wsDir("north"));
    // §5a-env: the CLI's allowlist, never the caller's whole env.
    expect(p.opts.env.HOME).toBe("/home/someone");
    expect(p.opts.env).not.toHaveProperty("SOME_TOKEN");
    expect(p.opts.env.DEN_AGENT).toBe("agent:planner");
    expect(fs.existsSync(a.r.ran)).toBe(false);
    const entry = recentActions().at(-1)!;
    expect(entry).toMatchObject({ actor: "user", verb: "agents" });
    expect(entry.detail).toBe("start planner (planner, den-claude) in north");
    expect(entry.outcome).toBeUndefined();
  });

  it("is refused while the lock is closed (423 locked): nothing starts, and the refusal is audited", async () => {
    const a = await api();
    a.lock.open = false;
    const { status, json } = await start(a, "north", { persona: "planner" });
    expect(status).toBe(423);
    expectR26(json, "locked");
    expect(a.r.made).toHaveLength(0);
    expect(await rows(a, "north")).toEqual([]);
    expect(recentActions().at(-1)).toMatchObject({
      verb: "agents",
      outcome: "refused",
    });
    // Stop and Resume are gated the same way.
    a.lock.open = true;
    await start(a, "north", { persona: "planner" });
    a.lock.open = false;
    for (const verb of ["stop", "resume"]) {
      const r = await a.call(
        "POST",
        `/api/workspaces/north/agents/planner/${verb}`,
      );
      expect(r.status).toBe(423);
      expectR26(r.json, "locked");
    }
    expect(a.r.made[0].signals).toEqual([]);
  });

  it("is capped by agents.max_concurrent (429 cap)", async () => {
    const a = await api();
    a.r.config.maxConcurrent = 1;
    expect((await start(a, "north", { persona: "planner" })).status).toBe(200);
    const { status, json } = await start(a, "south", { persona: "reviewer" });
    expect(status).toBe(429);
    expectR26(json, "cap");
    expect(json.hints).toEqual([
      expect.stringMatching(/raise agents\.max_concurrent/),
    ]);
    expect(a.r.made).toHaveLength(1);
    expect((await rows(a, "south")).length).toBe(0);
  });

  it("refuses an agent actor (403): agents use MCP agent_spawn", async () => {
    const a = await api();
    const { status, json } = await a.call(
      "POST",
      "/api/workspaces/north/agents",
      { persona: "planner" },
      { "x-den-actor": "agent", "x-den-mcp-agent": "agent:planner" },
    );
    expect(status).toBe(403);
    expectR26(json, "forbidden");
    expect(a.r.made).toHaveLength(0);
  });

  it("answers a bad request in R26's shape: no persona, an unknown one, an unknown runtime, bad JSON", async () => {
    const a = await api();
    for (const [body, re] of [
      [{}, /persona is required/],
      [{ persona: "nobody" }, /no persona "nobody"/],
      [{ persona: "planner", runtime: "x" }, /no runtime "x"/],
      [{ persona: 3 }, /persona must be a string/],
    ] as [unknown, RegExp][]) {
      const { status, json } = await start(
        a,
        "north",
        body as Record<string, unknown>,
      );
      expect(status).toBe(400);
      expectR26(json, "bad_request");
      expect(String(json.error)).toMatch(re);
    }
    expect(a.r.made).toHaveLength(0);
  });

  it("an agent already running is a conflict (409)", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    const { status, json } = await start(a, "north", { persona: "planner" });
    expect(status).toBe(409);
    expectR26(json, "conflict");
    expect(a.r.made).toHaveLength(1);
  });
});

describe("POST …/agents/<id>/stop and …/resume", () => {
  it("stop sends TERM and marks the record stopped; the row says so", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    const { status, json } = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/stop",
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      agent: "planner",
      wasRunning: true,
    });
    await settle();
    expect(a.r.made[0].signals).toContain("SIGTERM");
    a.r.made[0].exit(143);
    await settle();
    const [row] = await rows(a, "north");
    expect(row).toMatchObject({ state: "stopped", resumable: true });
    expect(recentActions().at(-1)).toMatchObject({
      verb: "agents",
      detail: "stop planner in north",
    });
  });

  it("resume is refused while the agent runs, and runs once it is stopped", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    const busy = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/resume",
    );
    expect(busy.status).toBe(409);
    expectR26(busy.json, "conflict");
    expect(String(busy.json.error)).toMatch(/is running/);
    await a.call("POST", "/api/workspaces/north/agents/planner/stop");
    a.r.made[0].exit(143);
    await settle();
    const { status, json } = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/resume",
    );
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, agent: { id: "planner" } });
    expect(a.r.made).toHaveLength(2);
    expect(a.r.made[1].opts.cwd).toBe(a.r.wsDir("north"));
    expect((await rows(a, "north"))[0]).toMatchObject({
      state: "running",
      resumable: false,
    });
  });

  it("resume is refused for a runtime without resume (generic), and its row says it can't", async () => {
    const a = await api();
    const packs = path.join(a.r.dir, "personas");
    fs.mkdirSync(packs, { recursive: true });
    fs.writeFileSync(
      path.join(packs, "shell.md"),
      '---\nname: shell\nruntime: generic\nargv: ["sh"]\n---\nA shell.\n',
    );
    a.r.config.personaPacks = ["personas"];
    expect((await start(a, "north", { persona: "shell" })).status).toBe(200);
    await a.call("POST", "/api/workspaces/north/agents/shell/stop");
    a.r.made[0].exit(143);
    await settle();
    expect((await rows(a, "north"))[0]).toMatchObject({
      state: "stopped",
      resumable: false,
    });
    const { status, json } = await a.call(
      "POST",
      "/api/workspaces/north/agents/shell/resume",
    );
    expect(status).toBe(409);
    expectR26(json, "conflict");
    expect(String(json.error)).toMatch(/does not declare resume/);
    expect(a.r.made).toHaveLength(1);
  });

  it("an unknown agent is a 404; GET on an action is 405", async () => {
    const a = await api();
    const r = await a.call("POST", "/api/workspaces/north/agents/ghost/stop");
    expect(r.status).toBe(404);
    expectR26(r.json, "not_found");
    const g = await a.call("GET", "/api/workspaces/north/agents/ghost/stop");
    expect(g.status).toBe(405);
    expectR26(g.json, "method_not_allowed");
  });
});
