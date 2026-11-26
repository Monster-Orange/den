import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { AddressInfo } from "net";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  restartMany,
  type RestartPlan,
} from "../../../src/ui/cli/agent-ops.js";
import { RestartQueue } from "../../../src/shared/agents/restart-queue.js";
import { RestartLive } from "../../../src/ui/server/restart-live.js";
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

async function twoAgentsOnOlderTools() {
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

function midTurn(r: Rig, token: string): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${token}.jsonl`),
    JSON.stringify({
      type: "user",
      cwd: r.wsDir("north"),
      message: { content: "Go" },
    }) + "\n",
  );
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

const ids = (x: unknown) =>
  ((x as { id: string }[] | undefined) ?? []).map((a) => a.id).sort();

describe("a bulk restart for tools goes through the restart queue, a batch at a time", () => {
  it("85 agents, a batch of 4: no window starts more than 4 stops and resumes, and every one restarts", async () => {
    const agents = Array.from({ length: 85 }, (_, i) => ({
      id: `a${i}`,
      workspace: "north",
    }));
    let clock = 0;
    const windows: number[] = [];
    let inWindow = 0;
    const queue = new RestartQueue({
      config: () => ({ batch: 4, gapMs: 1_000, loadCeiling: 0 }),
      load: () => 0,
      now: () => clock,
      sleep: async (ms) => {
        windows.push(inWindow);
        inWindow = 0;
        clock += ms;
        await new Promise((r) => setImmediate(r));
      },
    });
    const done: string[] = [];
    await new Promise<void>((resolve) => {
      void restartMany({} as never, agents, {
        slot: async (id) => {
          await queue.add({
            id,
            why: "tools",
            run: async () => {
              inWindow++;
              return true;
            },
          });
          return () => undefined;
        },
        stateOf: async (_d, id, ws) =>
          ({ id, workspace: ws ?? "", state: "now" }) as RestartPlan,
        restart: (async (
          _d: unknown,
          _id: string,
          _ws: string,
          _when: string,
          o?: { slot?: () => Promise<() => void> },
        ) => {
          const release = await o?.slot?.();
          release?.();
          return {} as never;
        }) as never,
        onDone: (r) => {
          done.push(r.id);
          if (done.length === agents.length) resolve();
        },
      });
    });
    windows.push(inWindow);
    expect(done).toHaveLength(85);
    expect(Math.max(...windows)).toBeLessThanOrEqual(4);
    expect(windows.filter((n) => n > 0).length).toBeGreaterThanOrEqual(22);
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
    const r = await twoAgentsOnOlderTools();
    for (const id of ["planner", "reviewer"])
      midTurn(r, readRecord(r.stateDir, id)!.resumeToken!);
    const call = await api(r);
    const first = await call({});
    expect(first.status).toBe(202);
    expect(ids(first.json.pending)).toEqual(["planner", "reviewer"]);
    expect(
      (first.json.agents as { state: string }[]).map((a) => a.state),
    ).toEqual(["turn", "turn"]);
    const second = await call({});
    const third = await call({});
    expect(ids(second.json.pending)).toEqual([]);
    expect(ids(third.json.pending)).toEqual([]);
    expect(second.json.run).toEqual({ total: 2, done: 0 });
    await settle(300);
  });

  it("two presses at the same moment queue each agent once", async () => {
    const r = await twoAgentsOnOlderTools();
    for (const id of ["planner", "reviewer"])
      midTurn(r, readRecord(r.stateDir, id)!.resumeToken!);
    const call = await api(r);
    const both = await Promise.all([call({}), call({})]);
    expect(both.map((b) => b.status)).toEqual([202, 202]);
    expect(both.flatMap((b) => ids(b.json.pending)).sort()).toEqual([
      "planner",
      "reviewer",
    ]);
    await settle(300);
  });
});
