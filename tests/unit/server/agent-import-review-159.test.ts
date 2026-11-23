/**
 * Issue 159: the Allow for agent_import says what Den will do after it. A
 * conversation still open in a terminal is no longer refused: Den asks it
 * for its hand-off, closes that terminal and continues it here. When the
 * org config sets agents.import.hook, the Allow names the command, since
 * it runs on this Allow.
 */
import { describe, expect, it } from "@jest/globals";
import { heldActions } from "../../../src/ui/server/held-actions.js";

const SESSION = "0f1e2d3c-aaaa-bbbb-cccc-000000000159";

async function review(importHook?: () => string | undefined) {
  const a = heldActions({
    agentImport: async () => ({ ok: true }),
    workspaceExists: () => true,
    ...(importHook ? { importHook } : {}),
  } as never).agent_import!;
  const c = await a.check(
    { project: "north", session: SESSION, persona: "planner" },
    { agent: "scout", project: "north" },
  );
  if (!c.ok) throw new Error(c.error);
  return c as unknown as {
    details: string[];
    detailKeys: { key: string; vars?: Record<string, string> }[];
  };
}

describe("issue 159: the agent_import Allow says Den does the rest", () => {
  it("open in a terminal: Den asks for its hand-off, closes it and continues it here", async () => {
    const c = await review();
    const keys = c.detailKeys.map((k) => k.key);
    expect(keys).toContain("ap.det.agent_import.handover");
    expect(keys).not.toContain("ap.det.agent_import.refused");
    expect(c.details.join("\n")).toMatch(
      /still open in a terminal, Den asks it for its hand-off, closes that terminal/,
    );
    expect(keys).not.toContain("ap.det.agent_import.hook");
  });

  it("a hook set: the Allow names the command it runs", async () => {
    const c = await review(() => "lanes forget $DEN_IMPORT_PID");
    const hook = c.detailKeys.find((k) => k.key === "ap.det.agent_import.hook");
    expect(hook?.vars).toEqual({ hook: "lanes forget $DEN_IMPORT_PID" });
    expect(c.details.join("\n")).toContain("lanes forget $DEN_IMPORT_PID");
  });
});
