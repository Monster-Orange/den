/**
 * Issue 770: the Agents page's rows say Working or Idle for an agent whose
 * screen its runtime's rules read (activity), only while its session runs.
 * Blocked is the waiting mark instead (attention-screen-770.test.ts).
 *
 * The rig's scripted PTY; nothing runs. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  resolveAgentsDeps,
  startAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

describe("issue 770: Working / Idle on the agent's row", () => {
  it("working and idle are listed; blocked and unknown are not (the waiting mark says blocked)", async () => {
    const r = await rig();
    const d = resolveAgentsDeps({ ...r.deps, loginPath: async () => {} });
    await startAgent(d, { workspace: "north", persona: "planner" });
    await startAgent(d, { workspace: "north", persona: "reviewer" });
    const c = await connectHost(sessionPaths(r.stateDir).socket);
    const live = await c.list();
    c.close();
    const rows = (act: Record<string, string>) =>
      listedSessions(live, {
        stateDir: () => r.stateDir,
        dist: () => "acme",
        activeWorkspaces: () => ["north"],
        activity: () => new Map(Object.entries(act)),
      });
    const by = (act: Record<string, string>, id: string) =>
      rows(act).find((x) => x.agent === id)!;
    expect(by({ planner: "working" }, "planner").activity).toBe("working");
    expect(by({ planner: "idle" }, "planner").activity).toBe("idle");
    expect(by({ planner: "blocked" }, "planner").activity).toBeUndefined();
    expect(by({ planner: "working" }, "reviewer").activity).toBeUndefined();
    // Not running (no live session): nothing said.
    const gone = listedSessions([], {
      stateDir: () => r.stateDir,
      dist: () => "acme",
      activeWorkspaces: () => ["north"],
      activity: () => new Map([["planner", "working"]]),
    }).find((x) => x.agent === "planner");
    expect(gone?.activity).toBeUndefined();
  });
});
