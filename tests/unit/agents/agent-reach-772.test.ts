/**
 * Issue 772: agentReach, what an agent may do, read for agent_prompt's
 * "privilege by proxy" check. Its mode now as a rank (agent_mode's order,
 * ask < edits < auto < all) and its grants. Anything Den can't tell is
 * unknown (a null rank, or null), and the caller reads unknown as wider.
 *
 * The rig's scripted PTY; nothing runs. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  agentReach,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { clearPermissionModesCache } from "../../../src/shared/agents/den-claude.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  clearPermissionModesCache();
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) =>
  cmdAgents(args, { ...r.deps, loginPath: async () => {} });

function persona(r: Rig, name: string): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n---\nYou work.\n`,
  );
  r.config.personaPacks = ["personas"];
}

describe("issue 772: agentReach", () => {
  it("no such agent: unknown", async () => {
    const r = await rig();
    expect(agentReach(resolveAgentsDeps(r.deps), "nobody")).toBeNull();
  }, 30_000);

  it("its own mode as a rank, and its grants", async () => {
    const r = await rig();
    persona(r, "scout");
    r.config.agents = { scout: { grants: ["south"] } };
    expect(await agents(r, "start", "-w", "north", "--persona", "scout")).toBe(
      0,
    );
    expect(await agents(r, "permission", "scout", "edits")).toBe(0);
    expect(agentReach(resolveAgentsDeps(r.deps), "scout")).toEqual({
      rank: 1,
      grants: ["south"],
    });
    expect(await agents(r, "permission", "scout", "all")).toBe(0);
    expect(agentReach(resolveAgentsDeps(r.deps), "scout")?.rank).toBe(3);
  }, 30_000);

  it("grants it holds that the config no longer gives: unknown", async () => {
    const r = await rig();
    persona(r, "scout");
    r.config.agents = { scout: { grants: ["south"] } };
    expect(await agents(r, "start", "-w", "north", "--persona", "scout")).toBe(
      0,
    );
    r.config.agents = {};
    expect(agentReach(resolveAgentsDeps(r.deps), "scout")).toBeNull();
  }, 30_000);

  it("running in a mode it would not get now (drift): rank unknown", async () => {
    const r = await rig();
    persona(r, "scout");
    expect(await agents(r, "start", "-w", "north", "--persona", "scout")).toBe(
      0,
    );
    // Started in the default (ask); its project's mode changed since.
    r.wsPermission.north = "all";
    expect(agentReach(resolveAgentsDeps(r.deps), "scout")?.rank).toBeNull();
  }, 30_000);
});
