import { describe, expect, it } from "@jest/globals";
import {
  clockLine,
  handoffPrompt,
  resumeHandoffPrompt,
} from "../../../src/shared/agents/rotation.js";

const AT = new Date("2026-11-24T03:20:00Z");
const ZONE = "America/Los_Angeles";
const NOW = "It is now Mon 2026-11-23 19:20 PST (America/Los_Angeles).";
const HANDOFF =
  "## Objective\nShip it.\n## Next step\nThe one thing, at 03:40.";

describe("a relaunched agent is told the current local time", () => {
  it("says the day, date, time and zone, for a fixed clock", () => {
    expect(clockLine(AT, ZONE)).toBe(NOW);
  });

  it("uses the zone's own offset (summer time too)", () => {
    expect(clockLine(new Date("2026-07-01T16:05:00Z"), ZONE)).toBe(
      "It is now Wed 2026-07-01 09:05 PDT (America/Los_Angeles).",
    );
    expect(clockLine(new Date("2026-11-24T03:20:00Z"), "Asia/Tokyo")).toMatch(
      /^It is now Tue 2026-11-24 12:20 .+ \(Asia\/Tokyo\)\.$/,
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
