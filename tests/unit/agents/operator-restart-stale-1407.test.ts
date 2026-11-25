/**
 * Issue 1407 (PR review, Reviewer C): the test operator's restart-stale
 * restarts only the bed's own agents. Two running agents, both on an
 * older Den's tools: "planner", which Den marked testBed, and "reviewer",
 * which it didn't. The operator's restart-stale names and restarts the
 * marked one only; the other is left alone (no signal, listed nowhere).
 * The person's restart-stale still takes both.
 *
 * The request is marked as the operator's act the way index.ts's gate
 * marks it (a fixture session's principal, then markOperatorAct); the
 * gate's own rules (operator install, loopback) are test-operator.test.ts's.
 * A real host on a temp socket with a scripted PTY. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import {
  markOperatorAct,
  setPrincipal,
} from "../../../src/ui/server/request-guard.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const OPERATOR = "x-gate-test-operator";

async function api(r: Rig) {
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.headers[OPERATOR]) {
      setPrincipal(req, {
        kind: "person-browser",
        session: "fixture-session",
        fixture: true,
      });
      markOperatorAct(req, "agents-restart-stale");
    }
    void handleAgentRoutes(req, res, p, {
      agents: r.deps,
      personaWait: { pollMs: 20 },
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  return async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(
      `http://localhost:${port}/api/agents/restart-stale`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
    );
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
}

/** Two running agents on an older Den's tools; planner is the bed's own. */
async function twoStale() {
  const r = await rig();
  for (const id of ["planner", "reviewer"]) {
    const code = await cmdAgents(
      ["start", "-w", "north", "--persona", id],
      r.deps,
    );
    expect({ code, err: r.err.slice(-2) }).toEqual({ code: 0, err: [] });
    await settle();
    const rec = readRecord(r.stateDir, id)!;
    writeRecord(r.stateDir, {
      ...rec,
      denVersion: "0.0.1-old",
      ...(id === "planner" ? { testBed: true as const } : {}),
    });
  }
  return r;
}

const ids = (x: unknown) =>
  ((x as { id: string }[] | undefined) ?? []).map((a) => a.id).sort();

describe("issue 1407: the test operator's restart-stale", () => {
  it("names and restarts only the agent Den marked testBed; the other is left alone", async () => {
    const r = await twoStale();
    const other = r.made[1];
    const call = await api(r);
    const go = await call({}, { [OPERATOR]: "1" });
    expect(go.status).toBe(202);
    expect(ids(go.json.pending)).toEqual(["planner"]);
    expect(ids(go.json.agents)).toEqual(["planner"]);
    await settle(200);
    expect(other.signals).toEqual([]);
    expect(readRecord(r.stateDir, "reviewer")!.denVersion).toBe("0.0.1-old");
  });

  it("the person's restart-stale still takes both", async () => {
    const r = await twoStale();
    const call = await api(r);
    const go = await call({});
    expect(go.status).toBe(202);
    expect(ids(go.json.pending)).toEqual(["planner", "reviewer"]);
  });
});
