/**
 * Issue 169 (T2): a project's terminals are "terminal-1", "terminal-2", ...
 * and a number is never given twice in one project, even after the one
 * that had it closed.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  nextTerminalName,
  terminalNumber,
} from "../../../src/shared/sessions/terminal-names.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-term-names-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("terminal names (issue 169)", () => {
  it("start at terminal-1, then terminal-2", () => {
    const s = tmp();
    expect(nextTerminalName(s, "north", [])).toBe("terminal-1");
    expect(nextTerminalName(s, "north", ["terminal-1"])).toBe("terminal-2");
  });

  it("never repeat after one closes", () => {
    const s = tmp();
    expect(nextTerminalName(s, "north", [])).toBe("terminal-1");
    expect(nextTerminalName(s, "north", ["terminal-1"])).toBe("terminal-2");
    // terminal-2 closed: the list holds terminal-1 only.
    expect(nextTerminalName(s, "north", ["terminal-1"])).toBe("terminal-3");
    // Every one closed: still on.
    expect(nextTerminalName(s, "north", [])).toBe("terminal-4");
  });

  it("count per project", () => {
    const s = tmp();
    expect(nextTerminalName(s, "north", [])).toBe("terminal-1");
    expect(nextTerminalName(s, "south", [])).toBe("terminal-1");
  });

  it("step past a live name the count doesn't know (an older install's)", () => {
    const s = tmp();
    expect(nextTerminalName(s, "north", ["terminal-5"])).toBe("terminal-6");
  });

  it("a broken count file starts again above the live names", () => {
    const s = tmp();
    fs.mkdirSync(path.join(s, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(s, "sessions", "terminal-names.json"), "{nope");
    expect(nextTerminalName(s, "north", ["terminal-2"])).toBe("terminal-3");
  });

  it("read a name's number; others have none", () => {
    expect(terminalNumber("terminal-3")).toBe(3);
    expect(terminalNumber("shell-2")).toBeNull();
    expect(terminalNumber("planner")).toBeNull();
  });
});
