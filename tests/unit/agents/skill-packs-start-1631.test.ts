import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { applyUserSandbox } from "../../../src/shared/den-config.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const pluginDir = (r: Rig, i: number) => {
  const a = r.made[i]!.args;
  const at = a.indexOf("--plugin-dir");
  return at < 0 ? undefined : a[at + 1];
};

async function startRig(): Promise<Rig> {
  const r = await rig();
  const cfg = path.join(r.dir, "claude-config");
  fs.mkdirSync(cfg);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: cfg };
  return r;
}

describe("issue 1631: an agent's start passes its skill packs", () => {
  it("on by default: a built pstack folder in Den's state folder", async () => {
    const r = await startRig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    const dir = pluginDir(r, 0);
    expect(dir).toBeDefined();
    expect(
      dir!.startsWith(path.join(r.stateDir, "skill-packs", "pstack@")),
    ).toBe(true);
    expect(fs.existsSync(path.join(dir!, "skills", "tdd", "SKILL.md"))).toBe(
      true,
    );
  });

  it("user.yml's agents.<id>.skill_packs: off starts it with none, and keeps its other keys", async () => {
    const r = await startRig();
    applyUserSandbox(r.config, {
      planner: { skill_packs: "off", grants: ["south"] },
    });
    expect(r.config.agents.planner?.grants).toEqual(["south"]);
    expect(r.config.agents.planner?.skillPacks).toBe("off");
    applyUserSandbox(r.config, { planner: { skill_packs: "off" } });
    r.config.agents.planner!.grants = [];
    await agents(r, "start", "-w", "north", "--persona", "planner");
    expect(pluginDir(r, 0)).toBeUndefined();
  });

  it("skill_packs.on: false in user.yml starts every agent with none", async () => {
    const r = await startRig();
    r.config.skillPacks = { den: undefined, user: { on: false } };
    await agents(r, "start", "-w", "north", "--persona", "planner");
    expect(pluginDir(r, 0)).toBeUndefined();
  });

  it("a bad skill_packs value refuses the start and names the key", async () => {
    const r = await startRig();
    r.config.skillPacks = {
      den: { pstack: { exclude: ["nope"] } },
      user: undefined,
    };
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).not.toBe(0);
    expect(r.err.join("\n")).toMatch(
      /den\.yml skill_packs\.pstack\.exclude\[0\]/,
    );
  });
});
