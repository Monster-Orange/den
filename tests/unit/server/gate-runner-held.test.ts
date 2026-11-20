/**
 * Issue 621: a gate-only runner token is made through a held write, on
 * the person's Allow. An agent asks (gate_runner_token_create); Allow
 * makes the token and hands it back once, to the asking agent only;
 * Deny makes nothing. The Allow's answer, the person's view of the
 * request and the audit never hold the token.
 *
 * The queue and the handler, in process (as embed-app-keys-held does).
 * Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { policyFor } from "../../../src/shared/approval-policy.js";
import { RunnerTokens } from "../../../src/shared/gates/runner-tokens.js";
import {
  approvalView,
  createApprovalQueue,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import { gateRunnerTokenOp } from "../../../src/ui/server/gate-routes.js";
import {
  CRITICAL_HELD_ACTIONS,
  heldActions,
} from "../../../src/ui/server/held-actions.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-runner-held-"));
const tokens = () => RunnerTokens.at(stateDir);
const audited: string[] = [];
const actions = heldActions({
  gateRunnerToken: gateRunnerTokenOp({
    runners: tokens,
    audit: ((_a: unknown, action: { detail: string }) => {
      audited.push(action.detail);
      return {};
    }) as never,
  }),
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
            workspace: "den-server",
            grants: [],
            session: { name: `den-server:${id}` },
          }
        : { kind: "person-browser", session: "s1" };
    setPrincipal(req, p);
    const pathname = new URL(req.url!, "http://x").pathname;
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      session: null,
    } as unknown as Extract<GuardResult, { ok: true }>;
    void handleApprovalRoutes(req, res, pathname, guard, {
      queue,
      actions,
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  mintActorToken(stateDir, {
    agentId: "server",
    workspace: "den-server",
    sessionName: "den-server:server",
  });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function ask(args: Record<string, unknown>, agent?: string) {
  const r = await fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(agent ? { "x-test-agent": agent } : {}),
    },
    body: JSON.stringify({ action: "gate_runner_token_create", args }),
  });
  return {
    status: r.status,
    body: (await r.json()) as {
      id: string;
      state?: string;
      summary?: string;
      details?: string[];
      error?: string;
    },
  };
}

const get = async (id: string, agent?: string) =>
  (
    await fetch(`${base}/api/approvals/${id}`, {
      headers: agent ? { "x-test-agent": agent } : {},
    })
  ).text();

describe("gate runner tokens, made on the person's Allow", () => {
  it("an agent asks; it waits; the card says what the token can do; nothing is made before Allow", async () => {
    const a = await ask({ name: "ci-linux" }, "server");
    expect(a.status).toBe(202);
    expect(a.body.state).toBe("pending");
    expect(a.body.summary).toMatch(/ci-linux/);
    expect(a.body.details?.join(" ")).toMatch(/ask for, renew and give back/);
    expect(tokens().list()).toEqual([]);
  });

  it("a bad name is refused before anything waits", async () => {
    expect((await ask({ name: "no spaces" }, "server")).status).toBe(400);
    expect((await ask({}, "server")).status).toBe(400);
  });

  it("Deny makes nothing", async () => {
    const a = await ask({ name: "ci-denied" }, "server");
    const r = await queue.decide(a.body.id, "deny", "session:s1");
    expect(r.ok).toBe(true);
    expect(tokens().list().map((t) => t.name)).not.toContain("ci-denied");
  });

  it("Allow makes it; the token goes to the asking agent once, never to the Allow's answer, the person or the audit", async () => {
    const a = await ask({ name: "ci-mac" }, "server");
    const r = await queue.decide(a.body.id, "allow", "session:s1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // What the decide route answers the person's browser with.
    const shown = JSON.stringify(approvalView(r.approval));
    expect(shown).not.toMatch(/den_gr_/);
    // The person's view of the request.
    expect(await get(a.body.id)).not.toMatch(/den_gr_/);
    // The asking agent's: once.
    const first = JSON.parse(await get(a.body.id, "server")) as {
      result: { token?: string; name?: string };
    };
    const token = first.result.token!;
    expect(token).toMatch(/^den_gr_/);
    expect(first.result.name).toBe("ci-mac");
    expect(tokens().check(token).ok).toBe(true);
    expect(await get(a.body.id, "server")).not.toContain(token);
    expect(audited.join("\n")).toMatch(/ci-mac/);
    expect(audited.join("\n")).not.toContain(token);
  });

  it("is critical: no approval policy makes one without the person", () => {
    expect(CRITICAL_HELD_ACTIONS.has("gate_runner_token_create")).toBe(true);
    const loose = {
      policy: "auto",
      writes: { gate_runner_token_create: "auto" },
    } as const;
    expect(
      policyFor("gate_runner_token_create", {
        install: loose,
        project: loose,
      }).kind,
    ).toBe("ask");
  });
});
