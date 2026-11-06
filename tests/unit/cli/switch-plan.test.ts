/**
 * WS-6.7, WS-6.8: what `<cli> switch <ws> [--stop-others]` does, worked
 * out before anything runs (src/ui/cli/switch-plan.ts).
 */
import { describe, expect, it } from "@jest/globals";
import {
  switchPlanFor,
  switchPlanLines,
} from "../../../src/ui/cli/switch-plan.js";
import type { WorkspacesFile } from "../../../src/shared/types/index.js";

const file = {
  active: [],
  focus: null,
  workspaces: {},
} as unknown as WorkspacesFile;
const REPOS: Record<string, string[]> = {
  north: ["notes", "api"],
  south: ["blog", "api"],
  east: ["docs", "blog"],
};
const reposOf = (ws: string) => REPOS[ws] ?? [];

describe("switchPlanFor", () => {
  it("starts the target's repos; stops the others' except shared ones, each once", () => {
    const p = switchPlanFor("north", ["north", "south", "east"], file, reposOf);
    expect(p.starts).toEqual(["notes", "api"]);
    // api is north's too: kept. blog is in south and east: stopped once.
    expect(p.stops).toEqual([
      { workspace: "south", repos: ["blog"] },
      { workspace: "east", repos: ["docs"] },
    ]);
    expect(p.keeps).toEqual([{ repo: "api", with: ["south"] }]);
  });

  it("only the workspaces on this machine are stopped", () => {
    const p = switchPlanFor("north", ["north", "south"], file, reposOf);
    expect(p.stops.map((s) => s.workspace)).toEqual(["south"]);
  });
});

describe("switchPlanLines", () => {
  const p = switchPlanFor("north", ["north", "south"], file, reposOf);
  it("Switch says nothing else stops", () => {
    expect(switchPlanLines(p, false)).toEqual([
      "Switch to north: nothing else stops",
      "Starts: what isn't running in north (notes, api)",
      "Keeps running: api (shared with south), agents and sessions",
    ]);
  });
  it("Stop & Switch lists what stops, starts and keeps running", () => {
    expect(switchPlanLines(p, true)).toEqual([
      "Stop & Switch to north",
      "Stops: south (blog)",
      "Starts: what isn't running in north (notes, api)",
      "Keeps running: api (shared with south), agents and sessions",
    ]);
  });
});
