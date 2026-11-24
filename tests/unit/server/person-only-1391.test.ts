/**
 * Issue 1391 (Reviewers C and D, Builder 2; Den Builder's rule): a check
 * that says personOnly ("this one is the person's") always asks, on every
 * mode, keep or no keep. A check that should be routine on a personal
 * install stops saying personOnly there itself; the ask path never drops
 * it. Driven through the real path: policyFor / isCriticalWrite, and the
 * approval route with the install's mode and the policy wired in.
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import {
  HELD_WRITE_RISK,
  isCriticalWrite,
  policyFor,
} from "../../../src/shared/approval-policy.js";
import type { InstallMode } from "../../../src/shared/den-config.js";
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

const WRITES = Object.keys(HELD_WRITE_RISK).sort();
const MODES: InstallMode[] = ["personal", "strict"];

describe("personOnly asks on every mode (policyFor, isCriticalWrite)", () => {
  it.each(MODES.flatMap((m) => WRITES.map((w) => [m, w] as const)))(
    "%s: %s with personOnly is critical and asks",
    (mode, w) => {
      expect(isCriticalWrite(w, true, [], mode)).toBe(true);
      expect(policyFor(w, { widens: true, mode }).kind).toBe("ask");
    },
  );

  it("without personOnly, a routine write stays routine on personal", () => {
    expect(isCriticalWrite("agent_create", false, [], "personal")).toBe(false);
    expect(policyFor("agent_create", { mode: "personal" }).kind).toBe("notify");
  });
});

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-person-only-"));
const ran: string[] = [];
/** Each write's check says personOnly when the ask's args say so. */
const actions: HeldActions = Object.fromEntries(
  WRITES.map((w) => [
    w,
    {
      check: (a: Record<string, unknown>) => ({
        ok: true as const,
        args: { personOnly: a.personOnly === true },
        summary: `${w}`,
        params: {},
        details: [],
        ...(a.personOnly === true ? { personOnly: true } : {}),
      }),
      run: async () => {
        ran.push(w);
        return { ok: true };
      },
    },
  ]),
);
const queue = createApprovalQueue(actions, () => stateDir);
let mode: InstallMode = "personal";
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
  mintActorToken(stateDir, {
    agentId: "scout",
    workspace: "north",
    sessionName: "acme-north:scout",
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
        installMode: () => mode,
        // As index.ts wires it, with the install's policy left unset.
        policy: (action, _project, widens, ask) =>
          policyFor(action, {
            widens,
            mode,
            ...(ask?.category ? { setting: { category: ask.category } } : {}),
            areas: ask?.areas,
          }),
        notify: () => undefined,
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

let n = 0;
/** Each ask from its own agent (an agent's pending asks are capped). */
const ask = async (action: string, personOnly: boolean) => {
  const agent = `scout${++n}`;
  mintActorToken(stateDir, {
    agentId: agent,
    workspace: "north",
    sessionName: `acme-north:${agent}`,
  });
  const r = await fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: { "x-test-agent": agent, "content-type": "application/json" },
    body: JSON.stringify({ action, args: { personOnly } }),
  });
  const j = (await r.json()) as { state?: string; error?: string };
  return j.state ?? `no state (${r.status}): ${j.error ?? ""}`;
};

describe("personOnly asks on every mode (the approval route)", () => {
  it.each(MODES.flatMap((m) => WRITES.map((w) => [m, w] as const)))(
    "%s: an agent's %s whose check says personOnly is held for the person",
    async (m, w) => {
      mode = m;
      ran.length = 0;
      expect(await ask(w, true)).toBe("pending");
      expect(ran).toEqual([]);
    },
  );

  it("personal: agent_create with no personOnly runs at once", async () => {
    mode = "personal";
    ran.length = 0;
    expect(await ask("agent_create", false)).toBe("done");
    expect(ran).toEqual(["agent_create"]);
  });
});
