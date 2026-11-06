/**
 * `stack_namespace` shared by workspaces means one shared Compose project,
 * keyed by checkout (0.3.0-dev.36):
 *
 *  - two workspaces with `stack_namespace: main` bringing up the same stack
 *    from the same checkout run one project, `<stack>-main`, never two;
 *  - `stack down` from one while the other still holds it keeps it up; from
 *    the last, it stops;
 *  - a workspace in the same namespace on a different checkout is refused
 *    (identity_mismatch), naming both checkouts and the namespace;
 *  - a workspace skipping a healthy stack is still recorded as an owner;
 *  - DEN_STACK_WORKSPACE still wins, for one process;
 *  - the blueprint's value applies (and seeding carries it in).
 *
 * Real config in a throwaway distribution (acme/shop); docker is faked by
 * mocking spawnSync, as the other stack tests do, with a little state: the
 * projects `compose up` started and `compose down` stopped.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockSpawnSync = jest.fn();
jest.mock("child_process", () => ({
  ...(jest.requireActual("child_process") as object),
  spawnSync: (...a: unknown[]) => mockSpawnSync(...a),
}));

type StackCommand = typeof import("../../../src/ui/cli/stack-command.js");
type Status = typeof import("../../../src/shared/stacks/status.js");
type Runner =
  typeof import("../../../src/shared/environment-manager/service-runner.js");
type Seed =
  typeof import("../../../src/shared/environment-manager/default-workspace.js");
type WsMod =
  typeof import("../../../src/shared/environment-manager/workspaces.js");
let stack: StackCommand;
let status: Status;
let runner: Runner;
let seed: Seed;
let wsMod: WsMod;

let tmp = "";
let root = "";
let repos = "";
const saved = { ...process.env };

/** Compose projects the fake docker has running. */
const up = new Set<string>();
/** Every docker argv, in order. */
let calls: string[][] = [];

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fakeDocker(_cmd: unknown, a: unknown) {
  const args = a as string[];
  calls.push(args);
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  if (args[0] === "compose") {
    const p = args.indexOf("-p");
    const project = p >= 0 ? args[p + 1] : "";
    if (args.includes("config"))
      return ok(JSON.stringify({ name: project, services: { web: {} } }));
    if (args.includes("up") && project) up.add(project);
    if (args.includes("down") && project) up.delete(project);
    return ok();
  }
  if (args[0] === "ps") {
    const f = args.find((x) =>
      x.startsWith("label=com.docker.compose.project="),
    );
    const project = f?.split("=")[2] ?? "";
    if (args.includes("-q")) return ok(up.has(project) ? "c0ffee\n" : "");
    return ok(up.has(project) ? "web\trunning\tUp 1 minute\n" : "");
  }
  return ok();
}

/** Workspaces holding shop, each at a checkout, with a stack_namespace. */
function workspaces(
  list: { name: string; checkout: string; ns?: string }[],
  active = list.map((w) => w.name),
): void {
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      `active: [${active.join(", ")}]`,
      `focus: ${active[0]}`,
      "workspaces:",
      ...list.flatMap((w) => [
        `  ${w.name}:`,
        ...(w.ns ? [`    stack_namespace: ${w.ns}`] : []),
        "    services:",
        "      shop:",
        "        mode: dev-managed",
        `        path: ${path.join(repos, w.checkout)}`,
      ]),
      "",
    ].join("\n"),
  );
}

function shopRepo(dir: string): void {
  write(
    path.join(repos, dir, ".den.yml"),
    [
      "name: shop",
      "compose:",
      "  routes: { app: web:80 }",
      "services:",
      "  shop:",
      "    health:",
      "      local: { type: http, url: 'http://127.0.0.1:9/health' }",
      "",
    ].join("\n"),
  );
  write(path.join(repos, dir, "docker-compose.yml"), "services: {}\n");
}

async function stackCmd(workspace: string, argv: string[]): Promise<string> {
  process.env.DEN_WORKSPACE_OVERRIDE = workspace;
  const out: string[] = [];
  const log = jest.spyOn(console, "log").mockImplementation((...m) => {
    out.push(m.join(" "));
  });
  const err = jest.spyOn(console, "error").mockImplementation((...m) => {
    out.push(m.join(" "));
  });
  try {
    await stack.cmdStack(argv);
  } finally {
    log.mockRestore();
    err.mockRestore();
    delete process.env.DEN_WORKSPACE_OVERRIDE;
  }
  return out.join("\n");
}

/** The projects compose was asked to start or stop, in order. */
const composeProjects = (verb: "up" | "down"): string[] =>
  calls
    .filter((a) => a[0] === "compose" && a.includes(verb) && a.includes("-p"))
    .map((a) => a[a.indexOf("-p") + 1])
    .filter((p) => p !== undefined && !p.endsWith("edge"));

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-stack-ns-shared-")),
  );
  root = path.join(tmp, "den");
  repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "github_org: acme",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  publish: false",
      "  tls: none",
      "defaults:",
      "  workspaces:",
      "    ws-bp:",
      "      repos: [shop]",
      "      stack_namespace: main",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\n",
  );
  shopRepo("shop");
  shopRepo("shop-other");
  process.env.DEN_ROOT = root;
  process.env.DEN_HOME = path.join(tmp, "home");
  process.env.DEN_EDGE_DIR = path.join(tmp, "edge");
  process.env.DEN_DAEMONS_FILE = path.join(tmp, "daemons.json");
  delete process.env.DEN_STACK_WORKSPACE;
  delete process.env.DEN_WORKSPACE_OVERRIDE;
  stack = await import("../../../src/ui/cli/stack-command.js");
  status = await import("../../../src/shared/stacks/status.js");
  runner =
    await import("../../../src/shared/environment-manager/service-runner.js");
  seed =
    await import("../../../src/shared/environment-manager/default-workspace.js");
  wsMod = await import("../../../src/shared/environment-manager/workspaces.js");
});

afterAll(() => {
  process.env = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  up.clear();
  calls = [];
  mockSpawnSync.mockReset();
  mockSpawnSync.mockImplementation(fakeDocker);
  fs.rmSync(path.join(tmp, "edge"), { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "edge", "dynamic"), { recursive: true });
});

describe("two workspaces with stack_namespace: main", () => {
  beforeEach(() =>
    workspaces([
      { name: "ws-a", checkout: "shop", ns: "main" },
      { name: "ws-b", checkout: "shop", ns: "main" },
    ]),
  );

  it("run one project, shop-main: no second Compose project", async () => {
    await stackCmd("ws-a", ["up", "shop"]);
    const second = await stackCmd("ws-b", ["up", "shop"]);
    expect(composeProjects("up")).toEqual(["shop-main", "shop-main"]);
    expect([...up]).toEqual(["shop-main"]);
    expect(second).toMatch(/shared with \[ws-a\] \(stack namespace main\)/);
    expect(
      status
        .stackStatuses(status.loadStackContext("ws-b"))
        .map((s) => s.project),
    ).toEqual(["shop-main"]);
  });

  it("down from one keeps it up for the other; down from the last stops it", async () => {
    await stackCmd("ws-a", ["up", "shop"]);
    await stackCmd("ws-b", ["up", "shop"]);
    const first = await stackCmd("ws-a", ["down", "shop"]);
    expect(first).toMatch(
      /detached workspace "ws-a" — shop-main still running for \[ws-b\]/,
    );
    expect(composeProjects("down")).toEqual([]);
    expect(up.has("shop-main")).toBe(true);

    await stackCmd("ws-b", ["down", "shop"]);
    expect(composeProjects("down")).toEqual(["shop-main"]);
    expect(up.has("shop-main")).toBe(false);
  });

  it("a deactivated co-owner does not hold it: down stops it", async () => {
    await stackCmd("ws-a", ["up", "shop"]);
    await stackCmd("ws-b", ["up", "shop"]);
    workspaces(
      [
        { name: "ws-a", checkout: "shop", ns: "main" },
        { name: "ws-b", checkout: "shop", ns: "main" },
      ],
      ["ws-a"],
    );
    await stackCmd("ws-a", ["down", "shop"]);
    expect(composeProjects("down")).toEqual(["shop-main"]);
  });

  it("a workspace skipping it as healthy is recorded as an owner", async () => {
    await stackCmd("ws-a", ["up", "shop"]);
    const resolved = runner.resolveService("shop", "ws-b")!;
    expect(runner.claimHealthyService(resolved, "ws-b")).toBe("attached");
    await stackCmd("ws-a", ["down", "shop"]);
    expect(composeProjects("down")).toEqual([]);
    expect(up.has("shop-main")).toBe(true);
  });
});

describe("a different checkout in the same namespace", () => {
  beforeEach(() =>
    workspaces([
      { name: "ws-a", checkout: "shop", ns: "main" },
      { name: "ws-c", checkout: "shop-other", ns: "main" },
    ]),
  );

  it("is refused with the identity mismatch, naming both checkouts and the namespace", async () => {
    await stackCmd("ws-a", ["up", "shop"]);
    calls = [];
    let error: Error & { reason?: string } = new Error("none");
    try {
      await stackCmd("ws-c", ["up", "shop"]);
    } catch (e) {
      error = e as Error & { reason?: string };
    }
    expect(error.name).toBe("ServiceConflictError");
    expect(error.reason).toBe("identity_mismatch");
    expect(error.message).toContain('stack namespace "main"');
    expect(error.message).toContain(
      `[ws-a] at ${path.join(repos, "shop")} (branch: n/a)`,
    );
    expect(error.message).toContain(
      `differs from ${path.join(repos, "shop-other")} (branch: n/a) for workspace "ws-c"`,
    );
    // Nothing was started or swapped.
    expect(composeProjects("up")).toEqual([]);
    expect(up.has("shop-main")).toBe(true);
  });

  it("a healthy skip on the other checkout is a conflict, not a claim", async () => {
    await stackCmd("ws-a", ["up", "shop"]);
    const resolved = runner.resolveService("shop", "ws-c")!;
    expect(runner.claimHealthyService(resolved, "ws-c")).toBe("conflict");
  });

  it("once the project is down, the other checkout may start it", async () => {
    await stackCmd("ws-a", ["up", "shop"]);
    await stackCmd("ws-a", ["down", "shop"]);
    await stackCmd("ws-c", ["up", "shop"]);
    expect(composeProjects("up")).toEqual(["shop-main", "shop-main"]);
  });
});

describe("where the namespace comes from", () => {
  it("the blueprint's stack_namespace applies, and seeding carries it in", () => {
    workspaces([{ name: "ws-a", checkout: "shop" }]);
    expect(status.resolveStackWorkspaces("ws-bp", {})).toMatchObject({
      denWorkspace: "ws-bp",
      stackWorkspace: "main",
    });
    expect(status.resolveStackWorkspaces("ws-a", {}).stackWorkspace).toBe(
      "ws-a",
    );
    seed.seedBlueprintWorkspaces();
    expect(wsMod.readWorkspacesFile().workspaces["ws-bp"].stack_namespace).toBe(
      "main",
    );
  });

  it("DEN_STACK_WORKSPACE still wins, for one process", async () => {
    workspaces([{ name: "ws-a", checkout: "shop", ns: "main" }]);
    expect(
      status.resolveStackWorkspaces("ws-a", { DEN_STACK_WORKSPACE: "pr-12" }),
    ).toMatchObject({ stackWorkspace: "pr-12" });
    process.env.DEN_STACK_WORKSPACE = "pr-12";
    try {
      await stackCmd("ws-a", ["up", "shop"]);
    } finally {
      delete process.env.DEN_STACK_WORKSPACE;
    }
    expect(composeProjects("up")).toEqual(["shop-pr-12"]);
  });

  it("a bad stack_namespace is a config error naming the key", async () => {
    workspaces([{ name: "ws-a", checkout: "shop", ns: "Main" }]);
    await expect(stackCmd("ws-a", ["ls"])).rejects.toThrow(
      /workspaces\.ws-a\.stack_namespace/,
    );
  });
});
