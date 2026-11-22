/**
 * Issue 1072: settings that widen what an agent may do are read from the
 * install's local config only (config/local/user.yml, which an agent's
 * sandbox can't write, issue 936), never from the distribution's config.
 *
 *   - agents.<id>.grants (the projects beyond its own its MCP serves)
 *   - mcp.actions (the action tools registered for agents)
 *
 * This release, the same keys in the distribution's config are not read:
 * `agents doctor` names each one and where to move it. A later release
 * refuses them there.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  readAgentsConfig,
  readMcpConfig,
  type DenConfig,
  type UserConfig,
} from "../../../src/shared/den-config.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const org = (o: Record<string, unknown>) =>
  ({ environments: [], ...o }) as unknown as DenConfig;
const user = (o: Record<string, unknown>) => o as unknown as UserConfig;

describe("agents.<id>.grants (issue 1072)", () => {
  it("in the distribution's config: not read, and named for doctor", () => {
    const c = readAgentsConfig(
      org({ agents: { planner: { grants: ["south"] } } }),
      user({}),
    );
    expect(c.agents.planner?.grants ?? []).toEqual([]);
    expect(c.notReadFromOrg).toEqual(["agents.planner.grants"]);
  });

  it("in user.yml: read, as before", () => {
    const c = readAgentsConfig(
      org({}),
      user({ agents: { planner: { grants: ["south", "south"] } } }),
    );
    expect(c.agents.planner?.grants).toEqual(["south"]);
    expect(c.notReadFromOrg ?? []).toEqual([]);
  });

  it("in user.yml: a bad one names its key, as before", () => {
    expect(() =>
      readAgentsConfig(org({}), user({ agents: { planner: { grants: "x" } } })),
    ).toThrow(/agents\.planner\.grants: must be a list of project names/);
    expect(() =>
      readAgentsConfig(
        org({}),
        user({ agents: { planner: { grants: ["../x"] } } }),
      ),
    ).toThrow(/agents\.planner\.grants\[0\]: "\.\.\/x" is not a project name/);
  });

  it("user.yml's other agents keys are never read as an agent", () => {
    const c = readAgentsConfig(
      org({}),
      user({
        agents: {
          runtimes: { "den-claude": { bin: "/x" } },
          layout: { order: ["a"] },
          planner: { grants: ["south"], sandbox: "off" },
        },
      }),
    );
    expect(Object.keys(c.agents)).toEqual(["planner"]);
    expect(c.agents.planner).toEqual({ grants: ["south"], sandbox: false });
  });

  it("a start mints the agent's token with user.yml's grants only", async () => {
    for (const [o, u, want] of [
      [{ agents: { planner: { grants: ["south"] } } }, {}, []],
      [{}, { agents: { planner: { grants: ["south"] } } }, ["south"]],
    ] as const) {
      const r = await rig();
      const packs = path.join(r.dir, "personas");
      fs.mkdirSync(packs, { recursive: true });
      fs.writeFileSync(
        path.join(packs, "planner.md"),
        "---\nname: planner\n---\nYou plan.\n",
      );
      const read = readAgentsConfig(org(o), user(u));
      r.config.personaPacks = ["personas"];
      r.config.agents = read.agents;
      expect(
        await cmdAgents(
          ["start", "-w", "north", "--persona", "planner"],
          r.deps,
        ),
      ).toBe(0);
      const tokens = JSON.parse(
        fs.readFileSync(path.join(r.stateDir, "actor-tokens.json"), "utf-8"),
      ) as { tokens: Record<string, { actor?: string; grants?: string[] }> };
      const mine = Object.values(tokens.tokens).filter(
        (t) => t.actor === "agent:planner",
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]!.grants ?? []).toEqual(want);
    }
  });
});

describe("mcp.actions (issue 1072)", () => {
  it("in the distribution's config: not read, and named for doctor", () => {
    const c = readMcpConfig(
      org({ mcp: { actions: ["service_up"] } }),
      user({}),
    );
    expect(c.actions).toEqual([]);
    expect(c.notReadFromOrg).toEqual(["mcp.actions"]);
  });

  it("in user.yml: read, an unknown one refused naming it", () => {
    expect(
      readMcpConfig(org({}), user({ mcp: { actions: ["service_up"] } }))
        .actions,
    ).toEqual(["service_up"]);
    expect(() =>
      readMcpConfig(org({}), user({ mcp: { actions: ["deploy"] } })),
    ).toThrow(/mcp\.actions: unknown action "deploy"/);
  });

  it("the narrowing keys stay in the distribution's config", () => {
    const c = readMcpConfig(
      org({ mcp: { approvals: false, run_tests: { envs: ["local"] } } }),
      user({}),
    );
    expect(c.approvals).toBe(false);
    expect(c.notReadFromOrg ?? []).toEqual([]);
  });
});

describe("agents doctor names what it no longer reads (issue 1072)", () => {
  it("says each key and where to move it", async () => {
    const r = await rig();
    r.config.notReadFromOrg = ["agents.planner.grants"];
    r.deps.mcpNotReadFromOrg = () => ["mcp.actions"];
    await cmdAgents(["doctor"], r.deps);
    const text = r.out.join("\n");
    expect(text).toContain("Settings read from config/local only");
    expect(text).toContain(
      "  agents.planner.grants is in the distribution's config, which Den no longer reads for it: move it to config/local/user.yml",
    );
    expect(text).toContain(
      "  mcp.actions is in the distribution's config, which Den no longer reads for it: move it to config/local/user.yml",
    );
  });
});
