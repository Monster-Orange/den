/**
 * D44: an agent keeps the MCP servers it launched with. When Hub is
 * connected (or disconnected) after it started, Den says so: its row and
 * pane ("Hub tools arrive on restart"), doctor, Settings after Connect, and
 * the agent itself (MCP whoami). Restart, at its next idle, resumes the
 * same conversation with what it gets now. A person's only.
 *
 * A real host on a temp socket with a scripted PTY: nothing runs. A temp
 * CLAUDE_CONFIG_DIR, never ~/.claude. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { writeApiOnlyRules } from "../../../src/shared/agents/api-only.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { verifyActorToken } from "../../../src/shared/actor-token.js";
import { HUB_SERVER } from "../../../src/shared/hub.js";
import { cmdAgents, staleLines } from "../../../src/ui/cli/agents-command.js";
import {
  agentTools,
  hubNow,
  listAgents,
  mcpStaleOf,
  resolveAgentsDeps,
  restartAgent,
  staleAgents,
} from "../../../src/ui/cli/agent-ops.js";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";
import { callTool, toolsFor } from "../../../src/ui/mcp/tools.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const HUB = "https://hub.example.test";
const HUB_MCP = `${HUB}/mcp`;
const TOKEN = "hubi_TESTONLY_d44_token";
const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);

describe("D44: an agent's MCP servers against Hub now", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-d44-"));
  afterEach(() => undefined);
  const files = (servers: Record<string, unknown> | null) => {
    const d = fs.mkdtempSync(path.join(dir, "a-"));
    if (servers)
      fs.writeFileSync(
        path.join(d, "mcp.json"),
        JSON.stringify({ mcpServers: servers }),
      );
    return d;
  };
  const den = { acme: { command: "/x/acme", args: ["mcp"] } };

  it("launched without Hub, Hub connected now: Hub arrives on restart", () => {
    expect(mcpStaleOf(files(den), HUB_MCP)).toEqual({
      adds: [HUB_SERVER],
      drops: [],
    });
  });

  it("launched with Hub at another address: also stale", () => {
    expect(
      mcpStaleOf(
        files({ ...den, hub: { url: "https://old.example.test/mcp" } }),
        HUB_MCP,
      ),
    ).toEqual({ adds: [HUB_SERVER], drops: [] });
  });

  it("launched with Hub, Hub disconnected now: Hub goes on restart", () => {
    expect(mcpStaleOf(files({ ...den, hub: { url: HUB_MCP } }), null)).toEqual({
      adds: [],
      drops: [HUB_SERVER],
    });
  });

  it("in line, or no MCP file (a runtime that writes none): nothing", () => {
    expect(mcpStaleOf(files({ ...den, hub: { url: HUB_MCP } }), HUB_MCP)).toBe(
      undefined,
    );
    expect(mcpStaleOf(files(den), null)).toBe(undefined);
    expect(mcpStaleOf(files(null), HUB_MCP)).toBe(undefined);
  });

  it("asks for Hub's config once a while (the token read is slow); fresh asks again", async () => {
    let calls = 0;
    const d = {
      hub: async () => {
        calls++;
        return { url: HUB, token: TOKEN };
      },
    };
    expect(await hubNow(d)).toBe(HUB_MCP);
    expect(await hubNow(d)).toBe(HUB_MCP);
    expect(calls).toBe(1);
    await hubNow(d, true);
    expect(calls).toBe(2);
    const custom = {
      hub: async () => ({ url: HUB, token: TOKEN, mcpUrl: `${HUB}/m2` }),
    };
    expect(await hubNow(custom)).toBe(`${HUB}/m2`);
    expect(await hubNow({ hub: async () => null })).toBe(null);
    expect(
      await hubNow({
        hub: async () => {
          throw new Error("store locked");
        },
      }),
    ).toBe(null);
  });
});

/**
 * Stop waits for the session to end (as it does for real), and each
 * scripted session ends on TERM.
 */
function endOnTerm(r: Rig): void {
  r.deps.stopWaitMs = 3_000;
  const made = r.made;
  const push = made.push.bind(made);
  made.push = (...ps) => {
    for (const p of ps) {
      const kill = p.kill.bind(p);
      p.kill = (sig: string) => {
        kill(sig);
        setTimeout(() => p.exit(143), 5);
      };
    }
    return push(...ps);
  };
}

/** Its conversation's transcript: a prompt, then `last`. */
function transcript(r: Rig, token: string, last: unknown): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "Plan it" } },
      last,
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

const ENDED = {
  type: "assistant",
  message: {
    model: "opus",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Planned." }],
  },
};
const WORKING = {
  type: "assistant",
  message: {
    model: "opus",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "Bash" }],
  },
};

/** A Hub the test turns on and off. */
type HubBox = { on: boolean };

/** A planner started while Hub was off; then Hub is connected. */
async function startedBeforeHub(
  last: unknown = ENDED,
): Promise<{ r: Rig; hub: HubBox; token: string }> {
  const hub: HubBox = { on: false };
  const r = await rig({
    hub: async () => (hub.on ? { url: HUB, token: TOKEN } : null),
  });
  endOnTerm(r);
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  const token = readRecord(r.stateDir, "planner")!.resumeToken!;
  transcript(r, token, last);
  hub.on = true;
  return { r, hub, token };
}

const mcpOf = (r: Rig) =>
  JSON.parse(
    fs.readFileSync(
      path.join(r.stateDir, "agent-files", "planner", "mcp.json"),
      "utf-8",
    ),
  ) as { mcpServers: Record<string, unknown> };

describe("D44: Den knows which agents have out-of-date tools", () => {
  it("its row says so once Hub is asked again; doctor lists it", async () => {
    const { r } = await startedBeforeHub();
    const d = resolveAgentsDeps(r.deps);
    expect(mcpOf(r).mcpServers[HUB_SERVER]).toBeUndefined();
    expect(await staleAgents(d, { fresh: true })).toEqual([
      {
        id: "planner",
        workspace: "north",
        stale: { adds: [HUB_SERVER], drops: [] },
      },
    ]);
    const row = (await listAgents(d, "north")).find(
      (x) => x.agent === "planner",
    )!;
    expect(row.mcpStale).toEqual({ adds: [HUB_SERVER], drops: [] });

    r.out.length = 0;
    expect(await agents(r, "doctor", "--json")).toBeGreaterThanOrEqual(0);
    const json = JSON.parse(r.out.join("\n")) as { staleTools: unknown[] };
    expect(json.staleTools).toHaveLength(1);
    r.out.length = 0;
    await agents(r, "doctor");
    expect(r.out.join("\n")).toContain(
      "  planner (north): hub tools arrive on restart",
    );
  });

  it("D47 × D44: with a service api_only (its rules written, and dev.0's in agents/), stale agents still list", async () => {
    const { r } = await startedBeforeHub();
    const d = resolveAgentsDeps(r.deps);
    // 0.4.33-dev.0 wrote the rules beside the agents' records.
    const legacy = path.join(r.stateDir, "agents", "api-only.json");
    fs.writeFileSync(
      legacy,
      JSON.stringify({ services: [{ name: "vault", project: "vault" }] }),
    );
    const want = [
      {
        id: "planner",
        workspace: "north",
        stale: { adds: [HUB_SERVER], drops: [] },
      },
    ];
    // A file in agents/ that isn't an agent's record is not an agent.
    expect(await staleAgents(d, { fresh: true })).toEqual(want);
    expect((await listAgents(d, "north")).map((x) => x.agent)).toEqual([
      "planner",
    ]);
    // Written now: in guardrails/, and dev.0's is gone.
    const files = writeApiOnlyRules(r.stateDir, {
      services: [{ name: "vault", project: "vault" } as never],
    })!;
    expect(files.rules).toBe(
      path.join(r.stateDir, "guardrails", "api-only.json"),
    );
    expect(fs.existsSync(legacy)).toBe(false);
    expect(await staleAgents(d, { fresh: true })).toEqual(want);
    r.out.length = 0;
    await agents(r, "doctor");
    expect(r.out.join("\n")).toContain(
      "  planner (north): hub tools arrive on restart",
    );
  });

  it("doctor's words: each agent, what a restart does, and the command", () => {
    expect(
      staleLines(
        [
          {
            id: "planner",
            workspace: "north",
            stale: { adds: ["hub"], drops: [] },
          },
        ],
        "acme",
      ),
    ).toEqual([
      "Agents' tools     1 running agent started before the change:",
      "  planner (north): hub tools arrive on restart",
      "  `acme agents restart <id>` restarts one at its next idle, same conversation",
    ]);
    expect(staleLines([], "acme")).toEqual(["Agents' tools     all current"]);
  });

  it("the Agents page's list (/api/sessions) carries it for a running agent", async () => {
    const { r } = await startedBeforeHub();
    const c = await r.deps.connect!();
    const sessions = await c.list();
    c.close();
    const d = {
      stateDir: () => r.stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north"],
    };
    const row = (hubUrl?: string | null) =>
      listedSessions(sessions, d, undefined, hubUrl).find(
        (x) => x.agent === "planner",
      )!;
    expect(row(HUB_MCP).mcpStale).toEqual({ adds: [HUB_SERVER], drops: [] });
    expect(row(null).mcpStale).toBeUndefined();
    expect(row(undefined).mcpStale).toBeUndefined();
    // A stopped agent's row: nothing to restart for its tools.
    const stopped = sessions.map((x) => ({ ...x, exited: true, exitCode: 0 }));
    expect(
      listedSessions(stopped, d, undefined, HUB_MCP).find(
        (x) => x.agent === "planner",
      )!.mcpStale,
    ).toBeUndefined();
  });

  it("the agent is told the truth: Hub is connected, restart for its tools, no token step", async () => {
    const { r } = await startedBeforeHub();
    const d = resolveAgentsDeps(r.deps);
    await hubNow(d, true);
    const t = await agentTools(d, "planner", "north");
    expect(t.hub).toEqual({ connected: true, loaded: false, restart: true });
    expect(t.note).toMatch(/restart you from Den/);
    expect(t.note).toMatch(/no token step/);
  });
});

describe("D44: Restart keeps the conversation and never cuts a turn", () => {
  it("after its turn: waits while it works, then resumes the same conversation, now with Hub", async () => {
    const { r, token } = await startedBeforeHub(WORKING);
    const d = resolveAgentsDeps(r.deps);
    await hubNow(d, true);
    let done = false;
    const p = restartAgent(d, "planner", "north", "after-turn", {
      pollMs: 20,
    }).then((x) => {
      done = true;
      return x;
    });
    await new Promise((res) => setTimeout(res, 150));
    expect(done).toBe(false);
    expect(r.made[0].signals).toEqual([]);
    transcript(r, token, ENDED);
    const out = await p;
    expect(out.rec.id).toBe("planner");
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", token]);
    expect((mcpOf(r).mcpServers[HUB_SERVER] as { url: string }).url).toBe(
      HUB_MCP,
    );
    expect(await staleAgents(d)).toEqual([]);
  });

  it("now: stops at once and resumes", async () => {
    const { r, token } = await startedBeforeHub(WORKING);
    const d = resolveAgentsDeps(r.deps);
    await restartAgent(d, "planner", "north", "now");
    expect(r.made[0].signals.length).toBeGreaterThan(0);
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", token]);
  });

  it("the CLI: agents restart, and refused in an agent's session", async () => {
    const { r, token } = await startedBeforeHub();
    expect(await agents(r, "restart", "planner", "-w", "north")).toBe(0);
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", token]);
    expect(r.out.join("\n")).toMatch(
      /restarted agent planner; same conversation/,
    );
    const inAgent = {
      ...r.deps,
      env: { ...r.deps.env, DEN_ACTOR_TOKEN: "den_at_x" },
    };
    expect(await cmdAgents(["restart", "planner"], inAgent)).toBe(1);
    expect(r.err.join("\n")).toMatch(/only a person can restart an agent/);
  });
});

describe("D44: the routes", () => {
  async function api(r: Rig) {
    const server = http.createServer((req, res) => {
      jsonApiErrors(res, newRequestId());
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      const bearer = /^Bearer (den_at_\S+)$/.exec(
        String(req.headers.authorization ?? ""),
      );
      const t = bearer ? verifyActorToken(r.stateDir, bearer[1]) : null;
      if (t)
        setPrincipal(req, {
          kind: "agent",
          actor: t.actor,
          workspace: t.workspace,
          grants: t.grants,
          session: t.session,
        });
      void handleAgentRoutes(req, res, p, {
        agents: r.deps,
        personaWait: { pollMs: 20 },
      }).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end("{}");
        }
      });
    });
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, "localhost", res));
    const port = (server.address() as AddressInfo).port;
    return async (
      method: string,
      p: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await fetch(`http://localhost:${port}${p}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    };
  }

  it("stale lists it; restart-stale restarts it at its next idle (202), the same conversation", async () => {
    const { r, token } = await startedBeforeHub();
    const call = await api(r);
    const st = await call("GET", "/api/agents/stale?fresh=1");
    expect(st.status).toBe(200);
    expect((st.json.agents as { id: string }[]).map((a) => a.id)).toEqual([
      "planner",
    ]);
    const go = await call("POST", "/api/agents/restart-stale", {});
    expect(go.status).toBe(202);
    expect((go.json.pending as { id: string }[]).map((a) => a.id)).toEqual([
      "planner",
    ]);
    for (let i = 0; i < 100 && r.made.length < 2; i++) await settle(20);
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", token]);
  });

  it("tools: what the agent's MCP whoami reads", async () => {
    const { r } = await startedBeforeHub();
    const call = await api(r);
    await call("GET", "/api/agents/stale?fresh=1");
    const t = await call("GET", "/api/workspaces/north/agents/planner/tools");
    expect(t.status).toBe(200);
    expect(t.json.hub).toEqual({
      connected: true,
      loaded: false,
      restart: true,
    });
  });

  it("an agent's token can't restart one (403), nothing stopped; a bad body is 400", async () => {
    const { r } = await startedBeforeHub();
    const call = await api(r);
    const env = r.made[0].opts.env as Record<string, string>;
    const auth = { authorization: `Bearer ${env.DEN_ACTOR_TOKEN}` };
    const one = await call(
      "POST",
      "/api/workspaces/north/agents/planner/restart",
      { when: "now" },
      auth,
    );
    expect(one.status).toBe(403);
    expect(String(one.json.error)).toMatch(
      /only a person can restart an agent/,
    );
    const all = await call("POST", "/api/agents/restart-stale", {}, auth);
    expect(all.status).toBe(403);
    expect(String(all.json.error)).toMatch(/only a person can restart agents/);
    expect(r.made[0].signals).toEqual([]);
    const bad = await call(
      "POST",
      "/api/workspaces/north/agents/planner/restart",
      { when: "soon" },
    );
    expect(bad.status).toBe(400);
    expect(r.made).toHaveLength(1);
  });

  it("a person's restart now: 200, the same conversation", async () => {
    const { r, token } = await startedBeforeHub();
    const call = await api(r);
    const res = await call(
      "POST",
      "/api/workspaces/north/agents/planner/restart",
      { when: "now" },
    );
    expect(res.status).toBe(200);
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", token]);
  });
});

describe("D44: MCP whoami", () => {
  const cfg = {
    actions: [],
    runTestsEnvs: ["local" as const],
    logsRemote: false,
    approvals: true,
  };
  function fakeApi(): { api: DenApi; paths: string[] } {
    const paths: string[] = [];
    const api: DenApi = {
      baseUrl: "http://localhost:7777",
      async get(p, query = {}, method = "GET") {
        assertAllowedRequest(method, p, query);
        if (p.endsWith("/tools")) paths.push(p);
        if (p === "/api/workspaces")
          return {
            active: ["north"],
            focus: "north",
            workspaces: { north: {} },
          };
        return { hub: { connected: true, loaded: false, restart: true } };
      },
      async stream() {
        throw new Error("no stream here");
      },
    };
    return { api, paths };
  }

  it("is a read tool; asks for this agent's own tools, through the client's allowlist", async () => {
    expect(toolsFor(cfg).map((t) => t.name)).toContain("whoami");
    const { api, paths } = fakeApi();
    const r = await callTool(
      "whoami",
      {},
      {
        api,
        cfg,
        cli: "acme",
        scope: { workspace: "north", actor: "agent:planner", grants: [] },
      },
    );
    expect(r.isError).toBe(false);
    expect(paths).toEqual(["/api/workspaces/north/agents/planner/tools"]);
  });

  it("an MCP server that isn't an agent's has no one to describe", async () => {
    const { api, paths } = fakeApi();
    const r = await callTool("whoami", {}, { api, cfg, cli: "acme" });
    expect(r.isError).toBe(true);
    expect(paths).toEqual([]);
  });
});
