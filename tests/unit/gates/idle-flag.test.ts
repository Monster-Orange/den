/**
 * A slot whose run sits idle well past its estimate is flagged (never
 * stopped by the flag). The flag shows in `gate status` and in the agent
 * holder's bell. After a grace, a waiting release run may cancel it, naming
 * who and why; an unflagged slot is never cancelled that way. Temp stores,
 * a fake clock and a fake CPU reading; the one real reading is of a
 * process group this test starts.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  GATE_DEFAULTS,
  idleCancellable,
  mayCancel,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import {
  GateStore,
  checkGatePatch,
  groupCpuSeconds,
  parseCpuTime,
} from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cancelIdleFor } from "../../../src/shared/gates/cancel.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { handleGateRoutes } from "../../../src/ui/server/gate-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { ringIdleGates } from "../../../src/ui/server/gate-idle-bell.js";

const tmps: string[] = [];
const kids: ChildProcess[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const k of kids.splice(0))
    try {
      if (k.pid) process.kill(-k.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gateidle-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-19T10:00:00Z");
const MIN = 60_000;

/** A store on a fake clock; `cpu` says each run's CPU seconds so far. */
function rig() {
  let now = T0;
  const cpu = new Map<number, number>();
  const asked: number[] = [];
  const store = new GateStore({
    dir: tmp(),
    alive: () => true,
    now: () => now,
    cpu: (e) => {
      if (e.runPid === undefined) return null;
      asked.push(e.runPid);
      return cpu.get(e.runPid) ?? 0;
    },
  });
  return {
    store,
    cpu,
    asked,
    at: (min: number) => (now = T0 + min * MIN),
  };
}

const hold = (
  store: GateStore,
  runPid: number,
  o: { actor?: string; kind?: "cpu" | "browser" } = {},
) => {
  const e = store.ask({
    kind: o.kind ?? "cpu",
    who: `w${runPid}`,
    label: `run ${runPid}`,
    pid: 1,
    estimateMin: 10,
    ...(o.actor ? { agent: true, actor: o.actor } : {}),
  });
  store.setRunPid(e.id, runPid, true);
  return e;
};

describe("idle flag: settings", () => {
  it("are settings with permissive defaults", () => {
    expect(GATE_DEFAULTS.idleFlagAfterMinutes).toBe(15);
    expect(GATE_DEFAULTS.idleCpuPercent).toBe(2);
    expect(GATE_DEFAULTS.idleSampleSeconds).toBe(60);
    expect(GATE_DEFAULTS.idleCancelGraceMinutes).toBe(10);
    expect(
      checkGatePatch({
        idle_flag_after_minutes: 30,
        idle_cpu_percent: 5,
        idle_sample_seconds: 120,
        idle_cancel_grace_minutes: 20,
      }).ok,
    ).toBe(true);
    expect(checkGatePatch({ idle_cpu_percent: 101 }).ok).toBe(false);
  });
});

describe("idle flag: sampling", () => {
  it("a tree idle past its estimate plus the setting is flagged; a busy one isn't", () => {
    const r = rig();
    const idle = hold(r.store, 101);
    r.store.release(idle.id); // only one cpu pair at once is fine; ask again
    const a = hold(r.store, 201);
    const b = hold(r.store, 202);
    // Inside the estimate plus idle_flag_after_minutes: never sampled.
    r.at(20);
    r.store.list();
    expect(r.asked).toEqual([]);
    // Past it: the first look takes a sample, the next (a window later) judges.
    r.at(26);
    r.store.list();
    r.cpu.set(202, 30); // b used 30 s of CPU in the next minute: busy
    r.at(27);
    r.store.list();
    expect(r.store.get(a.id)?.idleAt).toBeDefined();
    expect(r.store.get(b.id)?.idleAt).toBeUndefined();
    const ev = r.store.events().filter((e) => e.event === "idle");
    expect(ev.map((e) => e.id)).toEqual([a.id]);
    // The flag never removes or stops anything.
    expect(r.store.list().map((e) => e.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });

  it("samples at most once a window", () => {
    const r = rig();
    hold(r.store, 301);
    r.at(26);
    r.store.list();
    r.store.list();
    r.store.list();
    expect(r.asked).toEqual([301]);
  });

  it("a flagged tree that works again is no longer flagged", () => {
    const r = rig();
    const a = hold(r.store, 401);
    r.at(26);
    r.store.list();
    r.at(27);
    r.store.list();
    expect(r.store.get(a.id)?.idleAt).toBeDefined();
    r.cpu.set(401, 40);
    r.at(28);
    r.store.list();
    expect(r.store.get(a.id)?.idleAt).toBeUndefined();
  });

  it("reads the CPU time ps prints, on Linux and on macOS", () => {
    expect(parseCpuTime("00:00:01")).toBe(1);
    expect(parseCpuTime("01:02:03")).toBe(3723);
    expect(parseCpuTime("1-00:00:00")).toBe(86400);
    expect(parseCpuTime("0:00.50")).toBeCloseTo(0.5);
    expect(parseCpuTime("12:34.00")).toBe(754);
    expect(parseCpuTime("x")).toBeNull();
  });

  it("sums a real group's CPU (a group this test starts)", async () => {
    const k = spawn(
      process.execPath,
      ["-e", "const t = Date.now(); while (Date.now() - t < 1500) {}"],
      { detached: true, stdio: "ignore" },
    );
    kids.push(k);
    await new Promise((r) => setTimeout(r, 1200));
    const s = groupCpuSeconds(k.pid!);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(0.3);
  }, 15_000);
});

describe("idle flag: shown", () => {
  it("gate status says idle N min past its estimate, in text and --json", async () => {
    const r = rig();
    const a = hold(r.store, 501);
    r.at(26);
    r.store.list();
    r.at(31);
    r.store.list();
    const out: string[] = [];
    const d = {
      store: r.store,
      env: {},
      out: (l: string) => out.push(l),
      err: () => {},
      now: () => T0 + 31 * MIN,
      sleep: () => Promise.resolve(),
      exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 1,
      cwd: "/x/r",
    } as GateDeps;
    expect(await cmdGate(["status"], d)).toBe(0);
    expect(out.join("\n")).toContain("(idle 21 min past its estimate)");
    const v = gateView(r.store, T0 + 31 * MIN);
    expect(v.slots.find((s) => s.id === a.id)).toMatchObject({
      idle: { minutesPast: 21 },
    });
  });

  it("an agent holder's bell gets one Needs-you item in its project", () => {
    const r = rig();
    const a = hold(r.store, 601, { actor: "agent:coder" });
    hold(r.store, 602, { actor: "agent:elsewhere" });
    r.at(26);
    r.store.list();
    r.at(31);
    const added: Record<string, unknown>[] = [];
    const rung = new Set<string>();
    const d = {
      store: r.store,
      bell: {
        add: (n: Record<string, unknown>) => {
          added.push(n);
          return null;
        },
      },
      records: () => [{ id: "coder", workspace: "north" }],
      rung,
      now: () => T0 + 31 * MIN,
    };
    ringIdleGates(d as never);
    ringIdleGates(d as never);
    expect(added).toEqual([
      expect.objectContaining({
        kind: "decision",
        scope: "workspace/north",
        subject: `gate:${a.id}`,
        msg: {
          key: "bell.m.gateIdle",
          vars: { label: "run 601", n: 21 },
        },
      }),
    ]);
  });
});

describe("idle flag: a release run may cancel it, only flagged and past the grace", () => {
  const flagged = (idleMinAgo: number): GateEntry => ({
    id: "cpu-a",
    kind: "cpu",
    who: "w",
    label: "l",
    pid: 1,
    askedAt: new Date(T0).toISOString(),
    grantedAt: new Date(T0).toISOString(),
    estimateMin: 10,
    runPid: 9,
    idleAt: new Date(T0 + (60 - idleMinAgo) * MIN).toISOString(),
  });
  const now = T0 + 60 * MIN;

  it("the rules", () => {
    const s = GATE_DEFAULTS;
    expect(idleCancellable(flagged(11), s, now)).toBe(true);
    expect(idleCancellable(flagged(5), s, now)).toBe(false);
    const { idleAt: _gone, ...plain } = flagged(30);
    expect(idleCancellable(plain, s, now)).toBe(false);
    const rel = { releases: new Set(["release-x"]) };
    expect(mayCancel(flagged(11), { release: "release-x" }, { ...rel, now })).toBe(
      true,
    );
    expect(mayCancel(flagged(5), { release: "release-x" }, { ...rel, now })).toBe(
      false,
    );
    expect(mayCancel(plain, { release: "release-x" }, { ...rel, now })).toBe(
      false,
    );
    // Not a release run that holds or waits: no.
    expect(
      mayCancel(flagged(11), { release: "release-y" }, { ...rel, now }),
    ).toBe(false);
  });

  it("a waiting release run cancels a flagged slot after the grace, naming who and why; never an unflagged one", async () => {
    const r = rig();
    const idle = hold(r.store, 701);
    const busy = hold(r.store, 702);
    r.at(26);
    r.store.list();
    r.cpu.set(702, 50);
    r.at(27);
    r.store.list(); // 701 flagged at 27, 702 busy
    const sent: [number, string][] = [];
    let groupUp = true;
    const rel = r.store.ask({
      kind: "release",
      who: "bed",
      label: "tag run",
      pid: 2,
      estimateMin: 30,
      tag: "v1.2.3-dev.1",
      commit: "abc",
    });
    // Before the grace: nothing is cancelled.
    r.at(30);
    expect(
      cancelIdleFor(r.store, rel.id, {
        alive: (p) => (p === -701 ? groupUp : true),
        kill: (p, s) => {
          sent.push([p, s]);
          if (p === -701) groupUp = false;
        },
        sleep: async () => {},
        now: () => T0 + 30 * MIN,
      }),
    ).toEqual([]);
    // After it: only the flagged one, recorded with who and why.
    r.at(38);
    const done = cancelIdleFor(r.store, rel.id, {
      alive: (p) => (p === -701 ? groupUp : true),
      kill: (p, s) => {
        sent.push([p, s]);
        if (p === -701) groupUp = false;
      },
      sleep: async () => {},
      now: () => T0 + 38 * MIN,
    });
    expect(done.map((c) => c.id)).toEqual([idle.id]);
    await Promise.all(done.map((c) => c.done));
    expect(sent).toEqual([[-701, "SIGTERM"]]);
    const row = r.store.events().find((e) => e.event === "cancelled")!;
    expect(row).toMatchObject({ id: idle.id, was: "running" });
    expect(row.by).toContain("bed");
    expect(row.reason).toMatch(/idle \d+ min past its estimate/);
    expect(r.store.get(busy.id)).not.toBeNull();
  });
});

async function serve(store: GateStore) {
  const audited: { action: { verb: string; detail: string } }[] = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization === "Bearer person")
      setPrincipal(req, { kind: "person", actor: "person:pat" });
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleGateRoutes(req, res, p, {
      store: () => store,
      title: "Acme",
      audit: ((_a, action) => {
        audited.push({ action });
        return {} as never;
      }) as never,
      stop: {
        alive: () => false,
        kill: () => {},
        sleep: async () => {},
        now: Date.now,
      },
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (body: unknown) => {
    const r = await fetch(base + "/api/gate-slots/cancel", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer person",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  return { call, audited };
}

describe("idle flag: over the route", () => {
  it("cancelling for a release run: refused unflagged; after the grace, recorded with why in the audit", async () => {
    const r = rig();
    const idle = hold(r.store, 801);
    const plain = hold(r.store, 802);
    r.at(26);
    r.store.list();
    r.cpu.set(802, 50);
    r.at(27);
    r.store.list();
    const rel = r.store.ask({
      kind: "release",
      who: "bed",
      label: "tag run",
      pid: 2,
      estimateMin: 30,
      tag: "v1.2.3-dev.1",
      commit: "abc",
    });
    r.at(40);
    const { call, audited } = await serve(r.store);
    expect((await call({ id: plain.id, release: rel.id })).status).toBe(403);
    const ok = await call({ id: idle.id, release: rel.id });
    expect(ok.status).toBe(200);
    expect(audited[0]!.action.detail).toMatch(/idle \d+ min past its estimate/);
  });
});
