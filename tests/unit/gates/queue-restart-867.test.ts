/**
 * Issue 867: a queued gate entry keeps its place across a Den restart.
 * A waiter that is gone (a restart ended its `gate run`) leaves its entry
 * in line, kept for `waiter_return_minutes` (default 10). The same run
 * asking again (same kind, asker, label and place) takes it back, in the
 * same place. One that never comes back is released with a reason in the
 * slot log, and its asker is told when it next asks. Never silently lost.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkGatePatch, GateStore } from "../../../src/shared/gates/store.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-22T20:00:00Z");
const MIN = 60_000;

/** A store on `dir`; `live` holds the pids still running. */
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate867-"));
  tmps.push(dir);
  const live = new Set<number>();
  let now = T0;
  const open = () =>
    new GateStore({
      platform: "linux",
      dir,
      now: () => now,
      alive: (p) => live.has(p),
    });
  return {
    dir,
    live,
    open,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type W = ReturnType<typeof world>;

/** Each ask a second after the last, so the queue's order is plain. */
function ask(w: W, s: GateStore, who: string, label: string, pid: number) {
  w.advance(1000);
  w.live.add(pid);
  return s.ask({ kind: "browser", who, label, pid, estimateMin: 10 });
}

/** A holder and three waiters, in order; then a restart ends the waiters. */
function queued(w: W) {
  const s = w.open();
  const h = ask(w, s, "den · a · a person", "holder", 100);
  const a = ask(w, s, "den · b · agent:one", "release check", 101);
  const b = ask(w, s, "den · c · agent:two", "full check", 102);
  const c = ask(w, s, "den · d · a person", "unit", 103);
  expect(h.grantedAt).toBeDefined();
  // The restart: every waiter's gate run ends; the holder's run goes on.
  for (const p of [101, 102, 103]) w.live.delete(p);
  return { h, a, b, c };
}

const order = (s: GateStore) =>
  s
    .list()
    .filter((e) => !e.grantedAt)
    .map((e) => e.label);

describe("issue 867: the queue survives a restart", () => {
  it("after a restart the waiters keep the same order, marked as gone", () => {
    const w = world();
    const { a, b, c } = queued(w);
    const s = w.open(); // the restarted server's store
    const list = s.list();
    expect(order(s)).toEqual(["release check", "full check", "unit"]);
    for (const id of [a.id, b.id, c.id])
      expect(list.find((e) => e.id === id)!.orphanedAt).toBeDefined();
    expect(s.events().map((r) => r.event)).toContain("waiter-gone");
    expect(s.events().map((r) => r.event)).not.toContain("taken-back-gone");
  });

  it("the same run asking again takes back its own place, not the end", () => {
    const w = world();
    const { b } = queued(w);
    const s = w.open();
    s.list();
    const again = ask(w, s, "den · c · agent:two", "full check", 202);
    expect(again.id).toBe(b.id);
    expect(again.askedAt).toBe(b.askedAt);
    expect(again.pid).toBe(202);
    expect(again.orphanedAt).toBeUndefined();
    expect(order(s)).toEqual(["release check", "full check", "unit"]);
    expect(s.events().at(-1)).toMatchObject({
      event: "reattached",
      id: b.id,
    });
  });

  it("a different run (another label) gets a new entry at the end", () => {
    const w = world();
    queued(w);
    const s = w.open();
    s.list();
    const other = ask(w, s, "den · c · agent:two", "lint", 203);
    expect(order(s).at(-1)).toBe("lint");
    expect(s.list().filter((e) => !e.grantedAt)).toHaveLength(4);
    expect(other.orphanedAt).toBeUndefined();
  });

  it("a gone waiter isn't given a slot: the next live one starts", () => {
    const w = world();
    const { h, c } = queued(w);
    const s = w.open();
    s.list();
    const back = ask(w, s, "den · d · a person", "unit", 303);
    expect(back.id).toBe(c.id);
    s.release(h.id);
    const now = s.list();
    // The two ahead of it are still gone: "unit" starts, they keep places.
    expect(now.find((e) => e.id === c.id)!.grantedAt).toBeDefined();
    expect(order(s)).toEqual(["release check", "full check"]);
  });

  it("a waiter that never comes back is released with a reason, and its asker is told", () => {
    const w = world();
    const { a } = queued(w);
    let s = w.open();
    s.list();
    w.advance(10 * MIN + 1);
    s = w.open();
    expect(s.list().find((e) => e.id === a.id)).toBeUndefined();
    const row = s
      .events()
      .find((r) => r.id === a.id && r.event === "taken-back-gone");
    expect(row).toMatchObject({ reason: "waiter-gone" });
    // Its asker, asking again later, hears what became of its place.
    const next = ask(w, s, "den · b · agent:one", "release check", 401);
    expect(next.id).not.toBe(a.id);
    expect(s.droppedFor(next)).toMatchObject({
      id: a.id,
      reason: "waiter-gone",
    });
    // Told once.
    expect(s.droppedFor(next)).toBeNull();
  });

  it("waiter_return_minutes 0: a gone waiter is taken back at once, as before", () => {
    const w = world();
    const s0 = w.open();
    s0.writeSettings({ waiter_return_minutes: 0 }, "a test");
    const { a } = queued(w);
    const s = w.open();
    expect(s.list().find((e) => e.id === a.id)).toBeUndefined();
    expect(order(s)).toEqual([]);
  });

  it("a holder whose run is gone is still taken back at once", () => {
    const w = world();
    const { h } = queued(w);
    w.live.delete(100);
    const s = w.open();
    expect(s.list().find((e) => e.id === h.id)).toBeUndefined();
  });

  it("waiter_return_minutes is a checked setting, default 10", () => {
    const w = world();
    expect(w.open().settings().waiterReturnMinutes).toBe(10);
    expect(checkGatePatch({ waiter_return_minutes: 30 })).toEqual({
      ok: true,
      patch: { waiter_return_minutes: 30 },
    });
    expect(checkGatePatch({ waiter_return_minutes: -1 }).ok).toBe(false);
  });
});
