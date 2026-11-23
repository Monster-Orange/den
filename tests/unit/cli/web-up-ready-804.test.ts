/**
 * Issue 804: `web up` said "did not become ready" for a server that was
 * starting fine. The pid it started (a launcher or wrapper) exited before
 * the server answered, and one probe at that moment was taken as the
 * answer. Now:
 *  1. A started pid that exits is never read as the server refusing: the
 *     wait goes on until web.start_wait_seconds, unless the server's log
 *     says it refused (startupRefusal).
 *  2. A launcher that exits at once, with the server answering 3 s later:
 *     ready.
 *  3. A server that refuses (its ✗ line) still fails fast, with its reason.
 *  4. When the wait does run out, one more probe; if Den answers then,
 *     it is ready, and says it answered after all.
 * Time is a fake clock: nothing here sleeps.
 */
import { describe, expect, it } from "@jest/globals";
import { waitForReady } from "../../../src/ui/cli/web-command.js";

/** A fake clock, a server that answers from `answersAt`, a pid alive until `exitsAt`. */
function rig(o: {
  answersAt: number;
  exitsAt: number;
  refusal?: { at: number; text: string };
  startMs?: number;
}) {
  let now = 0;
  const probes: number[] = [];
  return {
    probes,
    deps: {
      startMs: o.startMs ?? 120_000,
      pollMs: 250,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      probe: async () => {
        probes.push(now);
        now += 50;
        return now >= o.answersAt;
      },
      alive: () => now < o.exitsAt,
      refusal: () => (o.refusal && now >= o.refusal.at ? o.refusal.text : null),
    },
    at: () => now,
  };
}

describe("issue 804: web up's wait for the server", () => {
  it("a launcher that exits at once, the server answering 3 s later: ready", async () => {
    const r = rig({ answersAt: 3_000, exitsAt: 0 });
    expect(await waitForReady(r.deps)).toEqual({ ready: true });
    expect(r.at()).toBeGreaterThanOrEqual(3_000);
    expect(r.at()).toBeLessThan(5_000);
  });

  it("the started pid exiting is never taken as a refusal: it keeps probing", async () => {
    const r = rig({ answersAt: 60_000, exitsAt: 500 });
    expect(await waitForReady(r.deps)).toEqual({ ready: true });
    expect(r.probes.length).toBeGreaterThan(10);
  });

  it("a server that refuses fails fast, with its reason", async () => {
    const r = rig({
      answersAt: Infinity,
      exitsAt: 400,
      refusal: { at: 300, text: "Refusing to listen on 0.0.0.0" },
    });
    expect(await waitForReady(r.deps)).toEqual({
      ready: false,
      refusal: "Refusing to listen on 0.0.0.0",
    });
    expect(r.at()).toBeLessThan(2_000);
  });

  it("a refusal line while the pid still runs is not read early (the pid may be a launcher)", async () => {
    // Only a pid that has exited with a refusal in its log fails fast.
    const r = rig({
      answersAt: 5_000,
      exitsAt: Infinity,
      refusal: { at: 0, text: "an older line" },
    });
    expect(await waitForReady(r.deps)).toEqual({ ready: true });
  });

  it("the wait runs out, and one more probe finds Den: ready, after all", async () => {
    const r = rig({ answersAt: 10_050, exitsAt: 0, startMs: 10_000 });
    expect(await waitForReady(r.deps)).toEqual({
      ready: true,
      afterAll: true,
    });
  });

  it("the wait runs out and Den never answers: not ready, no refusal", async () => {
    const r = rig({ answersAt: Infinity, exitsAt: 0, startMs: 10_000 });
    expect(await waitForReady(r.deps)).toEqual({ ready: false });
  });
});
