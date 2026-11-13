/**
 * `<cli> agents doctor -w <ws>` with the CLI's own workspace lookup (no
 * injected `workspaceExists`): the workspaces config is loaded first, as
 * `agents start` and `agents resume` do. It used to answer "workspaces not
 * loaded" for any -w. The workspaces file is a stub; nothing else of the
 * machine is read (the rig's deps).
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../../../src/shared/environment-manager/workspaces.js", () => ({
  ...(jest.requireActual(
    "../../../src/shared/environment-manager/workspaces.js",
  ) as object),
  readWorkspacesFile: () => ({
    active: ["north"],
    focus: "north",
    workspaces: { north: { services: {} } },
  }),
}));

import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { clearVersionCache } from "../../../src/shared/agents/runtime-search.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(async () => {
  clearVersionCache();
  await cleanupRigs();
});

describe("agents doctor -w, with the CLI's own workspace lookup", () => {
  it("checks the named workspace (and refuses one that does not exist) instead of failing to load workspaces", async () => {
    const r = await rig();
    const deps = {
      ...r.deps,
      loginPath: async () => {},
      apiOnly: () => ({ services: [] }),
    };
    delete deps.workspaceExists;
    for (const flag of ["-w", "--workspace"]) {
      r.out.length = 0;
      expect(await cmdAgents(["doctor", flag, "north", "--json"], deps)).toBe(
        0,
      );
      const body = JSON.parse(r.out.join("\n")) as { workspace?: string };
      expect(body.workspace).toBe("north");
    }
    expect(await cmdAgents(["doctor", "-w", "nowhere"], deps)).toBe(2);
    expect(r.err.join("\n")).toMatch(/project "nowhere" does not exist/);
    expect(r.err.join("\n")).not.toMatch(/not loaded/);
  });
});
