/**
 * Issue 142: the asker may withdraw its own held write
 * (POST /api/approvals/<id>/withdraw). Only the asker: the same agent
 * token, or the same person's bearer or session. Another agent or another
 * person is refused 403, anyone without a credential 403, a decided
 * request 409, an unknown id 404. It is audited as withdrawn by the asker,
 * never as a person's decision; the agent then reads "withdrawn"; the
 * pending list (the Allow dialog, the bell) no longer has it.
 *
 * The handler in an in-process server, the principal set as request-guard
 * sets it for a verified credential. Invented names only.
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
import { recentActions } from "../../../src/ui/server/audit.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-apwithdraw-"));
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
  for (const agentId of ["asker", "other"])
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

describe("POST /api/approvals/<id>/withdraw", () => {
  it("the asking agent withdraws its own: it reads withdrawn, nothing ran, it leaves the pending list", async () => {
    const id = await ask(AGENT, "orchard");
    expect(pendingIds()).toContain(id);
    const before = changes;
    const r = await withdraw(id, AGENT);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { state: string }).state).toBe("withdrawn");
    expect(pendingIds()).not.toContain(id);
    expect(changes).toBeGreaterThan(before);
    const mine = await fetch(
      `${base}/api/approvals/${id}`,
      as(AGENT, undefined, "GET"),
    );
    expect(((await mine.json()) as { state: string }).state).toBe("withdrawn");
    expect(ran).not.toContain("orchard");
    // Audited as the asker's withdrawal, never as a person's decision.
    const line = recentActions().find((e) => e.detail.includes(id));
    expect(line).toBeDefined();
    const mineLines = recentActions().filter((e) => e.detail.includes(id));
    expect(mineLines.some((e) => e.verb === "approval-withdraw")).toBe(true);
    expect(mineLines.some((e) => e.verb === "approval-decide")).toBe(false);
    expect(
      mineLines.find((e) => e.verb === "approval-withdraw")?.detail,
    ).toContain("withdrawn by agent:asker");
  });

  it("a person withdraws their own", async () => {
    const id = await ask(PAT, "meadow");
    const r = await withdraw(id, PAT);
    expect(r.status).toBe(200);
    expect(pendingIds()).not.toContain(id);
  });

  it("another agent, another person, the signed-in browser of someone else's ask, or nobody: 403, and it still waits", async () => {
    const id = await ask(AGENT, "grove");
    for (const who of [OTHER, PAT, ANON])
      expect((await withdraw(id, who)).status).toBe(403);
    const id2 = await ask(PAT, "copse");
    for (const who of [SAM, AGENT, ANON])
      expect((await withdraw(id2, who)).status).toBe(403);
    expect(pendingIds()).toEqual(expect.arrayContaining([id, id2]));
    const refused = recentActions().filter(
      (e) => e.verb === "approval-withdraw" && e.outcome === "refused",
    );
    expect(refused.length).toBeGreaterThanOrEqual(6);
  });

  it("a decided request: 409; an unknown id: 404", async () => {
    const id = await ask(AGENT, "thicket");
    await queue.decide(id, "deny", "s1");
    const r = await withdraw(id, AGENT);
    expect(r.status).toBe(409);
    expect((await withdraw("zzzzzzzzzzzzzzzz", AGENT)).status).toBe(404);
  });

  it("is only a POST", async () => {
    const id = await ask(AGENT, "spinney");
    const r = await fetch(
      `${base}/api/approvals/${id}/withdraw`,
      as(AGENT, undefined, "GET"),
    );
    expect(r.status).toBe(405);
    expect(pendingIds()).toContain(id);
  });
});
