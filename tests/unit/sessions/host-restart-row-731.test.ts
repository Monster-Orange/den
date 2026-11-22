/**
 * Issue 731: doctor's terminal host row never tells a person to run a
 * command that stops every agent.
 *
 *   - while Den's own refresh waits for agents mid-turn, the row says so
 *     (since when, at most how long) and has no fix;
 *   - after a failed refresh, or with none known, the fix is the held
 *     write host_restart ("Restart the terminal host when agents
 *     are idle"), never a CLI line;
 *   - that held write, after the person's Allow, waits for idle, restarts
 *     the host and resumes the agents (refreshSessionHost, with fakes);
 *   - the server's failure line names the held write, not the CLI.
 *
 * Fakes only: no host process, no launchctl. Invented names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  refreshSessionHost,
  type RefreshDeps,
} from "../../../src/shared/sessions/host-refresh.js";
import {
  HOST_RESTART_ACTION,
  HOST_RESTART_TITLE,
  readHostRefreshState,
  writeHostRefreshState,
  type HostRefreshState,
} from "../../../src/shared/sessions/host-refresh-state.js";
import type { HostClient } from "../../../src/shared/sessions/client.js";
import { localDateTime } from "../../../src/shared/local-time.js";
import { hostModuleLines } from "../../../src/ui/cli/doctor-ptys.js";
import { hostRefreshFailedLine } from "../../../src/ui/server/agent-routes.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import {
  CRITICAL_HELD_ACTIONS,
  heldActions,
} from "../../../src/ui/server/held-actions.js";
import { hostRestartOp } from "../../../src/ui/server/host-restart-held.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const STOP_ALL = /sessions host --stop/;
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-731-"));
  tmps.push(d);
  return d;
};

/** A host whose code changed: the row needs a restart. */
const staleHost = {
  host: async () => ({ den: "1", code: "a", pty: null }),
  installed: () => ({ den: "2", code: "b", pty: null }),
};
const SINCE = "2026-11-20T15:04:00.000Z";
const waiting: HostRefreshState = {
  state: "waiting",
  startedAt: SINCE,
  waitSeconds: 900,
  pid: process.pid,
  why: "the terminal host runs code a, b is installed",
  by: "start",
};

/** Every string a row carries, its lines and its check, as one text. */
const allText = (r: Awaited<ReturnType<typeof hostModuleLines>>) =>
  [...r.lines, JSON.stringify(r.check)].join("\n");

describe("issue 731: doctor's terminal host row", () => {
  it("while Den's refresh waits for idle agents, the row says so, in the person's zone, with no CLI fix", async () => {
    const r = await hostModuleLines("acme", {
      ...staleHost,
      refresh: () => waiting,
      zone: () => "Asia/Tokyo",
    });
    const when = localDateTime(SINCE, "Asia/Tokyo");
    expect(r.check.status).toBe("warn");
    expect(r.problem).toBe(false);
    expect(r.check.detail).toContain(
      `Den restarts it when agents are idle (waiting since ${when}, at most 15 min)`,
    );
    expect(r.check.fix).toBeUndefined();
    expect(r.check.held).toBeUndefined();
    // The page words the time in the viewer's zone from the ISO stamp.
    expect(r.check.refresh).toEqual({
      state: "waiting",
      since: SINCE,
      waitSeconds: 900,
    });
    expect(allText(r)).not.toMatch(STOP_ALL);
    expect(allText(r)).not.toMatch(/\bacme sessions\b/);
  });

  it("issue 732: while a background job an agent started holds the wait, the row says so, never busy with a turn", async () => {
    const r = await hostModuleLines("acme", {
      ...staleHost,
      refresh: () => ({
        ...waiting,
        jobs: [{ agent: "planner", minutes: 42 }],
      }),
      zone: () => "UTC",
    });
    expect(r.check.status).toBe("warn");
    expect(r.check.detail).toContain(
      "agent planner: a background job it started is still running (42 min)",
    );
    expect(allText(r)).not.toMatch(/busy with a turn/);
    // The page reads it too.
    expect(r.check.refresh).toMatchObject({
      state: "waiting",
      jobs: [{ agent: "planner", minutes: 42 }],
    });
  });

  it("after a failed refresh, the row gives Den's reason and the fix is the held write", async () => {
    const r = await hostModuleLines("acme", {
      ...staleHost,
      refresh: () => ({
        ...waiting,
        state: "failed",
        endedAt: "2026-11-20T15:19:00.000Z",
        why: "the terminal host didn't restart: socket busy",
      }),
    });
    expect(r.check.status).toBe("fail");
    expect(r.problem).toBe(true);
    expect(r.check.detail).toContain(
      "Den's restart of it failed: the terminal host didn't restart: socket busy",
    );
    expect(r.check.held).toEqual({
      action: HOST_RESTART_ACTION,
      title: HOST_RESTART_TITLE,
    });
    expect(r.check.fix).toContain(HOST_RESTART_ACTION);
    expect(r.check.fix).toContain(HOST_RESTART_TITLE);
    expect(allText(r)).not.toMatch(STOP_ALL);
  });

  it("with no refresh known (a host that outlived a server restart), the same held write", async () => {
    for (const refresh of [
      () => null,
      // An earlier refresh that ended well says nothing of this host.
      () => ({ ...waiting, state: "restarted" as const, endedAt: SINCE }),
    ]) {
      const r = await hostModuleLines("acme", { ...staleHost, refresh });
      expect(r.check.status).toBe("fail");
      expect(r.check.held?.action).toBe(HOST_RESTART_ACTION);
      expect(r.check.detail).toContain(HOST_RESTART_TITLE);
      expect(allText(r)).not.toMatch(STOP_ALL);
    }
  });

  it("no doctor text or fix, in any state, contains the stop-every-agent command", async () => {
    const states: (HostRefreshState | null)[] = [
      null,
      waiting,
      { ...waiting, state: "failed", why: "x" },
      { ...waiting, state: "none" },
      { ...waiting, state: "kept" },
      { ...waiting, state: "current" },
    ];
    for (const s of states)
      for (const h of [staleHost.host, async () => null])
        expect(
          allText(
            await hostModuleLines("acme", {
              host: h,
              installed: staleHost.installed,
              refresh: () => s,
            }),
          ),
        ).not.toMatch(STOP_ALL);
  });

  it("the server's failure line names the held write, never the CLI", () => {
    const l = hostRefreshFailedLine("the terminal host went away");
    expect(l).toContain("the terminal host went away");
    expect(l).toContain(HOST_RESTART_ACTION);
    expect(l).not.toMatch(STOP_ALL);
  });
});

describe("issue 731: the refresh state doctor reads", () => {
  it("issue 732: keeps the agents a background job holds it for; drops a bad entry", () => {
    const dir = tmp();
    writeHostRefreshState(dir, {
      ...waiting,
      jobs: [
        { agent: "planner", minutes: 7 },
        { agent: "", minutes: 1 },
        { agent: "scout", minutes: -1 },
      ] as never,
    });
    expect(readHostRefreshState(dir, () => true)?.jobs).toEqual([
      { agent: "planner", minutes: 7 },
    ]);
  });

  it("round-trips; a wait whose server is gone is no refresh", () => {
    const dir = tmp();
    expect(readHostRefreshState(dir)).toBeNull();
    writeHostRefreshState(dir, waiting);
    expect(readHostRefreshState(dir)).toEqual(waiting);
    expect(readHostRefreshState(dir, () => false)).toBeNull();
    writeHostRefreshState(dir, { ...waiting, state: "failed", why: "x" });
    expect(readHostRefreshState(dir, () => false)?.state).toBe("failed");
  });

  it("the refresh says when it starts to wait, and how long at most", async () => {
    const f = fakeHost();
    const waits: { why: string; waitMs: number }[] = [];
    let busyLooks = 0;
    await refreshSessionHost({
      ...f.deps,
      busy: async (ids) => (busyLooks++ < 1 ? [...ids] : []),
      onWait: (w) => waits.push(w),
    });
    expect(waits).toEqual([
      { why: expect.stringContaining("code"), waitMs: 60000 },
    ]);
  });
});

/**
 * A fake host: hello says old code; shutdown records the stop; connect
 * brings back one on the installed code. `events` is the order of what
 * happened.
 */
function fakeHost() {
  const events: string[] = [];
  let pid = 100;
  let up = true;
  const client = (code: string): HostClient => {
    const e = new EventEmitter() as unknown as HostClient & EventEmitter;
    Object.assign(e, {
      hostPid: pid,
      hostDen: code === "b" ? "2" : "1",
      hostCode: code,
      hostPty: null,
      close: () => {},
      adopt: async () => {},
      list: async () => [],
      shutdown: async () => {
        events.push("stop");
        up = false;
        setImmediate(() => e.emit("close"));
      },
    });
    return e;
  };
  const deps: RefreshDeps = {
    connectExisting: async () => (up ? client("a") : null),
    connect: async () => {
      events.push("start");
      up = true;
      pid = 200;
      return client("b");
    },
    socket: path.join(os.tmpdir(), `den-731-no-socket-${process.pid}`),
    installed: () => ({ den: "2", code: "b", pty: null }),
    running: async () => ["a1", "a2"],
    busy: async () => [],
    waitMs: 60000,
    pollMs: 5,
    resume: async (id) => {
      events.push(`resume ${id}`);
    },
    log: () => {},
  };
  return { deps, events };
}

describe("issue 731: the held write host_restart", () => {
  it("is the person's own Allow, and its card says what it does", async () => {
    expect(CRITICAL_HELD_ACTIONS.has(HOST_RESTART_ACTION)).toBe(true);
    const op = hostRestartOp({
      refreshing: () => false,
      waitSeconds: () => 900,
      start: async () => ({ did: "current" }),
    });
    const c = op.check({}, { agent: "den-server" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBe(true);
    expect(c.summary).toBe("restart the terminal host when agents are idle");
    expect(c.detailKeys?.map((k) => k?.key)).toEqual([
      "ap.det.host_restart.wait",
      "ap.det.host_restart.resume",
    ]);
    expect(c.details.join(" ")).not.toMatch(STOP_ALL);
  });

  it("refuses while Den's own refresh already waits (nothing asked twice)", () => {
    const op = hostRestartOp({
      refreshing: () => true,
      waitSeconds: () => 900,
      start: async () => ({ did: "current" }),
    });
    const c = op.check({});
    expect(c.ok).toBe(false);
  });

  it("after the person's Allow, waits for idle agents, restarts the host and resumes them", async () => {
    const dir = tmp();
    const f = fakeHost();
    let busyLooks = 0;
    let done!: (v: unknown) => void;
    const finished = new Promise((r) => (done = r));
    const actions = heldActions({
      terminalHostRestart: hostRestartOp({
        refreshing: () => false,
        waitSeconds: () => 60,
        start: () => {
          const p = refreshSessionHost({
            ...f.deps,
            // a1 is mid-turn for the first two looks, then idle.
            busy: async (ids) => {
              f.events.push("look");
              return busyLooks++ < 2 ? ids.filter((i) => i === "a1") : [];
            },
          });
          void p.then(done);
          return p;
        },
      }),
    } as unknown as Parameters<typeof heldActions>[0]);
    const queue = createApprovalQueue(actions, () => dir);
    mintActorToken(dir, {
      agentId: "den-server",
      workspace: "den-server",
      sessionName: "den-server:den-server",
    });
    const server = http.createServer((req, res) => {
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
        { queue, actions, policy: () => ({ kind: "auto", from: "test" }) },
      ).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ask = await fetch(`${base}/api/approvals`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-agent": "den-server",
        },
        body: JSON.stringify({ action: HOST_RESTART_ACTION, args: {} }),
      });
      const asked = (await ask.json()) as { id: string; state: string };
      // Critical: even an auto policy leaves it for the person.
      expect(asked.state).toBe("pending");
      expect(f.events).toEqual([]);
      const dec = await queue.decide(asked.id, "allow", "session:s1");
      expect(dec.ok).toBe(true);
      const res = (await finished) as { did: string; resumed: string[] };
      expect(res.did).toBe("restarted");
      expect(res.resumed).toEqual(["a1", "a2"]);
      // Waited out the busy looks, then stopped, started, resumed.
      expect(f.events).toEqual([
        "look",
        "look",
        "look",
        "stop",
        "start",
        "resume a1",
        "resume a2",
      ]);
    } finally {
      server.close();
    }
  });
});
