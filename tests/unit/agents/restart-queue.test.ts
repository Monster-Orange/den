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

function world(
  o: {
    batch?: number;
    gapMs?: number;
    ceiling?: number;
    maxWaitMs?: number;
  } = {},
) {
  const logs: string[] = [];
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
      maxWaitMs: o.maxWaitMs ?? 600_000,
    }),
    load: () => load,
    log: (l) => logs.push(l),
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
    logs,
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

  it("most wait: with the load pinned over the ceiling, a batch still starts once the oldest has waited max_wait, and says why", async () => {
    const w = world({ batch: 2, ceiling: 8, gapMs: 30_000, maxWaitMs: 90_000 });
    w.setLoad(50);
    ids(4).forEach((id) => w.job(id));
    await w.flush();
    expect(w.started).toHaveLength(0);
    w.tick(30_000);
    await w.pass();
    w.tick(30_000);
    await w.pass();
    expect(w.started).toHaveLength(0);
    w.tick(30_000); // the oldest has now waited 90 s
    await w.pass();
    expect(w.started).toEqual(["a1", "a2"]);
    expect(w.logs.join("\n")).toMatch(/waited .*most wait/);
  });

  it("most wait 0: the load holds them as long as it stays over", async () => {
    const w = world({ batch: 2, ceiling: 8, gapMs: 30_000, maxWaitMs: 0 });
    w.setLoad(50);
    ids(2).forEach((id) => w.job(id));
    for (let i = 0; i < 10; i++) {
      w.tick(30_000);
      await w.pass();
    }
    expect(w.started).toHaveLength(0);
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

  it("the person's own Resume replaces the queued run: it starts once, and the queue's caller gets its result", async () => {
    const w = world({ batch: 1 });
    w.job("a1");
    const queued = w.job("a2");
    await w.flush();
    const mine = w.q.openNow("a2", async () => {
      w.started.push("a2-by-person");
      return "by person";
    });
    await expect(mine).resolves.toBe("by person");
    await expect(queued).resolves.toBe("by person");
    await w.pass();
    expect(w.started).toEqual(["a1", "a2-by-person"]);
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

describe("issue 1129: agents.resume in user.yml", () => {
  const cfg = (agents: Record<string, unknown> | undefined) => () =>
    ({ agents }) as never;

  it("defaults: 4 at a time, 30 s apart, a ceiling of the cores × 2", async () => {
    const { agentsResume } = await import("../../../src/shared/den-config.js");
    expect(agentsResume(cfg(undefined), 8)).toEqual({
      batch: 4,
      gapSeconds: 30,
      loadCeiling: 16,
      maxWaitSeconds: 600,
    });
  });

  it("takes what is set; 0 means all at once (batch) or no ceiling", async () => {
    const { agentsResume } = await import("../../../src/shared/den-config.js");
    expect(
      agentsResume(
        cfg({
          resume: {
            batch: 0,
            gap_seconds: 5,
            load_ceiling: 0,
            max_wait_seconds: 0,
          },
        }),
        8,
      ),
    ).toEqual({ batch: 0, gapSeconds: 5, loadCeiling: 0, maxWaitSeconds: 0 });
  });

  it.each([
    [{ batch: -1 }, /agents\.resume\.batch/],
    [{ batch: 1.5 }, /agents\.resume\.batch/],
    [{ gap_seconds: "30" }, /agents\.resume\.gap_seconds/],
    [{ load_ceiling: -2 }, /agents\.resume\.load_ceiling/],
    [{ max_wait_seconds: -1 }, /agents\.resume\.max_wait_seconds/],
  ])("refuses %j, naming the key", async (resume, re) => {
    const { agentsResume } = await import("../../../src/shared/den-config.js");
    expect(() => agentsResume(cfg({ resume }), 8)).toThrow(re);
  });
});
