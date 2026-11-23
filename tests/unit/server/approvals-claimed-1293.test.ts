/**
 * Issue 1293: a person's own requests, and the claim an unverified
 * `mcp --actor agent:<id>` (no agent token) sends.
 *  - GET /api/approvals?mine=1: the caller's own requests, for
 *    `<cli> approvals list --mine`. A person's bearer sees only its own;
 *    nobody signed in is refused.
 *  - A person's ask that carries the agent claim headers keeps the person as
 *    the asker and records the claim as `claimedAs`; the person withdraws it,
 *    the claimed agent's own token can't. A verified agent's ask has no
 *    claimedAs.
 *  - The bell item and the Needs you row say "You asked, as <agent> (not
 *    verified)".
 * Same in-process harness as approval-withdraw.test.ts. Invented names only.
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
import { heldWaiting, syncHeldBell } from "../../../src/ui/server/held-bell.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ap1293-"));
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
let changes = 0;
let server: http.Server;
let base = "";

/**
 * Who each request is: `x-test-agent: <id>` an agent's token,
 * `x-test-person: <user>` a person's bearer, `x-test-anon: 1` nobody,
 * else a signed-in browser.
 */
function principalFor(req: http.IncomingMessage): Principal | null {
  const id = req.headers["x-test-agent"];
  if (typeof id === "string")
    return {
      kind: "agent",
      actor: `agent:${id}`,
      workspace: "north",
      grants: [],
      session: { name: `acme-north:${id}` },
    } as Principal;
  const person = req.headers["x-test-person"];
  if (typeof person === "string")
    return { kind: "person", actor: `person:${person}` } as Principal;
  if (req.headers["x-test-anon"]) return null;
  return { kind: "person-browser", session: "s1" } as Principal;
}

beforeAll(async () => {
  for (const agentId of ["asker", "other", "helper"])
    mintActorToken(stateDir, {
      agentId,
      workspace: "north",
      sessionName: `acme-north:${agentId}`,
    });
  server = http.createServer((req, res) => {
    const p = principalFor(req);
    if (p) setPrincipal(req, p);
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
      { queue, actions, enabled: () => true, changed: () => void changes++ },
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

const as = (who: Record<string, string>, body?: unknown, method = "POST") => ({
  method,
  headers: {
    ...who,
    ...(body ? { "content-type": "application/json" } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const AGENT = { "x-test-agent": "asker" };
const OTHER = { "x-test-agent": "other" };
const PAT = { "x-test-person": "pat" };
const SAM = { "x-test-person": "sam" };
const ANON = { "x-test-anon": "1" };

async function ask(who: Record<string, string>, name: string) {
  const r = await fetch(
    `${base}/api/approvals`,
    as(who, {
      action: "workspace_create",
      args: { name },
      ask: true,
      note: "a live check's own request",
    }),
  );
  expect([200, 202]).toContain(r.status);
  return ((await r.json()) as { id: string }).id;
}
const withdraw = (id: string, who: Record<string, string>) =>
  fetch(`${base}/api/approvals/${id}/withdraw`, as(who, {}));
const pendingIds = () => queue.pending().map((a) => a.id);

const CLAIM = {
  "x-den-actor": "agent",
  "x-den-mcp-agent": "agent:helper",
  "x-den-mcp-workspace": "north",
};
const HELPER = { "x-test-agent": "helper" };
describe("issue 1293: GET /api/approvals?mine=1", () => {
  it("a person's bearer: its own requests only", async () => {
    const mineId = await ask(PAT, "fen");
    const theirs = await ask(SAM, "marsh");
    const r = await fetch(
      `${base}/api/approvals?mine=1`,
      as(PAT, undefined, "GET"),
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; mine: { id: string }[] };
    expect(j.ok).toBe(true);
    const ids = j.mine.map((x) => x.id);
    expect(ids).toContain(mineId);
    expect(ids).not.toContain(theirs);
  });

  it("an agent's token: its own, as before", async () => {
    const id = await ask(AGENT, "heath");
    const j = (await (
      await fetch(`${base}/api/approvals?mine=1`, as(AGENT, undefined, "GET"))
    ).json()) as { mine: { id: string }[] };
    expect(j.mine.map((x) => x.id)).toContain(id);
  });

  it("nobody signed in: refused, and no request in the answer", async () => {
    await ask(PAT, "moor");
    const r = await fetch(
      `${base}/api/approvals?mine=1`,
      as(ANON, undefined, "GET"),
    );
    expect(r.status).toBe(403);
    expect(JSON.stringify(await r.json())).not.toContain("moor");
  });
});

describe("issue 1293: an unverified agent claim on a person's ask", () => {
  it("the person is the asker; the claim is kept as claimedAs", async () => {
    const id = await ask({ ...PAT, ...CLAIM }, "bog");
    const a = queue.pending().find((x) => x.id === id)!;
    expect(a.actor).toBe("person:pat");
    expect(a.agent).toBeUndefined();
    expect(a.claimedAs).toBe("agent:helper");
    // What `approvals list --mine` reads carries it too.
    const j = (await (
      await fetch(`${base}/api/approvals?mine=1`, as(PAT, undefined, "GET"))
    ).json()) as { mine: { id: string; claimedAs?: string }[] };
    expect(j.mine.find((x) => x.id === id)?.claimedAs).toBe("agent:helper");
  });

  it("the person withdraws it; the claimed agent's own token can't", async () => {
    const id = await ask({ ...PAT, ...CLAIM }, "carr");
    expect((await withdraw(id, HELPER)).status).toBe(403);
    expect(pendingIds()).toContain(id);
    expect((await withdraw(id, PAT)).status).toBe(200);
    expect(pendingIds()).not.toContain(id);
  });

  it("a verified agent's ask has no claimedAs", async () => {
    const id = await ask({ ...AGENT, ...CLAIM }, "mere");
    const a = queue.pending().find((x) => x.id === id)!;
    expect(a.agent).toBe("asker");
    expect(a.claimedAs).toBeUndefined();
  });

  it("a malformed claim is dropped, never kept", async () => {
    const id = await ask(
      { ...PAT, "x-den-actor": "agent", "x-den-mcp-agent": "agent:Bad Name!" },
      "slough",
    );
    expect(queue.pending().find((x) => x.id === id)!.claimedAs).toBeUndefined();
  });

  it("the bell item and the Needs you row say who asked, and that it isn't verified", async () => {
    const id = await ask({ ...PAT, ...CLAIM }, "tarn");
    const a = queue.pending().find((x) => x.id === id)!;
    const added: Record<string, unknown>[] = [];
    syncHeldBell(
      {
        list: () => [],
        add: (n) => (added.push(n as Record<string, unknown>), null),
        remove: () => 0,
      } as unknown as Parameters<typeof syncHeldBell>[0],
      [a],
    );
    expect(added[0].text).toBe(
      `Waiting for your Allow: ${a.summary}. You asked, as agent:helper (not verified).`,
    );
    expect(added[0].msg).toEqual({
      key: "bell.m.heldAllowClaimed",
      vars: { name: "agent:helper", what: a.summary },
    });
    expect(heldWaiting([a])[0].claimedAs).toBe("agent:helper");
  });
});
