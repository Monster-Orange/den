/**
 * 0.4.46: a pane reconnects on its own (public/pane-reconnect.js), the
 * rules without a browser: backoff, the failure cap within its window, a
 * success clearing the count, refusals, and a hidden page's closes (a
 * tablet dropping a background tab's socket) kept apart from the cap.
 */
import { describe, expect, it } from "@jest/globals";
import {
  paneReconnect,
  reconnectOptions,
} from "../../../src/ui/server/public/pane-reconnect.js";

/** A fake clock and timers: `run()` fires the next timer, `t` is now. */
function rig(opts: Record<string, unknown> = {}) {
  const c = { t: 0, timers: [] as { at: number; f: () => void; id: number }[] };
  let id = 0;
  const painted: { kind: string; tries: number; why: string }[] = [];
  let tries = 0;
  let hidden = false;
  const r = paneReconnect({
    connect: () => {
      tries++;
    },
    paint: (s: { kind: string; tries: number; why: string }) => painted.push(s),
    hidden: () => hidden,
    now: () => c.t,
    setTimer: (f: () => void, ms: number) => {
      c.timers.push({ at: c.t + ms, f, id: ++id });
      return id;
    },
    clearTimer: (h: number) => {
      c.timers = c.timers.filter((x) => x.id !== h);
    },
    baseMs: 1000,
    maxMs: 30_000,
    maxFailures: 10,
    windowMs: 300_000,
    quietMs: 1000,
    ...opts,
  });
  /** Fires the next timer that would run; returns its delay. */
  const run = () => {
    c.timers.sort((a, b) => a.at - b.at);
    const x = c.timers.shift();
    if (!x) return -1;
    const waited = x.at - c.t;
    c.t = x.at;
    x.f();
    return waited;
  };
  /** Runs timers until a connect happens; returns how long it waited. */
  const untilTry = () => {
    const before = tries;
    let waited = 0;
    while (tries === before) {
      const w = run();
      if (w < 0) return -1;
      waited += w;
    }
    return waited;
  };
  return {
    r,
    c,
    painted,
    untilTry,
    tries: () => tries,
    setHidden: (h: boolean) => (hidden = h),
  };
}

describe("0.4.46: a pane reconnects on its own", () => {
  it("a close after it opened tries again in 1 s; failures double the wait up to 30 s", () => {
    const x = rig();
    x.r.closed({ opened: true, why: "1006" });
    expect(x.r.state.kind).toBe("retrying");
    expect(x.untilTry()).toBe(1000);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      x.r.closed({ opened: false, why: "1006" });
      waits.push(x.untilTry());
    }
    expect(waits).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("10 failures within 5 minutes trip it; it says how many, and why", () => {
    const x = rig();
    x.r.closed({ opened: true, why: "1006" });
    x.untilTry();
    for (let i = 0; i < 9; i++) {
      x.r.closed({ opened: false, why: "server down" });
      expect(x.untilTry()).toBeGreaterThan(0);
    }
    x.r.closed({ opened: false, why: "server down" });
    expect(x.r.state.kind).toBe("tripped");
    expect(x.painted.at(-1)).toEqual({
      kind: "tripped",
      tries: 10,
      why: "server down",
    });
    // Tripped: no more tries on its own.
    expect(x.untilTry()).toBe(-1);
  });

  it("failures spread past the window never trip it", () => {
    const x = rig({ maxMs: 60_000 });
    x.r.closed({ opened: true });
    x.untilTry();
    for (let i = 0; i < 30; i++) {
      x.r.closed({ opened: false });
      expect(x.untilTry()).toBeGreaterThan(0);
      // A server that is down a long while: each try about a minute apart.
      expect(x.r.state.kind).not.toBe("tripped");
    }
    expect(x.r.state.tries).toBeLessThan(10);
  });

  it("a server that comes back clears the count", () => {
    const x = rig();
    x.r.closed({ opened: true });
    x.untilTry();
    for (let i = 0; i < 8; i++) {
      x.r.closed({ opened: false });
      x.untilTry();
    }
    expect(x.r.state.tries).toBe(8);
    x.r.opened();
    expect(x.r.state).toMatchObject({ kind: "live", tries: 0, streak: 0 });
    // The next drop starts again at 1 s.
    x.r.closed({ opened: true });
    expect(x.untilTry()).toBe(1000);
  });

  it("a refusal (sign in, refused, ended) stops at once with the button", () => {
    const x = rig();
    x.r.closed({ opened: false, refused: true, why: "Sign in" });
    expect(x.r.state.kind).toBe("refused");
    expect(x.untilTry()).toBe(-1);
    x.r.nudge();
    expect(x.tries()).toBe(0);
    // The person's Reconnect still tries.
    x.r.retry();
    expect(x.tries()).toBe(1);
  });

  it("hidden: a close is quiet and never counts; shown again, one try at once, no flash when it lands", () => {
    const x = rig({ maxFailures: 3 });
    x.setHidden(true);
    for (let i = 0; i < 20; i++) x.r.closed({ opened: i === 0 });
    expect(x.r.state).toMatchObject({ kind: "quiet", tries: 0 });
    expect(x.r.state.hiddenCloses).toBe(20);
    expect(x.painted).toEqual([]);
    expect(x.untilTry()).toBe(-1);
    x.setHidden(false);
    x.r.nudge();
    expect(x.tries()).toBe(1);
    // It opens before the quiet second is out: "Reconnecting…" never shows.
    x.c.t += 300;
    x.r.opened();
    expect(x.painted.map((p) => p.kind)).toEqual(["live"]);
  });

  it("a slow try shows Reconnecting… after a second", () => {
    const x = rig();
    x.setHidden(true);
    x.r.closed({ opened: true });
    x.setHidden(false);
    x.r.nudge();
    expect(x.painted).toEqual([]);
    x.c.t += 1000;
    x.c.timers
      .sort((a, b) => a.at - b.at)
      .shift()!
      .f();
    expect(x.painted.at(-1)?.kind).toBe("retrying");
  });

  it("visible, back online or back from the cache try once at once, even after the cap", () => {
    const x = rig({ maxFailures: 2 });
    x.r.closed({ opened: true });
    x.untilTry();
    x.r.closed({ opened: false });
    x.untilTry();
    x.r.closed({ opened: false });
    expect(x.r.state.kind).toBe("tripped");
    const n = x.tries();
    x.r.nudge();
    expect(x.tries()).toBe(n + 1);
  });

  it("the settings: defaults 1, 30, 10, 300 and a 10 s connect; bad values fall back", () => {
    expect(reconnectOptions(undefined)).toEqual({
      baseMs: 1000,
      maxMs: 30_000,
      maxFailures: 10,
      windowMs: 300_000,
      connectMs: 10_000,
    });
    expect(
      reconnectOptions({
        seconds: 2,
        max_seconds: 60,
        max_failures: 4,
        window_seconds: 120,
        connect_timeout_seconds: 3,
      }),
    ).toEqual({
      baseMs: 2000,
      maxMs: 60_000,
      maxFailures: 4,
      windowMs: 120_000,
      connectMs: 3000,
    });
    expect(reconnectOptions({ seconds: -1, max_failures: "x" })).toMatchObject({
      baseMs: 1000,
      maxFailures: 10,
    });
  });
});
