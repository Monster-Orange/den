/**
 * Issue 249, end to end on Den's side: an agent's Hub calls through Den's
 * proxy go out with the token Hub bound to that agent; the server agent's
 * with the install's token; removing the agent revokes its token on Hub;
 * and an approval made with the bound token is one Hub can record as the
 * agent's own (verified).
 *
 * A fake Hub stands in for Hub's side: it mints a bound token under the
 * install's token (POST /connect/agent), revokes one by its id, and marks
 * an approval verified only when a bound token made it, as Hub does. Den's
 * side is the real proxy in front of a real agent (a scripted PTY) with its
 * real actor token. Temp dirs, invented names, test-only token values.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  actorTokenOf,
  verifyActorToken,
} from "../../../src/shared/actor-token.js";
import {
  agentsDir,
  readRecord,
  removeRecord,
} from "../../../src/shared/agents/records.js";
import {
  SERVER_AGENT_ID,
  SERVER_SCOPE,
} from "../../../src/shared/agents/server-agent.js";
import {
  HubAgentTokens,
  agentHubTokenDir,
  listAgentHubTokens,
} from "../../../src/shared/hub-agent-tokens.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  hubUpstream,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { handleHubProxy } from "../../../src/ui/server/hub-proxy-routes.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { cleanupRigs, rig, settle, type Rig } from "../agents/helpers/rig.js";

const INSTALL = "hubi_TESTONLY_249_install_token";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((res) => s.close(() => res()));
  }
  await cleanupRigs();
});

interface Seen {
  method: string;
  url: string;
  auth: string;
  agentId: string;
  body: Record<string, unknown>;
}

/** A fake Hub with Hub's agent grant (C7b) and agent approvals. */
async function fakeHub() {
  const seen: Seen[] = [];
  /** Live bound tokens: token -> {tokenId, agent}. */
  const bound = new Map<string, { tokenId: string; agent: string }>();
  const approvals: { agent: string; verified: boolean }[] = [];
  let n = 0;
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        /* not JSON */
      }
      const auth = String(req.headers.authorization ?? "");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth,
        agentId: String(req.headers["x-den-agent-id"] ?? ""),
        body,
      });
      const json = (code: number, v: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      const bearer = auth.replace(/^Bearer /, "");
      const asBound = bound.get(bearer);
      if (bearer !== INSTALL && !asBound)
        return json(401, { error: "unauthorized" });
      if (req.url === "/connect/agent") {
        if (asBound) return json(403, { error: "install_token_required" });
        n += 1;
        const token = `hubi_TESTONLY_249_bound_${n}`;
        const tokenId = `00000000-0000-4000-8000-00000000000${n}`;
        bound.set(token, { tokenId, agent: String(body.agent_id) });
        return json(200, {
          token,
          token_id: tokenId,
          agent: { id: body.agent_id, name: body.agent_name },
        });
      }
      if (req.url === "/connect/revoke") {
        for (const [t, v] of bound)
          if (v.tokenId === body.token_id) {
            bound.delete(t);
            return json(200, { revoked: true, token_id: v.tokenId });
          }
        return json(404, { error: "no such token" });
      }
      if (req.url === "/mcp") {
        const params = (body.params ?? {}) as { name?: string };
        // Hub's rule: verified only when a token bound to the agent made it.
        if (params.name === "hub_approve")
          approvals.push(
            asBound
              ? { agent: asBound.agent, verified: true }
              : {
                  agent: String(req.headers["x-den-agent-id"] ?? ""),
                  verified: false,
                },
          );
        return json(200, {
          jsonrpc: "2.0",
          id: body.id ?? 1,
          result: { ok: true },
        });
      }
      json(404, { error: "not_found" });
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    seen,
    bound,
    approvals,
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
  };
}

/** Den: agent Ada started in project north, and the proxy in front of Hub. */
async function den(
  hubUrl: string,
  opts: {
    agentTokens?: boolean;
    /** Runs while the agent's token is asked for (before it's given). */
    duringToken?: (r: Rig, agentId: string) => void;
  } = {},
) {
  let tokens: HubAgentTokens | null = null;
  let rr: Rig | null = null;
  const r: Rig = await rig({
    hub: async () => ({ url: hubUrl, token: INSTALL }),
    hubAgentToken: async (h, a) => {
      const t = await tokens!.tokenFor(h, a);
      opts.duringToken?.(rr!, a.id);
      return t;
    },
  });
  rr = r;
  tokens = new HubAgentTokens({
    stateDir: () => r.stateDir,
    settings: () => ({
      enabled: opts.agentTokens !== false,
      retrySeconds: 600,
      maxAgeDays: 0,
    }),
  });
  expect(
    await cmdAgents(
      ["start", "-w", "north", "--persona", "planner", "--name", "Ada"],
      r.deps,
    ),
  ).toBe(0);
  await settle();
  const agentToken = actorTokenOf(r.made[0].opts.env) ?? "";
  const agentId = verifyActorToken(r.stateDir, agentToken)!.actor.slice(
    "agent:".length,
  );
  const d = resolveAgentsDeps(r.deps);
  const s = http.createServer((req, res) => {
    const m = /^Bearer (den_at_\S+)$/.exec(
      String(req.headers.authorization ?? ""),
    );
    const t = m ? verifyActorToken(r.stateDir, m[1]) : null;
    if (t)
      setPrincipal(req, {
        kind: "agent",
        actor: t.actor,
        workspace: t.workspace,
        grants: t.grants,
        session: t.session,
      });
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleHubProxy(req, res, p, {
      upstream: (who) => hubUpstream(d, who),
    }).then((handled) => {
      if (!handled) {
        res.writeHead(418);
        res.end();
      }
    });
  });
  servers.push(s);
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const call = (name: string) =>
    fetch(`${base}/hub/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "s-249",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      }),
    });
  return { r, d, agentId, agentToken, call };
}

describe("issue 1222: an agent removed while its Hub token is asked for", () => {
  it("its call in flight gets 403 agent_removed, and nothing goes to Hub (not on the install's token either)", async () => {
    const hub = await fakeHub();
    let removed = false;
    const { call } = await den(hub.url, {
      duringToken: (r, id) => {
        if (removed) return;
        removed = true;
        expect(removeRecord(r.stateDir, id)).toBe(true);
      },
    });
    const res = await call("hub_artifact_create");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "agent_removed",
    );
    expect(hub.seen.filter((x) => x.url === "/mcp")).toHaveLength(0);
  });

  it("removed before its call (its Den token not yet revoked): 403 agent_removed, no token asked for, nothing to Hub", async () => {
    const hub = await fakeHub();
    const { r, agentId, call } = await den(hub.url);
    const mints = hub.seen.filter((x) => x.url === "/connect/agent").length;
    expect(removeRecord(r.stateDir, agentId)).toBe(true);
    const res = await call("hub_artifact_create");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "agent_removed",
    );
    expect(hub.seen.filter((x) => x.url === "/mcp")).toHaveLength(0);
    expect(hub.seen.filter((x) => x.url === "/connect/agent")).toHaveLength(
      mints,
    );
  });

  const spoil = (r: Rig, id: string) =>
    fs.writeFileSync(path.join(agentsDir(r.stateDir), `${id}.json`), "{not");

  it("a record unreadable at the start: 503 agent_unreadable (try again), nothing to Hub", async () => {
    const hub = await fakeHub();
    const { r, agentId, call } = await den(hub.url);
    spoil(r, agentId);
    const res = await call("hub_artifact_create");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "agent_unreadable",
    );
    expect(hub.seen.filter((x) => x.url === "/mcp")).toHaveLength(0);
  });

  it("a record unreadable after the token wait: 503 agent_unreadable, nothing to Hub", async () => {
    const hub = await fakeHub();
    let done = false;
    const { call } = await den(hub.url, {
      duringToken: (r, id) => {
        if (done) return;
        done = true;
        spoil(r, id);
      },
    });
    const res = await call("hub_artifact_create");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "agent_unreadable",
    );
    expect(hub.seen.filter((x) => x.url === "/mcp")).toHaveLength(0);
  });
});

describe("issue 249: agents call Hub with their own bound token", () => {
  it("an agent's hub_artifact_create goes out with its bound token; the server agent's with the install token", async () => {
    const hub = await fakeHub();
    const { r, d, agentId, agentToken, call } = await den(hub.url);
    const res = await call("hub_artifact_create");
    expect(res.status).toBe(200);
    const mcp = hub.seen.filter((x) => x.url === "/mcp");
    expect(mcp).toHaveLength(1);
    const [boundToken] = [...hub.bound.keys()];
    expect(boundToken).toBeDefined();
    expect(mcp[0].auth).toBe(`Bearer ${boundToken}`);
    expect(mcp[0].agentId).toBe(agentId);
    // Minted once, under the install's token, for this agent.
    const mint = hub.seen.filter((x) => x.url === "/connect/agent");
    expect(mint).toHaveLength(1);
    expect(mint[0].auth).toBe(`Bearer ${INSTALL}`);
    expect(mint[0].body).toEqual({ agent_id: agentId, agent_name: "Ada" });
    // A second call: the same token, no second mint.
    await call("hub_artifact_create");
    expect(hub.seen.filter((x) => x.url === "/connect/agent")).toHaveLength(1);
    expect(hub.seen.filter((x) => x.url === "/mcp")[1].auth).toBe(
      `Bearer ${boundToken}`,
    );
    // The server agent: the install token, and nothing minted for it.
    const up = await hubUpstream(d, {
      agentId: SERVER_AGENT_ID,
      workspace: SERVER_SCOPE,
      session: "server-session",
    });
    expect(up && "headers" in up && up.headers.Authorization).toBe(
      `Bearer ${INSTALL}`,
    );
    expect(hub.seen.filter((x) => x.url === "/connect/agent")).toHaveLength(1);
    // The bound token is in the server's store only: never the agent's env.
    expect(JSON.stringify(r.made[0].opts.env)).not.toContain(boundToken);
    expect(
      fs.readFileSync(
        path.join(agentHubTokenDir(r.stateDir), `${agentId}.json`),
        "utf8",
      ),
    ).toContain(boundToken);
    expect(agentToken).not.toBe(boundToken);
  });

  it("removing the agent revokes its token on Hub and forgets it here", async () => {
    const hub = await fakeHub();
    const { r, agentId, call } = await den(hub.url);
    await call("hub_artifact_create");
    expect(hub.bound.size).toBe(1);
    const [{ tokenId }] = [...hub.bound.values()];
    expect(await cmdAgents(["stop", agentId], r.deps)).toBe(0);
    r.made[0].exit(143);
    await settle();
    expect(await cmdAgents(["rm", agentId], r.deps)).toBe(0);
    const revoke = hub.seen.filter((x) => x.url === "/connect/revoke");
    expect(revoke).toHaveLength(1);
    expect(revoke[0].auth).toBe(`Bearer ${INSTALL}`);
    expect(revoke[0].body).toEqual({ token_id: tokenId });
    expect(hub.bound.size).toBe(0);
    expect(listAgentHubTokens(r.stateDir)).toEqual([]);
    expect(readRecord(r.stateDir, agentId)).toBeNull();
  });

  it("an approval made with the bound token is the agent's own on Hub (verified); with the install token it is not", async () => {
    const hub = await fakeHub();
    const { agentId, call } = await den(hub.url);
    expect((await call("hub_approve")).status).toBe(200);
    expect(hub.approvals).toEqual([{ agent: agentId, verified: true }]);

    const old = await fakeHub();
    const before = await den(old.url, { agentTokens: false });
    await before.call("hub_approve");
    expect(old.approvals).toEqual([{ agent: before.agentId, verified: false }]);
    expect(old.seen.filter((x) => x.url === "/connect/agent")).toEqual([]);
  });

  it("the agent's row says whether it is bound on Hub; nothing when Hub isn't connected", async () => {
    const hub = await fakeHub();
    const { r, agentId, call } = await den(hub.url);
    const row = async (hubUrl: string | null) => {
      const c = await r.deps.connect!();
      const sessions = await c.list();
      c.close();
      return listedSessions(
        sessions,
        {
          stateDir: () => r.stateDir,
          dist: () => "acme",
          activeWorkspaces: () => ["north"],
        },
        undefined,
        hubUrl,
      ).find((x) => x.agent === agentId)!;
    };
    expect((await row(`${hub.url}/mcp`)).hubBound).toBe(false);
    await call("hub_artifact_create");
    expect((await row(`${hub.url}/mcp`)).hubBound).toBe(true);
    expect((await row(null)).hubBound).toBeUndefined();
  });
});
