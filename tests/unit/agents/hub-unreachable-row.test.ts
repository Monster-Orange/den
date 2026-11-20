/**
 * Issue 750 (step 3, and issue 749's agents-page part): an agent whose Hub
 * tools failed to load shows "Can't reach Hub" on its row, with Restart.
 * Den's record of each agent's Hub MCP start (hub-mcp-connect.ts) says it:
 * a failed connect since the agent started. An older failure (before this
 * run), a good connect, or a stopped agent shows nothing.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import {
  hubToolsLoaded,
  noteHubMcpInit,
  readHubMcpInit,
} from "../../../src/shared/agents/hub-mcp-connect.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function bed(startedAt: string) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-750-row-"));
  dirs.push(stateDir);
  writeRecord(stateDir, {
    id: "planner",
    persona: "planner",
    runtime: "claude",
    workspace: "north",
    cwd: stateDir,
    session: { backend: "den", id: "s-1" },
    sessionName: "acme-north:planner",
    startedAt,
  } as Parameters<typeof writeRecord>[1]);
  const sessions = [
    {
      ref: { backend: "den", id: "s-1" },
      name: "acme-north:planner",
      pid: 4242,
      startedAt,
    },
  ];
  const d = {
    stateDir: () => stateDir,
    dist: () => "acme",
    activeWorkspaces: () => ["north"],
    hubWork: () => null,
  };
  return { stateDir, sessions, d };
}

describe("issue 750: hubToolsLoaded", () => {
  const at = (iso: string, ok: boolean) => ({ ok, at: iso });
  it("false only for a failed connect since it started", () => {
    const start = "2026-11-20T10:00:00.000Z";
    expect(hubToolsLoaded(null, start)).toBeNull();
    expect(hubToolsLoaded(at("2026-11-20T10:00:01.000Z", true), start)).toBe(
      true,
    );
    expect(hubToolsLoaded(at("2026-11-20T10:00:01.000Z", false), start)).toBe(
      false,
    );
    // A failure from an earlier run: not this run's.
    expect(
      hubToolsLoaded(at("2026-11-20T09:00:00.000Z", false), start),
    ).toBeNull();
    expect(
      hubToolsLoaded(at("2026-11-20T10:00:01.000Z", false), ""),
    ).toBeNull();
  });
});

describe("issue 750: the agents page's row says Can't reach Hub", () => {
  it("a running agent whose Hub MCP start failed: hubUnreachable", () => {
    const start = new Date(Date.now() - 60_000).toISOString();
    const b = bed(start);
    noteHubMcpInit(b.stateDir, "planner", {
      ok: false,
      error: "hub (502): Bad Gateway",
    });
    expect(readHubMcpInit(b.stateDir, "planner")?.ok).toBe(false);
    const row = listedSessions(b.sessions, b.d).find(
      (x) => x.agent === "planner",
    )!;
    expect(row.hubUnreachable).toBe(true);
  });

  it("its tools loaded: nothing on the row", () => {
    const b = bed(new Date(Date.now() - 60_000).toISOString());
    noteHubMcpInit(b.stateDir, "planner", { ok: true });
    const row = listedSessions(b.sessions, b.d).find(
      (x) => x.agent === "planner",
    )!;
    expect(row.hubUnreachable).toBeUndefined();
  });

  it("a stopped agent: nothing (no Restart for its tools)", () => {
    const b = bed(new Date(Date.now() - 60_000).toISOString());
    noteHubMcpInit(b.stateDir, "planner", { ok: false, error: "x" });
    const stopped = b.sessions.map((s) => ({
      ...s,
      exited: true,
      exitCode: 0,
    }));
    const row = listedSessions(stopped, b.d).find(
      (x) => x.agent === "planner",
    )!;
    expect(row.hubUnreachable).toBeUndefined();
  });
});
