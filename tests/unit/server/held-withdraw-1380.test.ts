import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import {
  noteHeldWithdrawn,
  syncHeldBell,
} from "../../../src/ui/server/held-bell.js";
import { recentActions } from "../../../src/ui/server/audit.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1380-"));
const ran: string[] = [];
let release: (() => void) | null = null;
const actions: HeldActions = {
  gate_box_set: {
    check: (a) => ({
      ok: true,
      args: { name: String(a.name) },
      summary: `add the test box ${String(a.name)}`,
      params: { name: String(a.name) },
      details: [],
    }),
    run: async (a) => {
      if (String(a.name).startsWith("slow"))
        await new Promise<void>((r) => (release = r));
      ran.push(String(a.name));
      return { ok: true };
    },
  },
};
const queue = createApprovalQueue(actions, () => stateDir);
const store = new NotificationStore(stateDir);
let server: http.Server;
let base = "";

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
  for (const id of ["planner", "scribe"])
    mintActorToken(stateDir, {
      agentId: id,
      workspace: "north",
      sessionName: `acme-north:${id}`,
    });
  server = http.createServer((req, res) => {
    const p = principalFor(req);
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
        autoAllow: () => null,
        changed: () => void syncHeldBell(store, queue.pending()),
        withdrawn: (a, reason) =>
          void noteHeldWithdrawn(store, a, reason, "north"),
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

async function post(p: string, body: unknown, agent?: string) {
  const r = await fetch(`${base}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(agent ? { "x-test-agent": agent } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    json: (await r.json()) as Record<string, unknown>,
  };
}

async function ask(agent: string, name: string): Promise<string> {
  const r = await post(
    "/api/approvals",
    { action: "gate_box_set", args: { name } },
    agent,
  );
  expect(r.status).toBe(202);
  return String(r.json.id);
}

const heldItem = (id: string) =>
  store.list().filter((n) => n.subject === `record:held-${id}`);

describe("issue 1380: an agent withdraws its own pending held write", () => {
  it("its own: withdrawn, its bell card and Needs you row go, and the audit says why", async () => {
    const id = await ask("planner", "wrongbox");
    expect(heldItem(id)).toHaveLength(1);
    const r = await post(
      `/api/approvals/${id}/withdraw`,
      { reason: "wrong box name" },
      "planner",
    );
    expect([r.status, r.json.state]).toEqual([200, "withdrawn"]);
    expect(heldItem(id)).toEqual([]);
    expect(queue.pending().map((a) => a.id)).not.toContain(id);
    expect(
      recentActions().some(
        (e) =>
          e.verb === "approval-withdraw" &&
          !e.outcome &&
          e.detail.includes(`[${id}]`) &&
          e.detail.includes("wrong box name"),
      ),
    ).toBe(true);
    const kept = store
      .list()
      .find((n) => n.subject === `record:held-withdrawn-${id}`);
    expect(kept).toMatchObject({
      read: true,
      msg: {
        key: "bell.m.heldWithdrawn",
        vars: { name: "planner", reason: "wrong box name" },
      },
    });
    expect(kept?.text).toMatch(
      /planner withdrew its request: .*wrongbox.*Withdrawn: wrong box name/,
    );
  });

  it("an Allow after the withdraw runs nothing", async () => {
    const id = await ask("planner", "latebox");
    await post(
      `/api/approvals/${id}/withdraw`,
      { reason: "not needed" },
      "planner",
    );
    const d = await queue.decide(id, "allow", "person-browser");
    expect(d.ok).toBe(false);
    expect(ran).not.toContain("latebox");
  });

  it("another agent's is refused and recorded; it still waits", async () => {
    const id = await ask("planner", "theirbox");
    const r = await post(
      `/api/approvals/${id}/withdraw`,
      { reason: "tidy up" },
      "scribe",
    );
    expect([r.status, r.json.code]).toEqual([403, "not_asker"]);
    expect(queue.pending().map((a) => a.id)).toContain(id);
    expect(heldItem(id)).toHaveLength(1);
    expect(
      recentActions().some(
        (e) =>
          e.verb === "approval-withdraw" &&
          e.outcome === "refused" &&
          e.detail.includes(id),
      ),
    ).toBe(true);
  });

  it("one already decided is refused as already decided", async () => {
    const id = await ask("planner", "donebox");
    await queue.decide(id, "deny", "person-browser");
    const r = await post(
      `/api/approvals/${id}/withdraw`,
      { reason: "too late" },
      "planner",
    );
    expect([r.status, r.json.code]).toEqual([409, "already_decided"]);
  });

  it("an Allow that lands first wins: the withdraw answers already decided, and the write runs", async () => {
    const id = await ask("planner", "slowbox");
    const allowing = queue.decide(id, "allow", "person-browser");
    const r = await post(
      `/api/approvals/${id}/withdraw`,
      { reason: "racing the person" },
      "planner",
    );
    expect([r.status, r.json.code]).toEqual([409, "already_decided"]);
    release?.();
    expect((await allowing).ok).toBe(true);
    expect(ran).toContain("slowbox");
  });

  it("a reason that isn't one short line is refused at the boundary", async () => {
    const id = await ask("planner", "reasonbox");
    for (const reason of ["two\nlines", "x".repeat(201), 42]) {
      const r = await post(
        `/api/approvals/${id}/withdraw`,
        { reason },
        "planner",
      );
      expect([r.status, r.json.code]).toEqual([400, "bad_reason"]);
    }
    expect(queue.pending().map((a) => a.id)).toContain(id);
  });
});

describe("issue 1380: ask_withdraw takes a held-write request", () => {
  const ctx = (api: DenApi): ToolContext => ({
    api,
    cfg: {
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: true,
    },
    cli: "acme",
    scope: { workspace: "north", actor: "agent:planner" },
  });
  const REQ = "AbCdEfGh12345678";

  function fakeApi(answer: (p: string) => unknown) {
    const calls: { path: string; method?: string; body?: unknown }[] = [];
    const api: DenApi = {
      baseUrl: "http://localhost:47003",
      async get(p, _q, method, body) {
        if (p === "/api/workspaces")
          return { active: ["north"], workspaces: { north: {} } };
        calls.push({ path: p, method, body });
        return answer(p);
      },
      async stream() {
        throw new Error("no streams");
      },
    };
    return { api, calls };
  }

  it("`request` posts to the request's withdraw, with the reason; the route is allowed", async () => {
    const { api, calls } = fakeApi(() => ({ ok: true, state: "withdrawn" }));
    const r = await callTool(
      "ask_withdraw",
      { request: REQ, reason: " wrong box " },
      ctx(api),
    );
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: `/api/approvals/${REQ}/withdraw`,
        method: "POST",
        body: { reason: "wrong box" },
      },
    ]);
    expect(() =>
      assertAllowedRequest("POST", `/api/approvals/${REQ}/withdraw`, {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("POST", `/api/approvals/${REQ}/decide`, {}),
    ).toThrow();
  });

  it("refuses both or neither of id and request, and a malformed request id, without calling Den", async () => {
    const { api, calls } = fakeApi(() => ({ ok: true }));
    for (const a of [
      { id: "q1", request: REQ, reason: "r" },
      { reason: "r" },
      { request: "../decide", reason: "r" },
      { request: "short", reason: "r" },
    ]) {
      const r = await callTool("ask_withdraw", a, ctx(api));
      expect(r.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it("an already-decided request is a refusal that says so", async () => {
    const { DenHttpError } = await import("../../../src/ui/mcp/api.js");
    const { api } = fakeApi(() => {
      throw new DenHttpError(
        "POST",
        `/api/approvals/${REQ}/withdraw`,
        409,
        "This request was already decided.",
      );
    });
    const r = await callTool(
      "ask_withdraw",
      { request: REQ, reason: "late" },
      ctx(api),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already decided/);
  });
});
