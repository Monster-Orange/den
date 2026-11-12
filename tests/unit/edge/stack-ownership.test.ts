/**
 * D53: Den acts only on the Compose projects it started. A repo's manifest
 * can name a project something else runs: a stand-in manifest whose stack
 * renders to project "tools-hub", the name of a Hub started outside Den,
 * had ⌘K offer "Restart tools-hub/hub", which would have restarted that
 * Hub's real containers. Every container Den starts carries its owner
 * label; `up`, `down` and `restart` refuse a project holding any container
 * without this stack's mark.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockSpawnSync = jest.fn();
jest.mock("child_process", () => ({
  ...(jest.requireActual("child_process") as object),
  spawnSync: (...a: unknown[]) => mockSpawnSync(...a),
}));

import {
  DEN_OWNER_LABEL,
  projectOwnership,
  stackDown,
  stackOwner,
  stackRestartService,
  stackUp,
  type StackContext,
} from "../../../src/shared/stacks/runtime.js";
import type {
  ResolvedProject,
  StackConfig,
} from "../../../src/shared/stacks/types.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

let tmp: string;
let ctx: StackContext;
let s: StackConfig;
/** What `docker ps` lists for the project: name, owner label, config files. */
let rows: string[][];
let psFails = false;

const resolved: ResolvedProject = {
  name: "tools-hub",
  services: { hub: { ports: [{ target: 8080 }] } },
};

/** The compose calls that act: up, down, restart. */
const acted = () =>
  mockSpawnSync.mock.calls
    .map((c) => c[1] as string[])
    .filter(
      (a) =>
        a[0] === "compose" &&
        (a.includes("up") || a.includes("down") || a.includes("restart")),
    );

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-stack-own-")),
  );
  fs.mkdirSync(path.join(tmp, "repo"));
  fs.mkdirSync(path.join(tmp, "state", "dynamic"), { recursive: true });
  // The case: stack "tools" in namespace "hub" is project "tools-hub".
  s = {
    name: "tools",
    repo: "stand-in",
    repoPath: path.join(tmp, "repo"),
    files: ["docker-compose.yml"],
    routes: {},
    generate: [],
    uses: [],
    env: {},
    profiles: [],
  };
  ctx = {
    edge: {
      org: "acme",
      domain: "acme.localhost",
      aliases: [],
      stateDir: path.join(tmp, "state"),
      routes: {},
      workspaces: [],
      ports: null,
      tls: { strategy: "mkcert", ca: null },
    } as unknown as EdgeConfig,
    stacks: { tools: s },
    workspace: "hub",
  };
  rows = [];
  psFails = false;
  mockSpawnSync.mockReset();
  mockSpawnSync.mockImplementation((...a: unknown[]) => {
    const args = a[1] as string[];
    if (args[0] === "ps") {
      if (psFails) return { status: 1, stdout: "", stderr: "no docker" };
      return {
        status: 0,
        stdout: rows.map((r) => r.join("\t")).join("\n"),
        stderr: "",
      };
    }
    if (args.includes("config"))
      return { status: 0, stdout: JSON.stringify(resolved), stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The real Hub's container: started from its own checkout, no Den mark. */
const realHub = () => [
  "tools-hub-hub-1",
  "",
  "/Users/someone/src/tools-hub/docker-compose.yml",
];

describe("D53: a Compose project Den didn't start", () => {
  it("restart, down and up are refused, naming the project and its containers; nothing runs", () => {
    rows = [realHub(), ["tools-hub-db-1", "", "/elsewhere/compose.yml"]];
    const refused =
      /stack tools: Compose project "tools-hub" has containers .* didn't start for this stack \(tools-hub-hub-1, tools-hub-db-1\)/;
    expect(() => stackRestartService(ctx, s, "hub")).toThrow(refused);
    expect(() => stackDown(ctx, s)).toThrow(refused);
    expect(() => stackUp(ctx, s)).toThrow(refused);
    expect(() => stackUp(ctx, s)).toThrow(/compose\.name in the repo's/);
    expect(acted()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, "state", "stacks", "tools-hub"))).toBe(
      false,
    );
  });

  it("another install's mark, or another stack's, is not ours either", () => {
    rows = [["tools-hub-hub-1", "0123456789abcdef", ""]];
    expect(() => stackRestartService(ctx, s, "hub")).toThrow(
      /has containers .* didn't start/,
    );
    const other = { ...s, name: "mo" };
    rows = [
      [
        "tools-hub-hub-1",
        stackOwner({ ...ctx, workspace: "den-hub" }, other),
        "",
      ],
    ];
    expect(() => stackDown(ctx, s)).toThrow(/didn't start/);
    expect(acted()).toEqual([]);
  });

  it("its own containers: up marks every service; restart and down then act", () => {
    stackUp(ctx, s);
    const override = fs.readFileSync(
      path.join(tmp, "state", "stacks", "tools-hub", "override.yml"),
      "utf-8",
    );
    expect(override).toContain(
      `      "${DEN_OWNER_LABEL}": "${stackOwner(ctx, s)}"`,
    );
    rows = [["tools-hub-hub-1", stackOwner(ctx, s), ""]];
    stackRestartService(ctx, s, "hub");
    stackDown(ctx, s);
    expect(
      acted().map((a) => a.find((x) => ["up", "down", "restart"].includes(x))),
    ).toEqual(["up", "restart", "down"]);
  });

  it("a container Den started before the label: Compose's record of its files names this stack's override", () => {
    const override = path.join(
      tmp,
      "state",
      "stacks",
      "tools-hub",
      "override.yml",
    );
    const base = path.join(tmp, "repo", "docker-compose.yml");
    rows = [["tools-hub-hub-1", "", `${base},${override}`]];
    expect(projectOwnership(ctx, s)).toMatchObject({ ours: 1, foreign: [] });
    stackRestartService(ctx, s, "hub");
    expect(acted()).toHaveLength(1);
    // The same override with another repo's compose file is not.
    rows = [["tools-hub-hub-1", "", `/other/docker-compose.yml,${override}`]];
    expect(projectOwnership(ctx, s).foreign).toEqual(["tools-hub-hub-1"]);
  });

  it("no containers yet, or docker can't be asked: nothing to protect, so it goes on", () => {
    stackUp(ctx, s);
    psFails = true;
    expect(projectOwnership(ctx, s).known).toBe(false);
    stackRestartService(ctx, s, "hub");
    expect(acted()).toHaveLength(2);
  });
});

describe("D53: doctor names the projects Den's stacks can't call their own", () => {
  it("two stacks that render to one name; a project something else runs; one shared namespace on one checkout is no clash", async () => {
    const { stackProjectClashes } =
      await import("../../../src/shared/stacks/status.js");
    const { stackClashLines } =
      await import("../../../src/ui/cli/doctor-command.js");
    const st = (name: string, repo: string): StackConfig => ({
      ...s,
      name,
      repo,
      repoPath: path.join(tmp, repo),
    });
    const at = (
      workspace: string,
      denWorkspace: string,
      stacks: StackConfig[],
    ): StackContext => ({
      ...ctx,
      workspace,
      denWorkspace,
      stacks: Object.fromEntries(stacks.map((x) => [x.name, x])),
    });
    const contexts = [
      // "a-b" in namespace "c" and "a" in "b-c": both "a-b-c".
      at("c", "one", [st("a-b", "r1")]),
      at("b-c", "two", [st("a", "r2")]),
      // Two workspaces sharing namespace "team" on one checkout.
      at("team", "three", [st("web", "r3")]),
      at("team", "four", [st("web", "r3")]),
      // A stand-in whose project another tool's Hub runs.
      at("hub", "five", [st("tools", "stand-in")]),
    ];
    const clashes = stackProjectClashes(contexts, (c, x) => ({
      project: `${x.name}-${c.workspace}`,
      foreign: x.name === "tools" ? ["tools-hub-hub-1"] : [],
      ours: 0,
      known: true,
    }));
    expect(clashes).toEqual([
      { project: "a-b-c", stacks: ["a (two)", "a-b (one)"], foreign: [] },
      {
        project: "tools-hub",
        stacks: ["tools (five)"],
        foreign: ["tools-hub-hub-1"],
      },
    ]);
    const d = stackClashLines(clashes, "Acme", "acme");
    expect(d.check?.status).toBe("warn");
    expect(d.lines.join("\n")).toMatch(
      /Compose project "a-b-c" is the name of 2 stacks: a \(two\), a-b \(one\)/,
    );
    expect(d.lines.join("\n")).toMatch(
      /Compose project "tools-hub" \(stack tools \(five\)\) is running containers acme didn't start: tools-hub-hub-1\. Its up, down and restart are refused/,
    );
    expect(stackClashLines([], "Acme", "acme")).toEqual({ lines: [] });
  });
});
