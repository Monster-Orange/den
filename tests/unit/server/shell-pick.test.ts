/**
 * Issue 448: which plain shell the rail's Terminal opens
 * (public/shell-pick.js), without a browser. The server says when a shell
 * last had a person's input (inputAt, any browser, any machine); the list
 * order (project, then start) never decides. Exited shells never open.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { latestShell } from "../../../src/ui/server/public/shell-pick.js";

const row = (
  id: string,
  workspace: string,
  startedAt: string,
  more: Record<string, unknown> = {},
) => ({
  id,
  workspace,
  kind: "session",
  startedAt: `2026-11-18T${startedAt}:00.000Z`,
  ...more,
});
const at = (hm: string) => `2026-11-18T${hm}:00.000Z`;

describe("All projects (no project named)", () => {
  // North's shell is first in the list and started last; south's was typed
  // in last (in another browser: this one never used either).
  const rows = [
    row("n1", "north", "10:05", { inputAt: at("10:10") }),
    row("s1", "south", "10:00", { inputAt: at("10:20") }),
  ];

  it("opens the shell used last across every project, not the first", () => {
    expect(latestShell(rows, null)?.id).toBe("s1");
  });

  it("this browser's own use counts too", () => {
    const used = { n1: Date.parse(at("10:30")) };
    expect(latestShell(rows, null, used)?.id).toBe("n1");
  });

  it("with no input anywhere, the newest shell (an older host says no inputAt)", () => {
    const bare = rows.map(({ inputAt: _, ...r }) => r);
    expect(latestShell(bare, null)?.id).toBe("n1");
  });
});

describe("one project selected", () => {
  const rows = [
    row("n1", "north", "10:00", { inputAt: at("10:15") }),
    row("n2", "north", "10:05", { inputAt: at("10:06") }),
    row("s1", "south", "10:10", { inputAt: at("10:30") }),
  ];

  it("opens that project's shell used last, never another project's", () => {
    expect(latestShell(rows, "north")?.id).toBe("n1");
    expect(latestShell(rows, "south")?.id).toBe("s1");
  });

  it("none running there: null (a new one starts)", () => {
    expect(latestShell(rows, "west")).toBeNull();
  });
});

describe("exited shells never open", () => {
  it("(a) one exited, one running in the project: the running one", () => {
    const rows = [
      row("n1", "north", "10:00", { inputAt: at("10:01") }),
      row("nx", "north", "10:05", { inputAt: at("10:30"), exited: true }),
    ];
    expect(latestShell(rows, "north")?.id).toBe("n1");
    expect(latestShell(rows, null)?.id).toBe("n1");
  });

  it("(b) only an exited shell: null (a new one starts)", () => {
    const rows = [
      row("nx", "north", "10:05", { inputAt: at("10:30"), exited: true }),
    ];
    expect(latestShell(rows, "north")).toBeNull();
    expect(latestShell(rows, null)).toBeNull();
  });
});
