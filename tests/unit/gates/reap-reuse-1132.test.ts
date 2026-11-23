/**
 * Issue 1132, review of PR 1286: a recorded process group is signalled only
 * while it is still the one gate run started. Slot files outlive a reboot,
 * and after one (or after a late notice) the recorded number can lead
 * someone else's group: a shell, a service, another agent. So:
 *
 *   - the record is process-group.ts's (the leader's start time, and on
 *     Linux its ticks and boot id), checked before every signal; a group
 *     whose leader is now another process ("reused") is dropped, never
 *     signalled
 *   - a record from before this boot is dropped, never signalled
 *   - one that is still ours gets TERM, then KILL after the grace
 *
 * Fake process groups (GateStoreOpts.groups): nothing real is signalled.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore, type GroupOps } from "../../../src/shared/gates/store.js";
import type {
  GroupState,
  RecordedProcessGroup,
} from "../../../src/shared/process/process-group.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const REC: RecordedProcessGroup = {
  pgid: 7001,
  startedAt: "Sun Nov 22 20:00:00 2026",
};

/** A store whose holder dies on cue, over fake process groups. */
function rig(o: {
  state: GroupState | null;
  bootThen: number;
  bootNow: number;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1132r-"));
  tmps.push(dir);
  const box = { holderAlive: true, boot: o.bootThen, now: Date.now() };
  const signals: [number, string][] = [];
  const groups: GroupOps = {
    record: (pid) => (pid === REC.pgid ? REC : null),
    state: () => o.state,
    signal: (g, s) => signals.push([g, s]),
    boot: () => box.boot,
  };
  const store = new GateStore({
    platform: "linux",
    dir,
    alive: () => box.holderAlive,
    load: () => 0,
    now: () => box.now,
    groups,
  });
  const e = store.ask({
    kind: "cpu",
    who: "lane",
    label: "unit",
    pid: 4242,
    estimateMin: 5,
  });
  expect(store.get(e.id)?.grantedAt).toBeTruthy();
  store.setRunPid(e.id, REC.pgid, { group: REC.pgid, cmd: "/usr/bin/node" });
  // The run is gone (a reboot, or gate run killed hard), then the clock
  // moves on past the grace and the queue is read twice.
  const after = () => {
    box.holderAlive = false;
    box.boot = o.bootNow;
    store.list();
    box.now += 11_000;
    store.list();
  };
  return { store, signals, after };
}

const rows = (s: GateStore) =>
  s.events().filter((r) => r.event === "stopped-leftovers");

describe("a recorded group is signalled only while it is ours", () => {
  it("ours: TERM, then KILL after the grace, each recorded", () => {
    const r = rig({
      state: { state: "ours", members: [7002, 7003] },
      bootThen: 1000,
      bootNow: 1000,
    });
    r.after();
    expect(r.signals).toEqual([
      [7001, "SIGTERM"],
      [7001, "SIGKILL"],
    ]);
    expect(rows(r.store).map((x) => [x.signal, x.count, x.cmd])).toEqual([
      ["TERM", 2, "node"],
      ["KILL", 2, "node"],
    ]);
  });

  it("reused: its leader is now another process: never signalled, and dropped", () => {
    const r = rig({
      state: {
        state: "reused",
        detail: "pid 7001 now belongs to another process",
      },
      bootThen: 1000,
      bootNow: 1000,
    });
    r.after();
    expect(r.signals).toEqual([]);
    expect(rows(r.store)).toEqual([]);
  });

  it("recorded before this boot: never signalled, even if the number reads as ours", () => {
    const r = rig({
      state: { state: "ours", members: [7002] },
      bootThen: 1000,
      bootNow: 1500,
    });
    r.after();
    expect(r.signals).toEqual([]);
    expect(rows(r.store)).toEqual([]);
  });

  it("can't tell (ps fails): nothing is signalled", () => {
    const r = rig({ state: null, bootThen: 1000, bootNow: 1000 });
    r.after();
    expect(r.signals).toEqual([]);
  });

  it("a command whose group can't be read when it starts gets no group", () => {
    const r = rig({
      state: { state: "ours", members: [9] },
      bootThen: 1000,
      bootNow: 1000,
    });
    const e = r.store.ask({ kind: "cpu", who: "x", label: "y", pid: 4343 });
    r.store.setRunPid(e.id, 8888, { group: 8888, cmd: "node" });
    expect(r.store.get(e.id)?.group).toBeUndefined();
  });
});
