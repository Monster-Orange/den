/**
 * Issue 1414: on a test install, the test operator may Allow a held write
 * that one of the bed's own agents asked for (AgentRecord.testBed, issue
 * 943), and nothing else: never another agent's, never a deny, never a
 * fixture request the gate didn't let through as the act. The trail names
 * the test operator. The real check on a temp user.yml, in an in-process
 * server whose principal and operator act are set as the request gate sets
 * them (index.ts, after operatorRefusal). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { writeRecord } from "../../../src/shared/agents/records.js";
import type { AgentRecord } from "../../../src/shared/agents/records.js";
import {
  OPERATOR_PRINCIPAL,
  testBedAsker,
} from "../../../src/shared/test-operator.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import { recentActions } from "../../../src/ui/server/audit.js";
import {
  markOperatorAct,
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { approveKeyHash } from "../../../src/shared/web-session.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-opallow-"));
const ran: string[] = [];
const actions: HeldActions = {
  setting_change: {
    check: (a: Record<string, unknown>) => ({
      ok: true,
      args: a,
      summary: "change a setting",
      params: {},
      details: [],
    }),
    run: async (a: Record<string, unknown>) => {
      ran.push(String(a.key));
      return { ok: true };
    },
  },
} as unknown as HeldActions;
const queue = createApprovalQueue(actions, () => stateDir);
let server: http.Server;
let base = "";
/** Whether the server wires the test-bed lookup (fail closed without it). */
let wired = true;

function rec(id: string, testBed: boolean): AgentRecord {
  return {
    id,
    persona: id,
    runtime: "den-claude",
    cwd: stateDir,
    session: { backend: "den-pty", id: `gone-${id}` },
    sessionName: `acme-north:${id}`,
    startedAt: "2026-11-24T09:00:00.000Z",
    workspace: "north",
    ...(testBed ? { testBed: true as const } : {}),
  } as AgentRecord;
}

function principalFor(req: http.IncomingMessage): Principal {
  const agent = req.headers["x-test-agent"];
  if (typeof agent === "string")
    return {
      kind: "agent",
      actor: `agent:${agent}`,
      workspace: "north",
      grants: [],
      session: { name: `acme-north:${agent}` },
    } as Principal;
  // The fixture person: a test install's live checks.
  return { kind: "person-browser", session: "s1", fixture: true } as Principal;
}

beforeAll(async () => {
  writeRecord(stateDir, rec("bed", true));
  writeRecord(stateDir, rec("real", false));
  for (const id of ["bed", "real"])
    mintActorToken(stateDir, {
      agentId: id,
      workspace: "north",
      sessionName: `acme-north:${id}`,
    });
  server = http.createServer((req, res) => {
    const p = principalFor(req);
    setPrincipal(req, p);
    // The gate's mark: what operatorRefusal let through (loopback, an
    // operator install). Without the header: the fixture person only.
    if (req.headers["x-test-op"]) markOperatorAct(req, "approval-allow");
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      session: { key: "s1", csrf: "c", approveKeyHash: approveKeyHash("k") },
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
        changed: () => undefined,
        ...(wired
          ? { testBedAsker: (actor: string) => testBedAsker(stateDir, actor) }
          : {}),
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

const post = (url: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** A held write asked by agent `id`; its approval id. */
async function heldBy(id: string, key: string): Promise<string> {
  const r = await post(
    "/api/approvals",
    {
      action: "setting_change",
      args: { key, value: 1, reason: "r" },
      ask: true,
      note: "a live check of Allow",
    },
    { "x-test-agent": id },
  );
  if (r.status >= 300) throw new Error(await r.text());
  return ((await r.json()) as { id: string }).id;
}

const decide = (id: string, decision: string, op = true) =>
  post(
    `/api/approvals/${id}/decide`,
    { decision },
    op ? { "x-test-op": "1" } : {},
  );

describe("issue 1414: the test operator's Allow", () => {
  it("a test-bed agent's held write: allowed, it runs, and the trail names the test operator", async () => {
    const id = await heldBy("bed", "a.one");
    const r = await decide(id, "allow");
    if (r.status !== 200) throw new Error(await r.text());
    expect(ran).toContain("a.one");
    const row = recentActions().find(
      (e) =>
        e.verb === "approval-decide" &&
        String(e.detail).includes(id) &&
        e.outcome !== "refused",
    );
    expect(row?.principal).toBe(OPERATOR_PRINCIPAL);
    expect(queue.get(id)?.decidedBy).toBe(OPERATOR_PRINCIPAL);
  });

  it("an agent not marked as the bed's: refused, and it still waits", async () => {
    const id = await heldBy("real", "a.two");
    const r = await decide(id, "allow");
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code?: string }).code).toBe(
      "operator_not_test_bed",
    );
    expect(ran).not.toContain("a.two");
    expect(queue.get(id)?.state).toBe("pending");
  });

  it("a deny is not the operator's act: refused", async () => {
    const id = await heldBy("bed", "a.three");
    const r = await decide(id, "deny");
    expect(r.status).toBe(403);
    expect(queue.get(id)?.state).toBe("pending");
  });

  it("a fixture request the gate didn't let through as the act: the fixture person, refused", async () => {
    const id = await heldBy("bed", "a.four");
    const r = await decide(id, "allow", false);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code?: string }).code).toBe(
      "fixture_cannot_approve",
    );
    expect(queue.get(id)?.state).toBe("pending");
  });

  it("no such held write: refused, never a 404 that confirms an id", async () => {
    const r = await decide("AAAAAAAAAAAAAAAA", "allow");
    expect(r.status).toBe(403);
  });

  it("a server without the test-bed lookup: refused (fails closed)", async () => {
    const id = await heldBy("bed", "a.five");
    wired = false;
    try {
      const r = await decide(id, "allow");
      expect(r.status).toBe(403);
      expect(queue.get(id)?.state).toBe("pending");
    } finally {
      wired = true;
    }
  });
});

describe("issue 1414: which asker is the bed's (testBedAsker)", () => {
  it("only an agent whose record Den marked testBed", () => {
    expect(testBedAsker(stateDir, "agent:bed")).toBe(true);
    expect(testBedAsker(stateDir, "agent:real")).toBe(false);
    expect(testBedAsker(stateDir, "agent:nobody")).toBe(false);
    expect(testBedAsker(stateDir, "person:someone")).toBe(false);
    expect(testBedAsker(stateDir, "agent:../bed")).toBe(false);
    expect(testBedAsker(stateDir, "bed")).toBe(false);
  });

  it("a record that can't be read: not the bed's", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-opallow-bad-"));
    try {
      writeRecord(dir, rec("odd", true));
      const f = fs
        .readdirSync(dir, { recursive: true })
        .map(String)
        .find((n) => n.endsWith("odd.json"));
      if (!f) throw new Error("no record file");
      fs.writeFileSync(path.join(dir, f), "{ not json");
      expect(testBedAsker(dir, "agent:odd")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
