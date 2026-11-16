/**
 * Issue 225 (done-when 3): the mode the page shows is the mode the agent's
 * process runs in, read from its own command line (running-mode.ts), for
 * an agent with its own setting, one following its project and one
 * following its persona. The Agents page's rows (listedSessions) and
 * Settings › Project (projectModeView) both say it, with its source.
 *
 * The rig's scripted PTY; nothing runs. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  modeResolver,
  projectModeView,
  resolveAgentsDeps,
  startAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { intentOfCommandLine } from "../../../src/shared/agents/running-mode.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { clearPermissionModesCache } from "../../../src/shared/agents/den-claude.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  clearPermissionModesCache();
  await cleanupRigs();
});

function persona(r: Rig, name: string, extra = ""): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n${extra}---\nYou work.\n`,
  );
  r.config.personaPacks = ["personas"];
}

describe("issue 225: the mode shown is the running process's flag", () => {
  it("own setting, project and persona: each row's mode and source match its command line", async () => {
    const r = await rig();
    persona(r, "scout");
    persona(r, "pinned", "permission_mode: edits\n");
    persona(r, "solo", "permission_mode: edits\n");
    r.wsPermission.north = "auto";
    const d = resolveAgentsDeps({ ...r.deps, loginPath: async () => {} });
    // Each agent's process command line, as `ps` would print it.
    const line: Record<string, string> = {};
    const start = async (
      id: string,
      ws: string,
      extra: { permission?: string } = {},
    ) => {
      await startAgent(d, { workspace: ws, persona: id, ...extra });
      line[id] = ["claude", ...r.made.at(-1)!.args].join(" ");
    };
    await start("scout", "north"); // follows project north (auto)
    await start("pinned", "north", { permission: "ask" }); // its own setting
    await start("solo", "south"); // project south sets none: its persona's

    const c = await connectHost(sessionPaths(r.stateDir).socket);
    const live = await c.list();
    c.close();
    // Every fake session shares this process's pid: each agent's own line.
    const resolve = (rec: never, pid?: number) =>
      modeResolver(d, () => line[(rec as { id: string }).id])(rec, pid);
    const rows = listedSessions(live, {
      stateDir: () => r.stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north", "south"],
      modeOf: () => resolve,
    });
    const want = {
      scout: { mode: "auto", source: "project" },
      pinned: { mode: "ask", source: "own" },
      solo: { mode: "edits", source: "persona" },
    };
    for (const [id, w] of Object.entries(want)) {
      const row = rows.find((x) => x.agent === id)!;
      const flag = intentOfCommandLine(line[id]);
      expect({ id, flag }).toEqual({ id, flag: w.mode });
      expect({
        id,
        mode: row.mode,
        source: row.modeSource,
        running: row.modeRunning,
      }).toEqual({ id, mode: flag, source: w.source, running: flag });
    }

    // Settings › Project says the same, one resolver.
    const lineOf = () => null;
    const north = await projectModeView(d, "north", lineOf);
    expect(north).toMatchObject({ project: "north", mode: "auto", own: 1 });
    expect(
      north.agents.map((a) => [a.agent, a.mode, a.source, a.running]),
    ).toEqual([
      ["pinned", "ask", "own", undefined],
      ["scout", "auto", "project", undefined],
    ]);
    const south = await projectModeView(d, "south", lineOf);
    expect(south.agents.map((a) => [a.agent, a.mode, a.source])).toEqual([
      ["solo", "edits", "persona"],
    ]);

    // The project changes; scout's process still runs in auto: the page
    // says so ("runs as auto until restarted"), pinned keeps its own.
    r.wsPermission.north = "all";
    const scoutPid = live.find(
      (s) => s.ref.id === readRecord(r.stateDir, "scout")!.session.id,
    )!.pid!;
    const drift = await projectModeView(d, "north", (pid) =>
      pid === scoutPid ? line.scout : null,
    );
    expect(drift.agents.find((a) => a.agent === "scout")).toMatchObject({
      mode: "all",
      source: "project",
      running: "auto",
    });
    expect(drift.agents.find((a) => a.agent === "pinned")).toMatchObject({
      mode: "ask",
      source: "own",
    });
  }, 30_000);
});
