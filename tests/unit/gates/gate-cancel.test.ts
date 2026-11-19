/**
 * Issue 585: `<cli> gate cancel <id>`. The slot's owner or a person
 * withdraws a queued or running gate slot. Temp stores only; the real
 * process tests start their own `gate run` and signal only the process
 * group that run made.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { GATE_DEFAULTS, mayCancel } from "../../../src/shared/gates/rules.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { stopRun } from "../../../src/shared/gates/cancel.js";
import {
  cmdGate,
  realGateDeps,
  type GateDeps,
} from "../../../src/ui/cli/gate-command.js";
import { handleGateRoutes } from "../../../src/ui/server/gate-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { assertAllowedRequest } from "../../../src/ui/mcp/api.js";
import {
  READ_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";

const tmps: string[] = [];
const kids: ChildProcess[] = [];
/** Only processes these tests started. */
const strays: number[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill("SIGKILL");
  for (const p of strays.splice(0))
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* already gone */
    }
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gatecancel-"));
  tmps.push(d);
  return d;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function deps(over: Partial<GateDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[][] = [];
  const d: GateDeps = {
    store: new GateStore({ dir: tmp(), alive: () => true }),
    env: {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: (cmd, args) => {
      ran.push([cmd, ...args]);
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
    ...over,
  };
  return { d, out, err, ran };
}

describe("issue 585: who may cancel", () => {
  it("the owner (same agent) or a person; no one else", () => {
    const e = {
      id: "browser-1",
      kind: "browser" as const,
      who: "w",
      label: "l",
      pid: 1,
      askedAt: "2026-11-15T06:00:00Z",
      estimateMin: 5,
      agent: true,
      actor: "agent:coder",
    };
    expect(mayCancel(e, { person: true })).toBe(true);
    expect(mayCancel(e, { agent: "agent:coder" })).toBe(true);
    expect(mayCancel(e, { agent: "agent:other" })).toBe(false);
    expect(mayCancel(e, { agent: "" })).toBe(false);
    // A person's own ask: only a person.
    const person = { ...e, agent: undefined, actor: undefined };
    expect(mayCancel(person, { agent: "agent:coder" })).toBe(false);
    expect(mayCancel(person, { person: true })).toBe(true);
  });

  it("the grace before KILL is a setting with a permissive default", () => {
    expect(GATE_DEFAULTS.cancelGraceSeconds).toBeGreaterThanOrEqual(30);
  });
});

describe("issue 585: gate cancel, queued", () => {
  it("a queued ask cancelled by its owner never starts its command; gate run exits non-zero with who", async () => {
    const t = deps({ env: { DEN_AGENT: "agent:coder" } });
    const holder = t.d.store.ask({
      kind: "browser",
      who: "someone",
      label: "suite",
      pid: 7,
      estimateMin: 60,
    });
    let canceller: ReturnType<typeof deps> | undefined;
    let sleeps = 0;
    t.d.sleep = async () => {
      if (++sleeps !== 1) return;
      const mine = t.d.store.list().find((e) => e.id !== holder.id)!;
      canceller = deps({ env: { DEN_AGENT: "agent:coder" } });
      canceller.d.store = t.d.store;
      expect(await cmdGate(["cancel", mine.id], canceller.d)).toBe(0);
    };
    const code = await cmdGate(["run", "--kind", "browser", "--", "e2e"], t.d);
    expect(code).not.toBe(0);
    expect(t.ran).toEqual([]);
    expect(t.err.join("\n")).toMatch(/cancelled by .*agent:coder/);
    const row = t.d.store.events().find((e) => e.event === "cancelled")!;
    expect(row).toMatchObject({ was: "queued" });
    expect(row.by).toContain("agent:coder");
    expect(t.d.store.list().map((e) => e.id)).toEqual([holder.id]);
    expect(canceller!.out.join("\n")).toMatch(/Cancelled/);
  });

  it("another agent can't cancel; a person can cancel any", async () => {
    const t = deps();
    const a = t.d.store.ask({
      kind: "cpu",
      who: "w",
      label: "unit",
      pid: 7,
      estimateMin: 5,
      agent: true,
      actor: "agent:coder",
    });
    t.d.env = { DEN_AGENT: "agent:other" };
    expect(await cmdGate(["cancel", a.id], t.d)).toBe(1);
    expect(t.err.join("\n")).toMatch(/isn't yours/);
    expect(t.d.store.list()).toHaveLength(1);
    t.d.env = {};
    expect(await cmdGate(["cancel", a.id], t.d)).toBe(0);
    expect(t.d.store.list()).toEqual([]);
    // gate end keeps its meaning: its row is ended-early, not cancelled.
    expect(t.d.store.events().map((e) => e.event)).toEqual([
      "asked",
      "granted",
      "cancelled",
    ]);
    expect(await cmdGate(["cancel", "browser-nope"], t.d)).toBe(1);
  });
});

describe("issue 585: stopping a running slot", () => {
  it("TERM to the group, KILL after the grace when it ignores TERM, release only when the group is gone; the next waiter after", async () => {
    let groupUp = true;
    const sent: [number, string][] = [];
    let clock = 0;
    const store = new GateStore({
      dir: tmp(),
      alive: (pid) => (pid < 0 ? groupUp : true),
      now: () => 1_700_000_000_000 + clock,
    });
    const e = store.ask({
      kind: "browser",
      who: "w",
      label: "e2e",
      pid: 10,
      estimateMin: 5,
      agent: true,
      actor: "agent:coder",
    });
    store.setRunPid(e.id, 4321, true);
    const next = store.ask({
      kind: "browser",
      who: "n",
      label: "next",
      pid: 11,
      estimateMin: 5,
    });
    const c = store.cancel(e.id, "agent:coder");
    expect(c).toMatchObject({ was: "running", runPid: 4321, group: true });
    const gone = await stopRun(4321, true, 2_000, {
      alive: (p) => store.isAlive(p),
      kill: (p, s) => {
        sent.push([p, s]);
        // The group ignores TERM; KILL ends it.
        if (s === "SIGKILL") groupUp = false;
      },
      sleep: async (ms) => {
        clock += ms;
        // While the group is up, the next waiter never starts.
        expect(store.get(next.id)?.grantedAt).toBeUndefined();
      },
      now: () => clock,
    });
    expect(gone).toBe(true);
    expect(sent).toEqual([
      [-4321, "SIGTERM"],
      [-4321, "SIGKILL"],
    ]);
    expect(clock).toBeGreaterThanOrEqual(2_000);
    store.releaseCancelled(e.id);
    expect(store.get(next.id)?.grantedAt).toBeDefined();
    const ev = store.events().map((x) => `${x.event}:${x.id}`);
    expect(ev.indexOf(`released:${e.id}`)).toBeLessThan(
      ev.indexOf(`granted:${next.id}`),
    );
    expect(ev).toContain(`cancelled:${e.id}`);
  });

  it("a slot held over MCP (no run of its own) is freed without signalling anything", () => {
    const store = new GateStore({ dir: tmp(), alive: () => true });
    const e = store.ask({
      kind: "cpu",
      who: "w",
      label: "unit",
      pid: process.pid,
      estimateMin: 5,
    });
    expect(store.cancel(e.id, "a person")).toMatchObject({
      was: "running",
      runPid: undefined,
    });
    expect(store.list()).toEqual([]);
  });

  async function startRun(dir: string, script: string) {
    const k = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "cancel-child.ts")],
      {
        env: {
          ...process.env,
          DEN_GATE_DIR: dir,
          DEN_AGENT: "agent:coder",
          GATE_CHILD_SCRIPT: script,
          TSX_DISABLE_CACHE: "1",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    kids.push(k);
    let err = "";
    const exited = new Promise<number | null>((r) => k.on("exit", (c) => r(c)));
    await new Promise<void>((resolve) =>
      k.stderr.on("data", (d: Buffer) => {
        err += String(d);
        if (/kid \d+/.test(err) && /grand \d+/.test(err)) resolve();
      }),
    );
    const kid = Number(/kid (\d+)/.exec(err)?.[1]);
    const grand = Number(/grand (\d+)/.exec(err)?.[1]);
    strays.push(kid, grand);
    return { k, kid, grand, exited, err: () => err };
  }

  const tree = (grandIgnoresTerm: boolean) =>
    [
      "const { spawn } = require('child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(
        (grandIgnoresTerm ? "process.on('SIGTERM', () => {});" : "") +
          "console.error('grand ' + process.pid); setInterval(() => {}, 1000);",
      )}], { stdio: 'inherit' });`,
      "console.error('kid ' + process.pid); setInterval(() => {}, 1000);",
    ].join("\n");

  for (const ignores of [false, true])
    it(`a real run cancelled by its owner: the whole group (grandchild too${ignores ? ", which ignores TERM" : ""}) ends before the slot frees`, async () => {
      const dir = tmp();
      const store = new GateStore({ dir });
      store.writeSettings({ cancel_grace_seconds: 1 });
      const run = await startRun(dir, tree(ignores));
      const [mine] = store.list();
      expect(mine?.runPid).toBeDefined();
      // A waiter of this test's own (its pid is this process).
      const next = store.ask({
        kind: "browser",
        who: "next",
        label: "next",
        pid: process.pid,
        estimateMin: 5,
      });
      const out: string[] = [];
      const t0 = Date.now();
      const code = await cmdGate(["cancel", mine!.id], {
        ...realGateDeps(),
        store,
        env: { DEN_AGENT: "agent:coder" },
        out: (l) => out.push(l),
        err: (l) => out.push(l),
      });
      expect(code).toBe(0);
      expect(alive(run.kid)).toBe(false);
      expect(alive(run.grand)).toBe(false);
      if (ignores) expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
      expect(await run.exited).not.toBe(0);
      expect(run.err()).toMatch(/cancelled by .*agent:coder/);
      expect(store.get(next.id)?.grantedAt).toBeDefined();
      const ev = store.events().map((x) => `${x.event}:${x.id}`);
      expect(ev).toContain(`cancelled:${mine!.id}`);
      expect(ev.indexOf(`released:${mine!.id}`)).toBeLessThan(
        ev.indexOf(`granted:${next.id}`),
      );
      expect(store.events().find((x) => x.event === "cancelled")).toMatchObject(
        { was: "running" },
      );
      store.release(next.id);
    }, 30_000);
});

async function serve() {
  const dir = tmp();
  const store = new GateStore({ dir, alive: () => true });
  const audited: {
    actor: unknown;
    action: { verb: string; detail: string };
    principal?: string;
  }[] = [];
  const server = http.createServer((req, res) => {
    const who = req.headers.authorization;
    if (who === "Bearer coder" || who === "Bearer other")
      setPrincipal(req, {
        kind: "agent",
        actor: who === "Bearer coder" ? "agent:coder" : "agent:other",
        workspace: "north",
        grants: [],
        session: "s",
      } as never);
    if (who === "Bearer person")
      setPrincipal(req, { kind: "person", actor: "person:pat" });
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleGateRoutes(req, res, p, {
      store: () => store,
      title: "Acme",
      audit: ((actor, action, principal) => {
        audited.push({ actor, action, principal });
        return {} as never;
      }) as never,
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + "/api/gate-slots/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: r.status,
      json: (await r.json()) as Record<string, unknown>,
    };
  };
  return { store, call, audited };
}

describe("issue 585: POST /api/gate-slots/cancel", () => {
  const ask = (store: GateStore, actor?: string) =>
    store.ask({
      kind: "cpu",
      who: "w",
      label: "unit",
      pid: 7,
      estimateMin: 5,
      ...(actor ? { agent: true, actor } : {}),
    });

  it("another agent gets 403, by token or by claim; nothing changes", async () => {
    const { store, call, audited } = await serve();
    const a = ask(store, "agent:coder");
    expect(
      (await call({ id: a.id }, { authorization: "Bearer other" })).status,
    ).toBe(403);
    expect(
      (
        await call(
          { id: a.id },
          {
            "x-den-actor": "agent",
            "x-den-mcp-client": "x",
            "x-den-mcp-session": "s",
          },
        )
      ).status,
    ).toBe(403);
    expect(store.list()).toHaveLength(1);
    expect(audited).toEqual([]);
  });

  it("the owner agent cancels its own; recorded in the slot log and the audit", async () => {
    const { store, call, audited } = await serve();
    const a = ask(store, "agent:coder");
    const r = await call({ id: a.id }, { authorization: "Bearer coder" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, was: "running" });
    expect(store.list()).toEqual([]);
    const row = store.events().find((e) => e.event === "cancelled")!;
    expect(row.by).toBe("Acme · agent:coder");
    expect(audited).toEqual([
      expect.objectContaining({
        principal: "agent:coder",
        action: expect.objectContaining({
          verb: "gate-cancel",
          detail: expect.stringContaining(`cancelled gate slot ${a.id}`),
        }),
      }),
    ]);
  });

  it("a person cancels anyone's; a wrong id is said", async () => {
    const { store, call } = await serve();
    const a = ask(store, "agent:coder");
    expect(
      (await call({ id: "cpu-nope" }, { authorization: "Bearer person" }))
        .status,
    ).toBe(404);
    expect((await call({}, { authorization: "Bearer person" })).status).toBe(
      400,
    );
    const r = await call({ id: a.id }, { authorization: "Bearer person" });
    expect(r.status).toBe(200);
    expect(store.events().find((e) => e.event === "cancelled")).toMatchObject({
      event: "cancelled",
      by: "Acme · person:pat",
    });
  });
});

describe("issue 585: an agent cancels over MCP", () => {
  it("gate_slot_cancel posts to the route that checks the owner", async () => {
    expect(READ_TOOL_NAMES).toContain("gate_slot_cancel");
    expect(() =>
      assertAllowedRequest("POST", "/api/gate-slots/cancel", {}),
    ).not.toThrow();
    const calls: unknown[] = [];
    const api = {
      baseUrl: "http://localhost:47003",
      async get(p: string, _q: unknown, m: string, body: unknown) {
        if (p === "/api/workspaces")
          return { active: ["north"], workspaces: { north: {} } };
        calls.push([p, m, body]);
        return { ok: true, was: "queued" };
      },
      async stream() {
        throw new Error("no streams");
      },
    } as unknown as DenApi;
    const ctx = {
      api,
      cfg: {
        actions: [],
        runTestsEnvs: ["local"],
        logsRemote: false,
        approvals: true,
      },
      cli: "acme",
      scope: { workspace: "north", actor: "agent:coder" },
    } as unknown as ToolContext;
    const r = await callTool("gate_slot_cancel", { id: "cpu-abc" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.text)).toEqual({ ok: true, was: "queued" });
    expect(calls).toEqual([
      ["/api/gate-slots/cancel", "POST", { id: "cpu-abc" }],
    ]);
  });
});
