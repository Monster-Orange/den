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
const queue = createApprovalQueue(actions, () => stateDir);
let server: http.Server;
let base = "";

/** Who each request is: `x-test-agent: <id>` an agent, else a signed-in browser. */
function principalFor(req: http.IncomingMessage): Principal {
  const id = req.headers["x-test-agent"];
  return typeof id === "string"
    ? {
        kind: "agent",
        actor: `agent:${id}`,
        workspace: "north",
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
    const list = await fetch(`${base}/api/approvals`, as("server"));
    expect([
      list.status,
      ((await list.json()) as { code: string }).code,
    ]).toEqual([403, "person_only"]);
    const d = await fetch(
      `${base}/api/approvals/${a.id}/decide`,
      as("server", { decision: "allow" }),
    );
    expect([d.status, ((await d.json()) as { code: string }).code]).toEqual([
      403,
      "signin_to_approve",
    ]);
    // The person's list has it.
    const people = (await (
      await fetch(`${base}/api/approvals`, as())
    ).json()) as {
      pending: { id: string }[];
    };
    expect(people.pending.map((x) => x.id)).toContain(a.id);
    // Stopped: the queue's Allow (what an approving browser reaches) runs nothing.
    revokeAgentTokens(stateDir, "server");
    const late = await queue.decide(a.id, "allow", "s1");
    expect(late).toMatchObject({ ok: false, code: "actor_gone" });
    expect(ran).toEqual([]);
  });
});
