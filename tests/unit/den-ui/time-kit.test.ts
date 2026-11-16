/**
 * issue 206: the kit's date-times for people (packages/den-ui/src/time.js).
 * A stamp is stored in UTC and read in the person's own zone. Runs in Node
 * (no document): a fixed zone, locale and now each time.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  formatTime,
  setTimeZone,
  timeHtml,
  upgradeTimes,
} from "../../../packages/den-ui/src/time.js";

const ISO = "2026-11-16T00:32:05Z";
const NOW = "2026-11-16T01:00:00Z";
// ICU's spaces (a narrow no-break before AM/PM) read as plain ones here.
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");
const f = (o: Record<string, unknown>, iso: unknown = ISO) =>
  plain(formatTime(iso as string, { now: NOW, ...o }));

describe("formatTime: the person's zone, never UTC", () => {
  const cases: [string, string, Record<string, string>][] = [
    [
      "America/Los_Angeles",
      "en",
      { datetime: "Nov 15, 4:32 PM", date: "Nov 15", time: "4:32 PM" },
    ],
    [
      "Asia/Tokyo",
      "en",
      { datetime: "Nov 16, 9:32 AM", date: "Nov 16", time: "9:32 AM" },
    ],
    [
      "UTC",
      "en",
      { datetime: "Nov 16, 12:32 AM", date: "Nov 16", time: "12:32 AM" },
    ],
    [
      "America/Los_Angeles",
      "es",
      { datetime: "15 nov, 16:32", date: "15 nov", time: "16:32" },
    ],
    [
      "Asia/Tokyo",
      "ja",
      { datetime: "11月16日 9:32", date: "11月16日", time: "9:32" },
    ],
  ];
  for (const [zone, locale, want] of cases)
    it(`${zone} in ${locale}`, () => {
      for (const [style, text] of Object.entries(want))
        expect(f({ zone, locale, style })).toBe(text);
    });

  it("the default style is date and time; seconds on request", () => {
    expect(f({ zone: "UTC", locale: "en" })).toBe("Nov 16, 12:32 AM");
    expect(f({ zone: "UTC", locale: "en", seconds: true })).toBe(
      "Nov 16, 12:32:05 AM",
    );
  });

  it("the year shows only when it isn't this year, in that zone", () => {
    expect(f({ zone: "UTC", locale: "en" }, "2025-03-01T12:00:00Z")).toBe(
      "Mar 1, 2025, 12:00 PM",
    );
    // Jan 1 03:00 UTC is still Dec 31 last year in Los Angeles.
    expect(
      f({ zone: "America/Los_Angeles", locale: "en" }, "2026-01-01T03:00:00Z"),
    ).toBe("Dec 31, 2025, 7:00 PM");
    expect(
      f({ zone: "Asia/Tokyo", locale: "en" }, "2026-01-01T03:00:00Z"),
    ).toBe("Jan 1, 12:00 PM");
  });

  it("a missing or invalid stamp is empty", () => {
    for (const v of ["nope", "", null, undefined, "2026-13-45T99:00:00Z"])
      expect(formatTime(v as string, { zone: "UTC" })).toBe("");
  });

  it("relative: in the page's language", () => {
    const r = (iso: string, locale: string) =>
      f({ style: "relative", locale, zone: "UTC" }, iso);
    expect(r(ISO, "en")).toBe("28 minutes ago");
    expect(r("2026-11-16T00:59:50Z", "en")).toBe("now");
    expect(r("2026-11-15T22:00:00Z", "es")).toBe("hace 3 horas");
    expect(r("2026-11-13T00:00:00Z", "ja")).toBe("3 日前");
  });
});

describe("timeHtml", () => {
  it("datetime is the UTC stamp; the title is local with the zone's name", () => {
    const h = plain(
      timeHtml(ISO, {
        zone: "America/Los_Angeles",
        locale: "en",
        style: "relative",
        now: NOW,
      }),
    );
    expect(h).toBe(
      '<time datetime="2026-11-16T00:32:05.000Z" title="Sun, Nov 15, 2026, 4:32:05 PM Pacific Standard Time" data-den-time="relative">28 minutes ago</time>',
    );
  });

  it("escapes, and is empty for a bad stamp", () => {
    expect(timeHtml('"><x>')).toBe("");
    const h = timeHtml(ISO, { zone: "UTC", locale: "en", style: '"><x' });
    expect(h).toContain('data-den-time="datetime"');
    expect(h).not.toMatch(/<x/);
  });
});

describe("setTimeZone", () => {
  it("the pick is the default zone; null is the process's own again", () => {
    setTimeZone("Asia/Tokyo");
    expect(f({ locale: "en" })).toBe("Nov 16, 9:32 AM");
    setTimeZone("Not/AZone");
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(f({ locale: "en" })).toBe(f({ locale: "en", zone: own }));
    setTimeZone(null);
    expect(f({ locale: "en" })).toBe(f({ locale: "en", zone: own }));
  });

  it("upgradeTimes is safe without a document", () => {
    expect(() => upgradeTimes(undefined)).not.toThrow();
  });
});

describe("the kit ships it", () => {
  it("package.json exports ./time", () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../../../packages/den-ui/package.json"),
        "utf-8",
      ),
    );
    expect(pkg.exports["./time"]).toBe("./src/time.js");
  });
});
