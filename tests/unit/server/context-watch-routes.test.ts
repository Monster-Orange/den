/**
 * Issue 278 on the Agents page's data:
 *   1. a running agent stuck compacting is listed with `compacting`
 *      (its row says "compacting repeatedly"); with its start's
 *      instruction check over, `instructions` (the likely cause);
 *   2. instructions over the share are listed on its row;
 *   3. a person clears a hold with POST …/compacting-clear (an agent's
 *      claim is refused, here and at the guard).
 *
 * The agents' route handler on a rig (a scripted PTY, nothing runs).
 * Temp dirs, invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import {
  agentFilesDir,
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import {
  instructionCheck,
  readCompacting,
  writeCompacting,
  writeInstructionCheck,
} from "../../../src/shared/agents/context-watch.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { agentRefusal } from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import type { SessionInfo } from "../../../src/shared/sessions/types.js";
import { cleanupRigs, rig, type Rig } from "../agents/helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

function seed(r: Rig): AgentRecord {
  const rec: AgentRecord = {
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    cwd: r.wsDir("north"),
    session: { backend: "den-pty", id: "s-scout" },
    sessionName: "acme-north:scout",
    startedAt: "2026-11-01T09:59:00.000Z",
    resumeToken: "tok-scout",
  } as AgentRecord;
  writeRecord(r.stateDir, rec);
  return rec;
}

const live: SessionInfo[] = [
  {
    ref: { backend: "den-pty", id: "s-scout" },
    name: "acme-north:scout",
    pid: 4242,
    exited: false,
    startedAt: "2026-11-01T09:59:00.000Z",
  } as SessionInfo,
];

function rowOf(r: Rig, sessions: SessionInfo[] = live) {
  return listedSessions(sessions, {
    stateDir: () => r.stateDir,
    dist: () => "acme",
    activeWorkspaces: () => ["north"],
  }).find((x) => x.agent === "scout")!;
}

describe("issue 278: the Agents list's row", () => {
  it("clause 1: compacting repeatedly, with the likely cause from clause 2", async () => {
    const r = await rig();
    seed(r);
    expect(rowOf(r)).not.toHaveProperty("compacting");
    const dir = agentFilesDir(r.stateDir, "scout");
    writeCompacting(dir, {
      token: "tok-scout",
      active: true,
      count: 8,
      rangAt: "2026-11-01T10:05:00.000Z",
    });
    writeInstructionCheck(
      dir,
      instructionCheck(
        [{ path: `${r.wsDir("north")}/CLAUDE.md`, bytes: 840 * 1024 }],
        r.wsDir("north"),
        { sharePercent: 15, contextTokens: 200_000 },
      ),
    );
    const row = rowOf(r);
    expect(row.compacting).toEqual({
      active: true,
      count: 8,
      rangAt: "2026-11-01T10:05:00.000Z",
    });
    expect(row.instructions).toMatchObject({
      sharePercent: 15,
      largest: { path: "CLAUDE.md", bytes: 840 * 1024 },
    });
    // Stopped: the loop is over; only a hold would stay.
    expect(rowOf(r, [])).not.toHaveProperty("compacting");
  });

  it("clause 2: instructions under the share are not listed", async () => {
    const r = await rig();
    seed(r);
    writeInstructionCheck(
      agentFilesDir(r.stateDir, "scout"),
      instructionCheck(
        [{ path: `${r.wsDir("north")}/CLAUDE.md`, bytes: 100 }],
        r.wsDir("north"),
        { sharePercent: 15, contextTokens: 200_000 },
      ),
    );
    expect(rowOf(r)).not.toHaveProperty("instructions");
  });
});

async function api() {
  const r = await rig();
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleAgentRoutes(req, res, p, { agents: r.deps }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  return {
    r,
    async post(p: string, headers: Record<string, string> = {}) {
      const res = await fetch(`http://localhost:${port}${p}`, {
        method: "POST",
        headers,
      });
      const text = await res.text();
      return {
        status: res.status,
        json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
      };
    },
  };
}

describe("issue 278 clause 3: a person clears the hold", () => {
  const CLEAR = "/api/workspaces/north/agents/scout/compacting-clear";

  it("clears it: not paused, no longer looping", async () => {
    const a = await api();
    seed(a.r);
    const dir = agentFilesDir(a.r.stateDir, "scout");
    writeCompacting(dir, {
      token: "tok-scout",
      active: true,
      count: 5,
      paused: true,
    });
    expect(rowOf(a.r).compacting?.paused).toBe(true);
    const res = await a.post(CLEAR);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, agent: "scout" });
    const c = readCompacting(dir);
    expect(c?.paused).toBeUndefined();
    expect(c?.active).toBe(false);
    expect(typeof c?.clearedAt).toBe("string");
    expect(rowOf(a.r)).not.toHaveProperty("compacting");
  });

  it("a person's only: an agent's claim is refused, nothing changed", async () => {
    const a = await api();
    seed(a.r);
    const dir = agentFilesDir(a.r.stateDir, "scout");
    writeCompacting(dir, { token: "tok-scout", active: true, paused: true });
    const res = await a.post(CLEAR, {
      "content-type": "application/json",
      "x-den-actor": "agent",
      "x-den-mcp-client": "jest",
      "x-den-mcp-agent": "agent:scout",
      "x-den-mcp-workspace": "north",
    });
    expect(res.status).toBe(403);
    expect(String(res.json.error)).toMatch(/only a person can clear/);
    expect(readCompacting(dir)?.paused).toBe(true);
  });

  it("refused to an agent's token at the guard; a person's mutating route", () => {
    const why = agentRefusal(
      {
        kind: "agent",
        actor: "agent:scout",
        workspace: "north",
        grants: [],
        session: { id: "s1", name: "acme-north:scout" },
      },
      "POST",
      CLEAR,
      "mutating",
    );
    expect(why).toBeTruthy();
    expect(routeClass("POST", CLEAR)).toBe("mutating");
  });
});
