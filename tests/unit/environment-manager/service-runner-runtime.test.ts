import {
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import type { ChildProcess } from "child_process";
import type { ResolvedService } from "../../../src/shared/types/index.js";

jest.mock("../../../src/shared/manifest/read-manifest.js");
jest.mock("../../../src/shared/environment-manager/catalog.js");
jest.mock("../../../src/shared/environment-manager/workspaces.js");
jest.mock("../../../src/shared/process/spawn-streaming.js");
jest.mock("../../../src/shared/den-config.js");
jest.mock("../../../src/shared/terminal/tabs.js");
jest.mock("../../../src/shared/cli-tabs.js");
jest.mock("../../../src/shared/environment-manager/opctl.js");

import { readManifest } from "../../../src/shared/manifest/read-manifest.js";
import { readCatalog } from "../../../src/shared/environment-manager/catalog.js";
import {
  getActiveWorkspace,
  getFocusedWorkspaceName,
  getWorkspaceByName,
  getActiveWorkspaces,
  resolveServiceSource,
} from "../../../src/shared/environment-manager/workspaces.js";
import {
  getServiceLogPath,
  spawnStreaming,
} from "../../../src/shared/process/spawn-streaming.js";
import { readUserConfig } from "../../../src/shared/den-config.js";
import {
  closeTab,
  openTab,
  resolveTerminalApp,
  shellQuote,
} from "../../../src/shared/terminal/tabs.js";
import {
  forgetTab,
  lookupTab,
  recordTab,
} from "../../../src/shared/cli-tabs.js";
import {
  isOpctlAvailable,
  devOpContainerNames,
  diffSpawnedContainers,
  forceStopOpctlContainers,
  inspectOpctlContainer,
  listRunningOpctlContainers,
} from "../../../src/shared/environment-manager/opctl.js";
import {
  runServiceCommand,
  claimHealthyService,
  registerDaemon,
  listDaemons,
  pruneDeadDaemons,
  releaseWorkspaceDaemons,
  resolveServiceRuntime,
  unregisterDaemon,
  daemonRootOf,
} from "../../../src/shared/environment-manager/service-runner.js";
import { reapDeadDaemons } from "../../../src/ui/server/daemon-reaper.js";

const mockIsOpctlAvailable = isOpctlAvailable as jest.MockedFunction<
  typeof isOpctlAvailable
>;
const mockDevOpContainerNames = devOpContainerNames as jest.MockedFunction<
  typeof devOpContainerNames
>;
const mockListRunningOpctlContainers =
  listRunningOpctlContainers as jest.MockedFunction<
    typeof listRunningOpctlContainers
  >;
const mockInspectOpctlContainer = inspectOpctlContainer as jest.MockedFunction<
  typeof inspectOpctlContainer
>;
const mockForceStopOpctlContainers =
  forceStopOpctlContainers as jest.MockedFunction<
    typeof forceStopOpctlContainers
  >;
const mockDiffSpawnedContainers = diffSpawnedContainers as jest.MockedFunction<
  typeof diffSpawnedContainers
>;

const mockReadManifest = readManifest as jest.MockedFunction<
  typeof readManifest
>;
const mockReadCatalog = readCatalog as jest.MockedFunction<typeof readCatalog>;
const mockGetActiveWorkspace = getActiveWorkspace as jest.MockedFunction<
  typeof getActiveWorkspace
>;
const mockGetFocusedWorkspaceName =
  getFocusedWorkspaceName as jest.MockedFunction<
    typeof getFocusedWorkspaceName
  >;
const mockGetWorkspaceByName = getWorkspaceByName as jest.MockedFunction<
  typeof getWorkspaceByName
>;
const mockGetActiveWorkspaces = getActiveWorkspaces as jest.MockedFunction<
  typeof getActiveWorkspaces
>;
const mockResolveServiceSource = resolveServiceSource as jest.MockedFunction<
  typeof resolveServiceSource
>;
const mockSpawnStreaming = spawnStreaming as jest.MockedFunction<
  typeof spawnStreaming
>;
const mockGetServiceLogPath = getServiceLogPath as jest.MockedFunction<
  typeof getServiceLogPath
>;
const mockReadUserConfig = readUserConfig as jest.MockedFunction<
  typeof readUserConfig
>;
const mockOpenTab = openTab as jest.MockedFunction<typeof openTab>;
const mockCloseTab = closeTab as jest.MockedFunction<typeof closeTab>;
const mockResolveTerminalApp = resolveTerminalApp as jest.MockedFunction<
  typeof resolveTerminalApp
>;
const mockShellQuote = shellQuote as jest.MockedFunction<typeof shellQuote>;
const mockLookupTab = lookupTab as jest.MockedFunction<typeof lookupTab>;
const mockRecordTab = recordTab as jest.MockedFunction<typeof recordTab>;
const mockForgetTab = forgetTab as jest.MockedFunction<typeof forgetTab>;
const testDaemonsFile = path.join(
  os.tmpdir(),
  `den-service-runner-runtime-${process.pid}.json`,
);

function child(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

const resolved: ResolvedService = {
  address: "repo/api",
  repoName: "repo",
  subsystem: "api",
  repoPath: "/repos/repo",
  branch: null,
  mode: "dev-managed",
};

beforeEach(() => {
  jest.resetAllMocks();
  process.env.DEN_DAEMONS_FILE = testDaemonsFile;
  try {
    fs.unlinkSync(testDaemonsFile);
  } catch {
    /* ignore missing test registry */
  }
  mockReadCatalog.mockReturnValue({ repo: { gh: "Globex-Corp/repo" } });
  mockGetActiveWorkspace.mockReturnValue({
    name: "default",
    config: { services: { "repo/api": { mode: "dev-managed" } } },
  });
  mockGetFocusedWorkspaceName.mockReturnValue("default");
  mockGetActiveWorkspaces.mockReturnValue(["default"]);
  mockGetWorkspaceByName.mockImplementation((name: string) => {
    if (name !== "default") return null;
    return {
      name: "default",
      config: { services: { "repo/api": { mode: "dev-managed" as const } } },
    };
  });
  mockResolveServiceSource.mockReturnValue(resolved);
  mockIsOpctlAvailable.mockReturnValue(false);
  mockDevOpContainerNames.mockReturnValue([]);
  mockListRunningOpctlContainers.mockReturnValue([]);
  mockForceStopOpctlContainers.mockReturnValue({ stopped: [], failed: [] });
  // Mirror the real diff: bases in `after` that weren't in `before`.
  mockDiffSpawnedContainers.mockImplementation((before, after) => {
    const had = new Set(before.map((c) => c.base));
    return after.filter((c) => !had.has(c.base)).map((c) => c.base);
  });
  mockReadUserConfig.mockReturnValue({ terminal: "iterm2" });
  mockResolveTerminalApp.mockReturnValue("iterm2");
  mockShellQuote.mockImplementation((value) => `'${value}'`);
  mockOpenTab.mockReturnValue({ terminalApp: "iterm2", tabId: "tab-1" });
  mockRecordTab.mockImplementation((address, info) => ({
    address,
    ...info,
    startedAt: info.startedAt ?? new Date("2026-05-24T00:00:00.000Z"),
  }));
  mockReadManifest.mockReturnValue({
    services: {
      api: {
        commands: {
          local: {
            up: "make up",
            down: "make down",
          },
        },
      },
    },
  });
  mockSpawnStreaming.mockImplementation(
    (
      _command,
      _args,
      _env,
      _onLine,
      onClose,
    ): ReturnType<typeof spawnStreaming> => {
      onClose(0);
      return child() as ReturnType<typeof spawnStreaming>;
    },
  );
});

describe("resolveServiceRuntime", () => {
  // The web exec routes share this with the CLI, so `cli_tabs` means the same
  // thing whether an up is triggered from a terminal or the browser.
  afterEach(() => {
    delete process.env.DEN_FORCE_TABS;
  });

  it("returns daemon for non-starting commands regardless of preference", () => {
    mockReadUserConfig.mockReturnValue({ terminal: "iterm2", cli_tabs: true });
    expect(resolveServiceRuntime("down")).toBe("daemon");
    expect(resolveServiceRuntime("setup")).toBe("daemon");
  });

  it("honours cli_tabs for up and restart", () => {
    mockReadUserConfig.mockReturnValue({ terminal: "iterm2", cli_tabs: true });
    expect(resolveServiceRuntime("up")).toBe("tab");
    expect(resolveServiceRuntime("restart")).toBe("tab");

    mockReadUserConfig.mockReturnValue({ terminal: "iterm2", cli_tabs: false });
    expect(resolveServiceRuntime("up")).toBe("daemon");
  });

  it("lets DEN_FORCE_TABS override the preference both ways", () => {
    mockReadUserConfig.mockReturnValue({ terminal: "iterm2", cli_tabs: false });
    process.env.DEN_FORCE_TABS = "1";
    expect(resolveServiceRuntime("up")).toBe("tab");

    mockReadUserConfig.mockReturnValue({ terminal: "iterm2", cli_tabs: true });
    process.env.DEN_FORCE_TABS = "0";
    expect(resolveServiceRuntime("up")).toBe("daemon");
  });
});

describe("runServiceCommand tab runtime", () => {
  it("opens and records a terminal tab for tab-mode up", async () => {
    const onLine = jest.fn();
    const onClose = jest.fn();

    const result = runServiceCommand({
      address: "repo/api",
      command: "up",
      runtime: "tab",
      onLine,
      onClose,
    });

    expect(mockOpenTab).toHaveBeenCalledWith({
      cmd: "make up",
      cwd: "/repos/repo",
      label: "repo/api",
      terminalApp: "iterm2",
      env: {},
    });
    expect(mockRecordTab).toHaveBeenCalledWith("repo/api", {
      terminalApp: "iterm2",
      tabId: "tab-1",
      cwd: "/repos/repo",
      command: "make up",
    });
    expect(result.tab).toEqual({ terminalApp: "iterm2", tabId: "tab-1" });
    // onClose is deferred (never synchronous — see the zalgo guard suite).
    expect(onClose).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("closes and forgets a tracked tab after down succeeds", () => {
    mockLookupTab.mockReturnValue({
      address: "repo/api",
      terminalApp: "iterm2",
      tabId: "tab-1",
      startedAt: new Date("2026-05-24T00:00:00.000Z"),
    });
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine: jest.fn(),
      onClose,
    });

    expect(mockSpawnStreaming).toHaveBeenCalledWith(
      "make down",
      [],
      expect.any(Object),
      expect.any(Function),
      expect.any(Function),
      "/repos/repo",
      false,
      undefined,
      undefined,
    );
    expect(mockCloseTab).toHaveBeenCalledWith("tab-1", "iterm2");
    expect(mockForgetTab).toHaveBeenCalledWith("repo/api");
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("threads onServiceExit through to spawnStreaming so post-detach service deaths are observable", () => {
    // Review finding: daemon mode settles `up` via the detach timer + tail
    // close, never the service's real exit — without this plumbing a `make up`
    // dying after the window is invisible to fail-fast.
    const onServiceExit = jest.fn();
    runServiceCommand({
      address: "repo/api",
      command: "up",
      onLine: jest.fn(),
      onClose: jest.fn(),
      onServiceExit,
    });
    const call = mockSpawnStreaming.mock.calls[0];
    expect(call[6]).toBe(true); // detachable daemon path
    expect(call[8]).toBe(onServiceExit); // forwarded, not dropped
  });

  it("downs via opctl with PATH in the child env so opctl is found", () => {
    // Regression: the opctl-down branch passed bare buildServiceEnv() (no PATH)
    // to spawnStreaming, which uses it as the COMPLETE child env — so `opctl`
    // was not found and every teardown exited 1, leaving containers running.
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue(["repo"]);
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "repo-abc123", base: "repo" },
    ]);
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine: jest.fn(),
      onClose,
    });

    expect(mockSpawnStreaming).toHaveBeenCalledWith(
      "opctl container down 'repo' --force",
      [],
      expect.objectContaining({ PATH: process.env.PATH }),
      expect.any(Function),
      expect.any(Function),
      // /repos/repo doesn't exist on disk, and a nonexistent cwd makes spawn
      // fail with ENOENT — leaving every container running (the fresh-checkout
      // `down -a` failure). opctl stops containers by name; it doesn't need the
      // repo dir, so the cwd is omitted when the clone isn't there.
      undefined,
      false,
    );
    const envArg = mockSpawnStreaming.mock.calls[0][2] as NodeJS.ProcessEnv;
    expect(envArg.PATH).toBeTruthy();
  });

  it("uses the repo dir as cwd for opctl down when it exists on disk", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue(["repo"]);
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "repo-abc123", base: "repo" },
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-runner-"));
    try {
      mockResolveServiceSource.mockReturnValue({ ...resolved, repoPath: dir });
      runServiceCommand({
        address: "repo/api",
        command: "down",
        onLine: jest.fn(),
        onClose: jest.fn(),
      });
      expect(mockSpawnStreaming.mock.calls[0][5]).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats opctl down as SUCCESS when opctl exits 1 but the containers are gone (outcome verification)", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue(["repo"]);
    // 1st call: build targets (container running). 2nd call: post-down verify (gone).
    mockListRunningOpctlContainers
      .mockReturnValueOnce([{ name: "repo-abc123", base: "repo" }])
      .mockReturnValueOnce([]);
    mockSpawnStreaming.mockImplementation(
      (_c, _a, _e, _onLine, onClose): ReturnType<typeof spawnStreaming> => {
        onClose(1); // opctl's spurious non-zero exit on a successful teardown
        return child() as ReturnType<typeof spawnStreaming>;
      },
    );
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine,
      onClose,
    });

    expect(onClose).toHaveBeenCalledWith(0); // outcome wins over exit code
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("containers are stopped — down succeeded"),
    );
  });

  it("falls back to docker when opctl exits 1 and containers are still running", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue(["repo"]);
    // 1st: build targets. 2nd: still up after opctl. 3rd: gone after docker.
    mockListRunningOpctlContainers
      .mockReturnValueOnce([{ name: "repo-abc123", base: "repo" }])
      .mockReturnValueOnce([{ name: "repo-abc123", base: "repo" }])
      .mockReturnValueOnce([]);
    mockForceStopOpctlContainers.mockReturnValue({
      stopped: ["opctl_repo_abc123"],
      failed: [],
    });
    mockSpawnStreaming.mockImplementation(
      (_c, _a, _e, _onLine, onClose): ReturnType<typeof spawnStreaming> => {
        onClose(1);
        return child() as ReturnType<typeof spawnStreaming>;
      },
    );
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine,
      onClose,
    });

    expect(mockForceStopOpctlContainers).toHaveBeenCalledWith(["repo"]);
    expect(onClose).toHaveBeenCalledWith(0);
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("falling back to docker"),
    );
    expect(onLine).toHaveBeenCalledWith("docker rm -f opctl_repo_abc123");
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("docker fallback stopped remaining containers"),
    );
  });

  it("keeps the failure when opctl exits 1 AND docker fallback also fails", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue(["repo"]);
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "repo-abc123", base: "repo" },
    ]); // still running on every verify pass
    mockForceStopOpctlContainers.mockReturnValue({
      stopped: [],
      failed: ["opctl_repo_abc123"],
    });
    mockSpawnStreaming.mockImplementation(
      (_c, _a, _e, _onLine, onClose): ReturnType<typeof spawnStreaming> => {
        onClose(1);
        return child() as ReturnType<typeof spawnStreaming>;
      },
    );
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine,
      onClose,
    });

    expect(onClose).toHaveBeenCalledWith(1); // genuine failure preserved
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("docker fallback failed for"),
    );
  });

  it("maps legacy opctl kill down commands to opctl container delete", () => {
    mockReadManifest.mockReturnValue({
      services: {
        api: {
          commands: {
            local: {
              up: "make up",
              down: "opctl kill",
            },
          },
        },
      },
    });
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine,
      onClose,
    });

    expect(mockSpawnStreaming).toHaveBeenCalledWith(
      "opctl container delete --label container-name='repo'",
      [],
      expect.any(Object),
      expect.any(Function),
      expect.any(Function),
      "/repos/repo",
      false,
      undefined,
      undefined,
    );
    expect(onLine).toHaveBeenCalledWith(
      'legacy "opctl kill" mapped to opctl container delete for repo',
    );
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("maps legacy opctl kill inside synthesized restart commands", () => {
    mockReadManifest.mockReturnValue({
      services: {
        api: {
          commands: {
            local: {
              up: "make up",
              down: "opctl kill",
            },
          },
        },
      },
    });

    const result = runServiceCommand({
      address: "repo/api",
      command: "restart",
      onLine: jest.fn(),
      onClose: jest.fn(),
    });

    // A down step, then a detached up step (0.3.0-dev.38): never one
    // `<down> && <up>`, so the up's process group holds only the up. (The
    // mock closes each spawn at once, so the up follows the down here.)
    expect(result.detachable).toBe(true);
    expect(mockSpawnStreaming.mock.calls.map((c) => [c[0], c[6]])).toEqual([
      ["opctl container delete --label container-name='repo'", false],
      ["make up", true],
    ]);
  });

  it("keeps a tracked tab entry when tab close automation fails", () => {
    mockLookupTab.mockReturnValue({
      address: "repo/api",
      terminalApp: "iterm2",
      tabId: "tab-1",
      startedAt: new Date("2026-05-24T00:00:00.000Z"),
    });
    mockCloseTab.mockImplementation(() => {
      throw new Error("automation denied");
    });
    const onLine = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine,
      onClose: jest.fn(),
    });

    expect(mockForgetTab).not.toHaveBeenCalled();
    expect(onLine).toHaveBeenCalledWith("Warning: automation denied");
  });
});

describe("pruneDeadDaemons", () => {
  // Each record's checkout is on disk (a record whose checkout is gone is
  // stale, 0.3.0-dev.33), and its address resolves to that checkout.
  const repos = fs.mkdtempSync(path.join(os.tmpdir(), "den-prune-repos-"));
  const repoDir = (address: string) => {
    const dir = path.join(repos, address.split("/")[0]);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const rec = (address: string, containers?: string[]) => ({
    address,
    repoName: address.split("/")[0],
    subsystem: address.split("/")[1] ?? address,
    repoPath: repoDir(address),
    logPath: `/logs/${address}.log`,
    startedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...(containers ? { containers } : {}),
  });
  /** Every address resolves, each to its own record's checkout. */
  const resolveToOwnCheckout = () =>
    mockResolveServiceSource.mockImplementation((address: string) => ({
      ...resolved,
      address,
      repoName: address.split("/")[0],
      repoPath: repoDir(address),
    }));
  afterAll(() => fs.rmSync(repos, { recursive: true, force: true }));

  it("prunes daemons whose containers aren't running and keeps live ones", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue([]);
    resolveToOwnCheckout(); // resolves (in workspace)
    registerDaemon(rec("live/api", ["live"]));
    registerDaemon(rec("dead/api", ["dead"]));
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "opctl_live_abc", base: "live" },
    ]);

    const pruned = pruneDeadDaemons();

    expect(pruned).toEqual(["dead/api"]);
    expect(listDaemons().map((d) => d.address)).toEqual(["live/api"]);
  });

  it("drops daemons no longer resolvable to a workspace service", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue([]);
    mockResolveServiceSource.mockReturnValue(null); // not in workspace/catalog
    mockListRunningOpctlContainers.mockReturnValue([]);
    registerDaemon(rec("gone/api", ["gone"]));

    expect(pruneDeadDaemons()).toEqual(["gone/api"]);
    expect(listDaemons()).toEqual([]);
  });

  it("keeps daemons with no discoverable opctl containers (unverifiable)", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue([]); // non-opctl service
    resolveToOwnCheckout();
    mockListRunningOpctlContainers.mockReturnValue([]);
    registerDaemon(rec("web/app")); // no containers captured

    expect(pruneDeadDaemons()).toEqual([]);
    expect(listDaemons().map((d) => d.address)).toEqual(["web/app"]);
  });

  // Every root of a product shares one daemons file (the state dir is per
  // product). A second root's server must not prune the first's records
  // because they don't resolve in its own workspaces.
  const writeRecords = (records: object[]) =>
    fs.writeFileSync(
      testDaemonsFile,
      JSON.stringify({ denPid: 1, daemons: records }),
    );
  const json = (address: string, extra: object = {}) => ({
    ...rec(address),
    startedAt: "2026-05-01T00:00:00.000Z",
    ...extra,
  });

  it("stamps a registered daemon with this root", () => {
    resolveToOwnCheckout();
    registerDaemon(rec("repo/api"));
    const file = JSON.parse(fs.readFileSync(testDaemonsFile, "utf-8"));
    expect(typeof file.daemons[0].root).toBe("string");
  });

  it("keeps another root's daemons, resolvable here or not", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue([]);
    mockResolveServiceSource.mockReturnValue(null); // not in this root
    mockListRunningOpctlContainers.mockReturnValue([]);
    writeRecords([
      json("web/frontend", { root: "/elsewhere/other-root" }),
      json("dead/api", { root: "/elsewhere/other-root", containers: ["dead"] }),
    ]);

    expect(pruneDeadDaemons()).toEqual([]);
    // Still in the shared file, but not this root's to list.
    const file = JSON.parse(fs.readFileSync(testDaemonsFile, "utf-8"));
    expect(file.daemons.map((d: { address: string }) => d.address)).toEqual([
      "web/frontend",
      "dead/api",
    ]);
    expect(listDaemons()).toEqual([]);
  });

  it("prunes an unstamped (legacy) record only when verifiably dead", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue([]);
    mockResolveServiceSource.mockReturnValue(null);
    mockListRunningOpctlContainers.mockReturnValue([]);
    writeRecords([json("web/app"), json("dead/api", { containers: ["dead"] })]);

    expect(pruneDeadDaemons()).toEqual(["dead/api"]);
    expect(listDaemons().map((d) => d.address)).toEqual(["web/app"]);
  });

  it("both startup sweeps leave another root's and legacy records in the file", async () => {
    // A second root's server: the prune sweep, then the health reaper, over
    // a file shared with root A. Nothing of A's resolves here.
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue([]);
    mockResolveServiceSource.mockReturnValue(null);
    mockListRunningOpctlContainers.mockReturnValue([]);
    registerDaemon(rec("ghost/svc")); // this root's, unresolvable: goes
    const mine = JSON.parse(fs.readFileSync(testDaemonsFile, "utf-8"))
      .daemons as object[];
    writeRecords([
      ...mine,
      json("web/frontend", { root: "/elsewhere/root-a" }),
      json("legacy/svc"),
    ]);

    expect(pruneDeadDaemons()).toEqual(["ghost/svc"]);
    const reaped = await reapDeadDaemons({
      listDaemons,
      resolveService: () => null,
      getActiveWorkspaces: () => [],
      checkServiceHealth: async () => {
        throw new Error("no health check expected");
      },
      unregisterDaemon,
      delay: async () => undefined,
      retryDelayMs: 0,
      rootOf: daemonRootOf,
    });

    expect(reaped.removed).toEqual([]);
    const file = JSON.parse(fs.readFileSync(testDaemonsFile, "utf-8"));
    expect(file.daemons.map((d: { address: string }) => d.address)).toEqual([
      "web/frontend",
      "legacy/svc",
    ]);
  });

  it("deactivating a workspace never releases another root's daemon of the same name", async () => {
    // Both roots can have a workspace called "default".
    mockGetActiveWorkspaces.mockReturnValue([]);
    writeRecords([
      json("web/frontend", {
        root: "/elsewhere/root-a",
        workspaces: ["default"],
      }),
    ]);

    expect(await releaseWorkspaceDaemons("default")).toEqual([]);
    const file = JSON.parse(fs.readFileSync(testDaemonsFile, "utf-8"));
    expect(file.daemons).toHaveLength(1);
  });

  // A consumer's dev.32 dogfood finding: the repo was relocated, the record
  // (no pid, containers: []) kept its old repoPath, and the service now runs
  // as an unrelated compose container. Its address still resolved, so it was
  // kept forever and the Runs dock showed a permanent tab.
  it("drops a record whose checkout is gone, this root's or unstamped, though its address resolves (0.3.0-dev.33)", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue([]);
    resolveToOwnCheckout();
    // The new checkout's compose container runs under the repo's name.
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "shop", base: "shop" },
    ]);
    const gone = path.join(repos, "moved-away", "shop");
    // This root's stamp, as registerDaemon writes it.
    registerDaemon(rec("probe/api"));
    const here = JSON.parse(fs.readFileSync(testDaemonsFile, "utf-8"))
      .daemons[0].root as string;
    writeRecords([
      json("shop/api", { repoPath: gone, containers: [], root: here }),
      json("shop/worker", { repoPath: gone, containers: [] }),
      json("shop/db", {
        repoPath: gone,
        containers: [],
        root: "/elsewhere/root-a",
      }),
    ]);
    expect(daemonRootOf({ root: here })).toBe("here");

    expect(pruneDeadDaemons()).toEqual(["shop/api", "shop/worker"]);
    // Another root's record stays in the shared file.
    const file = JSON.parse(fs.readFileSync(testDaemonsFile, "utf-8"));
    expect(file.daemons.map((d: { address: string }) => d.address)).toEqual([
      "shop/db",
    ]);
  });

  it("drops a relocated record (its checkout still on disk, the service resolves elsewhere) when none of its containers run (0.3.0-dev.33)", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockImplementation((p: string) =>
      p.endsWith("old-shop") ? ["old-shop-dev"] : [],
    );
    resolveToOwnCheckout(); // shop/* now resolves to <repos>/shop
    mockListRunningOpctlContainers.mockReturnValue([
      // The relocated checkout's container, named after the repo.
      { name: "shop", base: "shop" },
      // A live container of the second record's.
      { name: "opctl_globex_1", base: "globex-api" },
    ]);
    const old = repoDir("old-shop");
    writeRecords([
      json("shop/api", { repoPath: old, containers: [] }),
      json("shop/worker", { repoPath: old, containers: ["globex-api"] }),
    ]);

    expect(pruneDeadDaemons()).toEqual(["shop/api"]);
    expect(listDaemons().map((d) => d.address)).toEqual(["shop/worker"]);
  });

  it("keeps a record that resolves to its own checkout with nothing verifiable (a possibly-live non-opctl process)", () => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue([]);
    resolveToOwnCheckout();
    mockListRunningOpctlContainers.mockReturnValue([]);
    writeRecords([json("web/app", { containers: [] })]);
    registerDaemon(rec("initech/api"));

    expect(pruneDeadDaemons()).toEqual([]);
    expect(listDaemons().map((d) => d.address)).toEqual([
      "web/app",
      "initech/api",
    ]);
  });

  it("keeps all daemons when opctl is unavailable (can't verify)", () => {
    mockIsOpctlAvailable.mockReturnValue(false);
    resolveToOwnCheckout();
    registerDaemon(rec("dead/api", ["dead"]));

    expect(pruneDeadDaemons()).toEqual([]);
    expect(listDaemons().map((d) => d.address)).toEqual(["dead/api"]);
  });
});

describe("up against untracked containers", () => {
  // Den can lose a daemon record while the containers keep running (server
  // restart, crash, reaper sweep). Bind mounts decide what happens next: the
  // same checkout is adopted back, a different one still blocks.
  beforeEach(() => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue(["repo"]);
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "repo-abc12345", base: "repo" },
    ]);
  });

  it("adopts containers running from the same checkout instead of blocking", async () => {
    mockInspectOpctlContainer.mockReturnValue({
      name: "opctl_repo_abc12345",
      mountSources: ["/repos/repo/.opspec/.empty-sibling", "/repos/repo"],
      startedAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "up",
      workspace: "default",
      onLine,
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onClose).toHaveBeenCalledWith(0);
    expect(mockSpawnStreaming).not.toHaveBeenCalled();
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("adopted already-running containers (repo)"),
    );
    const adopted = listDaemons().find((d) => d.address === "repo/api");
    expect(adopted?.workspaces).toEqual(["default"]);
    expect(adopted?.containers).toEqual(["repo"]);
    expect(adopted?.startedAt).toEqual(new Date("2026-08-01T10:00:00.000Z"));
  });

  it("still blocks when the running container is a different checkout", async () => {
    mockInspectOpctlContainer.mockReturnValue({
      name: "opctl_repo_abc12345",
      mountSources: ["/repos/repo-other"],
      startedAt: null,
    });
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "up",
      workspace: "default",
      onLine,
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onClose).toHaveBeenCalledWith(1);
    expect(mockSpawnStreaming).not.toHaveBeenCalled();
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("not tracked by den"),
    );
    expect(listDaemons()).toEqual([]);
  });

  it("blocks when the container can't be inspected (no evidence to adopt on)", async () => {
    mockInspectOpctlContainer.mockReturnValue(null);
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "up",
      workspace: "default",
      onLine: jest.fn(),
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onClose).toHaveBeenCalledWith(1);
    expect(listDaemons()).toEqual([]);
  });

  it("claimHealthyService adopts an untracked healthy service for the workspace", () => {
    mockInspectOpctlContainer.mockReturnValue({
      name: "opctl_repo_abc12345",
      mountSources: ["/repos/repo"],
      startedAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    expect(claimHealthyService(resolved, "files-api")).toBe("adopted");
    expect(
      listDaemons().find((d) => d.address === "repo/api")?.workspaces,
    ).toEqual(["files-api"]);
  });

  it("claimHealthyService adds the workspace as a co-owner of a tracked service", () => {
    registerDaemon({
      address: "repo/api",
      repoName: "repo",
      subsystem: "api",
      repoPath: "/repos/repo",
      branch: null,
      workspaces: ["default"],
      logPath: "/logs/repo-api.log",
      startedAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    expect(claimHealthyService(resolved, "files-api")).toBe("attached");
    expect(
      listDaemons().find((d) => d.address === "repo/api")?.workspaces,
    ).toEqual(["default", "files-api"]);
  });

  it("claimHealthyService leaves a record describing another checkout alone", () => {
    registerDaemon({
      address: "repo/api",
      repoName: "repo",
      subsystem: "api",
      repoPath: "/repos/repo-other",
      branch: null,
      workspaces: ["default"],
      logPath: "/logs/repo-api.log",
      startedAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    expect(claimHealthyService(resolved, "files-api")).toBe("untracked");
    expect(
      listDaemons().find((d) => d.address === "repo/api")?.workspaces,
    ).toEqual(["default"]);
  });

  it("adopts then bounces on restart (adoption is not a short-circuit)", async () => {
    mockInspectOpctlContainer.mockReturnValue({
      name: "opctl_repo_abc12345",
      mountSources: ["/repos/repo"],
      startedAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    runServiceCommand({
      address: "repo/api",
      command: "restart",
      workspace: "default",
      onLine: jest.fn(),
      onClose: jest.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(listDaemons().map((d) => d.address)).toEqual(["repo/api"]);
    expect(mockSpawnStreaming).toHaveBeenCalled();
  });
});

describe("up against a stale daemon record", () => {
  // Regression for the multi-workspace wedge: files-api's container was
  // SIGKILLed while its registry record survived, and every subsequent `up`
  // attached to the corpse ("already running (shared)") without starting
  // anything. A verifiably-dead record must be dropped and the up must spawn.
  const staleRecord = {
    address: "repo/api",
    repoName: "repo",
    subsystem: "api",
    repoPath: "/repos/repo",
    branch: null,
    workspaces: ["default"],
    logPath: "/logs/repo-api.log",
    startedAt: new Date("2026-08-01T10:00:00.000Z"),
    containers: ["repo"],
  };

  beforeEach(() => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue(["repo"]);
  });

  it("starts fresh when the registered daemon's containers are all gone", async () => {
    registerDaemon(staleRecord);
    mockListRunningOpctlContainers.mockReturnValue([]); // container was killed
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "up",
      workspace: "default",
      onLine,
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("stale daemon record for repo/api"),
    );
    expect(mockSpawnStreaming).toHaveBeenCalledWith(
      "make up",
      [],
      expect.any(Object),
      expect.any(Function),
      expect.any(Function),
      "/repos/repo",
      true,
      undefined,
      undefined,
    );
    expect(onLine).not.toHaveBeenCalledWith(
      expect.stringContaining("already running (shared)"),
    );
  });

  it("restart of a running shared instance says it is restarting it", async () => {
    registerDaemon(staleRecord);
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "repo-abc12345", base: "repo" },
    ]);
    const onLine = jest.fn();
    runServiceCommand({
      address: "repo/api",
      command: "restart",
      onLine,
      onClose: jest.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("restarting the running instance"),
    );
    expect(onLine).not.toHaveBeenCalledWith(
      expect.stringContaining("already running"),
    );
  });

  it("still attaches and short-circuits when the daemon's containers are running", async () => {
    // Second workspace sharing the same checkout — must attach, not respawn.
    mockGetWorkspaceByName.mockImplementation((name: string) => ({
      name,
      config: { services: { "repo/api": { mode: "dev-managed" as const } } },
    }));
    registerDaemon(staleRecord);
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "repo-abc12345", base: "repo" },
    ]);
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "up",
      workspace: "feat-x",
      onLine,
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onClose).toHaveBeenCalledWith(0);
    expect(mockSpawnStreaming).not.toHaveBeenCalled();
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("already running (shared)"),
    );
    expect(
      listDaemons().find((d) => d.address === "repo/api")?.workspaces,
    ).toEqual(["default", "feat-x"]);
  });

  it("clears a dead mismatched-identity record instead of raising a conflict", async () => {
    registerDaemon({ ...staleRecord, repoPath: "/repos/repo-other" });
    mockListRunningOpctlContainers.mockReturnValue([]); // other checkout's daemon is gone
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "up",
      workspace: "default",
      onLine,
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("stale daemon record for repo/api"),
    );
    expect(onLine).not.toHaveBeenCalledWith(expect.stringContaining("Error:"));
    expect(mockSpawnStreaming).toHaveBeenCalled();
  });
});

describe("auxiliary subsystem down scoping", () => {
  // Regression for the multi-workspace kill: downing files-api/s3 resolved
  // its targets by repo-wide convention and `docker rm -f`'d the files-api
  // API container another workspace owned. Auxiliary subsystems must never
  // claim the repo's main (entrypoint) container.
  const multiServiceManifest = {
    entrypoint: "api",
    services: {
      api: {
        commands: { local: { up: "make up", down: "make down" } },
      },
      s3: {
        commands: { local: { up: "make s3-up", down: "make s3-down" } },
      },
    },
  };

  beforeEach(() => {
    mockIsOpctlAvailable.mockReturnValue(true);
    mockDevOpContainerNames.mockReturnValue(["repo"]);
    // The repo's main (entrypoint) container is up.
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "repo-abc12345", base: "repo" },
    ]);
    mockReadManifest.mockReturnValue(multiServiceManifest);
  });

  it("down of an auxiliary subsystem leaves the repo's main container alone", async () => {
    mockResolveServiceSource.mockReturnValue({
      ...resolved,
      address: "repo/s3",
      subsystem: "s3",
    });
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/s3",
      command: "down",
      onLine,
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Falls through to the manifest down — no conventional opctl kill, no
    // docker sweep against the entrypoint's container.
    expect(mockSpawnStreaming).toHaveBeenCalledWith(
      "make s3-down",
      [],
      expect.any(Object),
      expect.any(Function),
      expect.any(Function),
      "/repos/repo",
      false,
      undefined,
      undefined,
    );
    expect(mockForceStopOpctlContainers).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("down of the entrypoint subsystem still takes the repo container", () => {
    mockResolveServiceSource.mockReturnValue(resolved); // repo/api
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine: jest.fn(),
      onClose,
    });

    expect(mockSpawnStreaming).toHaveBeenCalledWith(
      "opctl container down 'repo' --force",
      [],
      expect.any(Object),
      expect.any(Function),
      expect.any(Function),
      undefined,
      false,
    );
  });

  it("aux manifest `opctl container down` is not widened to the repo name", async () => {
    mockResolveServiceSource.mockReturnValue({
      ...resolved,
      address: "repo/s3",
      subsystem: "s3",
    });
    mockReadManifest.mockReturnValue({
      entrypoint: "api",
      services: {
        api: multiServiceManifest.services.api,
        s3: {
          commands: {
            local: {
              up: "make s3-up",
              down: "opctl container down repo-s3-bootstrap",
            },
          },
        },
      },
    });
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/s3",
      command: "down",
      onLine,
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Only the explicitly named base counts; "repo" (running) must not be
    // swept in, so there is nothing to stop.
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("nothing to stop"),
    );
    expect(mockForceStopOpctlContainers).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("registers auxiliary spawns with affinity-filtered container seeds and captures actually-spawned containers", () => {
    mockGetServiceLogPath.mockReturnValue("/logs/repo-s3.log");
    mockDevOpContainerNames.mockReturnValue(["repo", "repo-s3"]);
    mockResolveServiceSource.mockReturnValue({
      ...resolved,
      address: "repo/s3",
      subsystem: "s3",
    });
    // Nothing running before the spawn; the run creates repo-s3-bootstrap.
    mockListRunningOpctlContainers.mockReturnValue([]);
    mockSpawnStreaming.mockImplementation(
      (_c, _a, _e, _onLine, onClose): ReturnType<typeof spawnStreaming> => {
        mockListRunningOpctlContainers.mockReturnValue([
          {
            name: "opctl_repo-s3-bootstrap_abc12345",
            base: "repo-s3-bootstrap",
          },
        ]);
        onClose(0);
        return child() as ReturnType<typeof spawnStreaming>;
      },
    );

    runServiceCommand({
      address: "repo/s3",
      command: "up",
      workspace: "default",
      onLine: jest.fn(),
      onClose: jest.fn(),
    });

    const record = listDaemons().find((d) => d.address === "repo/s3");
    // Seeded with only the s3-affine declared name (never bare "repo"),
    // refined with what the run actually spawned.
    expect(record?.containers).toEqual(["repo-s3", "repo-s3-bootstrap"]);
  });
});

describe("workspace ownership refcount through runServiceCommand", () => {
  /** Make `names` resolvable workspaces so `-w`-style calls can target them. */
  function withWorkspaces(...names: string[]): void {
    mockGetActiveWorkspaces.mockReturnValue(names);
    mockGetWorkspaceByName.mockImplementation((name: string) =>
      names.includes(name)
        ? {
            name,
            config: {
              services: { "repo/api": { mode: "dev-managed" as const } },
            },
          }
        : null,
    );
  }

  function sharedDaemon(workspaces: string[], extra = {}): void {
    registerDaemon({
      address: "repo/api",
      repoName: "repo",
      subsystem: "api",
      repoPath: "/repos/repo",
      branch: null,
      workspaces,
      logPath: "/logs/repo-api.log",
      startedAt: new Date("2026-08-03T00:00:00.000Z"),
      ...extra,
    });
  }

  it("down detaches instead of stopping while another ACTIVE workspace owns it", async () => {
    withWorkspaces("wsA", "wsB");
    sharedDaemon(["wsA", "wsB"]);
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      workspace: "wsA",
      onLine,
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSpawnStreaming).not.toHaveBeenCalled();
    expect(onLine).toHaveBeenCalledWith(
      'detached workspace "wsA" — still running for [wsB]',
    );
    expect(listDaemons()[0].workspaces).toEqual(["wsB"]);
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("down really stops when the only OTHER owner has been deactivated", async () => {
    // The wedge: wsB is still recorded as an owner but is no longer active, so
    // it can neither run `down` nor be waited on. Counting it would leave the
    // service unstoppable without --force.
    withWorkspaces("wsA");
    sharedDaemon(["wsA", "wsB"]);

    runServiceCommand({
      address: "repo/api",
      command: "down",
      workspace: "wsA",
      onLine: jest.fn(),
      onClose: jest.fn(),
    });

    expect(mockSpawnStreaming.mock.calls[0]?.[0]).toBe("make down");
    expect(listDaemons()).toEqual([]);
  });

  it("down by a non-owner is a no-op that names --force as the way through", async () => {
    withWorkspaces("wsA", "wsB");
    sharedDaemon(["wsB"]);
    const onLine = jest.fn();
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "down",
      workspace: "wsA",
      onLine,
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSpawnStreaming).not.toHaveBeenCalled();
    expect(onLine).toHaveBeenCalledWith(
      expect.stringContaining("does not own running"),
    );
    expect(onLine).toHaveBeenCalledWith(expect.stringContaining("`--force`"));
    expect(listDaemons()[0].workspaces).toEqual(["wsB"]);
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("down --force stops a shared instance regardless of other owners", () => {
    withWorkspaces("wsA", "wsB");
    sharedDaemon(["wsA", "wsB"]);

    runServiceCommand({
      address: "repo/api",
      command: "down",
      workspace: "wsA",
      force: true,
      onLine: jest.fn(),
      onClose: jest.fn(),
    });

    expect(mockSpawnStreaming).toHaveBeenCalled();
    expect(listDaemons()).toEqual([]);
  });

  it("restart of a shared instance warns which workspaces it interrupts", () => {
    withWorkspaces("wsA", "wsB");
    sharedDaemon(["wsB"]);
    const onLine = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "restart",
      workspace: "wsA",
      onLine,
      onClose: jest.fn(),
    });

    expect(onLine).toHaveBeenCalledWith(
      "Warning: restarting a shared instance — this interrupts [wsB]",
    );
    // The warning informs, it doesn't block: the restart still runs.
    expect(mockSpawnStreaming).toHaveBeenCalled();
  });

  it("up attaches the workspace as an owner and short-circuits", async () => {
    withWorkspaces("wsA", "wsB");
    // A dev.37+ record carries its process group (a record without one is
    // a pre-dev.37 record: down-legacy-records.test.ts).
    sharedDaemon(["wsB"], {
      pgid: 2_000_000_000,
      pgidStartedAt: "Thu Jan  1 00:00:00 1970",
    });
    const onClose = jest.fn();

    runServiceCommand({
      address: "repo/api",
      command: "up",
      workspace: "wsA",
      onLine: jest.fn(),
      onClose,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSpawnStreaming).not.toHaveBeenCalled();
    expect(listDaemons()[0].workspaces).toEqual(["wsB", "wsA"]);
    expect(onClose).toHaveBeenCalledWith(0);
  });

  it("registerDaemon does not inherit owners from a record for a different checkout", () => {
    sharedDaemon(["wsB"]);
    registerDaemon({
      address: "repo/api",
      repoName: "repo",
      subsystem: "api",
      repoPath: "/repos/repo-other",
      branch: "feature",
      workspaces: ["wsA"],
      logPath: "/logs/repo-api.log",
      startedAt: new Date("2026-08-03T01:00:00.000Z"),
    });

    // wsB never started THIS instance, so it must not be refcounted against it.
    expect(listDaemons()[0].workspaces).toEqual(["wsA"]);
  });
});

describe("releaseWorkspaceDaemons (deactivate)", () => {
  function daemon(address: string, workspaces: string[]): void {
    registerDaemon({
      address,
      repoName: "repo",
      subsystem: "api",
      repoPath: "/repos/repo",
      branch: null,
      workspaces,
      logPath: `/logs/${address.replace("/", "-")}.log`,
      startedAt: new Date("2026-08-03T00:00:00.000Z"),
    });
  }

  /** Current workspaces.yml membership: workspace → its service keys. */
  let members: Record<string, string[]>;

  beforeEach(() => {
    // Post-deactivation world: "gone" has already left the active set.
    mockGetActiveWorkspaces.mockReturnValue(["keeper"]);
    members = { gone: ["repo/api"], keeper: [] };
    mockGetWorkspaceByName.mockImplementation((name: string) =>
      name in members
        ? {
            name,
            config: {
              services: Object.fromEntries(
                members[name].map((k) => [k, { mode: "dev-managed" as const }]),
              ),
            },
          }
        : null,
    );
  });

  it("detaches from a service another active workspace still owns", async () => {
    members.keeper = ["repo/api"];
    daemon("repo/api", ["gone", "keeper"]);

    const releases = await releaseWorkspaceDaemons("gone");

    expect(releases).toEqual([
      { address: "repo/api", outcome: "detached", remaining: ["keeper"] },
    ]);
    expect(mockSpawnStreaming).not.toHaveBeenCalled();
    expect(listDaemons()[0].workspaces).toEqual(["keeper"]);
  });

  it("stops a service it solely owns", async () => {
    daemon("repo/api", ["gone"]);

    const releases = await releaseWorkspaceDaemons("gone");

    expect(releases).toEqual([
      { address: "repo/api", outcome: "stopped", remaining: [] },
    ]);
    expect(mockSpawnStreaming).toHaveBeenCalled();
    expect(listDaemons()).toEqual([]);
  });

  it("stops a service whose only other owner is itself inactive", async () => {
    // Without the active-set filter this detaches and leaves the service
    // owned by two workspaces that can neither of them stop it.
    daemon("repo/api", ["gone", "also-inactive"]);

    const releases = await releaseWorkspaceDaemons("gone");

    expect(releases[0].outcome).toBe("stopped");
    expect(listDaemons()).toEqual([]);
  });

  it("leaves daemons the workspace never owned alone", async () => {
    daemon("repo/api", ["keeper"]);

    const releases = await releaseWorkspaceDaemons("gone");

    expect(releases).toEqual([]);
    expect(listDaemons()[0].workspaces).toEqual(["keeper"]);
  });

  it("reports a failed stop instead of silently dropping the record", async () => {
    daemon("repo/api", ["gone"]);
    mockSpawnStreaming.mockImplementation(
      (_c, _a, _e, _onLine, onClose): ReturnType<typeof spawnStreaming> => {
        onClose(1);
        return child() as ReturnType<typeof spawnStreaming>;
      },
    );

    const releases = await releaseWorkspaceDaemons("gone");

    expect(releases[0].outcome).toBe("stop-failed");
  });
});

describe("runServiceCommand never invokes onClose synchronously (zalgo guard)", () => {
  // Regression for the Jul 15 web-server crash: workspace Down hit a system
  // with no down command and nothing running; runServiceCommand called
  // onClose(0) SYNCHRONOUSLY, and the caller's callback closed over the
  // `const { proc }` binding being destructured from this very call — still
  // in TDZ → ReferenceError → the whole den daemon died.
  it("defers the nothing-to-stop close past the caller's own binding", async () => {
    mockReadManifest.mockReturnValue({
      services: { api: { commands: { local: { up: "make up" } } } }, // no down
    });
    mockIsOpctlAvailable.mockReturnValue(false);
    const closes: number[] = [];
    // The EXACT caller shape that crashed (workspace-routes doStart):
    const { proc } = runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine: jest.fn(),
      onClose: (code) => {
        // touching `proc` here is the crash on pre-fix code
        void proc;
        closes.push(code);
      },
    });
    expect(proc).toBeDefined();
    expect(closes).toEqual([]); // NOT called synchronously
    await new Promise((resolve) => setImmediate(resolve));
    expect(closes).toEqual([0]); // nothing-to-stop is still a successful down
  });

  it("defers the unknown-command error close too", async () => {
    mockReadManifest.mockReturnValue({
      services: { api: { commands: { local: {} } } },
    });
    mockIsOpctlAvailable.mockReturnValue(false);
    const closes: number[] = [];
    const { proc } = runServiceCommand({
      address: "repo/api",
      command: "preflight",
      onLine: jest.fn(),
      onClose: (code) => {
        void proc;
        closes.push(code);
      },
    });
    expect(closes).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closes).toEqual([1]);
  });
});

describe("runServiceCommand — remote services (R13)", () => {
  const remoteManifest = {
    name: "repo",
    services: {
      api: {
        runs: { local: "remote" as const },
        target: { env: "dev", account: "AWS" },
        commands: { local: { up: "make up", down: "make down" } },
      },
    },
  };

  it.each([
    ["up", "nothing to start here"],
    ["restart", "nothing to restart here"],
    ["seed", 'nothing to run "seed" on here'],
  ])(
    "refuses %s on a remote service and runs nothing",
    async (command, says) => {
      mockReadManifest.mockReturnValue(remoteManifest);
      const onLine = jest.fn();
      const onClose = jest.fn();
      runServiceCommand({ address: "repo/api", command, onLine, onClose });
      await new Promise((r) => setImmediate(r));
      expect(onLine).toHaveBeenCalledWith(
        `repo/api runs in dev (AWS); ${says}`,
      );
      expect(onClose).toHaveBeenCalledWith(1);
      expect(mockSpawnStreaming).not.toHaveBeenCalled();
      expect(mockOpenTab).not.toHaveBeenCalled();
    },
  );

  it("down on a remote service stops nothing and succeeds", async () => {
    mockReadManifest.mockReturnValue(remoteManifest);
    mockIsOpctlAvailable.mockReturnValue(true);
    mockListRunningOpctlContainers.mockReturnValue([
      { name: "opctl_repo_1", base: "repo" },
    ] as never);
    const onLine = jest.fn();
    const onClose = jest.fn();
    runServiceCommand({
      address: "repo/api",
      command: "down",
      onLine,
      onClose,
    });
    await new Promise((r) => setImmediate(r));
    expect(onLine).toHaveBeenCalledWith(
      "repo/api runs in dev (AWS); nothing to stop here",
    );
    expect(onClose).toHaveBeenCalledWith(0);
    expect(mockSpawnStreaming).not.toHaveBeenCalled();
  });
});
