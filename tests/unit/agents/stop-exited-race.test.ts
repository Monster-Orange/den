/**
 * Stop, when the agent ends on its own between Den reading it running and
 * Den asking the host to end it. The host refuses to end a session that has
 * already exited; for a stop that is the outcome asked for, so it is a
 * success, never a 503. Start fresh, Restart and a move all stop this way.
 *
 * A real host on a temp socket, a scripted PTY (nothing runs). The exit is
 * injected through the host client: the process exits, then the kill is
 * sent. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { resolveAgentsDeps, stopAgent } from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

/** Every client Den opens exits the agent's process just before a kill. */
function exitBeforeKill(r: Rig): void {
  const connect = r.deps.connect!;
  r.deps.connect = async () => {
    const c = await connect();
    const kill = c.kill.bind(c);
    c.kill = async (...args: Parameters<typeof c.kill>) => {
      for (const p of r.made) p.exit(0);
      await settle(50);
      return kill(...args);
    };
    return c;
  };
}

describe("stop: the agent exits between Den's look and its kill", () => {
  it("is a success: the record says stopped, and nothing throws", async () => {
    const r = await rig();
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    exitBeforeKill(r);
    const d = resolveAgentsDeps(r.deps);
    const out = await stopAgent(d, "planner", "north", { wait: true });
    expect(out.stillStopping).toBeUndefined();
    expect(readRecord(r.stateDir, "planner")?.stoppedAt).toEqual(
      expect.any(String),
    );
  });
});
