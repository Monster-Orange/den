import { describe, expect, it } from "@jest/globals";
import {
  isTimeZone,
  personTimeZone,
  timeZonePref,
} from "../../../src/shared/time-zone.js";
import * as serverPref from "../../../src/ui/server/time-zone-pref.js";

describe("the person's time zone, read once for the CLI, doctor and the server", () => {
  it("user.yml's time_zone when Intl knows it", () => {
    expect(personTimeZone(() => ({ time_zone: "Asia/Tokyo" }))).toBe(
      "Asia/Tokyo",
    );
  });

  it("missing, empty, unknown, too long or not a string: undefined (the machine's own)", () => {
    for (const v of [undefined, "", "Not/AZone", "x".repeat(65), 3, null])
      expect(
        personTimeZone(() => ({ time_zone: v }) as { time_zone?: string }),
      ).toBeUndefined();
  });

  it("a user.yml that can't be read: undefined, never a throw", () => {
    expect(
      personTimeZone(() => {
        throw new Error("bad yaml");
      }),
    ).toBeUndefined();
  });

  it("the server's pref module answers the same, from the one place", () => {
    expect(serverPref.isTimeZone).toBe(isTimeZone);
    expect(serverPref.timeZonePref).toBe(timeZonePref);
  });
});
