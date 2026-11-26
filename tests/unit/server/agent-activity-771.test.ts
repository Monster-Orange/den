import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-act771-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const agent = (id: string, exited = false) => {
  writeRecord(stateDir, {
    id,
    persona: "sde",
    runtime: "codex",
    workspace: "north",
    cwd: "/w/north",
    session: { backend: "den-pty", id: `s-${id}` },
    sessionName: `acme-north:${id}`,
    startedAt: "2026-11-07T10:00:00.000Z",
  });
  return {
    ref: { backend: "den-pty", id: `s-${id}` },
    name: `acme-north:${id}`,
    pid: 1,
    startedAt: "2026-11-07T10:00:00.000Z",
    ...(exited ? { exited: true, exitCode: 0 } : {}),
  };
};

const rows = (waiting: Set<string>) =>
  listedSessions(
    [agent("builder"), agent("tester"), agent("asker"), agent("gone", true)],
    {
      stateDir: () => stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north"],
      waitingAgents: () => waiting,
      activity: () =>
        new Map([
          ["builder", "working"],
          ["tester", "idle"],
          ["asker", "working"],
          ["gone", "working"],
        ]),
    },
  );
const by = (id: string) => rows(new Set(["asker"])).find((x) => x.agent === id);

describe("GET /api/sessions: what an agent's own terminal said it is doing", () => {
  it("a running agent's row says working or idle", () => {
    expect(by("builder")?.activity).toBe("working");
    expect(by("tester")?.activity).toBe("idle");
  });

  it("an agent waiting for its person says waiting, never working over it", () => {
    expect(by("asker")?.waiting).toBe(true);
    expect(by("asker")).not.toHaveProperty("activity");
  });

  it("an ended session says nothing", () => {
    expect(by("gone")).not.toHaveProperty("activity");
  });
});
