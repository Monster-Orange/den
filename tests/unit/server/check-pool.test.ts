/**
 * How health checks run (0.4.17, check-pool.ts): at most a cap at once, in
 * the items' order, and a check that runs over its time gets the stand-in
 * result ("timed out after 10 s") without holding up the rest.
 */
import { describe, expect, it } from "@jest/globals";
import {
  CHECK_CONCURRENCY,
  CHECK_TIMEOUT_MS,
  runCapped,
  timedOutText,
  withTimeout,
} from "../../../src/ui/server/check-pool.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the health check pool", () => {
  it("runs at most the cap at once, and keeps the items' order", async () => {
    let now = 0;
    let most = 0;
    const out = await runCapped([5, 1, 4, 2, 3, 0, 6], 3, async (ms, i) => {
      most = Math.max(most, ++now);
      await wait(ms * 5);
      now--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(most).toBe(3);
    expect(await runCapped([], 4, async () => 1)).toEqual([]);
  });

  it("a check over its time gets the stand-in, at once; it settling later changes nothing", async () => {
    const started = Date.now();
    const r = await withTimeout(
      wait(500).then(() => "late"),
      30,
      () => "cut",
    );
    expect(r).toBe("cut");
    expect(Date.now() - started).toBeLessThan(400);
    // In time: its own result; a rejection in time is the caller's.
    expect(await withTimeout(Promise.resolve("ok"), 30, () => "cut")).toBe(
      "ok",
    );
    await expect(
      withTimeout(Promise.reject(new Error("no")), 30, () => "cut"),
    ).rejects.toThrow("no");
    // A rejection after the stand-in is ignored, never unhandled.
    expect(
      await withTimeout(
        wait(60).then(() => {
          throw new Error("too late");
        }),
        10,
        () => "cut",
      ),
    ).toBe("cut");
    await wait(80);
  });

  it("the defaults: 12 at once, 10 s each, said as people read it", () => {
    expect([CHECK_CONCURRENCY, CHECK_TIMEOUT_MS]).toEqual([12, 10_000]);
    expect(timedOutText(CHECK_TIMEOUT_MS)).toBe("timed out after 10 s");
  });
});
