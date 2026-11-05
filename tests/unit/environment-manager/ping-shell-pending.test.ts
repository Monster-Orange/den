/**
 * pingShell: only a check that completed and failed is ok:false. No answer
 * within the budget is pending (ok null), not down.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  healthState,
  pingShell,
  pingTwiceOnTimeout,
  SHELL_CHECK_CONCURRENCY,
  TimeoutStreaks,
} from "../../../src/shared/environment-manager/health.js";

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

describe("shell checks run with bounded concurrency", () => {
  it("never more than max(2, cpus/2) at once, and each gets its full budget", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-shell-slots-"));
    try {
      const k = SHELL_CHECK_CONCURRENCY;
      expect(k).toBe(Math.max(2, Math.floor(os.cpus().length / 2)));
      // Each check records how many checks are running as it starts.
      const cmd = `touch ${dir}/run.$$; ls ${dir} | grep -c '^run' >> ${dir}/seen; sleep 0.3; rm ${dir}/run.$$`;
      // A 1s budget: queued checks must not spend it while they wait.
      const results = await Promise.all(
        Array.from({ length: k * 3 }, () =>
          pingShell(cmd, {}, undefined, { timeoutMs: 1_000 }),
        ),
      );
      expect(results.every((r) => r.ok === true)).toBe(true);
      const seen = fs
        .readFileSync(path.join(dir, "seen"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map(Number);
      expect(seen).toHaveLength(k * 3);
      expect(Math.max(...seen)).toBeLessThanOrEqual(k);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
