/**
 * Issue 199: a held write may offer the person a choice as they Allow
 * ("Also make these follow the project", off by default). The check
 * names it (choices) and the agents it is about (ownMode); the stored
 * args never carry it, even when an agent's ask tries to; only the
 * person's decide turns it on, and only a choice the check offered.
 *
 * The queue and the handler's ask, in process (deciding over HTTP needs
 * a signed-in browser: approval-routes.integration). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import {
  chosenOf,
  createApprovalQueue,
  handleApprovalRoutes,
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-apchoice-"));
const ran: Record<string, unknown>[] = [];
const actions: HeldActions = {
  project_mode: {
    check: (a) => ({
      ok: true,
      args: {
        project: "north",
        mode: String(a.mode),
        ...(a.follow === true ? { follow: true } : {}),
      },
      summary: `set project north's mode: auto → ${String(a.mode)}`,
      params: { project: "north", from: "auto", to: String(a.mode) },
      details: [],
      ownMode: [{ agent: "pinned", mode: "auto" }],
      choices: ["follow"],
    }),
    run: async (a) => {
      ran.push({ ...a });
      return { ok: true };
    },
  },
};
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
            workspace: "north",
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
      { queue, actions },
    ).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  mintActorToken(stateDir, {
    agentId: "lead",
    workspace: "north",
    sessionName: "acme-north:lead",
  });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function askAsAgent(args: Record<string, unknown>) {
  const r = await fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-agent": "lead" },
    body: JSON.stringify({ action: "project_mode", args }),
  });
  expect(r.status).toBe(202);
  return (await r.json()) as Record<string, unknown> & { id: string };
}

describe("issue 199: a choice the person makes as they Allow", () => {
  it("the request shows the agents and the choice; an agent's ask can't turn it on", async () => {
    ran.length = 0;
    const a = await askAsAgent({ mode: "all", follow: true });
    expect(a.ownMode).toEqual([{ agent: "pinned", mode: "auto" }]);
    expect(a.choices).toEqual(["follow"]);
    // Allowed with no choice: it runs without follow.
    await queue.decide(a.id, "allow", "s1");
    expect(ran).toEqual([{ project: "north", mode: "all" }]);
  });

  it("the person's choice runs with it", async () => {
    ran.length = 0;
    const a = await askAsAgent({ mode: "all" });
    const r = await queue.decide(a.id, "allow", "s1", { follow: true });
    expect(r.ok).toBe(true);
    expect(ran).toEqual([{ project: "north", mode: "all", follow: true }]);
  });

  it("only a choice the request offers, and only true or false", () => {
    const offered = { choices: ["follow"] } as never;
    expect(chosenOf(offered, undefined)).toEqual({ ok: true, chosen: {} });
    expect(chosenOf(offered, { follow: true })).toEqual({
      ok: true,
      chosen: { follow: true },
    });
    expect(chosenOf(offered, { follow: false })).toEqual({
      ok: true,
      chosen: {},
    });
    expect(chosenOf(offered, { mode: true }).ok).toBe(false);
    expect(chosenOf(offered, { follow: "yes" }).ok).toBe(false);
    expect(chosenOf({} as never, { follow: true }).ok).toBe(false);
    expect(chosenOf(offered, ["follow"]).ok).toBe(false);
  });
});

describe("issue 199: agent_mode is held like the others", () => {
  it("held-actions has agent_mode, and says so when this Den can't", () => {
    const h = heldActions({} as never);
    expect(Object.keys(h)).toContain("agent_mode");
    expect(h.agent_mode.check({ agent: "pinned" })).toEqual({
      ok: false,
      error: "this Den can't change an agent's mode here",
    });
  });
});
