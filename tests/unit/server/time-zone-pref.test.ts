/**
 * issue 206: the person's time zone pick (user.yml time_zone) and the
 * page's first paint in it (<html data-den-tz>).
 */
import { describe, expect, it } from "@jest/globals";
import {
  isTimeZone,
  timeZonePref,
  zonePage,
} from "../../../src/ui/server/time-zone-pref.js";

describe("time_zone", () => {
  it("only a zone Intl knows is kept; anything else is the browser's", () => {
    expect(isTimeZone("Asia/Tokyo")).toBe(true);
    expect(timeZonePref("America/Los_Angeles")).toBe("America/Los_Angeles");
    for (const v of ["", "Not/AZone", 3, null, undefined, '"><x'])
      expect(timeZonePref(v)).toBeNull();
  });

  it("a picked zone is on <html> for the first paint; none leaves it as is", () => {
    const html = '<!doctype html>\n<html lang="en">\n<body></body></html>';
    expect(zonePage(html, "Asia/Tokyo")).toBe(
      '<!doctype html>\n<html data-den-tz="Asia/Tokyo" lang="en">\n<body></body></html>',
    );
    expect(zonePage(html, null)).toBe(html);
    expect(zonePage(html, "Not/AZone")).toBe(html);
  });
});
