/**
 * Issue 1129: every batch of agent restarts (a resume after Den or the
 * machine restarts, Hub's new tools, a settings change) goes through one
 * queue: `agents.resume` agents at a time with a gap between batches, the
 * next batch waiting while the 1-minute load is over the ceiling, agents
 * that were working first, and an agent a person opens ahead of the rest.
 * Time and load are fakes: each gap is a sleep the test lets go.
 */
import { describe, expect, it } from "@jest/globals";
import { RestartQueue } from "../../../src/shared/agents/restart-queue.js";

function world(o: { batch?: number; gapMs?: number; ceiling?: number } = {}) {
  const started: string[] = [];
  const sleeps: Array<{ ms: number; go: () => void }> = [];
  let load = 0;
  let clock = 1_000_000;
  const q = new RestartQueue({
    now: () => clock,
    config: () => ({
      batch: o.batch ?? 4,
      gapMs: o.gapMs ?? 30_000,
      loadCeiling: o.ceiling ?? 16,
    }),
    load: () => load,
    sleep: (ms) => new Promise<void>((go) => sleeps.push({ ms, go })),
  });
  const job = (id: string, working = false) =>
    q.add({
      id,
      why: "resume",
      working,
      run: async () => {
        started.push(id);
        return id;
      },
    });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  /** Let the oldest pending sleep end. */
  const pass = async () => {
    await flush();
    sleeps.shift()?.go();
    await flush();
  };
  return {
    q,
    job,
    started,
    sleeps,
    flush,
    pass,
    setLoad: (v: number) => (load = v),
    tick: (ms: number) => (clock += ms),
  };
}

const ids = (n: number, p = "a") =>
  Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

describe("issue 1129: restarts go in batches", () => {
  it("12 agents, 4 at a time: no more than 4 start before the gap passes", async () => {
    const w = world();
    const all = ids(12).map((id) => w.job(id));
    await w.flush();
    expect(w.started).toHaveLength(4);
    expect(w.sleeps.map((s) => s.ms)).toEqual([30_000]);
    await w.pass();
    expect(w.started).toHaveLength(8);
    await w.pass();
    expect(w.started).toHaveLength(12);
    await expect(Promise.all(all)).resolves.toEqual(ids(12));
    expect(w.q.waiting()).toEqual([]);
  });

  it("agents that were working go first, then the idle ones, each in the order they came", async () => {
    const w = world({ batch: 2 });
    w.job("idle1");
    w.job("idle2");
    w.job("work1", true);
    w.job("idle3");
    w.job("work2", true);
    await w.flush();
    expect(w.started).toEqual(["work1", "work2"]);
    await w.pass();
    expect(w.started).toEqual(["work1", "work2", "idle1", "idle2"]);
    await w.pass();
    expect(w.started).toEqual(["work1", "work2", "idle1", "idle2", "idle3"]);
  });

  it("a batch waits while the load is over the ceiling, and goes when it drops", async () => {
    const w = world({ batch: 2, ceiling: 8 });
    ids(4).forEach((id) => w.job(id));
    await w.flush();
    expect(w.started).toHaveLength(2);
    w.setLoad(12);
    await w.pass(); // the gap
    expect(w.started).toHaveLength(2);
    expect(w.q.waiting()).toHaveLength(2);
    await w.pass(); // still over: it waits again
    expect(w.started).toHaveLength(2);
    w.setLoad(3);
    await w.pass();
    expect(w.started).toHaveLength(4);
  });

  it("an agent a person opens starts at once, ahead of the queue", async () => {
    const w = world({ batch: 2 });
    ids(6).forEach((id) => w.job(id));
    await w.flush();
    expect(w.started).toEqual(["a1", "a2"]);
    const opened = w.q.openNow("a6");
    expect(opened).not.toBeNull();
    await expect(opened).resolves.toBe("a6");
    expect(w.started).toEqual(["a1", "a2", "a6"]);
    expect(w.q.waiting().map((x) => x.id)).toEqual(["a3", "a4", "a5"]);
    // Not in the queue: nothing to do.
    expect(w.q.openNow("nobody")).toBeNull();
  });

  it("restarts that come one at a time still keep the gap (Hub's tools add them so)", async () => {
    const w = world({ batch: 2 });
    w.job("a1");
    w.job("a2");
    await w.flush();
    expect(w.started).toEqual(["a1", "a2"]);
    w.tick(5_000);
    w.job("a3");
    await w.flush();
    expect(w.started).toEqual(["a1", "a2"]);
    expect(w.sleeps.map((s) => s.ms)).toEqual([25_000]);
    await w.pass();
    expect(w.started).toEqual(["a1", "a2", "a3"]);
    // Long after the last batch: it starts at once.
    w.tick(60_000);
    w.job("a4");
    await w.flush();
    expect(w.started).toEqual(["a1", "a2", "a3", "a4"]);
  });

  it("0 keeps today's behaviour: every agent starts at once, no gap", async () => {
    const w = world({ batch: 0 });
    ids(12).forEach((id) => w.job(id));
    await w.flush();
    expect(w.started).toHaveLength(12);
    expect(w.sleeps).toEqual([]);
  });

  it("one queue: an agent already waiting is not added twice, whatever the cause", async () => {
    const w = world({ batch: 1 });
    w.job("a1");
    const first = w.job("a2");
    const again = w.q.add({
      id: "a2",
      why: "hub-tools",
      run: async () => {
        w.started.push("a2-twice");
      },
    });
    await w.flush();
    await w.pass();
    await w.pass();
    expect(w.started).toEqual(["a1", "a2"]);
    await expect(again).resolves.toBe(await first);
  });

  it("a restart that fails says so to its caller, and the queue goes on", async () => {
    const w = world({ batch: 1 });
    const bad = w.q.add({
      id: "bad",
      why: "resume",
      run: async () => {
        throw new Error("exited at once");
      },
    });
    const good = w.job("good");
    await expect(bad).rejects.toThrow("exited at once");
    await w.pass();
    await expect(good).resolves.toBe("good");
  });
});
