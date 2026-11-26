import { describe, expect, it } from "@jest/globals";
import {
  heldActions,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";
import { HELD_WRITE_RISK } from "../../../src/shared/approval-policy.js";

function rig(own: number | null, install: number) {
  const written: { project: string; max: number | null }[] = [];
  const deps = {
    workspaceExists: (n: string) => n === "north" || n === "south",
    projectCap: {
      read: () => ({ own, install }),
      write: (project: string, max: number | null) =>
        void written.push({ project, max }),
    },
  } as unknown as HeldActionDeps;
  return { a: heldActions(deps).project_agent_cap, written };
}
const lead = { agent: "lead", project: "north" };

describe("issue 1634: project_agent_cap, an agent's ask for its project's cap", () => {
  it("lowering is routine; on Allow it writes the project's own value", async () => {
    const { a, written } = rig(null, 6);
    const c = await a.check({ project: "north", max: 2 }, lead);
    expect(c).toMatchObject({
      ok: true,
      params: { project: "north", from: "6 (the install's)", to: "2" },
    });
    expect((c as { personOnly?: boolean }).personOnly).toBeUndefined();
    if (!c.ok) return;
    await a.run(c.args);
    expect(written).toEqual([{ project: "north", max: 2 }]);
  });

  it("raising it is the person's own Allow; 0 clears it to the install's", async () => {
    const { a } = rig(2, 6);
    expect(await a.check({ project: "north", max: 4 }, lead)).toMatchObject({
      ok: true,
      personOnly: true,
    });
    const c = await a.check({ project: "north", max: 0 }, lead);
    expect(c).toMatchObject({
      ok: true,
      personOnly: true,
      args: { project: "north", max: null },
      params: { to: "6 (the install's)" },
    });
  });

  it("refuses past the install's cap, a bad value, another project, and no change", async () => {
    const { a } = rig(2, 6);
    expect(await a.check({ project: "north", max: 9 }, lead)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/agents\.max_per_project is 6/),
    });
    expect(await a.check({ project: "north", max: -1 }, lead)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/workspaces\.north\.agents\.max_per_project/),
    });
    expect(await a.check({ project: "south", max: 1 }, lead)).toMatchObject({
      ok: false,
    });
    expect(await a.check({ project: "north", max: 2 }, lead)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already 2/),
    });
  });

  it("is placed: it widens when raised", () => {
    expect(HELD_WRITE_RISK.project_agent_cap.risk).toBe("widens");
  });
});
