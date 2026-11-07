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
import { verifyActorToken } from "../../../src/shared/actor-token.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { hasSudoPassword } from "../../../src/ui/server/sudo-store.js";
import { cleanupRigs, rig, settle, type Rig } from "../agents/helpers/rig.js";

interface Api {
  r: Rig;
  /** http://localhost:<port> */
  base: string;
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
  const server = http.createServer((req, res) => {
    const id = newRequestId();
    res.setHeader("X-Request-Id", id);
    jsonApiErrors(res, id);
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    // The server's credential step (request-guard): an agent's actor token
    // (SEC-1c) is the request's principal; no header claims one.
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
    base: `http://localhost:${port}`,
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

/** GET over a fresh connection each time (Linux CI: no keep-alive reuse). */
function getJson(
  base: string,
  p: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${p}`,
      { method: "GET", agent: false, headers: { Connection: "close" } },
      (res) => {
        let body = "";
        res.on("data", (d: Buffer) => (body += d.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(body) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /api/personas: each runtime's readiness (AG-0.2)", () => {
  it("names the CLI each runs, where it came from and its version, and the user.yml to edit", async () => {
    const a = await api();
    const base = a.base;
    const { status, json } = await getJson(base, "/api/personas");
    expect(status).toBe(200);
    expect(json.userConfig).toBe(
      path.join(a.r.dir, "config", "local", "user.yml"),
    );
    const runtimes = json.runtimes as Record<string, unknown>[];
    expect(runtimes.find((x) => x.id === "den-claude")).toEqual({
      id: "den-claude",
      label: "Claude Code",
      vendor: "Anthropic",
      denTools: true,
      available: true,
      version: "9.9.9",
      path: a.r.claude,
      source: "PATH",
      searched: [path.dirname(a.r.claude), "/usr/bin", "/bin"],
      setting: "agents.runtimes.den-claude.bin",
      resume: true,
      default: true,
    });
    // generic has nothing to find.
    expect(runtimes.find((x) => x.id === "generic")).not.toHaveProperty("path");
    // Asked again: nothing but --version ever ran.
    await getJson(base, "/api/personas");
    expect(fs.existsSync(a.r.ran)).toBe(false);
  });

  it("missing: unavailable with why and where it looked; a refused setting says why; Start is refused with the fix", async () => {
    const a = await api();
    a.r.deps.env = { PATH: "/usr/bin:/bin", HOME: "/home/someone" };
    let { json } = await getJson(a.base, "/api/personas");
    expect(
      (json.runtimes as Record<string, unknown>[]).find(
        (x) => x.id === "den-claude",
      ),
    ).toMatchObject({
      available: false,
      why: "claude not found (searched 2 directories)",
      searched: ["/usr/bin", "/bin"],
      setting: "agents.runtimes.den-claude.bin",
    });
    a.r.runtimeBins["den-claude"] = path.join(a.r.dir, "nope");
    ({ json } = await getJson(a.base, "/api/personas"));
    expect(
      (json.runtimes as Record<string, unknown>[]).find(
        (x) => x.id === "den-claude",
      ),
    ).toMatchObject({
      available: false,
      why: `agents.runtimes.den-claude.bin: ${path.join(a.r.dir, "nope")} does not exist`,
      // The setting is the reason, so the page says so (not "not found").
      source: "setting",
    });
    const r = await start(a, "north", { persona: "planner" });
    expect(r.status).toBe(503);
    expect(r.json.hints).toEqual([
      `Install it, or set agents.runtimes.den-claude.bin to its absolute path in ${path.join(a.r.dir, "config", "local", "user.yml")}.`,
      "`acme agents doctor` shows where it looked.",
    ]);
  });

  it("a configured bin wins: the agent runs it", async () => {
    const a = await api();
    const other = path.join(a.r.dir, "elsewhere", "claude");
    fs.mkdirSync(path.dirname(other));
    fs.copyFileSync(a.r.claude, other);
    fs.chmodSync(other, 0o755);
    a.r.runtimeBins["den-claude"] = other;
    const { json } = await getJson(a.base, "/api/personas");
    expect(
      (json.runtimes as Record<string, unknown>[]).find(
        (x) => x.id === "den-claude",
      ),
    ).toMatchObject({ available: true, path: other, source: "setting" });
    expect((await start(a, "north", { persona: "planner" })).status).toBe(200);
    expect(a.r.made[0].file).toBe(other);
    // Its directory is on the session's PATH, for its own tools.
    expect(String(a.r.made[0].opts.env.PATH).split(":")).toContain(
      path.dirname(other),
    );
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

  it("asking never starts a session host: with none running, a record lists as interrupted", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    let started = 0;
    a.r.deps.connect = () => {
      started++;
      return Promise.reject(new Error("must not start a host"));
    };
    a.r.deps.connectExisting = async () => null;
    const [row] = await rows(a, "north");
    expect(row).toMatchObject({ agent: "planner", state: "interrupted" });
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

  it("never asks for the admin password (LK-0): with none held, start, stop and resume run", async () => {
    const a = await api();
    expect(hasSudoPassword()).toBe(false);
    expect((await start(a, "north", { persona: "planner" })).status).toBe(200);
    const stop = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/stop",
    );
    expect(stop.status).toBe(200);
    a.r.made[0].exit(143);
    await settle();
    const resume = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/resume",
    );
    expect(resume.status).toBe(200);
    expect(a.r.made).toHaveLength(2);
    // Each one done, none refused.
    expect(
      recentActions()
        .slice(-3)
        .map((e) => e.outcome),
    ).toEqual([undefined, undefined, undefined]);
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

  it("refuses an agent (its actor token, SEC-1c: 403): agents use MCP agent_spawn", async () => {
    const a = await api();
    expect((await start(a, "north", { persona: "planner" })).status).toBe(200);
    const token = a.r.made[0].opts.env.DEN_ACTOR_TOKEN ?? "";
    const auth = { authorization: `Bearer ${token}` };
    for (const [p, body] of [
      ["/api/workspaces/north/agents", { persona: "planner", id: "p2" }],
      ["/api/workspaces/north/agents/planner/stop", undefined],
    ] as const) {
      const { status, json } = await a.call("POST", p, body, auth);
      expect([p, status]).toEqual([p, 403]);
      expectR26(json, "forbidden");
    }
    expect(a.r.made).toHaveLength(1);
    expect(recentActions().at(-1)).toMatchObject({
      actor: "agent",
      agent: "agent:planner",
      workspace: "north",
      outcome: "refused",
    });
  });

  it("an x-den-actor header alone is no agent (SEC-1c): ignored, kept as an unverified claim", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    const { status } = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/stop",
      undefined,
      { "x-den-actor": "agent", "x-den-mcp-agent": "agent:other" },
    );
    expect(status).toBe(200);
    const e = recentActions().at(-1)!;
    expect(e).toMatchObject({
      actor: "user",
      unverified: true,
      claimed: { agent: "agent:other" },
    });
    expect(e).not.toHaveProperty("agent");
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
    expect(String(json.error)).toMatch(/generic can't resume a conversation/);
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

describe("the runtime catalog's routes (AG-0.5)", () => {
  /** A fake codex in the rig's PATH dir: --version only. */
  function fakeCodex(a: Api, dir: string, version = "codex-cli 0.50.0") {
    const bin = path.join(dir, "codex");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho "$@" >> "${a.r.ran}"\nexit 1\n`,
      { mode: 0o755 },
    );
    return bin;
  }

  it("GET /api/agents/runtimes lists the catalog, installed first; ?workspace= shows that workspace's path", async () => {
    const a = await api();
    fakeCodex(a, path.dirname(a.r.claude));
    const north = fakeCodex(a, path.join(a.r.dir, "n"), "codex-cli 0.52.0");
    a.r.wsBins.north = { codex: north };
    const list = async (q = "") => {
      const { status, json } = await a.call("GET", `/api/agents/runtimes${q}`);
      expect(status).toBe(200);
      return json.runtimes as Record<string, unknown>[];
    };
    const plain = await list();
    expect(plain.map((x) => x.id)).toEqual([
      "den-claude",
      "codex",
      "gemini",
      "grok",
      "generic",
    ]);
    expect(plain[1]).toMatchObject({ source: "PATH", version: "0.50.0" });
    expect((await list("?workspace=north"))[1]).toMatchObject({
      path: north,
      source: "workspace",
      version: "0.52.0",
    });
    const nowhere = await a.call(
      "GET",
      "/api/agents/runtimes?workspace=nowhere",
    );
    expect(nowhere.status).toBe(404);
    expectR26(nowhere.json);
    expect(fs.existsSync(a.r.ran)).toBe(false);
  });

  it("POST …/runtimes/<id>/path: a path that isn't the runtime is 422, the runtime's is saved; an agent is refused (403); each audited", async () => {
    const a = await api();
    const good = fakeCodex(a, path.join(a.r.dir, "g"));
    const other = fakeCodex(a, path.join(a.r.dir, "o"), "1.2.3");
    const post = (body: unknown, headers?: Record<string, string>) =>
      a.call("POST", "/api/agents/runtimes/codex/path", body, headers);
    let r = await post({ scope: "global", bin: other });
    expect(r.status).toBe(422);
    expectR26(r.json);
    expect(String(r.json.error)).toMatch(/is not Codex CLI/);
    expect(a.r.runtimeBins).toEqual({});
    r = await post({ scope: "global", bin: good });
    expect(r.status).toBe(200);
    expect(r.json.runtime).toMatchObject({
      id: "codex",
      path: good,
      version: "0.50.0",
    });
    expect(a.r.runtimeBins).toEqual({ codex: good });
    expect(recentActions().at(-1)).toMatchObject({
      verb: "agents",
      detail: "runtime codex path (global)",
    });
    expect(recentActions().at(-1)!.outcome).toBeUndefined();
    r = await post({ scope: "workspace", workspace: "north", bin: good });
    expect(r.status).toBe(200);
    expect(a.r.wsBins).toEqual({ north: { codex: good } });
    r = await post({ scope: "workspace", workspace: "north", bin: null });
    expect(r.status).toBe(200);
    expect(a.r.wsBins).toEqual({ north: {} });
    // Bad requests: a scope, a bin, an unknown runtime, GET.
    expect((await post({ scope: "x", bin: good })).status).toBe(400);
    expect((await post({ bin: 3 })).status).toBe(400);
    expect(
      (await a.call("POST", "/api/agents/runtimes/nope/path", { bin: good }))
        .status,
    ).toBe(400);
    expect(
      (await a.call("GET", "/api/agents/runtimes/codex/path")).status,
    ).toBe(405);
    // An agent (its actor token) can't set one.
    expect((await start(a, "north", { persona: "planner" })).status).toBe(200);
    const token = a.r.made[0].opts.env.DEN_ACTOR_TOKEN ?? "";
    r = await post(
      { scope: "global", bin: good },
      { authorization: `Bearer ${token}` },
    );
    expect(r.status).toBe(403);
    expectR26(r.json, "forbidden");
    expect(recentActions().at(-1)).toMatchObject({
      actor: "agent",
      outcome: "refused",
    });
    // Only --version ever ran.
    expect(fs.existsSync(a.r.ran)).toBe(false);
  });
});

describe("POST /api/workspaces/<ws>/agents/<id>/name (AG-4b: a tab's name)", () => {
  const rename = (a: Api, ws: string, id: string, body: unknown, h = {}) =>
    a.call("POST", `/api/workspaces/${ws}/agents/${id}/name`, body, h);

  it("stores a trimmed name in the record; the id never changes; null or blank clears it", async () => {
    const a = await api();
    expect((await start(a, "north", { persona: "planner" })).status).toBe(200);
    const r = await rename(a, "north", "planner", {
      name: "  Release  notes ",
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      ok: true,
      agent: "planner",
      displayName: "Release  notes",
    });
    const rec = JSON.parse(
      fs.readFileSync(
        path.join(a.r.stateDir, "agents", "planner.json"),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(rec).toMatchObject({ id: "planner", displayName: "Release  notes" });
    // The list (and so the CLI's --json, MCP and the page) says it.
    expect((await rows(a, "north"))[0]).toMatchObject({
      agent: "planner",
      displayName: "Release  notes",
    });
    expect(recentActions().at(-1)).toMatchObject({
      detail: "name planner in north",
    });
    // Start fresh keeps the name: it is the agent's, not its session's.
    await a.call("POST", "/api/workspaces/north/agents/planner/stop");
    a.r.made[0].exit(0);
    await settle();
    expect(
      (await a.call("POST", "/api/workspaces/north/agents/planner/fresh"))
        .status,
    ).toBe(200);
    expect((await rows(a, "north"))[0].displayName).toBe("Release  notes");
    for (const clear of [null, "   ", ""]) {
      await rename(a, "north", "planner", { name: "x" });
      const c = await rename(a, "north", "planner", { name: clear });
      expect(c.status).toBe(200);
      expect(c.json).not.toHaveProperty("displayName");
      expect((await rows(a, "north"))[0]).not.toHaveProperty("displayName");
    }
  });

  it("refuses a name that is too long, has control characters or isn't a string; another workspace's agent; and an agent", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    for (const name of [
      "x".repeat(41),
      "bad\nname",
      "bell\u0007",
      "rtl‮flip",
      42,
    ]) {
      const r = await rename(a, "north", "planner", { name });
      expect([name, r.status]).toEqual([name, 400]);
      expectR26(r.json);
    }
    expect((await rename(a, "north", "planner", {})).status).toBe(400);
    expect((await rows(a, "north"))[0]).not.toHaveProperty("displayName");
    const other = await rename(a, "south", "planner", { name: "x" });
    expect(other.status).toBe(404);
    expect(String(other.json.error)).not.toContain("north");
    const token = a.r.made[0].opts.env.DEN_ACTOR_TOKEN ?? "";
    const agent = await rename(
      a,
      "north",
      "planner",
      { name: "mine now" },
      { authorization: `Bearer ${token}` },
    );
    expect(agent.status).toBe(403);
    expect((await rows(a, "north"))[0]).not.toHaveProperty("displayName");
  });
});

describe("GET /api/workspaces/<ws>/agents/<id>/paths (AG-4b: path links)", () => {
  const paths = (a: Api, ws: string, id: string, ps: string[], h = {}) =>
    a.call(
      "GET",
      `/api/workspaces/${ws}/agents/${id}/paths?${ps.map((p) => `p=${encodeURIComponent(p)}`).join("&")}`,
      undefined,
      h,
    );

  it("says which paths exist inside the agent's workspace, resolved against its cwd; never one outside it; reads nothing", async () => {
    const a = await api();
    expect((await start(a, "north", { persona: "planner" })).status).toBe(200);
    const ws = fs.realpathSync(a.r.wsDir("north"));
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "x.ts"), "secret contents\n");
    fs.mkdirSync(path.join(a.r.dir, "elsewhere"), { recursive: true });
    fs.writeFileSync(path.join(a.r.dir, "elsewhere", "y.ts"), "y\n");
    // A link inside that leads out of the workspace is outside.
    fs.symlinkSync(path.join(a.r.dir, "elsewhere"), path.join(ws, "out"));
    const r = await paths(a, "north", "planner", [
      "src/x.ts",
      "./src/x.ts",
      path.join(ws, "src", "x.ts"),
      "src/missing.ts",
      "../../elsewhere/y.ts",
      path.join(a.r.dir, "elsewhere", "y.ts"),
      "out/y.ts",
      "/etc/hosts",
      "src",
    ]);
    expect(r.status).toBe(200);
    const abs = path.join(ws, "src", "x.ts");
    expect(r.json.paths).toEqual({
      "src/x.ts": abs,
      "./src/x.ts": abs,
      [abs]: abs,
      "src/missing.ts": null,
      "../../elsewhere/y.ts": null,
      [path.join(a.r.dir, "elsewhere", "y.ts")]: null,
      "out/y.ts": null,
      "/etc/hosts": null,
      // A directory is a path too.
      src: path.join(ws, "src"),
    });
    // Nothing of the file is in the answer.
    expect(JSON.stringify(r.json)).not.toContain("secret contents");
  });

  it("refuses another workspace's agent (404), too many paths (400), a POST (405)", async () => {
    const a = await api();
    await start(a, "north", { persona: "planner" });
    expect((await paths(a, "south", "planner", ["src/x.ts"])).status).toBe(404);
    const many = Array.from({ length: 65 }, (_, i) => `f${i}.ts`);
    const big = await paths(a, "north", "planner", many);
    expect(big.status).toBe(400);
    expectR26(big.json);
    const post = await a.call(
      "POST",
      "/api/workspaces/north/agents/planner/paths",
    );
    expect(post.status).toBe(405);
  });
});
