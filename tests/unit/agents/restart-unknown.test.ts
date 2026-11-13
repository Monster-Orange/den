/**
 * `agents restart <unknown> -w <project>` (and `agents persona`) said
 * "waiting for agent <id>'s turn to end…" before "no agent". Now the agent
 * is checked first, and the closest one in that project is suggested.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

function stopped(r: Rig, id: string, workspace: string, displayName?: string) {
  writeRecord(r.stateDir, {
    id,
    persona: "planner",
    runtime: "den-claude",
    workspace,
    cwd: r.wsDir("north"),
    session: { backend: "den-pty", id: `s-${id}` },
    sessionName: `acme-${workspace}:${id}`,
    startedAt: "2026-11-06T09:30:00.000Z",
    stoppedAt: "2026-11-06T10:30:00.000Z",
    ...(displayName ? { displayName } : {}),
  });
}

describe("agents restart / persona: an agent that isn't there", () => {
  it("says no agent at once, with the closest one in that project", async () => {
    const r = await rig();
    stopped(r, "warm-greeter", "north");
    stopped(r, "planner", "north");
    stopped(r, "warm-greeter2", "south");
    expect(
      await cmdAgents(["restart", "warm-greter", "-w", "north"], r.deps),
    ).toBe(1);
    const err = r.err.join("\n");
    expect(err).toContain('no agent "warm-greter" in north');
    expect(err).toContain("did you mean warm-greeter?");
    expect(r.out.join("\n")).not.toContain("waiting for agent");
    r.err.length = 0;
    expect(
      await cmdAgents(
        ["persona", "warm-greter", "reviewer", "-w", "north", "--after-turn"],
        r.deps,
      ),
    ).toBe(1);
    expect(r.err.join("\n")).toContain("did you mean warm-greeter?");
    expect(r.out.join("\n")).not.toContain("waiting for agent");
  });

  it("nothing near: no guess", async () => {
    const r = await rig();
    stopped(r, "planner", "north");
    expect(await cmdAgents(["restart", "zzzzzz", "-w", "north"], r.deps)).toBe(
      1,
    );
    expect(r.err.join("\n")).toContain('no agent "zzzzzz" in north');
    expect(r.err.join("\n")).not.toContain("did you mean");
  });
});
