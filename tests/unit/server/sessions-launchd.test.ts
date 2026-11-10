/**
 * D20: GET /api/sessions rows carry the launchd session their host stamped
 * (Aqua ends at logout), so the agents page can tag them. The 0.4.22-dev.0
 * gate found the tags never rendered: the rows dropped it.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-launchd-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

writeRecord(stateDir, {
  id: "scout",
  persona: "sde",
  runtime: "den-claude",
  workspace: "north",
  cwd: "/w/north",
  session: { backend: "den-pty", id: "s-scout" },
  sessionName: "acme-north:scout",
  startedAt: "2026-11-09T10:00:00.000Z",
});
writeRecord(stateDir, {
  id: "idle",
  persona: "sde",
  runtime: "den-claude",
  workspace: "north",
  cwd: "/w/north",
  session: { backend: "den-pty", id: "s-gone" },
  sessionName: "acme-north:idle",
  startedAt: "2026-11-09T10:00:00.000Z",
  stoppedAt: "2026-11-09T11:00:00.000Z",
});

const live = (id: string, name: string, launchd?: string) => ({
  ref: { backend: "den-pty", id },
  name,
  pid: 1,
  startedAt: "2026-11-09T10:00:00.000Z",
  ...(launchd ? { launchd } : {}),
});

const rows = (launchd?: string) =>
  listedSessions(
    [
      live("s-scout", "acme-north:scout", launchd),
      live("s-sh", "acme-north:shell", launchd),
    ],
    {
      stateDir: () => stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north"],
    },
  );

describe("session rows carry their launchd session", () => {
  it("an agent row and a plain session row", () => {
    const r = rows("Aqua");
    expect(r.find((x) => x.agent === "scout")?.launchd).toBe("Aqua");
    expect(r.find((x) => x.label === "shell")?.launchd).toBe("Aqua");
  });

  it("none when the host didn't say, or the agent has no session", () => {
    const r = rows();
    expect(r.find((x) => x.agent === "scout")).not.toHaveProperty("launchd");
    expect(
      rows("Background").find((x) => x.agent === "idle"),
    ).not.toHaveProperty("launchd");
  });
});
