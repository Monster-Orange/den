/**
 * lookup: a lookup that times out is retried with a longer limit, and
 * one that never answers is "couldn't tell" (LookupTimeoutError), never
 * "found nothing" (0.4.29-dev.1's gate: `web down` read a timed-out lookup
 * as no server). No real lsof or ps runs.
 */
import { describe, expect, it } from "@jest/globals";
import {
  LOOKUP_TIMEOUTS_MS,
  LookupError,
  LookupTimeoutError,
  lookup,
  lookupAsync,
  lookupTimeouts,
  type SpawnAsync,
} from "../../../src/shared/process/lookup.js";

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
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const spawn = (
    _c: string,
    _a: string[],
    o: { timeout: number; env?: NodeJS.ProcessEnv },
  ) => {
    seen.push(o.timeout);
    envs.push(o.env);
    return answers.shift() ?? none();
  };
  return { spawn, seen, envs };
}
const missing = (): R => ({
  status: null,
  stdout: "",
  error: Object.assign(new Error("spawnSync lsof ENOENT"), { code: "ENOENT" }),
  signal: null,
});

describe("lookup (shared/process/lookup.ts)", () => {
  it("answers at once: its stdout, one try", () => {
    const f = fake(ok("123\n"));
    expect(lookup("lsof", [], f.spawn)).toBe("123\n");
    expect(f.seen).toEqual([LOOKUP_TIMEOUTS_MS[0]]);
  });

  it("runs in the C locale (ps's dates, lsof's messages)", () => {
    const f = fake(ok("1\n"));
    lookup("ps", [], f.spawn);
    expect(f.envs[0]?.LC_ALL).toBe("C");
    expect(f.envs[0]?.LANG).toBe("C");
  });

  it("a non-zero exit keeps what it printed (lsof's partial answer)", () => {
    expect(
      lookup(
        "lsof",
        [],
        fake({ status: 1, stdout: "9\n", signal: null }).spawn,
      ),
    ).toBe("9\n");
  });

  it("a tool that can't run: empty, or LookupError when strict (D38)", () => {
    expect(lookup("ps", [], fake(missing()).spawn)).toBe("");
    expect(() =>
      lookup("ps", [], fake(missing()).spawn, { strict: true }),
    ).toThrow(LookupError);
    expect(() =>
      lookup("ps", [], fake(missing()).spawn, { strict: true }),
    ).toThrow("ps couldn't run (ENOENT)");
    expect(new LookupTimeoutError("ps")).toBeInstanceOf(LookupError);
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

describe("lookupAsync", () => {
  type A = { err: Record<string, unknown> | null; out: string };
  function fakeAsync(...answers: A[]) {
    const seen: number[] = [];
    const spawn: SpawnAsync = (_c, _a, o, cb) => {
      seen.push(o.timeout);
      const a = answers.shift() ?? { err: null, out: "" };
      setImmediate(() => cb(a.err as never, a.out));
    };
    return { spawn, seen };
  }
  const killedA = (): A => ({
    err: { killed: true, signal: "SIGTERM", code: null },
    out: "",
  });

  it("answers, retries a timed-out try, and throws when every try timed out", async () => {
    expect(
      await lookupAsync("ps", [], fakeAsync({ err: null, out: "1\n" }).spawn),
    ).toBe("1\n");
    const f = fakeAsync(killedA(), { err: null, out: "2\n" });
    expect(await lookupAsync("ps", [], f.spawn)).toBe("2\n");
    expect(f.seen).toEqual([...LOOKUP_TIMEOUTS_MS]);
    await expect(
      lookupAsync("ps", [], fakeAsync(killedA(), killedA()).spawn),
    ).rejects.toThrow(LookupTimeoutError);
  });

  it("a non-zero exit is its output; a tool that can't run is empty, or LookupError when strict", async () => {
    expect(
      await lookupAsync(
        "ps",
        [],
        fakeAsync({ err: { code: 1 }, out: "3\n" }).spawn,
      ),
    ).toBe("3\n");
    const enoent = (): A => ({ err: { code: "ENOENT" }, out: "" });
    expect(await lookupAsync("ps", [], fakeAsync(enoent()).spawn)).toBe("");
    await expect(
      lookupAsync("ps", [], fakeAsync(enoent()).spawn, { strict: true }),
    ).rejects.toThrow(LookupError);
  });
});
