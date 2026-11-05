/**
 * pingShell: only a check that completed and failed is ok:false. No answer
 * within the budget is pending (ok null), and `stack health`'s unknown exit
 * is ok null: neither is down.
 */
import { describe, expect, it } from "@jest/globals";
import {
  healthState,
  pingShell,
  pingTwiceOnTimeout,
  shellCheckOpts,
  TimeoutStreaks,
} from "../../../src/shared/environment-manager/health.js";
import { STACK_HEALTH_UNKNOWN_EXIT } from "../../../src/shared/constants.js";

describe("pingShell verdicts", () => {
  it("exit 0 is up; another exit code is a completed failure", async () => {
    expect(await pingShell("exit 0")).toEqual({ ok: true });
    expect(await pingShell("exit 2")).toEqual({ ok: false, error: "exit 2" });
  });

  it("no answer within the budget is pending, not down", async () => {
    const started = Date.now();
    const r = await pingShell("sleep 5", {}, undefined, { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toEqual(expect.objectContaining({ ok: null, pending: true }));
    expect(healthState(r)).toBe("pending");
  });

  it("the unknown exit is unknown only for the check that declares it", async () => {
    const cmd = `exit ${STACK_HEALTH_UNKNOWN_EXIT}`;
    expect(
      await pingShell(cmd, {}, undefined, {
        unknownExit: STACK_HEALTH_UNKNOWN_EXIT,
      }),
    ).toEqual({ ok: null, error: "state unknown" });
    // A distribution's own script exiting 3 is still a failure.
    expect((await pingShell(cmd)).ok).toBe(false);
  });

  it("shellCheckOpts declares the unknown exit for Den's stack health only", () => {
    const stack = '"/d/bin/den" stack health shopdb -w default';
    expect(shellCheckOpts(stack, stack)).toEqual({
      unknownExit: STACK_HEALTH_UNKNOWN_EXIT,
    });
    expect(shellCheckOpts("./health.sh", stack)).toEqual({});
    expect(shellCheckOpts("./health.sh", null)).toEqual({});
  });
});

describe("timeouts: pending once, down when repeated", () => {
  const timeout = { ok: false, error: "timeout" } as const;

  it("TimeoutStreaks: one timed-out cycle is pending, two in a row are down", () => {
    const t = new TimeoutStreaks();
    expect(t.judge("a", timeout)).toEqual({
      ok: null,
      pending: true,
      error: "timeout",
    });
    expect(t.judge("a", timeout)).toEqual({
      ok: false,
      error: "timeout (twice in a row)",
    });
    // An answer resets the streak; checks are counted apart.
    expect(t.judge("a", { ok: true })).toEqual({ ok: true });
    expect(t.judge("a", timeout).ok).toBeNull();
    expect(t.judge("b", timeout).ok).toBeNull();
    // A completed failure is down at once.
    expect(t.judge("c", { ok: false, error: "exit 1" }).ok).toBe(false);
  });

  it("pingTwiceOnTimeout: re-probes once; down only when both time out", async () => {
    const seq = (...rs: { ok: boolean | null; error?: string }[]) => {
      let i = 0;
      return () => Promise.resolve(rs[i++]);
    };
    expect(await pingTwiceOnTimeout(seq(timeout, { ok: true }))).toEqual({
      ok: true,
    });
    expect(await pingTwiceOnTimeout(seq(timeout, timeout))).toEqual({
      ok: false,
      error: "timeout (twice in a row)",
    });
    expect(
      await pingTwiceOnTimeout(seq({ ok: false, error: "exit 1" })),
    ).toEqual({ ok: false, error: "exit 1" });
  });
});
