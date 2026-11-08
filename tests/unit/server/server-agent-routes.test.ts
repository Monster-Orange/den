/**
 * The server agent's routes (ON-6, server-agent-routes.ts): its status,
 * starting it, and its runtime. Only a person starts it or picks its
 * runtime: an agent's token, or a claim to be an agent, is refused. Its
 * writes stay held (ON-3): with its own token, it can ask, never approve.
 *
 * A real session host on a temp socket with a scripted PTY (nothing runs),
 * a `claude` shim that only answers --version, the handlers in-process with
 * the principal set as request-guard sets it. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { handleServerAgentRoutes } from "../../../src/ui/server/server-agent-routes.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cleanupRigs, rig, type Rig } from "../agents/helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const AGENT: Principal = {
  kind: "agent",
  actor: "agent:server",
  workspace: SERVER_SCOPE,
  grants: [],
  session: { name: `acme-${SERVER_SCOPE}:server` },
};

async function serve(
  r: Rig,
  saved: { id?: string | null; model?: string | null },
  ran: string[],
) {
  const actions: HeldActions = {
    workspace_create: {
      check: (a) => ({
        ok: true,
        args: { name: String(a.name) },
        summary: `create the workspace "${String(a.name)}"`,
        params: { name: String(a.name) },
        details: [],
      }),
      run: async (a) => {
        ran.push(String(a.name));
        return { ok: true };
      },
    },
  };
  const queue = createApprovalQueue(actions, () => r.stateDir);
  const server = http.createServer((req, res) => {
    const p: Principal =
      req.headers["x-test-agent"] === "1"
        ? AGENT
        : { kind: "person-browser", session: "s1" };
    setPrincipal(req, p);
    const pathname = new URL(req.url!, "http://x").pathname;
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      session: null,
    } as unknown as Extract<GuardResult, { ok: true }>;
    void (async () => {
      const handled =
        (await handleServerAgentRoutes(req, res, pathname, {
          agents: r.deps,
          server: {
            title: () => "Acme",
            fresh: () => true,
            readSetting: () => saved.id ?? undefined,
            saveSetting: (id) => {
              saved.id = id;
            },
            readModel: () => saved.model ?? undefined,
            saveModel: (id) => {
              saved.model = id;
            },
            root: () => "/dens/acme",
          },
        })) ||
        (await handleApprovalRoutes(req, res, pathname, guard, {
          queue,
          actions,
          enabled: () => true,
        }));
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    })();
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return async (
    method: string,
    p: string,
    body?: unknown,
    agent = false,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        ...(agent ? { "x-test-agent": "1" } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
}

describe("/api/server-agent", () => {
  it("says what it is, that this Den is fresh, its runtime, and that it hasn't started", async () => {
    const r = await rig();
    const call = await serve(r, {}, []);
    const { status, json } = await call("GET", "/api/server-agent");
    expect(status).toBe(200);
    expect(json).toMatchObject({
      name: "Acme agent",
      id: "server",
      scope: SERVER_SCOPE,
      fresh: true,
      runtime: { id: "den-claude" },
      state: "none",
    });
  });

  it("a person starts it; then it runs, with a session to open", async () => {
    const r = await rig();
    const call = await serve(r, {}, []);
    const s = await call("POST", "/api/server-agent/start", {});
    expect([s.status, s.json.how, s.json.runtime]).toEqual([
      200,
      "started",
      "den-claude",
    ]);
    const st = await call("GET", "/api/server-agent");
    expect(st.json).toMatchObject({
      state: "running",
      sessionId: s.json.sessionId,
    });
  });

  it("an agent can't start it or pick its runtime", async () => {
    const r = await rig();
    const saved: { id?: string | null } = {};
    const call = await serve(r, saved, []);
    const s = await call("POST", "/api/server-agent/start", {}, true);
    expect(s.status).toBe(403);
    const p = await call(
      "POST",
      "/api/server-agent/runtime",
      { runtime: "den-claude" },
      true,
    );
    expect(p.status).toBe(403);
    expect(r.made).toHaveLength(0);
    expect(readRecord(r.stateDir, "server")).toBeNull();
    expect(saved.id).toBeUndefined();
  });

  it("the person's runtime choice is saved; an unknown one is refused", async () => {
    const r = await rig();
    const saved: { id?: string | null } = {};
    const call = await serve(r, saved, []);
    const ok = await call("POST", "/api/server-agent/runtime", {
      runtime: "den-claude",
    });
    expect([ok.status, ok.json.setting]).toEqual([200, "den-claude"]);
    const bad = await call("POST", "/api/server-agent/runtime", {
      runtime: "nope",
    });
    expect(bad.status).toBe(400);
    expect(saved.id).toBe("den-claude");
  });
});

describe("/api/server-agent/model", () => {
  it("offers the runtime's own models, Sonnet by default; the person's choice is saved; others refused", async () => {
    const r = await rig();
    const saved: { id?: string | null; model?: string | null } = {};
    const call = await serve(r, saved, []);
    const st = await call("GET", "/api/server-agent");
    expect(st.json.model).toBe("sonnet");
    expect((st.json.models as { id: string }[]).map((m) => m.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
    const ok = await call("POST", "/api/server-agent/model", {
      model: "opus",
    });
    expect([ok.status, ok.json.model]).toEqual([200, "opus"]);
    expect(saved.model).toBe("opus");
    const bad = await call("POST", "/api/server-agent/model", {
      model: "gpt-x",
    });
    expect(bad.status).toBe(400);
    const agent = await call(
      "POST",
      "/api/server-agent/model",
      { model: "haiku" },
      true,
    );
    expect(agent.status).toBe(403);
    expect(saved.model).toBe("opus");
  });
});

describe("its writes", () => {
  it("are held: with its own token it asks, and can't allow its own request", async () => {
    const r = await rig();
    const ran: string[] = [];
    const call = await serve(r, {}, ran);
    mintActorToken(r.stateDir, {
      agentId: "server",
      workspace: SERVER_SCOPE,
      sessionName: `acme-${SERVER_SCOPE}:server`,
    });
    const ask = await call(
      "POST",
      "/api/approvals",
      { action: "workspace_create", args: { name: "web" } },
      true,
    );
    expect([ask.status, ask.json.state, ask.json.agent]).toEqual([
      202,
      "pending",
      "server",
    ]);
    const d = await call(
      "POST",
      `/api/approvals/${String(ask.json.id)}/decide`,
      { decision: "allow" },
      true,
    );
    expect([d.status, d.json.code]).toEqual([403, "signin_to_approve"]);
    expect(ran).toEqual([]);
  });
});
