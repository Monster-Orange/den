/**
 * Issue 1129: doctor says how many agents the restart queue still holds,
 * from agents/restarts-waiting.json. Nothing when none wait. Invented names.
 */
import { describe, expect, it } from "@jest/globals";
import { restartsWaitingLines } from "../../../src/ui/cli/doctor-command";

const at = "2026-01-02T10:00:00.000Z";

describe("issue 1129: doctor's restart queue line", () => {
  it("no file: no line", () => {
    expect(restartsWaitingLines(() => null)).toEqual([]);
  });

  it("none waiting: no line", () => {
    expect(restartsWaitingLines(() => ({ waiting: 0, ids: [], at }))).toEqual(
      [],
    );
  });

  it("some waiting: one line with the count, the time and the names", () => {
    const lines = restartsWaitingLines(() => ({
      waiting: 2,
      ids: ["alpha", "beta"],
      at,
    }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("2 agents waiting to restart");
    expect(lines[1]).toContain(at);
    expect(lines[1]).toContain("alpha, beta");
  });

  it("many waiting: five names, then how many more", () => {
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    const [, line] = restartsWaitingLines(() => ({ waiting: 7, ids, at }));
    expect(line).toContain("a1, a2, a3, a4, a5 and 2 more");
    expect(line).not.toContain("a6");
  });

  it("one waiting: singular", () => {
    const [, line] = restartsWaitingLines(() => ({
      waiting: 1,
      ids: ["solo"],
      at,
    }));
    expect(line).toContain("1 agent waiting to restart");
  });
});
