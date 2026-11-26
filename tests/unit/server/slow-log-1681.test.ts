import { describe, expect, it } from "@jest/globals";
import {
  callerKind,
  lagWatch,
  lagLine,
  rateLimit,
  slowRequestLine,
} from "../../../src/ui/server/slow-log.js";
import { routePattern } from "../../../src/ui/server/route-classes.js";
import {
  SERVER_LOG_LIMITS,
  serverLogSetting,
} from "../../../src/shared/server-log-file.js";
import { patchCliRows } from "../../../src/shared/settings-cli-rows.js";

describe("issue 1681: what a slow-request line names", () => {
  it("the route's pattern from the route table, never the raw path", () => {
    expect(routePattern("GET", "/api/personas/sk-live-123")).toBe(
      "/api/personas/:id",
    );
    expect(routePattern("DELETE", "/api/personas/x")).toBe("/api/personas/:id");
    expect(routePattern("GET", "/api/nothing/sk-live-123/more")).toBe(
      "/api/nothing/…",
    );
    expect(routePattern("GET", "/api/nothing")).toBe("/api/nothing");
    expect(routePattern("GET", "/")).toBe("/");
  });

  it("the caller's kind: person, agent, cli, runner or unsigned", () => {
    expect(callerKind({ kind: "person-browser" })).toBe("person");
    expect(callerKind({ kind: "agent" })).toBe("agent");
    expect(callerKind({ kind: "person" })).toBe("cli");
    expect(callerKind({ kind: "gate-runner" })).toBe("runner");
    expect(callerKind(null)).toBe("unsigned");
    expect(callerKind(undefined)).toBe("unsigned");
  });

  it("one line: method, pattern, ms and caller, and nothing else", () => {
    expect(
      slowRequestLine({
        method: "get",
        pattern: "/api/personas/:id",
        ms: 4123.6,
        caller: "agent",
        more: 0,
      }),
    ).toBe("  ⚠ slow request: GET /api/personas/:id took 4124 ms (agent)");
    expect(
      slowRequestLine({
        method: "POST",
        pattern: "/api/x",
        ms: 5000,
        caller: "cli",
        more: 3,
      }),
    ).toBe(
      "  ⚠ slow request: POST /api/x took 5000 ms (cli); 3 more like it not logged",
    );
    expect(lagLine(6012.2, 0)).toBe(
      "  ⚠ event loop blocked for 6012 ms: no request or timer ran",
    );
    expect(lagLine(1500, 2)).toBe(
      "  ⚠ event loop blocked for 1500 ms: no request or timer ran; 2 more like it not logged",
    );
  });
});

describe("issue 1681: a stalled server never floods its own log", () => {
  it("one line per key per window; the next says how many were held back", () => {
    let t = 0;
    const lim = rateLimit({ windowMs: 10_000, now: () => t });
    expect(lim("GET /a")).toBe(0);
    expect(lim("GET /a")).toBeNull();
    expect(lim("GET /a")).toBeNull();
    expect(lim("GET /b")).toBe(0);
    t = 9_999;
    expect(lim("GET /a")).toBeNull();
    t = 10_000;
    expect(lim("GET /a")).toBe(3);
    expect(lim("GET /a")).toBeNull();
  });

  it("keeps a bounded number of keys", () => {
    let t = 0;
    const lim = rateLimit({ windowMs: 10_000, now: () => t, maxKeys: 3 });
    for (const k of ["a", "b", "c", "d"]) expect(lim(k)).toBe(0);
    expect(lim("a")).toBe(0);
  });
});

describe("issue 1681: a blocked main thread is measured by a timer's drift", () => {
  function clock() {
    let t = 0;
    let tick: (() => void) | null = null;
    let cleared = false;
    const watch = (everyMs: number, onLag: (ms: number) => void) =>
      lagWatch({
        everyMs,
        now: () => t,
        setInterval: (f) => {
          tick = f;
          return { unref() {} };
        },
        clearInterval: () => {
          cleared = true;
        },
        onLag,
      });
    return {
      watch,
      fire: (at: number) => {
        t = at;
        tick!();
      },
      cleared: () => cleared,
    };
  }

  it("a tick on time reports nothing; a late one reports how late", () => {
    const c = clock();
    const seen: number[] = [];
    const w = c.watch(500, (ms) => seen.push(ms));
    c.fire(500);
    c.fire(1000);
    expect(seen).toEqual([]);
    c.fire(7500);
    expect(seen).toEqual([6000]);
    c.fire(8000);
    expect(seen).toEqual([6000]);
    w.stop();
    expect(c.cleared()).toBe(true);
  });
});

describe("issue 1681: the two thresholds are Settings with permissive defaults", () => {
  it("defaults, an override, and out of range or not a number: the default", () => {
    expect(SERVER_LOG_LIMITS.slow_request_ms).toEqual({
      def: 3000,
      min: 100,
      max: 600_000,
    });
    expect(SERVER_LOG_LIMITS.event_loop_lag_ms).toEqual({
      def: 1000,
      min: 50,
      max: 600_000,
    });
    expect(serverLogSetting({}, "slow_request_ms")).toBe(3000);
    expect(serverLogSetting({}, "event_loop_lag_ms")).toBe(1000);
    const user = {
      server_log: { slow_request_ms: 250, event_loop_lag_ms: 400 },
    };
    expect(serverLogSetting(user, "slow_request_ms")).toBe(250);
    expect(serverLogSetting(user, "event_loop_lag_ms")).toBe(400);
    expect(
      serverLogSetting(
        { server_log: { slow_request_ms: 5 } },
        "slow_request_ms",
      ),
    ).toBe(3000);
    expect(
      serverLogSetting(
        { server_log: { event_loop_lag_ms: "slow" } },
        "event_loop_lag_ms",
      ),
    ).toBe(1000);
    expect(serverLogSetting(null, "slow_request_ms")).toBe(3000);
  });

  it("Settings and config write them, checked, and a bad value is refused by its key", () => {
    const user: Record<string, unknown> = {};
    expect(
      patchCliRows(user, {
        server_log: { slow_request_ms: 2000, event_loop_lag_ms: 500 },
      }),
    ).toEqual({ ok: true });
    expect(user.server_log).toEqual({
      slow_request_ms: 2000,
      event_loop_lag_ms: 500,
    });
    const bad = patchCliRows(user, { server_log: { slow_request_ms: 10 } });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(
      /server_log\.slow_request_ms/,
    );
    const worse = patchCliRows(user, {
      server_log: { event_loop_lag_ms: "x" },
    });
    expect(worse.ok).toBe(false);
    expect((worse as { error: string }).error).toMatch(
      /server_log\.event_loop_lag_ms/,
    );
    expect(user.server_log).toEqual({
      slow_request_ms: 2000,
      event_loop_lag_ms: 500,
    });
  });
});
