import { describe, expect, it } from "@jest/globals";
import { runOneShot, type OneShotOptions } from "../../../src/ui/mcp/server.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import {
  SERVER_AGENT_ID,
  SERVER_SCOPE,
} from "../../../src/shared/agents/server-agent.js";
import { handleGithubWatchRoutes } from "../../../src/ui/server/github-watch-routes.js";
import { GithubWatcher } from "../../../src/shared/github-watch/watcher.js";
import type { Delivery } from "../../../src/shared/hub/hub-delivery.js";
import { FakeGithub } from "../shared/github-watch/fake-github.js";
import { Readable } from "stream";
import type * as http from "http";

const SERVER = { workspace: SERVER_SCOPE, actor: `agent:${SERVER_AGENT_ID}` };
const SHA = "e5".repeat(20);

function shot(scope?: OneShotOptions["scope"]) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:7777",
    async get(path, _q, method, body) {
      calls.push({ path, method, body });
      return { ok: true, watch: { id: "gw-9", state: "waiting" }, watches: [] };
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  const out: string[] = [];
  const opts: OneShotOptions = {
    cfg: {
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: true,
    },
    cli: "acme",
    api,
    out: (s) => out.push(s),
    err: (s) => out.push(s),
    ...(scope ? { scope } : {}),
  };
  const call = (tool: string, args: Record<string, unknown>) =>
    runOneShot({ kind: "call", tool, args }, opts);
  return { call, calls, out };
}

describe("issue 1807: the server agent's MCP server and github_watch", () => {
  it("github_watch, github_watch_list and github_watch_cancel go through", async () => {
    const s = shot(SERVER);
    expect(await s.call("github_watch", { repo: "acme/north", pr: 5 })).toBe(0);
    expect(await s.call("github_watch_list", {})).toBe(0);
    expect(await s.call("github_watch_cancel", { id: "gw-9" })).toBe(0);
    expect(s.calls).toEqual([
      {
        path: "/api/agents/self/github-watches",
        method: "POST",
        body: { repo: "acme/north", pr: 5 },
      },
      {
        path: "/api/agents/self/github-watches",
        method: "GET",
        body: undefined,
      },
      {
        path: "/api/agents/self/github-watches/cancel",
        method: "POST",
        body: { id: "gw-9" },
      },
    ]);
  });

  it("an MCP server that is no agent's is still refused, asking Den nothing", async () => {
    const s = shot();
    for (const [tool, args] of [
      ["github_watch", { repo: "acme/north", pr: 5 }],
      ["github_watch_list", {}],
      ["github_watch_cancel", { id: "gw-9" }],
    ] as const)
      expect(await s.call(tool, args)).toBe(1);
    expect(s.calls).toEqual([]);
    expect(s.out.join("")).toContain("isn't an agent's");
  });

  it("the watch is the server agent's: its finish notice goes to the server agent's session only", async () => {
    let t = Date.parse("2030-01-01T12:00:00Z");
    const gh = new FakeGithub(() => t);
    gh.pr("acme/north", 5, SHA);
    const sent: Delivery[] = [];
    const watcher = new GithubWatcher({
      get: gh.get,
      now: () => t,
      settings: () => ({
        intervalSeconds: 60,
        maxIntervalSeconds: 300,
        budgetFloor: 500,
        watchesMax: 50,
        staleMinutes: 60,
        maxOpenHours: 24,
        rerunLookMinutes: 5,
      }),
      relay: async (dv) => {
        sent.push(dv);
        return true;
      },
    });
    const body = Buffer.from(JSON.stringify({ repo: "acme/north", pr: 5 }));
    const req = Readable.from([body]) as unknown as http.IncomingMessage;
    (req as { method?: string }).method = "POST";
    let status = 0;
    const res = {
      writeHead(s: number) {
        status = s;
        return res;
      },
      setHeader() {},
      end() {},
    } as unknown as http.ServerResponse;
    await handleGithubWatchRoutes(req, res, "/api/agents/self/github-watches", {
      watcher: () => watcher,
      principal: () =>
        ({
          kind: "agent",
          actor: SERVER.actor,
          workspace: SERVER_SCOPE,
          session: { name: "s" },
        }) as never,
      reposOf: () => [],
      allRepos: () => ["acme/north"],
    });
    expect(status).toBe(200);
    gh.check("acme/north", SHA, {
      id: 1,
      name: "lint",
      status: "completed",
      conclusion: "success",
      suite: 1,
    });
    for (let i = 0; i < 3; i++) {
      await watcher.tick();
      await watcher.deliver();
      t = watcher.nextAt;
    }
    expect(sent.map((d) => [d.agent, d.project])).toEqual([
      [SERVER_AGENT_ID, SERVER_SCOPE],
    ]);
  });
});
