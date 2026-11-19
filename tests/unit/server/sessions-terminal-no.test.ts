/**
 * Issue 169 part 2 (Den Design, option a): GET /api/sessions gives each
 * plain terminal its number in its project (`terminalNo`), the one every
 * view shows as "Terminal N". Per project; an older "shell-2" is 2; two
 * names on one number: the later one gets the lowest free. Agents get
 * none. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listedSessions } from "../../../src/ui/server/session-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-termno-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const live = (id: string, name: string, startedAt: string) => ({
  ref: { backend: "den-pty", id },
  name,
  pid: 1,
  startedAt: `2026-11-18T${startedAt}:00.000Z`,
});

const numbers = (sessions: ReturnType<typeof live>[]) =>
  Object.fromEntries(
    listedSessions(sessions, {
      stateDir: () => stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north", "south"],
      shellDir: (ws: string) => path.join(os.homedir(), "proj", ws),
    }).map((r) => [r.id, (r as { terminalNo?: number }).terminalNo]),
  );

describe("issue 169: each terminal row's number", () => {
  it("an older shell-2 is 2, shell is 1, terminal-3 is 3", () => {
    expect(
      numbers([
        live("a", "acme-north:shell", "09:00"),
        live("b", "acme-north:shell-2", "09:10"),
        live("c", "acme-north:terminal-3", "09:20"),
      ]),
    ).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("per project: each project starts at 1", () => {
    expect(
      numbers([
        live("n", "acme-north:terminal-1", "09:00"),
        live("s", "acme-south:terminal-1", "09:05"),
      ]),
    ).toEqual({ n: 1, s: 1 });
  });

  it("two on one number: the later one takes the lowest free", () => {
    expect(
      numbers([
        live("old", "acme-north:shell", "09:00"),
        live("new", "acme-north:terminal-1", "10:00"),
      ]),
    ).toEqual({ old: 1, new: 2 });
  });
});
