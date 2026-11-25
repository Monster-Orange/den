import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  firstCheckDelay,
  readCheckState,
  scheduleUpdateChecks,
  tickBegun,
  writeCheckState,
  type CheckState,
} from "../../../src/ui/server/update-check.js";

const MIN = 60_000;
const EVERY = 30 * MIN;
const START = Date.parse("2026-11-16T17:40:00-08:00");

function before(next: string | null, lastAt?: string): CheckState {
  return {
    everyMinutes: 30,
    next,
    ...(lastAt ? { last: { at: lastAt, did: "current" } } : {}),
  };
}

describe("a check missed while the server was stopped", () => {
  it("runs at once when its time passed before the start", () => {
    const prev = before(
      "2026-11-16T16:53:00-08:00",
      "2026-11-16T16:23:00-08:00",
    );
    expect(firstCheckDelay(prev, EVERY, START)).toBe(0);
  });

  it("runs at once when the last pass is an interval old and no next is set", () => {
    const prev = before(null, "2026-11-16T16:23:00-08:00");
    expect(firstCheckDelay(prev, EVERY, START)).toBe(0);
  });

  it("runs at once when the time is exactly now", () => {
    const prev = before(new Date(START).toISOString());
    expect(firstCheckDelay(prev, EVERY, START)).toBe(0);
  });
});

describe("a check that isn't due yet", () => {
  it("keeps its time instead of starting a whole new interval", () => {
    const prev = before(new Date(START + 10 * MIN).toISOString());
    expect(firstCheckDelay(prev, EVERY, START)).toBe(10 * MIN);
  });

  it("never waits longer than one interval (a shorter Setting since)", () => {
    const prev = before(new Date(START + 50 * MIN).toISOString());
    expect(firstCheckDelay(prev, 20 * MIN, START)).toBe(20 * MIN);
  });

  it("waits one interval on a first start, with no state yet", () => {
    expect(firstCheckDelay(null, EVERY, START)).toBe(EVERY);
  });

  it("waits one interval when the state file's next is unreadable", () => {
    expect(firstCheckDelay(before("not a time"), EVERY, START)).toBe(EVERY);
  });
});

describe("the interval stays the Setting", () => {
  it("is null when checks are off (0 minutes), whatever was due", () => {
    const prev = before("2026-11-16T16:53:00-08:00");
    expect(firstCheckDelay(prev, 0, START)).toBeNull();
  });

  it("follows a changed Setting for a first start", () => {
    expect(firstCheckDelay(null, 5 * MIN, START)).toBe(5 * MIN);
  });
});

describe("the server's schedule", () => {
  function timers() {
    const set: { kind: "once" | "every"; ms: number; fn: () => void }[] = [];
    return {
      set,
      t: {
        once: (fn: () => void, ms: number) =>
          void set.push({ kind: "once", ms, fn }),
        every: (fn: () => void, ms: number) =>
          void set.push({ kind: "every", ms, fn }),
      },
    };
  }

  it("runs a missed check at the start, then every interval", () => {
    const { set, t } = timers();
    let ticks = 0;
    const s = scheduleUpdateChecks({
      every: EVERY,
      prev: before("2026-11-16T16:53:00-08:00"),
      now: START,
      tick: () => void ticks++,
      timers: t,
    });
    expect(s.next).toBe(new Date(START).toISOString());
    const once = set.find((x) => x.kind === "once");
    expect(once?.ms).toBe(0);
    once?.fn();
    expect(ticks).toBe(1);
    const every = set.find((x) => x.kind === "every");
    expect(every?.ms).toBe(EVERY);
    every?.fn();
    expect(ticks).toBe(2);
  });

  it("says the kept time as the next check when one isn't due yet", () => {
    const { set, t } = timers();
    const s = scheduleUpdateChecks({
      every: EVERY,
      prev: before(new Date(START + 10 * MIN).toISOString()),
      now: START,
      tick: () => undefined,
      timers: t,
    });
    expect(s.next).toBe(new Date(START + 10 * MIN).toISOString());
    expect(set.map((x) => [x.kind, x.ms])).toEqual([["once", 10 * MIN]]);
  });

  it("sets nothing when checks are off", () => {
    const { set, t } = timers();
    const s = scheduleUpdateChecks({
      every: 0,
      prev: before("2026-11-16T16:53:00-08:00"),
      now: START,
      tick: () => undefined,
      timers: t,
    });
    expect(s.next).toBeNull();
    expect(set).toEqual([]);
  });
});

describe("a check begun and not finished", () => {
  it("gives one interval at the next start, not an immediate check", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-298-"));
    try {
      writeCheckState(dir, {
        everyMinutes: 30,
        next: new Date(START).toISOString(),
        last: { at: "2026-11-16T16:23:00-08:00", did: "current" },
      });
      const begun = START + 5;
      writeCheckState(dir, tickBegun(readCheckState(dir), 30, EVERY, begun));
      const after = readCheckState(dir);
      expect(after?.last?.at).toBe("2026-11-16T16:23:00-08:00");
      expect(firstCheckDelay(after, EVERY, begun + 2_000)).toBe(EVERY - 2_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts from nothing when there was no state", () => {
    expect(tickBegun(null, 30, EVERY, START)).toEqual({
      everyMinutes: 30,
      next: new Date(START + EVERY).toISOString(),
    });
  });
});
