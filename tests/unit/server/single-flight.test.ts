import { describe, expect, it } from "@jest/globals";
import { singleFlight } from "../../../src/ui/server/single-flight.js";

const held = () => {
  let done: (v: string) => void = () => {};
  const p = new Promise<string>((r) => (done = r));
  return { p, done };
};
const flush = () => new Promise((r) => setImmediate(r));

function counted() {
  const built: Record<string, number> = {};
  const build = (k: string) => () => {
    built[k] = (built[k] ?? 0) + 1;
    return Promise.resolve(k);
  };
  return { built, build };
}

describe("singleFlight", () => {
  it("shares one build between callers of the same key", async () => {
    const c = singleFlight<string>(1_000);
    const { built, build } = counted();
    await Promise.all([c.get("a", build("a")), c.get("a", build("a"))]);
    expect(built.a).toBe(1);
  });

  it("past maxKeys drops the oldest settled key", async () => {
    const c = singleFlight<string>(60_000, Date.now, 2);
    const { built, build } = counted();
    await c.get("a", build("a"));
    await c.get("b", build("b"));
    await c.get("c", build("c"));
    await flush();
    await c.get("b", build("b"));
    await c.get("c", build("c"));
    expect([built.b, built.c]).toEqual([1, 1]);
    await c.get("a", build("a"));
    expect(built.a).toBe(2);
  });

  it("past maxKeys keeps a key still building", async () => {
    const c = singleFlight<string>(60_000, Date.now, 1);
    const slow = held();
    let slowBuilds = 0;
    const first = c.get("slow", () => {
      slowBuilds += 1;
      return slow.p;
    });
    await c.get("b", () => Promise.resolve("b"));
    const again = c.get("slow", () => {
      slowBuilds += 1;
      return Promise.resolve("other");
    });
    slow.done("slow");
    expect(await first).toBe("slow");
    expect(await again).toBe("slow");
    expect(slowBuilds).toBe(1);
  });

  it("with no cap drops nothing", async () => {
    const c = singleFlight<string>(60_000);
    const { built, build } = counted();
    const keys = Array.from({ length: 200 }, (_, n) => `k${n}`);
    for (const k of keys) await c.get(k, build(k));
    await flush();
    for (const k of keys) await c.get(k, build(k));
    expect(keys.every((k) => built[k] === 1)).toBe(true);
  });
});
