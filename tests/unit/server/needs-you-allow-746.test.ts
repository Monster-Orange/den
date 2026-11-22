/**
 * Issue 746: a held write waiting for the person's Allow leads Needs you.
 *
 *  - GET /api/notifications' `waiting` has every pending held write first,
 *    `kind: "allow"`, above agents' questions: what it is, who asked, since
 *    when, and when it expires.
 *  - Allow from that entry (its id, POSTed to the existing decide route)
 *    runs it, and it leaves `waiting`.
 *  - A request that expires unanswered: a bell item says it lapsed, and the
 *    agent that asked is told directly (the reason and a hint to ask
 *    again); its own read says the same.
 *
 * The handlers in an in-process server, the principal set as request-guard
 * sets it for a signed-in browser. Invented names only; temp dirs only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { approveKeyHash } from "../../../src/shared/web-session.js";
import {
  approvalView,
  createApprovalQueue,
  handleApprovalRoutes,
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import { ApprovalQueue } from "../../../src/ui/server/approvals.js";
import type { Attention } from "../../../src/ui/server/attention.js";
import { heldLapsed } from "../../../src/ui/server/held-bell.js";
import { handleNotificationRoutes } from "../../../src/ui/server/notification-routes.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};

const AK = "k".repeat(43);
const SESSION = {
  key: "sess-746",
  csrf: "csrf-746-aaaaaaaaaaaaaaaaaaaaaaaa",
  approveKeyHash: approveKeyHash(AK),
};

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

describe("issue 746: held writes in Needs you", () => {
  let stateDir = "";
  let queue: ApprovalQueue;
  let store: NotificationStore;
  let server: http.Server;
  let base = "";
  // One agent asked its person a question a minute ago.
  const attention = {
    waitingNow: () => new Map([["quiet-scribe", "asked"]]),
    waitingDetail: () => ({
      why: "asked",
      what: "which branch?",
      since: new Date(Date.now() - 60_000).toISOString(),
    }),
  } as unknown as Attention;

  beforeAll(async () => {
    stateDir = tmp("den-746-");
    // The asking agent still runs (its token is live).
    mintActorToken(stateDir, {
      agentId: "north-planner",
      workspace: "north",
      sessionName: "acme-north:north-planner",
    });
    queue = createApprovalQueue(actions, () => stateDir);
    store = new NotificationStore(stateDir);
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url!, "http://x").pathname;
      const agent = req.headers["x-test-agent"];
      const p = (
        typeof agent === "string"
          ? {
              kind: "agent",
              actor: `agent:${agent}`,
              workspace: "north",
              grants: [],
              session: { name: `acme-north:${agent}` },
            }
          : { kind: "person-browser", session: SESSION.key }
      ) as Principal;
      setPrincipal(req, p);
      const guard = {
        ok: true,
        principal: p,
        via: "loopback",
        beyond: false,
        session: typeof agent === "string" ? null : SESSION,
      } as unknown as Extract<GuardResult, { ok: true }>;
      void (async () => {
        if (
          await handleNotificationRoutes(req, res, pathname, {
            store,
            attention,
            held: () => queue.pending(),
          })
        )
          return;
        if (
          await handleApprovalRoutes(req, res, pathname, guard, {
            queue,
            actions,
            enabled: () => true,
          })
        )
          return;
        res.writeHead(404);
        res.end();
      })();
    });
    await new Promise<void>((r) => server.listen(0, "localhost", r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  const notifications = async () =>
    (await (await fetch(`${base}/api/notifications`)).json()) as {
      waiting: Record<string, unknown>[];
    };

  it("a pending held write is in `waiting`, first, as kind allow", async () => {
    const asked = queue.request({
      actor: "agent:north-planner",
      agent: "north-planner",
      action: "workspace_create",
      args: { name: "orchard" },
      summary: 'create the workspace "orchard"',
    });
    const b = await notifications();
    expect(b.waiting.length).toBe(2);
    expect(b.waiting[0]).toMatchObject({
      kind: "allow",
      id: asked.id,
      agent: "north-planner",
      action: "workspace_create",
      what: 'create the workspace "orchard"',
      since: new Date(asked.requestedAt).toISOString(),
      expiresAt: new Date(asked.expiresAt).toISOString(),
    });
    // The agent's question follows it.
    expect(b.waiting[1]).toMatchObject({ agent: "quiet-scribe", why: "asked" });
  });

  it("Allow from that entry runs it through the decide route, and it leaves `waiting`", async () => {
    const first = (await notifications()).waiting[0];
    expect(first.kind).toBe("allow");
    const r = await fetch(`${base}/api/approvals/${String(first.id)}/decide`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-den-approve-key": AK,
      },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { state: string }).state).toBe("done");
    expect(ran).toContain("orchard");
    const after = await notifications();
    expect(after.waiting.some((w) => w.kind === "allow")).toBe(false);
  });
});

describe("issue 746: a held write that lapses unanswered", () => {
  it("rings a lapsed bell item and tells the asking agent directly, once", async () => {
    const stateDir = tmp("den-746-lapse-");
    const store = new NotificationStore(stateDir);
    let t = 1_000_000;
    const told: { agent: string; text: string }[] = [];
    const queue = new ApprovalQueue({
      now: () => t,
      ttlMs: 10 * 60_000,
      run: async () => ({ ok: true }),
      onExpire: (a) =>
        void heldLapsed(a, {
          store,
          projectOf: () => "north",
          tell: async (agent, text) => {
            told.push({ agent, text });
            return "told";
          },
        }),
    });
    const a = queue.request({
      actor: "agent:north-planner",
      agent: "north-planner",
      action: "agent_create",
      args: { name: "helper" },
      summary: 'start the agent "helper"',
    });
    t += 10 * 60_000 + 1;
    expect(queue.pending()).toHaveLength(0);
    queue.pending();
    queue.get(a.id);
    await new Promise((r) => setImmediate(r));

    const items = store
      .list()
      .filter((n) => n.subject === `record:held-lapsed-${a.id}`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      scope: "workspace/north",
      msg: {
        key: "bell.m.heldLapsed",
        vars: { name: "north-planner", what: 'start the agent "helper"' },
      },
    });
    expect(told).toHaveLength(1);
    expect(told[0].agent).toBe("north-planner");
    expect(told[0].text).toContain(a.id);
    expect(told[0].text).toContain("agent_create");
    expect(told[0].text).toMatch(/nothing ran/i);
    expect(told[0].text).toMatch(/ask again/i);

    // The agent's own read (approval_check) says why, and what to do.
    const v = approvalView(queue.get(a.id)!);
    expect(v.state).toBe("expired");
    expect(String(v.reason)).toMatch(/ask again/i);
  });
});
