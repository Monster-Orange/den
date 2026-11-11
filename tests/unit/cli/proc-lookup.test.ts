/**
 * proc-lookup: a lookup that times out is retried with a longer limit, and
 * one that never answers is "couldn't tell" (LookupTimeoutError), never
 * "found nothing" (0.4.29-dev.1's gate: `web down` read a timed-out lookup
 * as no server). No real lsof or ps runs.
 */
import { describe, expect, it } from "@jest/globals";
import {
  LOOKUP_TIMEOUTS_MS,
  LookupTimeoutError,
  lookup,
  lookupTimeouts,
} from "../../../src/ui/cli/proc-lookup.js";

type R = {
  status: number | null;
  stdout: string;
  error?: Error;
  signal: NodeJS.Signals | null;
};
const timeout = (): R => ({
  status: null,
  stdout: "",
  error: Object.assign(new Error("spawnSync lsof ETIMEDOUT"), {
    code: "ETIMEDOUT",
  }),
  signal: "SIGTERM",
});
const killed = (): R => ({ status: null, stdout: "", signal: "SIGTERM" });
const ok = (stdout: string): R => ({ status: 0, stdout, signal: null });
const none = (): R => ({ status: 1, stdout: "", signal: null });

function fake(...answers: R[]) {
  const seen: number[] = [];
  const spawn = (_c: string, _a: string[], o: { timeout: number }) => {
    seen.push(o.timeout);
    return answers.shift() ?? none();
  };
  return { spawn, seen };
}

describe("lookup (proc-lookup.ts)", () => {
  it("answers at once: its stdout, one try", () => {
    const f = fake(ok("123\n"));
    expect(lookup("lsof", [], f.spawn)).toBe("123\n");
    expect(f.seen).toEqual([LOOKUP_TIMEOUTS_MS[0]]);
  });

  it("found nothing (a non-zero exit): empty, no retry", () => {
    const f = fake(none());
    expect(lookup("lsof", [], f.spawn)).toBe("");
    expect(f.seen).toHaveLength(1);
  });

  it("timed out once: tried again with the longer limit, and its answer counts", () => {
    const f = fake(timeout(), ok("456\n"));
    expect(lookup("lsof", [], f.spawn)).toBe("456\n");
    expect(f.seen).toEqual([...LOOKUP_TIMEOUTS_MS]);
    expect(LOOKUP_TIMEOUTS_MS[1]).toBeGreaterThan(LOOKUP_TIMEOUTS_MS[0]);
  });

  it("killed by its timeout without an error object: the same", () => {
    const f = fake(killed(), ok("7\n"));
    expect(lookup("ps", [], f.spawn)).toBe("7\n");
  });

  it("timed out every time: couldn't tell, never empty", () => {
    const f = fake(timeout(), timeout());
    expect(() => lookup("lsof", [], f.spawn)).toThrow(LookupTimeoutError);
    expect(() => lookup("ps", [], fake(timeout(), timeout()).spawn)).toThrow(
      "ps took too long to answer",
    );
  });

  it("DEN_LOOKUP_TIMEOUTS_MS sets the tries' limits; a bad value keeps the defaults", () => {
    expect(lookupTimeouts({})).toEqual(LOOKUP_TIMEOUTS_MS);
    expect(lookupTimeouts({ DEN_LOOKUP_TIMEOUTS_MS: "200, 300" })).toEqual([
      200, 300,
    ]);
    expect(lookupTimeouts({ DEN_LOOKUP_TIMEOUTS_MS: "1000" })).toEqual([1000]);
    for (const bad of ["", "x", "0", "-5", "100,", "1.5"])
      expect(lookupTimeouts({ DEN_LOOKUP_TIMEOUTS_MS: bad })).toEqual(
        LOOKUP_TIMEOUTS_MS,
      );
  });
});
