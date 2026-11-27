import { describe, expect, it } from "@jest/globals";
import {
  clockLine,
  handoffPrompt,
  resumeHandoffPrompt,
} from "../../../src/shared/agents/rotation.js";

const AT = new Date("2026-11-24T03:20:00Z");
const ZONE = "America/Los_Angeles";
const NOW =
  "It is now Mon 2026-11-23 19:20 PST (UTC-08:00, America/Los_Angeles).";
const HANDOFF =
  "## Objective\nShip it.\n## Next step\nThe one thing, at 03:40.";

describe("a relaunched agent is told the current local time", () => {
  it("says the day, date, time and zone, for a fixed clock", () => {
    expect(clockLine(AT, ZONE)).toBe(NOW);
  });

  it("uses the zone's own offset (summer time too), as a number", () => {
    expect(clockLine(new Date("2026-07-01T16:05:00Z"), ZONE)).toBe(
      "It is now Wed 2026-07-01 09:05 PDT (UTC-07:00, America/Los_Angeles).",
    );
    expect(clockLine(AT, "Asia/Kolkata")).toBe(
      "It is now Tue 2026-11-24 08:50 (UTC+05:30, Asia/Kolkata).",
    );
  });

  it("a zone with no short name of its own gives only the number, never a GMT stand-in", () => {
    expect(clockLine(AT, "Asia/Tokyo")).toBe(
      "It is now Tue 2026-11-24 12:20 (UTC+09:00, Asia/Tokyo).",
    );
    expect(clockLine(AT, "UTC")).toBe(
      "It is now Tue 2026-11-24 03:20 UTC (UTC+00:00, UTC).",
    );
  });

  it("a rotation's relaunch carries it before the handoff", () => {
    const p = handoffPrompt(HANDOFF, "compactions", 3, [], AT, ZONE);
    expect(p).toContain(NOW);
    expect(p.indexOf(NOW)).toBeLessThan(p.indexOf("## Objective"));
    expect(p).toMatch(/not from the times in the handoff/);
  });

  it("a person's relaunch carries it too", () => {
    expect(handoffPrompt(HANDOFF, "manual", 0, [], AT, ZONE)).toContain(NOW);
  });

  it("a fresh start from a handoff carries it too", () => {
    expect(resumeHandoffPrompt(HANDOFF, AT, ZONE)).toContain(NOW);
  });

  it("an unknown zone falls back to the install's own", () => {
    expect(clockLine(AT, "Not/AZone")).toBe(clockLine(AT));
  });
});
