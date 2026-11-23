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
  noteHubMcpCall,
  noteHubMcpInit,
  noteHubMcpTools,
  mcpLoadFailures,
  readHubMcpInit,
} from "../../../src/shared/agents/hub-mcp-connect.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  agentTools,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import {
  handleHubProxy,
  type HubProxyDeps,
} from "../../../src/ui/server/hub-proxy-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import {
  verifyActorToken,
  actorTokenOf,
} from "../../../src/shared/actor-token.js";
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
  const r = await rig({
    hub: async () => ({ url: HUB, token: "hubi_TESTONLY" }),
  });
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  await settle();
  return { r, d: resolveAgentsDeps(r.deps) };
}

describe("whoami after a Hub connection that failed at start", () => {
  it("started with Hub, its connect got a 502: not loaded, restart, the error named", async () => {
    const { r, d } = await started();
    const ok = await agentTools(d, "planner", "north");
    expect(ok.hub).toEqual({ connected: true, loaded: true, restart: false });
    noteHubMcpInit(r.stateDir, "planner", {
      ok: false,
      error: "hub (502): Bad Gateway",
    });
    const t = await agentTools(d, "planner", "north");
    expect(t.hub).toEqual({ connected: true, loaded: false, restart: true });
    expect(t.note).toContain("hub (502): Bad Gateway");
    expect(t.note).toMatch(/restart you from Den/);
  });

  it("a later connect that worked (the runtime reconnected): loaded again", async () => {
    const { r, d } = await started();
    noteHubMcpInit(r.stateDir, "planner", {
      ok: false,
      error: "hub (502): Bad Gateway",
    });
    noteHubMcpInit(r.stateDir, "planner", { ok: true });
    expect((await agentTools(d, "planner", "north")).hub.loaded).toBe(true);
  });

  it("a failure from before this session started doesn't count", async () => {
    const { r, d } = await started();
    noteHubMcpInit(r.stateDir, "planner", {
      ok: false,
      error: "hub (502): Bad Gateway",
    });
    const rec = readRecord(r.stateDir, "planner")!;
    writeRecord(r.stateDir, {
      ...rec,
      startedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await agentTools(d, "planner", "north")).hub).toEqual({
      connected: true,
      loaded: true,
      restart: false,
    });
  });
});

describe("the /hub proxy notes each MCP initialize", () => {
  async function proxied(
    status: number | "down",
    extra: Partial<HubProxyDeps> = {},
  ) {
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
    const mcpUrl =
      status === "down"
        ? "http://127.0.0.1:1/mcp"
        : `http://127.0.0.1:${port}/mcp`;
    const notes: unknown[] = [];
    const den = http.createServer((req, res) => {
      const t = verifyActorToken(
        r.stateDir,
        String(req.headers.authorization ?? "").slice(7),
      );
      if (t)
        setPrincipal(req, {
          kind: "agent",
          actor: t.actor,
          workspace: t.workspace,
          grants: t.grants,
          session: t.session,
        });
      void handleHubProxy(
        req,
        res,
        new URL(req.url ?? "/", "http://x").pathname,
        {
          upstream: async () => ({
            base: mcpUrl.replace(/\/mcp$/, ""),
            mcpUrl,
            headers: {},
          }),
          onMcpInit: (agentId, o) => notes.push({ agentId, ...o }),
          ...extra,
        },
      );
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
    expect(notes).toEqual([
      { agentId: "planner", ok: false, error: "hub (502): Bad Gateway" },
    ]);
  });

  it("Hub not answering: noted as failed", async () => {
    const { notes, post } = await proxied("down");
    expect((await post()).status).toBe(502);
    expect(notes).toEqual([
      { agentId: "planner", ok: false, error: "hub didn't answer" },
    ]);
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

  it("0.4.48: every answer from Hub is reported (a 401 inside a session too), so Den can re-read its token and keep the note live", async () => {
    const answers: unknown[] = [];
    const { post } = await proxied(401, {
      onHubAnswer: (agentId, o) => answers.push({ agentId, ...o }),
    });
    expect((await post()).status).toBe(401);
    expect((await post("s1")).status).toBe(401);
    expect(answers).toEqual([
      { agentId: "planner", sub: "/mcp", status: 401 },
      { agentId: "planner", sub: "/mcp", status: 401 },
    ]);
  });

  it("0.4.48: Hub set up but its token unreadable: the agent is told so plainly, never to reconnect", async () => {
    const answers: unknown[] = [];
    const why =
      "Den can't read the Hub token from its secrets store (Too many requests.); trying again in 1 min";
    const { notes, post } = await proxied(200, {
      upstream: async () => null,
      whyNotConnected: () => why,
      onHubAnswer: (agentId, o) => answers.push({ agentId, ...o }),
    });
    const res = await post();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("hub_token_unreadable");
    expect(body.error).toContain(why);
    expect(body.error).not.toMatch(/Settings/);
    expect(body.error).toMatch(/nothing for the person to do/i);
    expect(notes).toEqual([
      {
        agentId: "planner",
        ok: false,
        error: "Den couldn't read its Hub token",
      },
    ]);
    expect(answers).toEqual([
      { agentId: "planner", sub: "/mcp", status: null, error: why },
    ]);
  });
});

describe("0.4.48: hub-mcp.json says how the agent's Hub calls go now", () => {
  it("each call's result is kept beside the connect's; the connect's note stays what whoami reads", async () => {
    const { r } = await started();
    noteHubMcpInit(r.stateDir, "planner", { ok: true });
    noteHubMcpCall(r.stateDir, "planner", {
      ok: false,
      error: "hub (401): Unauthorized",
    });
    const v = readHubMcpInit(r.stateDir, "planner");
    expect(v).toMatchObject({
      ok: true,
      last: {
        ok: false,
        error: "hub (401): Unauthorized",
        at: expect.any(String),
      },
    });
    noteHubMcpCall(r.stateDir, "planner", { ok: true });
    expect(readHubMcpInit(r.stateDir, "planner")?.last).toEqual({
      ok: true,
      at: expect.any(String),
    });
    // A call with no connect noted yet is never read as a failed connect.
    noteHubMcpCall(r.stateDir, "nobody-yet", { ok: false, error: "x" });
    expect(readHubMcpInit(r.stateDir, "nobody-yet")).toBeNull();
    // A new connect keeps the last call it had.
    noteHubMcpInit(r.stateDir, "planner", { ok: true });
    expect(readHubMcpInit(r.stateDir, "planner")?.last?.ok).toBe(true);
  });
});

describe("issue 749: Hub connected but listing its tools failed", () => {
  async function listed(answer: (res: http.ServerResponse) => void) {
    const { r } = await started();
    const token = actorTokenOf(r.made[0].opts.env) ?? "";
    const hub = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (/"tools\/list"/.test(body)) return answer(res);
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "s1",
        });
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      });
    });
    servers.push(hub);
    await new Promise<void>((x) => hub.listen(0, "127.0.0.1", x));
    const mcpUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}/mcp`;
    const lists: unknown[] = [];
    const den = http.createServer((req, res) => {
      const t = verifyActorToken(
        r.stateDir,
        String(req.headers.authorization ?? "").slice(7),
      );
      if (t)
        setPrincipal(req, {
          kind: "agent",
          actor: t.actor,
          workspace: t.workspace,
          grants: t.grants,
          session: t.session,
        });
      void handleHubProxy(
        req,
        res,
        new URL(req.url ?? "/", "http://x").pathname,
        {
          upstream: async () => ({
            base: mcpUrl.replace(/\/mcp$/, ""),
            mcpUrl,
            headers: {},
          }),
          onMcpToolsList: (agentId, o) => lists.push({ agentId, ...o }),
        },
      );
    });
    servers.push(den);
    await new Promise<void>((x) => den.listen(0, "127.0.0.1", x));
    const base = `http://127.0.0.1:${(den.address() as AddressInfo).port}`;
    const post = (method: string) =>
      fetch(`${base}/hub/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "mcp-session-id": "s1",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method }),
      });
    return { r, lists, post };
  }

  it("a 500 for tools/list is noted as failed, with the status", async () => {
    const { lists, post } = await listed((res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
    expect((await post("tools/list")).status).toBe(500);
    expect(lists).toEqual([
      {
        agentId: "planner",
        ok: false,
        error: "hub (500): Internal Server Error",
      },
    ]);
  });

  it("a 200 whose answer is a JSON-RPC error (as an event stream) is failed too", async () => {
    const { lists, post } = await listed((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'event: message\ndata: {"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"boom"}}\n\n',
      );
    });
    await (await post("tools/list")).text();
    expect(lists).toEqual([
      {
        agentId: "planner",
        ok: false,
        error: "hub answered tools/list with an error",
      },
    ]);
  });

  it("a 200 with the tools is ok; other calls in the session aren't a listing", async () => {
    const { lists, post } = await listed((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}');
    });
    await (await post("tools/call")).text();
    await (await post("tools/list")).text();
    expect(lists).toEqual([{ agentId: "planner", ok: true }]);
  });

  it("review: an answer with a content-encoding isn't read (Den can't see its result), so it is never noted as a failure", async () => {
    const { lists, post } = await listed((res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    });
    await (await post("tools/list")).arrayBuffer().catch(() => undefined);
    expect(lists).toEqual([]);
  });

  it("whoami: connected, its connect ok, its listing failed: not loaded, restart, the reason named", async () => {
    const { r, d } = await started();
    noteHubMcpInit(r.stateDir, "planner", { ok: true });
    noteHubMcpTools(r.stateDir, "planner", {
      ok: false,
      error: "hub (500): Internal Server Error",
    });
    const t = await agentTools(d, "planner", "north");
    expect(t.hub).toEqual({ connected: true, loaded: false, restart: true });
    expect(t.note).toContain(
      "listing Hub's tools failed (hub (500): Internal Server Error)",
    );
    expect(
      mcpLoadFailures(r.stateDir, readRecord(r.stateDir, "planner")!),
    ).toEqual([
      {
        server: "hub",
        error: "listing Hub's tools failed (hub (500): Internal Server Error)",
        at: expect.any(String),
      },
    ]);
  });

  it("a later listing that worked, or a new connect, clears it", async () => {
    const { r, d } = await started();
    noteHubMcpInit(r.stateDir, "planner", { ok: true });
    noteHubMcpTools(r.stateDir, "planner", { ok: false, error: "x" });
    expect((await agentTools(d, "planner", "north")).hub.loaded).toBe(false);
    noteHubMcpTools(r.stateDir, "planner", { ok: true });
    expect((await agentTools(d, "planner", "north")).hub.loaded).toBe(true);
    noteHubMcpTools(r.stateDir, "planner", { ok: false, error: "x" });
    expect((await agentTools(d, "planner", "north")).hub.loaded).toBe(false);
    noteHubMcpInit(r.stateDir, "planner", { ok: true });
    expect((await agentTools(d, "planner", "north")).hub.loaded).toBe(true);
    // A listing that worked never hides a connect that failed.
    noteHubMcpInit(r.stateDir, "planner", {
      ok: false,
      error: "hub (502): Bad Gateway",
    });
    noteHubMcpTools(r.stateDir, "planner", { ok: true });
    expect((await agentTools(d, "planner", "north")).hub.loaded).toBe(false);
  });
});
