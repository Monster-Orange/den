/**
 * den_update asked by a project's agent: a held write a person Allows.
 * The ask holds it and Den does not update; no setting runs it at once
 * (server_agent.self_update: auto covers Den's own agent only, and no
 * approval policy runs a critical write); no agent Allows it, its own or
 * another's; the person's Allow runs the same held den_update as every
 * other way in (the update path with its doctor and rollback).
 *
 * The queue and the handler in process, with Den's own held actions and
 * its self_update rule; the update itself is a fake that records.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { selfUpdateAutoAllow } from "../../../src/ui/server/server-restart.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-upd-held-"));
const updates: unknown[] = [];
const actions = heldActions({
  updateDen: async (version: string, reason: string, asked?: unknown) => {
    updates.push({ version, reason, asked });
    return { ok: true, restarting: true };
  },
} as unknown as Parameters<typeof heldActions>[0]);
const queue = createApprovalQueue(actions, () => stateDir);
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const id = req.headers["x-test-agent"];
    const p: Principal =
      typeof id === "string"
        ? {
            kind: "agent",
            actor: `agent:${id}`,
            workspace: String(req.headers["x-test-project"] ?? "north"),
            grants: [],
            session: { name: `acme-north:${id}` },
          }
        : { kind: "person-browser", session: "s1" };
    setPrincipal(req, p);
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
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
        autoAllow: (action, agent, workspace) =>
          // server_agent.self_update: auto, the loosest it gets.
          selfUpdateAutoAllow(action, agent, workspace, () => true),
        // The loosest policy there is: it must never reach a critical write.
        policy: () => ({ kind: "auto", from: "a policy that runs all" }),
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
  for (const agentId of ["planner", "reviewer"])
    mintActorToken(stateDir, {
      agentId,
      workspace: "north",
      sessionName: `acme-north:${agentId}`,
    });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function ask(agent: string) {
  const r = await fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-agent": agent },
    body: JSON.stringify({
      action: "den_update",
      args: { version: "0.4.44", reason: "a fix we need" },
    }),
  });
  return {
    status: r.status,
    body: (await r.json()) as { id: string; state: string },
  };
}

const decideAs = (id: string, agent: string) =>
  fetch(`${base}/api/approvals/${id}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-agent": agent },
    body: JSON.stringify({ decision: "allow" }),
  });

describe("den_update from a project's agent", () => {
  it("is held, even with self_update: auto and a policy that runs all; Den does not update", async () => {
    const a = await ask("planner");
    expect([a.status, a.body.state]).toEqual([202, "pending"]);
    expect(updates).toEqual([]);
    await queue.decide(a.body.id, "deny", "session:s1");
  });

  it("self_update: auto runs Den's own agent's update only, never a project agent's", () => {
    const own = (action: string, auto = true) =>
      selfUpdateAutoAllow(action, "server", SERVER_SCOPE, () => auto);
    expect(own("den_update")).toBe("server_agent.self_update: auto");
    expect(own("den_restart")).toBe("server_agent.self_update: auto");
    expect(own("den_update", false)).toBe(null);
    expect(own("agent_create")).toBe(null);
    expect(
      selfUpdateAutoAllow("den_update", "planner", SERVER_SCOPE, () => true),
    ).toBe(null);
  });

  it('a project\'s agent whose id is "server" is still held: the scope decides, not the name', () => {
    for (const ws of ["north", "", undefined])
      expect(selfUpdateAutoAllow("den_update", "server", ws, () => true)).toBe(
        null,
      );
    expect(
      selfUpdateAutoAllow("den_restart", "server", "north", () => true),
    ).toBe(null);
  });

  it("no agent can Allow it: not the one that asked, not another", async () => {
    const a = await ask("planner");
    for (const agent of ["planner", "reviewer"]) {
      const r = await decideAs(a.body.id, agent);
      expect(r.status).toBe(403);
    }
    expect(queue.get(a.body.id)?.state).toBe("pending");
    expect(updates).toEqual([]);
    await queue.decide(a.body.id, "deny", "session:s1");
  });

  it("Deny updates nothing", async () => {
    const a = await ask("planner");
    const r = await queue.decide(a.body.id, "deny", "session:s1");
    expect(r.ok).toBe(true);
    expect(updates).toEqual([]);
  });

  it("the person's Allow runs Den's update path once, with the version, the reason and who asked", async () => {
    const a = await ask("planner");
    const r = await queue.decide(a.body.id, "allow", "session:s1");
    expect(r.ok).toBe(true);
    expect(updates).toEqual([
      {
        version: "0.4.44",
        reason: "a fix we need",
        asked: expect.objectContaining({
          id: a.body.id,
          agent: "planner",
          decidedBy: "session:s1",
        }),
      },
    ]);
  });
});
