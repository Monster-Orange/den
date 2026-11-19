/**
 * Issue 169 (T2, Den Design's ruling, option a): a project's terminals are
 * "terminal-1", "terminal-2", ... and each is shown as "Terminal N": N per
 * project, the lowest number no listed terminal there holds (exited ones
 * included), stable for the session's life. A number comes back only once
 * the terminal that had it was removed. Older sessions ("shell",
 * "shell-2") count as Terminal 1, Terminal 2. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  nextTerminalName,
  terminalNumber,
  terminalNumbers,
} from "../../../src/shared/sessions/terminal-names.js";

describe("terminal names (issue 169)", () => {
  it("start at terminal-1, then terminal-2", () => {
    expect(nextTerminalName([])).toBe("terminal-1");
    expect(nextTerminalName(["terminal-1"])).toBe("terminal-2");
  });

  it("the lowest free number: one that left the list is given again", () => {
    // terminal-1 was removed; terminal-2 is still listed.
    expect(nextTerminalName(["terminal-2"])).toBe("terminal-1");
    expect(nextTerminalName(["terminal-1", "terminal-3"])).toBe("terminal-2");
  });

  it("never a number a listed terminal holds, exited ones included", () => {
    // The caller passes every session the host still lists.
    expect(nextTerminalName(["terminal-1", "terminal-2"])).toBe("terminal-3");
  });

  it("an older session's name holds its number: shell is 1, shell-2 is 2", () => {
    expect(nextTerminalName(["shell"])).toBe("terminal-2");
    expect(nextTerminalName(["shell", "shell-2"])).toBe("terminal-3");
    expect(nextTerminalName(["shell-2"])).toBe("terminal-1");
  });

  it("read a name's number; others have none", () => {
    expect(terminalNumber("terminal-3")).toBe(3);
    expect(terminalNumber("shell-2")).toBe(2);
    expect(terminalNumber("shell")).toBe(1);
    expect(terminalNumber("planner")).toBeNull();
    expect(terminalNumber("terminal-0")).toBeNull();
  });
});

describe("the number each row shows (issue 169)", () => {
  const row = (id: string, name: string, startedAt: string) => ({
    id,
    name,
    startedAt: `2026-11-18T${startedAt}:00.000Z`,
  });

  it("a name's own number: shell-2 is 2, terminal-4 is 4", () => {
    const n = terminalNumbers([
      row("a", "shell-2", "10:00"),
      row("b", "terminal-4", "10:05"),
    ]);
    expect(n.get("a")).toBe(2);
    expect(n.get("b")).toBe(4);
  });

  it("two names on one number: the later one takes the lowest free", () => {
    const n = terminalNumbers([
      row("new", "terminal-1", "11:00"),
      row("old", "shell", "09:00"),
    ]);
    expect(n.get("old")).toBe(1);
    expect(n.get("new")).toBe(2);
  });

  it("the same rows give the same numbers every time (stable)", () => {
    const rows = [
      row("x", "shell", "09:00"),
      row("y", "terminal-1", "10:00"),
      row("z", "shell-3", "11:00"),
    ];
    const a = terminalNumbers(rows);
    const b = terminalNumbers([...rows].reverse());
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get("z")).toBe(3);
  });

  it("a name that isn't a terminal's (one a person chose) gets none", () => {
    expect(terminalNumbers([row("p", "scratch", "09:00")]).has("p")).toBe(
      false,
    );
  });
});
