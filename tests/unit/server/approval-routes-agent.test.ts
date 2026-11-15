/**
 * ON-3's held writes as an agent's own token sees them (approval-routes.ts):
 * it may ask, and read its own request; never the person's list, another
 * agent's request, or a decision. Once it is stopped (its token revoked),
 * the person's Allow runs nothing.
 *
 * The handler in an in-process server, the principal set as request-guard
 * sets it for a verified actor token (a live one needs a session host).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  mintActorToken,
  revokeAgentTokens,
} from "../../../src/shared/actor-token.js";
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

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-apagent-"));
const ran: string[] = [];
const restarts: unknown[] = [];
/** SRV-P1: who each agent_create check was told asked. */
const askers: unknown[] = [];
const created: unknown[] = [];
/** SRV-P4: project_mode asks that ran. */
const modes: unknown[] = [];
const actions: HeldActions = {
  project_mode: {
    check: (a) => ({
      ok: true,
      args: { project: "north", mode: String(a.mode) },
      summary: `set project north's mode: edits → ${String(a.mode)}`,
      params: {},
      details: [],
      // A loosening (edits → auto) is the person's Allow only.
      ...(a.mode === "auto" ? { personOnly: true } : {}),
    }),
    run: async (a) => {
      modes.push(a.mode);
      return { ok: true };
    },
  },
  agent_create: {
    check: (a, who) => {
      askers.push(who);
      return {
        ok: true,
        args: { project: String(a.project), persona: "planner" },
        summary: `start agent planner (planner) in ${String(a.project)}, mode ask`,
        params: {},
        details: [],
      };
    },
    run: async (a) => {
      created.push(a);
      return { ok: true, id: "planner" };
    },
  },
  den_restart: {
    check: (a) => ({
      ok: true,
      args: { reason: String(a.reason) },
      summary: `restart Den (${String(a.reason)})`,
      params: { reason: String(a.reason) },
      details: [],
    }),
    run: async (a, asked) => {
      restarts.push({ reason: a.reason, ...asked });
      return { ok: true, restarting: true };
    },
  },
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
const queue = createApprovalQueue(actions, () => stateDir);
/** `mcp.approvals` as the handler reads it. */
let enabled = true;
/** SRV-1a: server_agent.self_update as the handler reads it. */
let selfUpdate: "ask" | "auto" = "ask";
/** SRV-P4: an auto-allow that allows every ask, held writes' worst case. */
let autoEvery = false;
let server: http.Server;
let base = "";

/** Who each request is: `x-test-agent: <id>` an agent, else a signed-in browser. */
function principalFor(req: http.IncomingMessage): Principal {
  const id = req.headers["x-test-agent"];
  return typeof id === "string"
    ? {
        kind: "agent",
        actor: `agent:${id}`,
        workspace: String(req.headers["x-test-project"] ?? "north"),
        grants: [],
        session: { name: `acme-north:${id}` },
      }
    : { kind: "person-browser", session: "s1" };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = principalFor(req);
    setPrincipal(req, p);
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      // The browser's session holds no approval key here: approving is
      // tested on a real server (approval-routes.integration).
      session: null,
    } as unknown as Extract<GuardResult, { ok: true }>;
    void handleApprovalRoutes(
      req,
      res,
      new URL(req.url!, "http://x").pathname,
      guard,
      {
        queue,
        actions,
        enabled: () => enabled,
        autoAllow: (action, agent) =>
          autoEvery
            ? "a setting that allows every ask"
            : action === "den_restart" &&
                agent === "server" &&
                selfUpdate === "auto"
              ? "server_agent.self_update: auto"
              : null,
      },
    ).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const as = (
  agent?: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) => ({
  method,
  headers: {
    ...(agent ? { "x-test-agent": agent } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

describe("an agent's own token", () => {
  it("asks, reads its own request; never the list, another's, or a decision; stopped, its Allow runs nothing", async () => {
    mintActorToken(stateDir, {
      agentId: "server",
      workspace: "north",
      sessionName: "acme-north:server",
    });
    const r = await fetch(
      `${base}/api/approvals`,
      as("server", { action: "workspace_create", args: { name: "byagent" } }),
    );
    expect(r.status).toBe(202);
    const a = (await r.json()) as { id: string; agent: string };
    expect(a.agent).toBe("server");
    const mine = await fetch(`${base}/api/approvals/${a.id}`, as("server"));
    expect(((await mine.json()) as { state: string }).state).toBe("pending");
    expect(
      (await fetch(`${base}/api/approvals/${a.id}`, as("other"))).status,
    ).toBe(404);
    // Its list is its own requests and their outcomes; never another agent's.
    mintActorToken(stateDir, {
      agentId: "other",
      workspace: "north",
      sessionName: "acme-north:other",
    });
    const theirs = (await (
      await fetch(
        `${base}/api/approvals`,
        as("other", {
          action: "workspace_create",
          args: { name: "othersecret" },
        }),
      )
    ).json()) as { id: string };
    const list = await fetch(`${base}/api/approvals`, as("server"));
    expect(list.status).toBe(200);
    const listText = await list.text();
    const mineList = (JSON.parse(listText) as { mine: { id: string }[] }).mine;
    expect(mineList.map((x) => x.id)).toEqual([a.id]);
    expect(listText).not.toContain("othersecret");
    expect(listText).not.toContain(theirs.id);
    // An agent is never handed a ticket: its token says who it is.
    expect(Object.keys(a)).not.toContain("ticket");
    const d = await fetch(
      `${base}/api/approvals/${a.id}/decide`,
      as("server", { decision: "allow" }),
    );
    expect([d.status, ((await d.json()) as { code: string }).code]).toEqual([
      403,
      "signin_to_approve",
    ]);
    // A browser without its approval key (none here) gets no list.
    const people = await fetch(`${base}/api/approvals`, as());
    expect([
      people.status,
      ((await people.json()) as { code: string }).code,
    ]).toEqual([403, "signin_to_approve"]);
    // Stopped: the queue's Allow (what an approving browser reaches) runs nothing.
    revokeAgentTokens(stateDir, "server");
    const late = await queue.decide(a.id, "allow", "s1");
    expect(late).toMatchObject({ ok: false, code: "actor_gone" });
    expect(ran).toEqual([]);
  });

  it("mcp.approvals: false: the server holds nothing", async () => {
    enabled = false;
    try {
      const r = await fetch(
        `${base}/api/approvals`,
        as("server", { action: "workspace_create", args: { name: "off" } }),
      );
      expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([
        403,
        "approvals_off",
      ]);
    } finally {
      enabled = true;
    }
  });
});

describe("SRV-P1: agent_create hears who asked", () => {
  it("a project's agent's ask names it and its project; held, then run on Allow", async () => {
    mintActorToken(stateDir, {
      agentId: "lead",
      workspace: "north",
      sessionName: "acme-north:lead",
    });
    askers.length = 0;
    const r = await fetch(
      `${base}/api/approvals`,
      as("lead", { action: "agent_create", args: { project: "north" } }),
    );
    expect(r.status).toBe(202);
    const a = (await r.json()) as { id: string; agent: string };
    expect(a.agent).toBe("lead");
    expect(askers[0]).toEqual({ agent: "lead", project: "north" });
    expect(created).toEqual([]);
    await queue.decide(a.id, "allow", "s1");
    expect(created).toEqual([{ project: "north", persona: "planner" }]);
  });

  it("a person's ask (no agent token) names no agent", async () => {
    askers.length = 0;
    await fetch(
      `${base}/api/approvals`,
      as(undefined, { action: "agent_create", args: { project: "north" } }),
    );
    expect(askers[0]).toEqual({});
  });
});

describe("SRV-1a: server_agent.self_update", () => {
  const ask = (agent?: string) =>
    fetch(
      `${base}/api/approvals`,
      as(agent, { action: "den_restart", args: { reason: "new pin" } }),
    ).then(async (r) => ({
      status: r.status,
      body: (await r.json()) as { id: string; state: string; result?: unknown },
    }));

  it("ask (the default): the server agent's restart is held", async () => {
    mintActorToken(stateDir, {
      agentId: "server",
      workspace: "north",
      sessionName: "acme-north:server",
    });
    const r = await ask("server");
    expect([r.status, r.body.state]).toEqual([202, "pending"]);
    expect(restarts).toEqual([]);
  });

  it("auto: its own ask runs at once, and says who allowed it; another agent's and a token-less ask are still held", async () => {
    selfUpdate = "auto";
    try {
      const r = await ask("server");
      expect(r.body.state).toBe("done");
      expect(r.body.result).toEqual({ ok: true, restarting: true });
      expect(restarts).toEqual([
        {
          reason: "new pin",
          id: r.body.id,
          agent: "server",
          decidedBy: "auto:server_agent.self_update: auto",
        },
      ]);
      mintActorToken(stateDir, {
        agentId: "other",
        workspace: "north",
        sessionName: "acme-north:other",
      });
      expect((await ask("other")).body.state).toBe("pending");
      expect((await ask()).body.state).toBe("pending");
      expect(restarts).toHaveLength(1);
    } finally {
      selfUpdate = "ask";
    }
  });
});

describe("SRV-P4: a loosening project_mode is the person's Allow only", () => {
  const ask = (mode: string) =>
    fetch(
      `${base}/api/approvals`,
      as("lead", { action: "project_mode", args: { mode } }),
    ).then(async (r) => (await r.json()) as { id: string; state: string });

  it("no auto-allow runs it, even one that allows every ask; a tightening it may", async () => {
    mintActorToken(stateDir, {
      agentId: "lead",
      workspace: "north",
      sessionName: "acme-north:lead",
    });
    autoEvery = true;
    try {
      const loosen = await ask("auto");
      expect(loosen.state).toBe("pending");
      expect(modes).toEqual([]);
      const tighten = await ask("ask");
      expect(tighten.state).toBe("done");
      expect(modes).toEqual(["ask"]);
      // The person's Allow runs it.
      await queue.decide(loosen.id, "allow", "s1");
      expect(modes).toEqual(["ask", "auto"]);
    } finally {
      autoEvery = false;
    }
  });
});
