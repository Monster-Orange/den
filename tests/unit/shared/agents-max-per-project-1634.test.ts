import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

type DenConfigMod = typeof import("../../../src/shared/den-config.js");
type RowsMod = typeof import("../../../src/shared/settings-cli-rows.js");
type ConfigCmd = typeof import("../../../src/ui/cli/config-command.js");
type CapMod = typeof import("../../../src/shared/agents/project-cap.js");

let root = "";
const savedRoot = process.env.DEN_ROOT;
let cfg: DenConfigMod;
let rows: RowsMod;
let cli: ConfigCmd;
let cap: CapMod;

const local = (f: string) => path.join(root, "config", "local", f);
const writeUser = (s: string) => fs.writeFileSync(local("user.yml"), s);
const writeProjects = (agents: Record<string, unknown> | null) =>
  fs.writeFileSync(
    local("workspaces.yml"),
    yaml.stringify({
      active: "north",
      workspaces: {
        north: { services: {}, ...(agents ? { agents } : {}) },
        south: { services: {} },
      },
    }),
  );

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1634-")));
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nagents:\n  max_concurrent: 100\n",
  );
  process.env.DEN_ROOT = root;
  cfg = await import("../../../src/shared/den-config.js");
  rows = await import("../../../src/shared/settings-cli-rows.js");
  cli = await import("../../../src/ui/cli/config-command.js");
  cap = await import("../../../src/shared/agents/project-cap.js");
});
afterAll(() => {
  if (savedRoot === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(local("user.yml"), { force: true });
  writeProjects(null);
});

describe("issue 1634: agents.max_per_project", () => {
  it("is an agent limit Settings, config and setting_change set", () => {
    expect(cfg.AGENTS_USER_LIMIT_KEYS).toContain("max_per_project");
    expect(cli.configKeyNames()).toContain("agents.max_per_project");
  });

  it("unset means no project limit: only the machine cap holds", () => {
    expect(cfg.readAgentsConfig().maxPerProject).toBe(0);
    expect(
      cfg.agentLimitInForce("max_per_project", {}, cfg.readDenConfig()),
    ).toEqual({ value: 0, from: "default" });
    expect(cap.projectAgentCap("north")).toEqual({
      limit: 0,
      key: "agents.max_per_project",
    });
  });

  it("user.yml's value holds every project without its own", () => {
    writeUser("agents:\n  max_per_project: 5\n");
    expect(cfg.readAgentsConfig().maxPerProject).toBe(5);
    expect(cap.projectAgentCap("south")).toEqual({
      limit: 5,
      key: "agents.max_per_project",
    });
  });

  it("a project's own value wins over the install's", () => {
    writeUser("agents:\n  max_per_project: 5\n");
    writeProjects({ max_per_project: 2 });
    expect(cap.projectAgentCap("north")).toEqual({
      limit: 2,
      key: "workspaces.north.agents.max_per_project",
    });
    expect(cap.projectAgentCap("south").limit).toBe(5);
  });

  it("a project's own value can't raise it past the install's", () => {
    writeUser("agents:\n  max_per_project: 3\n");
    writeProjects({ max_per_project: 9 });
    expect(cap.projectAgentCap("north")).toEqual({
      limit: 3,
      key: "agents.max_per_project",
    });
    fs.rmSync(local("user.yml"), { force: true });
    expect(cap.projectAgentCap("north")).toEqual({
      limit: 9,
      key: "workspaces.north.agents.max_per_project",
    });
  });

  it("a bad value is refused by its key", () => {
    for (const v of [-1, 1.5, "3", true])
      expect(cfg.agentsLimitValueError("max_per_project", v)).toMatch(
        /^agents\.max_per_project: /,
      );
    expect(cfg.agentsLimitValueError("max_per_project", 0)).toBeNull();
    writeProjects({ max_per_project: "lots" });
    expect(() => cap.projectAgentCap("north")).toThrow(
      /^workspaces\.north\.agents\.max_per_project: /,
    );
  });

  it("Settings saves it to user.yml, clears it, and refuses a bad one", () => {
    const user: Record<string, unknown> = {};
    expect(
      rows.patchCliRows(user, { agents_limits: { max_per_project: 6 } }),
    ).toEqual({ ok: true });
    expect(user.agents).toEqual({ max_per_project: 6 });
    rows.patchCliRows(user, { agents_limits: { max_per_project: null } });
    expect(user.agents).toBeUndefined();
    const r = rows.patchCliRows(user, {
      agents_limits: { max_per_project: -2 },
    });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/agents\.max_per_project/);
  });
});
