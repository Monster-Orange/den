/**
 * Issue 1129: doctor says how many agents the restart queue still holds,
 * from agents/restarts-waiting.json. Nothing when none wait. Invented names.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { restartsWaitingLines } from "../../../src/ui/cli/doctor-command";
import { localDateTime } from "../../../src/shared/local-time";
import {
  clearRestartsWaiting,
  readRestartsWaiting,
  restartsWaitingFile,
} from "../../../src/ui/server/restart-queue-service";

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
    // People read it: the machine's own zone, never the UTC ISO stamp.
    expect(lines[1]).toContain(localDateTime(at));
    expect(lines[1]).not.toContain(at);
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

  it("a new server clears what an earlier one left waiting", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1129-"));
    try {
      const f = restartsWaitingFile(dir);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ waiting: 3, ids: ["x"], at }));
      expect(readRestartsWaiting(dir)?.waiting).toBe(3);
      clearRestartsWaiting(dir);
      expect(fs.existsSync(f)).toBe(false);
      expect(readRestartsWaiting(dir)).toBeNull();
      expect(restartsWaitingLines(() => readRestartsWaiting(dir))).toEqual([]);
      clearRestartsWaiting(dir); // nothing there: no throw
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
