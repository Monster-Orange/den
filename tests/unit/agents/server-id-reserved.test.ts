/**
 * Den's own agent is "server" in the server scope. A project's agent is
 * never given that id, so nothing that trusts the id (self_update: auto)
 * can be reached by a project's agent named "server".
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  resolveAgentsDeps,
  startAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

describe("a project's agent can't take Den's own agent's id", () => {
  it("--id server in a project is refused, and nothing is written", async () => {
    const r = await rig();
    await expect(
      startAgent(resolveAgentsDeps(r.deps), {
        workspace: "north",
        persona: "reviewer",
        id: "server",
      }),
    ).rejects.toThrow(/Den's own agent/);
    expect(readRecord(r.stateDir, "server")).toBeNull();
  });
});
