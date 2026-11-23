/**
 * Issue 772 clauses 1 and 2, through the real approvals route and queue:
 *
 *   1. a policy that holds agent_prompt: the request waits and nothing is
 *      typed until the person allows it; a denied one types nothing
 *   2. a policy that doesn't hold it: the text is typed into the target
 *      once, at the ask
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
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import {
  AgentPrompts,
  type PromptState,
} from "../../../src/ui/server/agent-prompt.js";
import type { PolicyKind } from "../../../src/shared/approval-policy.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-772-held-"));
const typed: [string, string][] = [];
const state = new Map<string, PromptState | null>([
  ["planner", "working"],
  ["builder", "idle"],
]);
const prompts = new AgentPrompts({
  record: (id) => (state.has(id) ? { id, workspace: "north" } : null),
  stateOf: (id) => state.get(id) ?? null,
  type: async (id, text) => {
    typed.push([id, text]);
    state.set(id, "working");
  },
  note: () => undefined,
  sleep: async () => undefined,
});
const actions: HeldActions = {
  agent_prompt: {
    check: (a, who) => prompts.check(a, who),
    run: (a) => prompts.run(a),
  },
};
const queue = createApprovalQueue(actions, () => stateDir);
let kind: PolicyKind = "ask";
let server: http.Server;
let base = "";

beforeAll(async () => {
  mintActorToken(stateDir, {
    agentId: "planner",
    workspace: "north",
    sessionName: "acme-north:planner",
  });
  server = http.createServer((req, res) => {
    const p: Principal = {
      kind: "agent",
      actor: "agent:planner",
      workspace: "north",
      grants: [],
      session: { name: "acme-north:planner" },
    };
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
        enabled: () => true,
        policy: () => ({ kind, from: "test" }),
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

const ask = (text: string) =>
  fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "agent_prompt",
      args: { agent: "builder", text },
    }),
  }).then(async (r) => ({
    status: r.status,
    json: (await r.json()) as { id: string; state: string },
  }));

describe("772: agent_prompt behind the approval policy", () => {
  it("1: held: waits, types nothing; Deny types nothing; Allow types once", async () => {
    kind = "ask";
    typed.length = 0;
    state.set("builder", "idle");
    const held = await ask("run the tests");
    expect(held.status).toBe(202);
    expect(held.json.state).toBe("pending");
    expect(typed).toEqual([]);
    await queue.decide(held.json.id, "deny", "s1");
    expect(typed).toEqual([]);

    const again = await ask("run the tests, please");
    expect(again.json.state).toBe("pending");
    await queue.decide(again.json.id, "allow", "s1");
    expect(typed).toEqual([["builder", "run the tests, please"]]);
  });

  it("2: not held: typed into the target once, at the ask", async () => {
    kind = "notify";
    typed.length = 0;
    state.set("builder", "idle");
    const r = await ask("go");
    expect(r.json.state).toBe("done");
    expect(typed).toEqual([["builder", "go"]]);
  });
});
