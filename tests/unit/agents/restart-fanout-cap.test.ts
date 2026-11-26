import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  RestartSlots,
  restartMany,
  type RestartPlan,
} from "../../../src/ui/cli/agent-ops.js";
import { RestartLive } from "../../../src/ui/server/restart-live.js";
import {
  readAgentsConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";
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
    });
  }
  return r;
}

const ids = (x: unknown) =>
  ((x as { id: string }[] | undefined) ?? []).map((a) => a.id).sort();

describe("a bulk restart for tools runs a few at a time (agents.restart_concurrency)", () => {
  it("85 agents, a cap of 4: never more than 4 restarting at once, and every one restarts", async () => {
    const agents = Array.from({ length: 85 }, (_, i) => ({
      id: `a${i}`,
      workspace: "north",
    }));
    let running = 0;
    let most = 0;
    const done: string[] = [];
    const finished = new Promise<void>((resolve) => {
      void restartMany({} as never, agents, {
        slots: new RestartSlots(() => 4),
        stateOf: async (_d, id, ws) =>
          ({ id, workspace: ws ?? "", state: "now" }) as RestartPlan,
        restart: (async (_d, id, _ws, _when, o) => {
          const release = await o?.slot?.();
          running++;
          most = Math.max(most, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
          release?.();
          return {} as never;
        }) as never,
        onDone: (r) => {
          done.push(r.id);
          if (done.length === agents.length) resolve();
        },
      });
    });
    await finished;
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
    expect(done).toHaveLength(85);
  });

  it("defaults to 4; a value is read; a bad one names the key", () => {
    const cap = (v: unknown) =>
      readAgentsConfig({
        agents: { restart_concurrency: v },
      } as unknown as DenConfig).restartConcurrency;
    expect(readAgentsConfig({} as DenConfig).restartConcurrency).toBe(4);
    expect(cap(8)).toBe(8);
    for (const bad of [0, -1, 2.5, "many", 65])
      expect(() => cap(bad)).toThrow("agents.restart_concurrency");
  });
});

describe("the live run a page shows while a bulk restart goes", () => {
  it("counts the agents restarting, and how many are done; nothing running is null", () => {
    const live = new RestartLive();
    expect(live.progress()).toBeNull();
    live.begin([
      { id: "a", workspace: "w", state: "now" },
      { id: "b", workspace: "w", state: "turn" },
      {
        id: "c",
        workspace: "w",
        state: "job",
        job: { command: "x", minutes: 1 },
      },
    ]);
    expect(live.progress()).toEqual({ total: 2, done: 0 });
    expect(live.inProgress("w", "a")).toBe(true);
    expect(live.inProgress("w", "c")).toBe(false);
    live.done({ id: "a", workspace: "w", outcome: "restarted" });
    expect(live.progress()).toEqual({ total: 2, done: 1 });
    live.done({ id: "b", workspace: "w", outcome: "restarted" });
    expect(live.progress()).toBeNull();
  });
});

describe("pressing Restart all again while a wave runs adds nothing", () => {
  it("a second and a third press queue no agent twice", async () => {
    const r = await twoStale();
    const call = await api(r);
    const first = await call({});
    expect(first.status).toBe(202);
    expect(ids(first.json.pending)).toEqual(["planner", "reviewer"]);
    const second = await call({});
    const third = await call({});
    expect(ids(second.json.pending)).toEqual([]);
    expect(ids(third.json.pending)).toEqual([]);
    expect(second.json.run).toEqual({ total: 2, done: expect.any(Number) });
    await settle(300);
  });
});
