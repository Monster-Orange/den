/**
 * Issue 214: a schedule's cron and window. Times are the host's local time,
 * so every test builds dates with the local Date constructor.
 */
import { describe, expect, it } from "@jest/globals";
import {
  parseCron,
  nextRun,
  parseWindow,
  inWindow,
  windowEnd,
  describeCron,
} from "../../../src/shared/verify/cron";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0);

describe("parseCron", () => {
  it("reads five fields with lists, ranges and steps", () => {
    const c = parseCron("*/15 2-4 * * 1,5");
    expect(c.minute).toEqual([0, 15, 30, 45]);
    expect(c.hour).toEqual([2, 3, 4]);
    expect(c.dow).toEqual([1, 5]);
  });

  it("takes 7 as Sunday", () => {
    expect(parseCron("0 3 * * 7").dow).toEqual([0]);
  });

  it.each([
    ["0 2 * *", "five fields"],
    ["60 2 * * *", "minute"],
    ["0 24 * * *", "hour"],
    ["0 2 0 * *", "day of the month"],
    ["0 2 * 13 *", "month"],
    ["0 2 * * 8", "day of the week"],
    ["*/0 * * * *", "step"],
    ["5-1 * * * *", "range"],
  ])("refuses %j, naming the %s", (cron, what) => {
    expect(() => parseCron(cron)).toThrow(new RegExp(what));
  });
});

describe("nextRun", () => {
  it("the next minute after, never the same minute", () => {
    expect(nextRun("0 2 * * *", at(2026, 11, 21, 1, 59))).toEqual(
      at(2026, 11, 21, 2, 0),
    );
    expect(nextRun("0 2 * * *", at(2026, 11, 21, 2, 0))).toEqual(
      at(2026, 11, 22, 2, 0),
    );
  });

  it("weekdays: Tuesdays and Fridays at 22:00", () => {
    // 2026-11-21 is a Saturday.
    expect(nextRun("0 22 * * 2,5", at(2026, 11, 21, 12))).toEqual(
      at(2026, 11, 24, 22, 0),
    );
  });

  it("day of the month or day of the week, when both are set", () => {
    // The 1st, or any Monday: the Monday 2026-11-23 comes first.
    expect(nextRun("0 3 1 * 1", at(2026, 11, 21))).toEqual(
      at(2026, 11, 23, 3, 0),
    );
  });

  it("hourly", () => {
    expect(nextRun("0 * * * *", at(2026, 11, 21, 9, 40))).toEqual(
      at(2026, 11, 21, 10, 0),
    );
  });

  it("a date that never comes (Feb 30) gives null", () => {
    expect(nextRun("0 0 30 2 *", at(2026, 1, 1))).toBeNull();
  });
});

describe("windows", () => {
  it("reads HH:MM-HH:MM, night and any", () => {
    expect(parseWindow("01:00-05:00")).toEqual({ from: 60, to: 300 });
    expect(parseWindow("night")).toEqual({ from: 22 * 60, to: 6 * 60 });
    expect(parseWindow(undefined)).toBeNull();
    expect(parseWindow("any")).toBeNull();
  });

  it.each(["1-5", "25:00-01:00", "01:00-01:00", "evening"])(
    "refuses %j",
    (w) => {
      expect(() => parseWindow(w)).toThrow(/window/);
    },
  );

  it("a window across midnight", () => {
    const w = parseWindow("20:00-06:00");
    expect(inWindow(w, at(2026, 11, 21, 23))).toBe(true);
    expect(inWindow(w, at(2026, 11, 21, 5, 59))).toBe(true);
    expect(inWindow(w, at(2026, 11, 21, 6, 0))).toBe(false);
    expect(inWindow(w, at(2026, 11, 21, 12))).toBe(false);
    expect(inWindow(null, at(2026, 11, 21, 12))).toBe(true);
  });

  it("windowEnd: when a run due at a time must have started by", () => {
    const w = parseWindow("20:00-06:00");
    expect(windowEnd(w, at(2026, 11, 21, 22))).toEqual(at(2026, 11, 22, 6));
    expect(windowEnd(w, at(2026, 11, 22, 1))).toEqual(at(2026, 11, 22, 6));
    // Due at noon, outside the window: it waits for the window and runs by 06:00.
    expect(windowEnd(w, at(2026, 11, 21, 12))).toEqual(at(2026, 11, 22, 6));
  });
});

describe("describeCron", () => {
  it("names the shapes the page says in words", () => {
    expect(describeCron("0 * * * *")).toEqual({ kind: "hourly" });
    expect(describeCron("0 2 * * *")).toEqual({ kind: "daily", time: "02:00" });
    expect(describeCron("30 22 * * 2,5")).toEqual({
      kind: "weekly",
      time: "22:30",
      days: [2, 5],
    });
    expect(describeCron("*/10 * * * *")).toEqual({ kind: "raw" });
  });
});
