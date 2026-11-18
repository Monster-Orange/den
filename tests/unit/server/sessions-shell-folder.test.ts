/**
 * Issue 482 (clause 2): a Terminals row shows its folder and, once it
 * exited, when. GET /api/sessions rows for plain shells carry the folder
 * the host started them in (`cwd`, and `folder` with the home folder as
 * "~"), else, from an older host that doesn't say, their project's
 * folder; and `endedAt` from the host's exitedAt. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listedSessions } from "../../../src/ui/server/session-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-shfolder-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const home = os.homedir();
const live = (id: string, name: string, more: Record<string, unknown> = {}) => ({
  ref: { backend: "den-pty", id },
  name,
  pid: 1,
  startedAt: "2026-11-18T10:00:00.000Z",
  ...more,
});

const rows = (sessions: ReturnType<typeof live>[]) =>
  listedSessions(sessions, {
    stateDir: () => stateDir,
    dist: () => "acme",
    activeWorkspaces: () => ["north"],
    shellDir: (ws: string) => path.join(home, "proj", ws),
  });

describe("issue 482: a shell row's folder and end", () => {
  it("the host's cwd, and the home folder as ~", () => {
    const r = rows([
      live("s1", "acme-north:shell", { cwd: path.join(home, "w", "api") }),
    ])[0];
    expect(r.cwd).toBe(path.join(home, "w", "api"));
    expect(r.folder).toBe("~/w/api");
  });
  it("a folder outside home stays as it is", () => {
    const r = rows([live("s1", "acme-north:shell", { cwd: "/srv/north" })])[0];
    expect(r.folder).toBe("/srv/north");
  });
  it("an older host says no cwd: the project's folder", () => {
    const r = rows([live("s1", "acme-north:shell")])[0];
    expect(r.folder).toBe("~/proj/north");
  });
  it("an exited shell says when it ended", () => {
    const r = rows([
      live("s1", "acme-north:shell", {
        exited: true,
        exitCode: 0,
        exitedAt: "2026-11-18T11:00:00.000Z",
      }),
    ])[0];
    expect(r.endedAt).toBe("2026-11-18T11:00:00.000Z");
  });
});
