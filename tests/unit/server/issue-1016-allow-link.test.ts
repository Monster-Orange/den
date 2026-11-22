/**
 * Issue 1016: a held write's result carries the full Allow link, on the
 * install's address (web.url): where the person Allows it, from any
 * machine. With web.url unset there is no link (never a guessed one).
 *  - the web server's ask (POST /api/approvals) and its read say it;
 *  - the MCP write tool's answer while it waits says it.
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
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import { DenHttpError, type DenApi } from "../../../src/ui/mcp/api.js";

const ADDRESS = "https://den.example.test";
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1016-"));
const actions: HeldActions = {
  agent_create: {
    check: (a) => ({
      ok: true,
      args: { project: String(a.project ?? "north"), persona: "planner" },
      summary: "start agent planner in north",
      params: {},
      details: [],
    }),
    run: async () => ({ ok: true, id: "planner2" }),
  },
};
const queue = createApprovalQueue(actions, () => stateDir);
let webUrl: string | null = ADDRESS;
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
      { queue, actions, enabled: () => true, webUrl: () => webUrl },
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

const ask = () =>
  fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "agent_create",
      args: { project: "north" },
    }),
  });

describe("issue 1016: the web server's held write carries the Allow link", () => {
  it("web.url set: the ask and its read have the Allow link under it", async () => {
    webUrl = ADDRESS;
    const r = await ask();
    expect(r.status).toBe(202);
    const a = (await r.json()) as { id: string; allowLink?: string };
    expect(a.allowLink).toBe(`${ADDRESS}/agents?project=north&agent=planner`);
    const one = (await (
      await fetch(`${base}/api/approvals/${a.id}`)
    ).json()) as {
      allowLink?: string;
    };
    expect(one.allowLink).toBe(a.allowLink);
  });

  it("web.url unset: no link at all", async () => {
    webUrl = null;
    const r = await ask();
    const a = (await r.json()) as Record<string, unknown>;
    expect(a.state).toBe("pending");
    expect("allowLink" in a).toBe(false);
  });
});

const ID = "AbCdEfGhIjKlMnOp";
function fakeApi(post: Record<string, unknown>): DenApi {
  return {
    baseUrl: "http://localhost:47003",
    async get(p, _q, method) {
      if (p === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      if (p === "/api/approvals" && method === "POST") return post;
      if (p === `/api/approvals/${ID}`) return { id: ID, state: "pending" };
      if (p === "/api/activity") return { ok: true };
      throw new DenHttpError("GET", p, 404, "not found");
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
}
const ctx = (api: DenApi): ToolContext => ({
  api,
  cfg: {
    actions: [],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  },
  cli: "acme",
  approvalWait: { intervalMs: 1, waitMs: 5, sleep: async () => undefined },
  scope: { workspace: "north", actor: "agent:planner" },
});

describe("issue 1016: the MCP held write's answer carries the Allow link", () => {
  it("still waiting: the answer gives the full Allow link", async () => {
    const link = `${ADDRESS}/agents?project=north&agent=planner`;
    const r = await callTool(
      "agent_create",
      { persona: "planner" },
      ctx(fakeApi({ id: ID, state: "pending", allowLink: link })),
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`request ${ID}`);
    expect(r.text).toContain(`The person Allows it at ${link}`);
  });

  it("no link from the server (web.url unset): none in the answer", async () => {
    const r = await callTool(
      "agent_create",
      { persona: "planner" },
      ctx(fakeApi({ id: ID, state: "pending" })),
    );
    expect(r.text).toContain(`request ${ID}`);
    expect(r.text).not.toMatch(/https?:\/\//);
  });
});
