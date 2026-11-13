/**
 * whoami tells an agent what it actually got: when its Hub MCP connection
 * failed at start ("hub (502): Bad Gateway", no hub_* tools), Hub is not
 * loaded, a restart is what brings it, and the note names the error.
 * Den's /hub proxy notes each MCP initialize (a POST to /mcp with no
 * Mcp-Session-Id) per agent.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import {
  noteHubMcpInit,
  readHubMcpInit,
} from "../../../src/shared/agents/hub-mcp-connect.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  agentTools,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { handleHubProxy } from "../../../src/ui/server/hub-proxy-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { verifyActorToken, actorTokenOf } from "../../../src/shared/actor-token.js";
import { cleanupRigs, rig, settle } from "./helpers/rig.js";

const HUB = "http://hub.example.test";
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  await cleanupRigs();
});

async function started() {
  const r = await rig({ hub: async () => ({ url: HUB, token: "hubi_TESTONLY" }) });
  expect(await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps)).toBe(0);
  await settle();
  return { r, d: resolveAgentsDeps(r.deps) };
}

describe("whoami after a Hub connection that failed at start", () => {
  it("started with Hub, its connect got a 502: not loaded, restart, the error named", async () => {
    const { r, d } = await started();
    const ok = await agentTools(d, "planner", "north");
    expect(ok.hub).toEqual({ connected: true, loaded: true, restart: false });
    noteHubMcpInit(r.stateDir, "planner", { ok: false, error: "hub (502): Bad Gateway" });
    const t = await agentTools(d, "planner", "north");
    expect(t.hub).toEqual({ connected: true, loaded: false, restart: true });
    expect(t.note).toContain("hub (502): Bad Gateway");
    expect(t.note).toMatch(/restart you from Den/);
  });

  it("a later connect that worked (the runtime reconnected): loaded again", async () => {
    const { r, d } = await started();
    noteHubMcpInit(r.stateDir, "planner", { ok: false, error: "hub (502): Bad Gateway" });
    noteHubMcpInit(r.stateDir, "planner", { ok: true });
    expect((await agentTools(d, "planner", "north")).hub.loaded).toBe(true);
  });

  it("a failure from before this session started doesn't count", async () => {
    const { r, d } = await started();
    noteHubMcpInit(r.stateDir, "planner", { ok: false, error: "hub (502): Bad Gateway" });
    const rec = readRecord(r.stateDir, "planner")!;
    writeRecord(r.stateDir, { ...rec, startedAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await agentTools(d, "planner", "north")).hub).toEqual({
      connected: true,
      loaded: true,
      restart: false,
    });
  });
});

describe("the /hub proxy notes each MCP initialize", () => {
  async function proxied(status: number | "down") {
    const { r } = await started();
    const token = actorTokenOf(r.made[0].opts.env) ?? "";
    const hub = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(status === "down" ? 200 : status, {
          "content-type": "application/json",
          ...(status === 200 ? { "mcp-session-id": "s1" } : {}),
        });
        res.end("{}");
      });
    });
    servers.push(hub);
    await new Promise<void>((x) => hub.listen(0, "127.0.0.1", x));
    const port = (hub.address() as AddressInfo).port;
    const mcpUrl = status === "down" ? "http://127.0.0.1:1/mcp" : `http://127.0.0.1:${port}/mcp`;
    const notes: unknown[] = [];
    const den = http.createServer((req, res) => {
      const t = verifyActorToken(r.stateDir, String(req.headers.authorization ?? "").slice(7));
      if (t)
        setPrincipal(req, {
          kind: "agent",
          actor: t.actor,
          workspace: t.workspace,
          grants: t.grants,
          session: t.session,
        });
      void handleHubProxy(req, res, new URL(req.url ?? "/", "http://x").pathname, {
        upstream: async () => ({ base: mcpUrl.replace(/\/mcp$/, ""), mcpUrl, headers: {} }),
        onMcpInit: (agentId, o) => notes.push({ agentId, ...o }),
      });
    });
    servers.push(den);
    await new Promise<void>((x) => den.listen(0, "127.0.0.1", x));
    const base = `http://127.0.0.1:${(den.address() as AddressInfo).port}`;
    const post = (session?: string) =>
      fetch(`${base}/hub/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      });
    return { r, notes, post };
  }

  it("a 502 from Hub: noted as failed, with the status", async () => {
    const { notes, post } = await proxied(502);
    expect((await post()).status).toBe(502);
    expect(notes).toEqual([{ agentId: "planner", ok: false, error: "hub (502): Bad Gateway" }]);
  });

  it("Hub not answering: noted as failed", async () => {
    const { notes, post } = await proxied("down");
    expect((await post()).status).toBe(502);
    expect(notes).toEqual([{ agentId: "planner", ok: false, error: "hub didn't answer" }]);
  });

  it("a 200 with a session: noted as ok; a call inside a session isn't an initialize", async () => {
    const { notes, post } = await proxied(200);
    expect((await post()).status).toBe(200);
    expect((await post("s1")).status).toBe(200);
    expect(notes).toEqual([{ agentId: "planner", ok: true }]);
  });

  it("the note is the agent's own file; the latest wins", async () => {
    const { r } = await started();
    noteHubMcpInit(r.stateDir, "planner", { ok: false, error: "x" });
    noteHubMcpInit(r.stateDir, "planner", { ok: true });
    expect(readHubMcpInit(r.stateDir, "planner")).toMatchObject({ ok: true });
    expect(readHubMcpInit(r.stateDir, "nobody")).toBeNull();
  });
});
