import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { MockedFunction } from "jest-mock";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

// readManifest is called by expandMonoRepoEntry / listWorkspaceServices / computeMissingDeps
jest.mock("../../../src/shared/manifest/read-manifest.js");
import type {
  ServiceCatalog,
  WorkspaceConfig,
  WorkspacesFile,
  RawManifest,
} from "../../../src/shared/types/index.js";
import { readManifest } from "../../../src/shared/manifest/read-manifest.js";

const mockReadManifest = readManifest as MockedFunction<typeof readManifest>;

// ── Notes on strategy ─────────────────────────────────────────────────────────
//
// workspaces.ts captures `const ROOT = process.cwd()` at module load time, so
// WORKSPACES_PATH is fixed. We mock the entire `fs` module so that
// readFileSync / writeFileSync / mkdirSync are jest.fn()s that we intercept
// without touching disk. parseAddress and resolveServiceSource are pure /
// catalog-driven and require no fs mocking.

jest.mock("fs");

const mockFs = fs as jest.Mocked<typeof fs>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCatalog(...names: string[]): ServiceCatalog {
  return Object.fromEntries(names.map((n) => [n, { gh: `Globex-Corp/${n}` }]));
}

function makeWorkspace(
  services: Record<string, { mode: string; path?: string; branch?: string }>,
  extra?: Partial<WorkspaceConfig>,
): WorkspaceConfig {
  return { services, ...extra } as WorkspaceConfig;
}

afterEach(() => {
  delete process.env.DEN_WORKSPACE_OVERRIDE;
  jest.resetAllMocks();
});

// ── parseAddress ──────────────────────────────────────────────────────────────

describe("parseAddress", () => {
  // Import parseAddress directly — it is a pure function and does not touch the
  // filesystem, so no mocking is needed.
  let parseAddress: typeof import("../../../src/shared/environment-manager/workspaces.js").parseAddress;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    parseAddress = mod.parseAddress;
  });

  it("bare name (no slash) → repoName and subsystem both equal the name", () => {
    expect(parseAddress("shop")).toEqual({
      repoName: "shop",
      subsystem: "shop",
    });
  });

  it("bare name with no catalog provided is symmetric", () => {
    expect(parseAddress("tasks-runner")).toEqual({
      repoName: "tasks-runner",
      subsystem: "tasks-runner",
    });
  });

  it("slash address with no catalog → first segment is repoName, rest is subsystem", () => {
    expect(parseAddress("shop/api")).toEqual({
      repoName: "shop",
      subsystem: "api",
    });
  });

  it("slash address with empty catalog → falls back to first-slash split", () => {
    expect(parseAddress("shop/api", {})).toEqual({
      repoName: "shop",
      subsystem: "api",
    });
  });

  it("exact catalog match: full address is itself a catalog key (nested repo path)", () => {
    const catalog = makeCatalog("org/project");
    expect(parseAddress("org/project", catalog)).toEqual({
      repoName: "org/project",
      subsystem: "org/project",
    });
  });

  it("longest-prefix match: shop in catalog, address is shop/api", () => {
    const catalog = makeCatalog("shop");
    expect(parseAddress("shop/api", catalog)).toEqual({
      repoName: "shop",
      subsystem: "api",
    });
  });

  it("longest-prefix match: org/project in catalog, address is org/project/svc", () => {
    const catalog = makeCatalog("org/project");
    expect(parseAddress("org/project/svc", catalog)).toEqual({
      repoName: "org/project",
      subsystem: "svc",
    });
  });

  it("exact match takes priority over prefix match when both could apply", () => {
    // catalog has both "a/b" and "a" — full address "a/b" should match exactly
    const catalog: ServiceCatalog = {
      "a/b": { gh: "Globex-Corp/a-b" },
      a: { gh: "Globex-Corp/a" },
    };
    expect(parseAddress("a/b", catalog)).toEqual({
      repoName: "a/b",
      subsystem: "a/b",
    });
  });

  it("longest prefix wins when multiple catalog prefixes match", () => {
    // "org/project/svc": prefixes are "org/project" and "org" — longer prefix wins
    const catalog: ServiceCatalog = {
      "org/project": { gh: "Globex-Corp/org-project" },
      org: { gh: "Globex-Corp/org" },
    };
    expect(parseAddress("org/project/svc", catalog)).toEqual({
      repoName: "org/project",
      subsystem: "svc",
    });
  });

  it("falls back to first-slash split when catalog is provided but has no matching prefix", () => {
    const catalog = makeCatalog("other-repo");
    expect(parseAddress("shop/api", catalog)).toEqual({
      repoName: "shop",
      subsystem: "api",
    });
  });
});

// ── readWorkspacesFile / writeWorkspacesFile ──────────────────────────────────

describe("readWorkspacesFile / writeWorkspacesFile", () => {
  it("returns the default file structure when no workspaces file exists", async () => {
    const { readWorkspacesFile } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    mockFs.readFileSync.mockImplementation((...args: unknown[]) => {
      const filePath = args[0] as string;
      if (filePath.endsWith("workspaces.yml")) {
        const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        throw err;
      }
      throw new Error(`Unexpected readFileSync call: ${String(filePath)}`);
    });

    const result = readWorkspacesFile();
    expect(result.active).toEqual(["default"]);
    expect(result.focus).toBe("default");
    expect(result.workspaces).toHaveProperty("default");
    expect(result.workspaces.default.services).toEqual({});
  });

  it("parses a valid YAML workspaces file correctly", async () => {
    const { readWorkspacesFile } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    const fileContent = {
      active: "feature-xyz",
      workspaces: {
        default: { services: {} },
        "feature-xyz": {
          services: {
            "shop/api": { mode: "dev-managed", path: "/home/dev/shop" },
          },
        },
      },
    };

    mockFs.readFileSync.mockReturnValue(
      yaml.stringify(fileContent) as unknown as Buffer,
    );
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.renameSync.mockReturnValue(undefined);

    const result = readWorkspacesFile();
    expect(result.active).toEqual(["feature-xyz"]);
    expect(result.focus).toBe("feature-xyz");
    expect(result.workspaces["feature-xyz"].services["shop/api"].mode).toBe(
      "dev-managed",
    );
  });

  it("coerces legacy active string to active array and sets focus", async () => {
    const { readWorkspacesFile } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    mockFs.readFileSync.mockReturnValue(
      yaml.stringify({
        active: "default",
        workspaces: { default: { services: {} } },
      }) as unknown as Buffer,
    );
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.renameSync.mockReturnValue(undefined);

    const result = readWorkspacesFile();
    expect(result.active).toEqual(["default"]);
    expect(result.focus).toBe("default");
  });

  it("preserves multi-active array and focus when already migrated", async () => {
    const { readWorkspacesFile } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    mockFs.readFileSync.mockReturnValue(
      yaml.stringify({
        active: ["default", "feat-x"],
        focus: "feat-x",
        workspaces: {
          default: { services: {} },
          "feat-x": { services: {} },
        },
      }) as unknown as Buffer,
    );

    const result = readWorkspacesFile();
    expect(result.active).toEqual(["default", "feat-x"]);
    expect(result.focus).toBe("feat-x");
  });

  it("normalizes legacy mode value 'linked' to 'dev-managed'", async () => {
    const { readWorkspacesFile } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    const rawYaml = yaml.stringify({
      active: "default",
      workspaces: {
        default: {
          services: {
            api: { mode: "linked", path: "/repos/api" },
          },
        },
      },
    });

    mockFs.readFileSync.mockReturnValue(rawYaml as unknown as Buffer);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.renameSync.mockReturnValue(undefined);

    const result = readWorkspacesFile();
    expect(result.workspaces.default.services["api"].mode).toBe("dev-managed");
  });

  it("normalizes legacy mode value 'managed' to 'managed'", async () => {
    const { readWorkspacesFile } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    const rawYaml = yaml.stringify({
      active: "default",
      workspaces: {
        default: {
          services: {
            db: { mode: "managed", branch: "main" },
          },
        },
      },
    });

    mockFs.readFileSync.mockReturnValue(rawYaml as unknown as Buffer);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.renameSync.mockReturnValue(undefined);

    const result = readWorkspacesFile();
    expect(result.workspaces.default.services["db"].mode).toBe("managed");
  });

  it("re-throws errors that are not ENOENT", async () => {
    const { readWorkspacesFile } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    mockFs.readFileSync.mockImplementation(() => {
      const err = Object.assign(new Error("Permission denied"), {
        code: "EACCES",
      });
      throw err;
    });

    expect(() => readWorkspacesFile()).toThrow("Permission denied");
  });

  it("writeWorkspacesFile creates the directory and writes YAML", async () => {
    const { writeWorkspacesFile } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    let writtenContent = "";
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockImplementation((...args: unknown[]) => {
      writtenContent = args[1] as string;
    });
    mockFs.renameSync.mockReturnValue(undefined);

    const file: WorkspacesFile = {
      active: ["default"],
      focus: "default",
      workspaces: { default: { services: {} } },
    };

    writeWorkspacesFile(file);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("config"),
      expect.objectContaining({ recursive: true }),
    );
    const parsed = yaml.parse(writtenContent) as WorkspacesFile;
    expect(parsed.active).toEqual(["default"]);
  });

  it("writeWorkspacesFile removes the temp file when the atomic rename fails", async () => {
    const { writeWorkspacesFile } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    let tmpPath = "";
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockImplementation((...args: unknown[]) => {
      tmpPath = args[0] as string;
    });
    mockFs.renameSync.mockImplementation(() => {
      throw new Error("EACCES: rename failed");
    });

    const file: WorkspacesFile = {
      active: ["default"],
      focus: "default",
      workspaces: { default: { services: {} } },
    };

    expect(() => writeWorkspacesFile(file)).toThrow("rename failed");
    expect(tmpPath).toContain(".tmp");
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(tmpPath);
  });
});

// ── resolveServiceSource ──────────────────────────────────────────────────────

describe("resolveServiceSource", () => {
  let resolveServiceSource: typeof import("../../../src/shared/environment-manager/workspaces.js").resolveServiceSource;
  let DEN_SERVICES_DIR: string;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    resolveServiceSource = mod.resolveServiceSource;
    DEN_SERVICES_DIR = mod.DEN_SERVICES_DIR;
  });

  it("returns null when the repo is not in the catalog", () => {
    const catalog = makeCatalog("other-repo");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });

    const result = resolveServiceSource("api", "default", workspace, catalog);
    expect(result).toBeNull();
  });

  it("returns null when the service is not in the workspace", () => {
    const catalog = makeCatalog("api");
    const workspace = makeWorkspace({}); // api not in workspace services

    const result = resolveServiceSource("api", "default", workspace, catalog);
    expect(result).toBeNull();
  });

  it("managed: path is .den-services/<repo>/<branch>/", () => {
    const catalog = makeCatalog("my-service");
    const workspace = makeWorkspace({
      "my-service": { mode: "managed", branch: "feat/xyz" },
    });

    const result = resolveServiceSource(
      "my-service",
      "default",
      workspace,
      catalog,
    );

    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe(
      path.join(DEN_SERVICES_DIR, "my-service", "feat/xyz"),
    );
    expect(result!.branch).toBe("feat/xyz");
    expect(result!.mode).toBe("managed");
  });

  it("managed: defaults branch to 'main' when branch not specified", () => {
    const catalog = makeCatalog("my-service");
    const workspace = makeWorkspace({
      "my-service": { mode: "managed" },
    });

    const result = resolveServiceSource(
      "my-service",
      "default",
      workspace,
      catalog,
    );

    expect(result).not.toBeNull();
    expect(result!.branch).toBe("main");
    expect(result!.repoPath).toContain("main");
  });

  it("dev-managed: repoPath comes from wsEntry.path", () => {
    const catalog = makeCatalog("my-service");
    const workspace = makeWorkspace({
      "my-service": { mode: "dev-managed", path: "/home/dev/my-service" },
    });

    const result = resolveServiceSource(
      "my-service",
      "default",
      workspace,
      catalog,
    );

    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe("/home/dev/my-service");
    expect(result!.branch).toBeNull();
    expect(result!.mode).toBe("dev-managed");
  });

  it("dev-managed: repoPath is empty string when path not provided", () => {
    const catalog = makeCatalog("my-service");
    const workspace = makeWorkspace({
      "my-service": { mode: "dev-managed" },
    });

    const result = resolveServiceSource(
      "my-service",
      "default",
      workspace,
      catalog,
    );

    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe("");
  });

  it("mono-repo: falls back from subsystem address to bare repo-name key in workspace", () => {
    const catalog = makeCatalog("shop");
    // Workspace has bare "shop" key, but address is "shop/api"
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
    });

    const result = resolveServiceSource(
      "shop/api",
      "default",
      workspace,
      catalog,
    );

    expect(result).not.toBeNull();
    expect(result!.repoName).toBe("shop");
    expect(result!.subsystem).toBe("api");
    expect(result!.repoPath).toBe("/repos/shop");
  });

  it("exact workspace entry takes priority over bare repo-name fallback", () => {
    const catalog = makeCatalog("shop");
    // Both "shop/api" and bare "shop" exist in workspace
    const workspace = makeWorkspace({
      "shop/api": {
        mode: "dev-managed",
        path: "/repos/shop-api-specific",
      },
      shop: { mode: "dev-managed", path: "/repos/shop" },
    });

    const result = resolveServiceSource(
      "shop/api",
      "default",
      workspace,
      catalog,
    );

    expect(result).not.toBeNull();
    expect(result!.repoPath).toBe("/repos/shop-api-specific");
  });

  it("feature workspace: uses workspace.directory + workspace.repos branch", () => {
    const catalog = makeCatalog("shop");
    const workspace = makeWorkspace(
      {
        shop: { mode: "managed", branch: "feat/old" },
      },
      {
        directory: ".den-workspaces/my-feature",
        repos: { shop: "feat/my-feature" },
      },
    );

    const result = resolveServiceSource(
      "shop",
      "my-feature",
      workspace,
      catalog,
    );

    expect(result).not.toBeNull();
    // Should use workspace.directory path, not .den-services
    expect(result!.repoPath).toContain(".den-workspaces/my-feature");
    expect(result!.repoPath).toContain("shop");
    expect(result!.branch).toBe("feat/my-feature");
    expect(result!.repoPath).not.toContain(".den-services");
  });

  it("returns correct address, repoName, subsystem in resolved output", () => {
    const catalog = makeCatalog("tasks-runner");
    const workspace = makeWorkspace({
      "tasks-runner": { mode: "dev-managed", path: "/repos/tce" },
    });

    const result = resolveServiceSource(
      "tasks-runner",
      "default",
      workspace,
      catalog,
    );

    expect(result).not.toBeNull();
    expect(result!.address).toBe("tasks-runner");
    expect(result!.repoName).toBe("tasks-runner");
    expect(result!.subsystem).toBe("tasks-runner");
  });
});

// ── Helpers for file-mutating functions ───────────────────────────────────────

/** Accept legacy `active: string` fixtures — read path coerces them. */
function stubFile(content: {
  active: string | string[];
  focus?: string;
  workspaces: Record<string, WorkspaceConfig>;
}): void {
  let raw = yaml.stringify(content);
  mockFs.readFileSync.mockImplementation((...args: unknown[]) => {
    const filePath = String(args[0]);
    if (
      filePath.endsWith("workspaces.yml") ||
      filePath.includes("workspaces")
    ) {
      return raw as unknown as Buffer;
    }
    throw new Error(`Unexpected readFileSync: ${filePath}`);
  });
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.writeFileSync.mockImplementation((...args: unknown[]) => {
    raw = args[1] as string;
  });
  mockFs.renameSync.mockReturnValue(undefined);
}

function captureFile(): { get: () => WorkspacesFile } {
  let written: WorkspacesFile = {
    active: ["default"],
    focus: "default",
    workspaces: {},
  };
  const prevWrite = mockFs.writeFileSync.getMockImplementation();
  mockFs.mkdirSync.mockReturnValue(undefined);
  mockFs.writeFileSync.mockImplementation((...args: unknown[]) => {
    written = yaml.parse(args[1] as string) as WorkspacesFile;
    if (prevWrite) prevWrite(...args);
  });
  mockFs.renameSync.mockReturnValue(undefined);
  return { get: () => written };
}

// ── getActiveWorkspace ────────────────────────────────────────────────────────

describe("getActiveWorkspace", () => {
  let getActiveWorkspace: typeof import("../../../src/shared/environment-manager/workspaces.js").getActiveWorkspace;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    getActiveWorkspace = mod.getActiveWorkspace;
  });

  it("returns the focused workspace name and config", () => {
    stubFile({
      active: ["feature-a"],
      focus: "feature-a",
      workspaces: {
        default: { services: {} },
        "feature-a": { services: { api: { mode: "dev-managed", path: "/r" } } },
      },
    });

    const result = getActiveWorkspace();
    expect(result).not.toBeNull();
    expect(result!.name).toBe("feature-a");
    expect(result!.config.services).toHaveProperty("api");
  });

  it("returns null when the focus key names a non-existent workspace", () => {
    stubFile({
      active: ["ghost"],
      workspaces: { default: { services: {} } },
    });

    // ghost is dropped from active; focus falls back to default
    const result = getActiveWorkspace();
    expect(result!.name).toBe("default");
  });

  it("honors DEN_WORKSPACE_OVERRIDE without mutating the active set", () => {
    process.env.DEN_WORKSPACE_OVERRIDE = "feature-b";
    stubFile({
      active: ["feature-a"],
      focus: "feature-a",
      workspaces: {
        default: { services: {} },
        "feature-a": { services: { api: { mode: "dev-managed", path: "/a" } } },
        "feature-b": { services: { web: { mode: "dev-managed", path: "/b" } } },
      },
    });

    const result = getActiveWorkspace();
    expect(result).not.toBeNull();
    expect(result!.name).toBe("feature-b");
    expect(result!.config.services).toHaveProperty("web");
  });

  it("uses focus when multiple workspaces are active", () => {
    stubFile({
      active: ["default", "feature-a"],
      focus: "feature-a",
      workspaces: {
        default: { services: { api: { mode: "dev-managed", path: "/d" } } },
        "feature-a": { services: { web: { mode: "dev-managed", path: "/a" } } },
      },
    });

    const result = getActiveWorkspace();
    expect(result!.name).toBe("feature-a");
  });
});

// ── setActiveWorkspace / activate / deactivate ────────────────────────────────

describe("setActiveWorkspace", () => {
  let setActiveWorkspace: typeof import("../../../src/shared/environment-manager/workspaces.js").setActiveWorkspace;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    setActiveWorkspace = mod.setActiveWorkspace;
  });

  it("activates and focuses the workspace when it exists", () => {
    stubFile({
      active: ["default"],
      focus: "default",
      workspaces: {
        default: { services: {} },
        "feature-b": { services: {} },
      },
    });
    const capture = captureFile();

    setActiveWorkspace("feature-b");

    expect(capture.get().active).toEqual(
      expect.arrayContaining(["default", "feature-b"]),
    );
    expect(capture.get().focus).toBe("feature-b");
  });

  it("throws when the named workspace does not exist", () => {
    stubFile({
      active: ["default"],
      workspaces: { default: { services: {} } },
    });
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);

    expect(() => setActiveWorkspace("missing-ws")).toThrow(
      /Workspace "missing-ws" does not exist/,
    );
  });
});

describe("activateWorkspace / deactivateWorkspace", () => {
  let activateWorkspace: typeof import("../../../src/shared/environment-manager/workspaces.js").activateWorkspace;
  let deactivateWorkspace: typeof import("../../../src/shared/environment-manager/workspaces.js").deactivateWorkspace;
  let getActiveWorkspaces: typeof import("../../../src/shared/environment-manager/workspaces.js").getActiveWorkspaces;
  let setFocusedWorkspace: typeof import("../../../src/shared/environment-manager/workspaces.js").setFocusedWorkspace;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    activateWorkspace = mod.activateWorkspace;
    deactivateWorkspace = mod.deactivateWorkspace;
    getActiveWorkspaces = mod.getActiveWorkspaces;
    setFocusedWorkspace = mod.setFocusedWorkspace;
  });

  it("activate adds to the active set without removing others", () => {
    stubFile({
      active: ["default"],
      focus: "default",
      workspaces: {
        default: { services: {} },
        "feat-x": { services: {} },
      },
    });
    const capture = captureFile();

    activateWorkspace("feat-x");

    expect(capture.get().active).toEqual(["default", "feat-x"]);
    expect(capture.get().focus).toBe("default");
  });

  it("deactivate removes from the active set and reassigns focus", () => {
    stubFile({
      active: ["default", "feat-x"],
      focus: "feat-x",
      workspaces: {
        default: { services: {} },
        "feat-x": { services: {} },
      },
    });
    const capture = captureFile();

    deactivateWorkspace("feat-x");

    expect(capture.get().active).toEqual(["default"]);
    expect(capture.get().focus).toBe("default");
  });

  it("deactivate of the last active falls back to default", () => {
    stubFile({
      active: ["feat-x"],
      focus: "feat-x",
      workspaces: {
        default: { services: {} },
        "feat-x": { services: {} },
      },
    });
    const capture = captureFile();

    deactivateWorkspace("feat-x");

    expect(capture.get().active).toEqual(["default"]);
    expect(capture.get().focus).toBe("default");
  });

  it("setFocusedWorkspace rejects inactive workspaces", () => {
    stubFile({
      active: ["default"],
      focus: "default",
      workspaces: {
        default: { services: {} },
        "feat-x": { services: {} },
      },
    });

    expect(() => setFocusedWorkspace("feat-x")).toThrow(/not active/);
  });

  it("getActiveWorkspaces returns the full active set", () => {
    stubFile({
      active: ["default", "feat-x"],
      focus: "default",
      workspaces: {
        default: { services: {} },
        "feat-x": { services: {} },
      },
    });

    expect(getActiveWorkspaces()).toEqual(["default", "feat-x"]);
  });
});

// ── createWorkspace ───────────────────────────────────────────────────────────

describe("createWorkspace", () => {
  let createWorkspace: typeof import("../../../src/shared/environment-manager/workspaces.js").createWorkspace;
  let renameWorkspace: typeof import("../../../src/shared/environment-manager/workspaces.js").renameWorkspace;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    createWorkspace = mod.createWorkspace;
    renameWorkspace = mod.renameWorkspace;
  });

  it("adds the new workspace to the file and writes it", () => {
    stubFile({
      active: ["default"],
      workspaces: { default: { services: {} } },
    });
    const capture = captureFile();

    createWorkspace(
      "new-ws",
      makeWorkspace({ api: { mode: "dev-managed", path: "/r" } }),
    );

    expect(capture.get().workspaces).toHaveProperty("new-ws");
    expect(capture.get().workspaces["new-ws"].services).toHaveProperty("api");
  });

  // D70: one check before any create; an existing workspace is never
  // overwritten (it was, silently, before).
  it("refuses a workspace that exists, by its name or its slug", () => {
    stubFile({
      active: ["default"],
      workspaces: {
        default: { services: { old: { mode: "dev-managed" } } },
        "back-office": { name: "back office", services: {} },
      },
    });
    expect(() =>
      createWorkspace(
        "default",
        makeWorkspace({ neo: { mode: "managed", branch: "main" } }),
      ),
    ).toThrow(/"default" already exists/);
    expect(() => createWorkspace("Back Office", makeWorkspace({}))).toThrow(
      /"back office" already exists/,
    );
  });

  it("D70: a rename changes the name only; the slug stays", () => {
    stubFile({
      active: ["back-office"],
      focus: "back-office",
      workspaces: {
        "back-office": { name: "back office", services: {} },
        web: { services: {} },
      },
    });
    const capture = captureFile();
    renameWorkspace("back-office", "Front Office");
    expect(capture.get().workspaces["back-office"]).toMatchObject({
      name: "Front Office",
    });
    expect(Object.keys(capture.get().workspaces).sort()).toEqual([
      "back-office",
      "web",
    ]);
    expect(() => renameWorkspace("back-office", "WEB")).toThrow(
      /"web" already exists/,
    );
  });

  it("makes a name with spaces under its slug, the name kept", () => {
    stubFile({
      active: ["default"],
      workspaces: { default: { services: {} } },
    });
    const capture = captureFile();
    expect(createWorkspace("back office", makeWorkspace({}))).toBe(
      "back-office",
    );
    expect(capture.get().workspaces["back-office"]).toMatchObject({
      name: "back office",
    });
  });
});

// ── deleteWorkspaceConfig ─────────────────────────────────────────────────────

describe("deleteWorkspaceConfig", () => {
  let deleteWorkspaceConfig: typeof import("../../../src/shared/environment-manager/workspaces.js").deleteWorkspaceConfig;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    deleteWorkspaceConfig = mod.deleteWorkspaceConfig;
  });

  it("removes the workspace from the file", () => {
    stubFile({
      active: ["default"],
      workspaces: { default: { services: {} }, extra: { services: {} } },
    });
    const capture = captureFile();

    deleteWorkspaceConfig("extra");

    expect(capture.get().workspaces).not.toHaveProperty("extra");
  });

  it("removes deleted workspace from active and falls back to default", () => {
    stubFile({
      active: ["to-delete"],
      focus: "to-delete",
      workspaces: { default: { services: {} }, "to-delete": { services: {} } },
    });
    const capture = captureFile();

    deleteWorkspaceConfig("to-delete");

    expect(capture.get().active).toEqual(["default"]);
    expect(capture.get().focus).toBe("default");
    expect(capture.get().workspaces).not.toHaveProperty("to-delete");
  });

  it("preserves other active workspaces when a different workspace is deleted", () => {
    stubFile({
      active: ["keeper"],
      focus: "keeper",
      workspaces: {
        default: { services: {} },
        keeper: { services: {} },
        gone: { services: {} },
      },
    });
    const capture = captureFile();

    deleteWorkspaceConfig("gone");

    expect(capture.get().active).toEqual(["keeper"]);
    expect(capture.get().focus).toBe("keeper");
  });
});

// ── listWorkspaceServices ─────────────────────────────────────────────────────

describe("listWorkspaceServices", () => {
  let listWorkspaceServices: typeof import("../../../src/shared/environment-manager/workspaces.js").listWorkspaceServices;

  beforeEach(async () => {
    jest.resetAllMocks();
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    listWorkspaceServices = mod.listWorkspaceServices;
  });

  it("returns an empty array when workspace has no services", () => {
    const catalog = makeCatalog("api");
    const workspace = makeWorkspace({});

    const result = listWorkspaceServices(workspace, catalog, "default");
    expect(result).toEqual([]);
  });

  it("skips entries that are not in the catalog", () => {
    const catalog = makeCatalog("api"); // "db" not in catalog
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
      db: { mode: "dev-managed", path: "/repos/db" },
    });

    mockReadManifest.mockReturnValue({
      name: "api",
      services: { api: { depends_on: [] } },
    } as RawManifest);

    const result = listWorkspaceServices(workspace, catalog, "default");
    expect(result.map((r) => r.address)).not.toContain("db");
  });

  it("expands single-service repo — corrects subsystem to manifest key", () => {
    // repo "tasks-runner", manifest service key "tool-runner" (no s)
    const catalog = makeCatalog("tasks-runner");
    const workspace = makeWorkspace({
      "tasks-runner": { mode: "dev-managed", path: "/repos/tce" },
    });

    mockReadManifest.mockReturnValue({
      name: "tasks-runner",
      services: { "tool-runner": { depends_on: [] } },
    } as RawManifest);

    const result = listWorkspaceServices(workspace, catalog, "default");
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe("tasks-runner");
    expect(result[0].subsystem).toBe("tool-runner");
  });

  it("expands bare mono-repo entry to all subsystems when manifest has multiple services", () => {
    const catalog = makeCatalog("shop");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
    });

    mockReadManifest.mockReturnValue({
      name: "shop",
      services: {
        api: { depends_on: [] },
        worker: { depends_on: [] },
      },
    } as RawManifest);

    const result = listWorkspaceServices(workspace, catalog, "default");
    expect(result).toHaveLength(2);
    const addresses = result.map((r) => r.address);
    expect(addresses).toContain("shop/api");
    expect(addresses).toContain("shop/worker");
  });

  it("keeps the bare repo address when a multi-service manifest has a root service key", () => {
    const catalog = makeCatalog("infra-stack");
    const workspace = makeWorkspace({
      "infra-stack": {
        mode: "dev-managed",
        path: "/repos/infra-stack",
      },
    });

    mockReadManifest.mockReturnValue({
      name: "infra-stack",
      services: {
        "infra-stack": { depends_on: [] },
        localstack: { depends_on: ["infra-stack"] },
        postgres: { depends_on: ["infra-stack"] },
      },
    } as RawManifest);

    const result = listWorkspaceServices(workspace, catalog, "default");
    const addresses = result.map((r) => r.address);
    expect(addresses).toContain("infra-stack");
    expect(addresses).not.toContain("infra-stack/infra-stack");
    expect(addresses).toContain("infra-stack/localstack");
    expect(addresses).toContain("infra-stack/postgres");
  });

  it("returns as-is when manifest has no services", () => {
    const catalog = makeCatalog("api");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });

    mockReadManifest.mockReturnValue({
      name: "api",
      services: {},
    } as RawManifest);

    const result = listWorkspaceServices(workspace, catalog, "default");
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe("api");
  });
});

// ── resolveDepAddress ─────────────────────────────────────────────────────────

describe("resolveDepAddress", () => {
  let resolveDepAddress: typeof import("../../../src/shared/environment-manager/workspaces.js").resolveDepAddress;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    resolveDepAddress = mod.resolveDepAddress;
  });

  it("passes through deps that already contain a slash (explicit subsystem)", () => {
    const catalog = makeCatalog("files-api");
    const workspace = makeWorkspace({
      "files-api": { mode: "dev-managed", path: "/repos/files-api" },
    });
    expect(
      resolveDepAddress("files-api/api", catalog, workspace, "default"),
    ).toBe("files-api/api");
    expect(resolveDepAddress("shop/web", catalog, workspace, "default")).toBe(
      "shop/web",
    );
  });

  it("passes through deps that are not in the catalog", () => {
    const catalog = makeCatalog("other-service");
    const workspace = makeWorkspace({});
    expect(
      resolveDepAddress("unknown-service", catalog, workspace, "default"),
    ).toBe("unknown-service");
  });

  it("passes through when the dep repo is not in the workspace (resolveServiceSource returns null)", () => {
    // Catalog knows about it, but workspace has no entry for it.
    const catalog = makeCatalog("files-api");
    const emptyWorkspace = makeWorkspace({});
    expect(
      resolveDepAddress("files-api", catalog, emptyWorkspace, "default"),
    ).toBe("files-api");
  });

  it("passes through when the manifest has no entrypoint (multi-service, no declaration)", () => {
    const catalog = makeCatalog("files-api");
    const workspace = makeWorkspace({
      "files-api": { mode: "dev-managed", path: "/repos/files-api" },
    });
    mockReadManifest.mockReturnValue({
      name: "files-api",
      services: { db: {}, api: {} },
    } as RawManifest);
    expect(resolveDepAddress("files-api", catalog, workspace, "default")).toBe(
      "files-api",
    );
  });

  it("passes through for single-service repos (bare name is the canonical address)", () => {
    const catalog = makeCatalog("tasks-runner");
    const workspace = makeWorkspace({
      "tasks-runner": {
        mode: "dev-managed",
        path: "/repos/tasks-runner",
      },
    });
    mockReadManifest.mockReturnValue({
      name: "tasks-runner",
      services: { executor: {} },
    } as RawManifest);
    // Single-service repo: no entrypoint field → bare name stays
    expect(
      resolveDepAddress("tasks-runner", catalog, workspace, "default"),
    ).toBe("tasks-runner");
  });

  it("normalizes to repo/entrypoint when the manifest declares an entrypoint", () => {
    const catalog = makeCatalog("files-api");
    const workspace = makeWorkspace({
      "files-api": { mode: "dev-managed", path: "/repos/files-api" },
    });
    mockReadManifest.mockReturnValue({
      name: "files-api",
      entrypoint: "api",
      services: { db: {}, s3: {}, api: {} },
    } as RawManifest);
    expect(resolveDepAddress("files-api", catalog, workspace, "default")).toBe(
      "files-api/api",
    );
  });

  it("uses the declared entrypoint even when it does not match any service key", () => {
    // Den trusts the manifest author — we don't validate that the key exists.
    const catalog = makeCatalog("my-service");
    const workspace = makeWorkspace({
      "my-service": { mode: "dev-managed", path: "/repos/my-service" },
    });
    mockReadManifest.mockReturnValue({
      name: "my-service",
      entrypoint: "gateway",
      services: { gateway: {}, worker: {} },
    } as RawManifest);
    expect(resolveDepAddress("my-service", catalog, workspace, "default")).toBe(
      "my-service/gateway",
    );
  });

  it("ignores entrypoint for single-service repos (off-convention but tolerated)", () => {
    // The init CLI only emits entrypoint for multi-service repos, but a
    // hand-authored manifest may include it on a single-service repo. Since
    // expandMonoRepoEntry keeps such repos addressed by bare repo name, we
    // must pass through bare here too — otherwise dep edges target an
    // address ("repo/entrypoint") that no display node owns, and the
    // workspace graph renders the dep as an orphan ghost.
    const catalog = makeCatalog("billing-api");
    const workspace = makeWorkspace({
      "billing-api": { mode: "managed", branch: "main" },
    });
    mockReadManifest.mockReturnValue({
      name: "billing-api",
      entrypoint: "api",
      services: { api: {} },
    } as RawManifest);
    expect(
      resolveDepAddress("billing-api", catalog, workspace, "default"),
    ).toBe("billing-api");
  });
});

// ── computeMissingDeps ────────────────────────────────────────────────────────

describe("computeMissingDeps", () => {
  let computeMissingDeps: typeof import("../../../src/shared/environment-manager/workspaces.js").computeMissingDeps;

  beforeEach(async () => {
    jest.resetAllMocks();
    const mod =
      await import("../../../src/shared/environment-manager/workspaces.js");
    computeMissingDeps = mod.computeMissingDeps;
  });

  it("returns empty array when workspace has no services", () => {
    const catalog = makeCatalog("shop");
    const workspace = makeWorkspace({});
    expect(computeMissingDeps(workspace, catalog, "test")).toEqual([]);
  });

  it("returns empty array when all depends_on are satisfied by workspace services", () => {
    // shop/api depends on files-api and shop/db — both present.
    const catalog = makeCatalog("shop", "files-api");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
      "files-api": { mode: "dev-managed", path: "/repos/files-api" },
    });

    mockReadManifest.mockImplementation((repoPath) => {
      if (repoPath === "/repos/shop") {
        return {
          name: "shop",
          services: {
            api: { depends_on: ["files-api", "shop/db"] },
            db: { depends_on: [] },
          },
        } as RawManifest;
      }
      return {
        name: "files-api",
        services: { "files-api": {} },
      } as RawManifest;
    });

    const result = computeMissingDeps(workspace, catalog, "test");
    expect(result).toEqual([]);
  });

  it("reports missing deps for a mono-repo workspace that lacks required services", () => {
    // Workspace has only bare "shop". shop/api depends on files-api and
    // tasks-runner which are NOT in the workspace → both flagged missing.
    const catalog = makeCatalog("shop", "files-api", "tasks-runner");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
    });

    mockReadManifest.mockReturnValue({
      name: "shop",
      services: {
        db: { depends_on: [] },
        api: {
          depends_on: ["files-api", "tasks-runner", "shop/db"],
        },
        web: { depends_on: ["shop/api"] },
      },
    } as RawManifest);

    const result = computeMissingDeps(workspace, catalog, "test");

    // Only shop/api has truly missing deps (files-api, tasks-runner).
    // shop/db (in workspace via expansion) and shop/api (same) are present.
    expect(result).toHaveLength(1);
    const apiEntry = result.find((r) => r.address === "shop/api");
    expect(apiEntry).toBeDefined();
    expect(apiEntry!.missingDeps).toContain("files-api");
    expect(apiEntry!.missingDeps).toContain("tasks-runner");
    expect(apiEntry!.missingDeps).not.toContain("shop/db");
  });

  it("resolves bare dep names to repo/entrypoint when entrypoint is declared", () => {
    // files-api declares entrypoint: "api" so bare dep "files-api"
    // normalises to "files-api/api" before the existingAddresses check.
    const catalog = makeCatalog("shop", "files-api");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
      // Note: workspace has "files-api/api" — the resolved form.
      "files-api/api": {
        mode: "dev-managed",
        path: "/repos/files-api",
      },
    });

    mockReadManifest.mockImplementation((repoPath) => {
      if (repoPath === "/repos/shop") {
        return {
          name: "shop",
          services: { api: { depends_on: ["files-api"] } },
        } as RawManifest;
      }
      // files-api manifest: declares entrypoint "api"
      return {
        name: "files-api",
        entrypoint: "api",
        services: { api: {}, db: {} },
      } as RawManifest;
    });

    const result = computeMissingDeps(workspace, catalog, "test");
    // "files-api" normalises to "files-api/api", which IS in the workspace.
    expect(result).toEqual([]);
  });

  it("skips services whose manifest cannot be read", () => {
    const catalog = makeCatalog("shop", "broken-svc");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
      "broken-svc": { mode: "dev-managed", path: "/repos/broken" },
    });

    mockReadManifest.mockImplementation((repoPath) => {
      if (repoPath === "/repos/shop") {
        return {
          name: "shop",
          services: { api: { depends_on: [] } },
        } as RawManifest;
      }
      // broken-svc manifest unreadable
      return null;
    });

    // Should not throw; broken-svc is silently skipped.
    expect(() => computeMissingDeps(workspace, catalog, "test")).not.toThrow();
    expect(computeMissingDeps(workspace, catalog, "test")).toEqual([]);
  });

  it("bare repo name dep is satisfied when the repo itself is present in the workspace", () => {
    // Dep "files-api" (no slash, no entrypoint in manifest) — the bare repo
    // name should match against existingAddresses which includes repoName entries.
    const catalog = makeCatalog("shop", "files-api");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
      "files-api": { mode: "dev-managed", path: "/repos/files-api" },
    });

    mockReadManifest.mockImplementation((repoPath) => {
      if (repoPath === "/repos/shop") {
        return {
          name: "shop",
          services: { api: { depends_on: ["files-api"] } },
        } as RawManifest;
      }
      // files-api: multi-service, no entrypoint declared
      return {
        name: "files-api",
        services: { db: {}, api: {} },
      } as RawManifest;
    });

    // "files-api" resolveDepAddress → stays "files-api" (no entrypoint).
    // existingAddresses contains "files-api" (repoName) → NOT missing.
    expect(computeMissingDeps(workspace, catalog, "test")).toEqual([]);
  });
});

// ── generateVSCodeWorkspace ───────────────────────────────────────────────────

describe("generateVSCodeWorkspace", () => {
  const ROOT = process.cwd(); // mirrors what workspaces.ts captures at load time
  const GWD = path.join(ROOT, "..", "den-workspaces");

  beforeEach(() => {
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    // readManifest returns null by default so listWorkspaceServices doesn't expand
    mockReadManifest.mockReturnValue(null);
  });

  it("only includes dev-managed repos, not managed", async () => {
    const { generateVSCodeWorkspace } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const catalog = makeCatalog("shop", "tasks-runner");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
      "tasks-runner": { mode: "managed", branch: "main" },
    });

    generateVSCodeWorkspace("default", workspace, catalog);

    const written = JSON.parse(
      (mockFs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>)
        .mock.calls[0][1] as string,
    );
    expect(written.folders).toHaveLength(1);
    expect(written.folders[0].name).toBe("shop");
  });

  it("uses absolute path for dev-managed repos outside the workspace dir", async () => {
    const { generateVSCodeWorkspace } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const catalog = makeCatalog("shop");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
    });

    generateVSCodeWorkspace("default", workspace, catalog);

    const written = JSON.parse(
      (mockFs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>)
        .mock.calls[0][1] as string,
    );
    expect(written.folders[0].path).toBe("/repos/shop");
  });

  it("uses relative path for repos already inside the workspace dir", async () => {
    const { generateVSCodeWorkspace } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const wsDir = path.join(GWD, "Billing");
    const repoPath = path.join(wsDir, "shop");
    const catalog = makeCatalog("shop");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: repoPath },
    });

    generateVSCodeWorkspace("Billing", workspace, catalog);

    const written = JSON.parse(
      (mockFs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>)
        .mock.calls[0][1] as string,
    );
    expect(written.folders[0].path).toBe("shop");
  });

  it("deduplicates repos that appear as multiple services (mono-repo)", async () => {
    const { generateVSCodeWorkspace } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const catalog = makeCatalog("shop");
    // shop/api and shop/web both resolve to the same repoPath
    mockReadManifest.mockImplementation((p: string) => {
      if (p === "/repos/shop") {
        return {
          name: "shop",
          services: { api: {}, web: {} },
        } as RawManifest;
      }
      return null;
    });
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
    });

    generateVSCodeWorkspace("default", workspace, catalog);

    const written = JSON.parse(
      (mockFs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>)
        .mock.calls[0][1] as string,
    );
    expect(written.folders).toHaveLength(1);
    expect(written.folders[0].name).toBe("shop");
  });

  it("writes to <workspace.directory>/<name>.code-workspace when directory is set", async () => {
    const { generateVSCodeWorkspace } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const catalog = makeCatalog("shop");
    const workspace = makeWorkspace(
      { shop: { mode: "dev-managed", path: "/repos/shop" } },
      { directory: "den-workspaces/Billing" },
    );

    const result = generateVSCodeWorkspace("Billing", workspace, catalog);

    expect(result).toBe(
      path.join(ROOT, "den-workspaces", "Billing", "Billing.code-workspace"),
    );
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      path.join(ROOT, "den-workspaces", "Billing"),
      { recursive: true },
    );
  });

  it("writes to den-workspaces/<name>/<name>.code-workspace when no directory", async () => {
    const { generateVSCodeWorkspace } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const catalog = makeCatalog("shop");
    const workspace = makeWorkspace({
      shop: { mode: "dev-managed", path: "/repos/shop" },
    });

    const result = generateVSCodeWorkspace("default", workspace, catalog);

    expect(result).toBe(path.join(GWD, "default", "default.code-workspace"));
  });

  it("returns an empty folders array when no dev-managed repos are in the workspace", async () => {
    const { generateVSCodeWorkspace } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const catalog = makeCatalog("tasks-runner");
    const workspace = makeWorkspace({
      "tasks-runner": { mode: "managed", branch: "main" },
    });

    generateVSCodeWorkspace("default", workspace, catalog);

    const written = JSON.parse(
      (mockFs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>)
        .mock.calls[0][1] as string,
    );
    expect(written.folders).toEqual([]);
  });
});

// ── readManifestAnyBranch ────────────────────────────────────────────────────

describe("readManifestAnyBranch", () => {
  const SERVICES_DIR = path.join(process.cwd(), ".den-services");

  it("returns the primary manifest when it exists", async () => {
    const { readManifestAnyBranch } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const manifest = { name: "my-repo", services: {} } as RawManifest;
    mockReadManifest.mockReturnValueOnce(manifest);

    const result = readManifestAnyBranch("my-repo", "/repos/my-repo");
    expect(result).toBe(manifest);
    expect(mockReadManifest).toHaveBeenCalledWith("/repos/my-repo");
  });

  it("falls back to .den-services branch clones when primary returns null", async () => {
    const { readManifestAnyBranch } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const manifest = { name: "my-repo", services: {} } as RawManifest;
    mockReadManifest.mockReturnValueOnce(null); // primary
    // readdirSync for .den-services/my-repo/
    (mockFs.readdirSync as jest.Mock).mockReturnValueOnce([
      { name: "main", isDirectory: () => true },
      { name: "feature", isDirectory: () => true },
    ]);
    mockReadManifest
      .mockReturnValueOnce(null) // main branch
      .mockReturnValueOnce(manifest); // feature branch

    const result = readManifestAnyBranch("my-repo", "/repos/my-repo");
    expect(result).toBe(manifest);
    expect(mockReadManifest).toHaveBeenCalledWith(
      path.join(SERVICES_DIR, "my-repo", "feature"),
    );
  });

  it("skips non-directory entries in .den-services", async () => {
    const { readManifestAnyBranch } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    mockReadManifest.mockReturnValueOnce(null); // primary
    (mockFs.readdirSync as jest.Mock).mockReturnValueOnce([
      { name: "some-file", isDirectory: () => false },
    ]);
    // No branch manifest found → falls through to sibling
    mockReadManifest.mockReturnValueOnce(null); // sibling

    const result = readManifestAnyBranch("my-repo", "/repos/my-repo");
    expect(result).toBeNull();
  });

  it("falls back to sibling repo when no managed clones have a manifest", async () => {
    const { readManifestAnyBranch } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const manifest = { name: "my-repo", services: {} } as RawManifest;
    mockReadManifest.mockReturnValueOnce(null); // primary
    (mockFs.readdirSync as jest.Mock).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockReadManifest.mockReturnValueOnce(manifest); // sibling

    const result = readManifestAnyBranch("my-repo", "/repos/my-repo");
    expect(result).toBe(manifest);
  });

  it("returns null when no manifest found anywhere", async () => {
    const { readManifestAnyBranch } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    mockReadManifest.mockReturnValue(null);
    (mockFs.readdirSync as jest.Mock).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const result = readManifestAnyBranch("my-repo", "/repos/my-repo");
    expect(result).toBeNull();
  });
});

// ── syncJetBrainsWorkspaceSymlinks ───────────────────────────────────────────

describe("syncJetBrainsWorkspaceSymlinks", () => {
  const GWD = path.join(process.cwd(), "..", "den-workspaces");

  it("creates symlinks for dev-managed repos outside the workspace dir", async () => {
    const { syncJetBrainsWorkspaceSymlinks } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    (mockFs.lstatSync as jest.Mock).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    syncJetBrainsWorkspaceSymlinks({
      active: "default",
      workspaces: {
        default: {
          services: {
            shop: { mode: "dev-managed", path: "/external/shop" },
          },
        },
      },
    });

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(path.join(GWD, "default"), {
      recursive: true,
    });
    expect(mockFs.symlinkSync).toHaveBeenCalledWith(
      "/external/shop",
      path.join(GWD, "default", "shop"),
    );
  });

  it("skips managed repos", async () => {
    const { syncJetBrainsWorkspaceSymlinks } =
      await import("../../../src/shared/environment-manager/workspaces.js");

    syncJetBrainsWorkspaceSymlinks({
      active: "default",
      workspaces: {
        default: {
          services: {
            shop: { mode: "managed", branch: "main" },
          },
        },
      },
    });

    expect(mockFs.symlinkSync).not.toHaveBeenCalled();
  });

  it("skips repos already inside the workspace directory", async () => {
    const { syncJetBrainsWorkspaceSymlinks } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    const wsDir = path.join(GWD, "default");

    syncJetBrainsWorkspaceSymlinks({
      active: "default",
      workspaces: {
        default: {
          services: {
            shop: {
              mode: "dev-managed",
              path: path.join(wsDir, "shop"),
            },
          },
        },
      },
    });

    expect(mockFs.symlinkSync).not.toHaveBeenCalled();
  });

  it("replaces stale symlinks pointing to wrong target", async () => {
    const { syncJetBrainsWorkspaceSymlinks } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    (mockFs.lstatSync as jest.Mock).mockReturnValue({
      isSymbolicLink: () => true,
    });
    (mockFs.readlinkSync as jest.Mock).mockReturnValue("/old/path");

    syncJetBrainsWorkspaceSymlinks({
      active: "default",
      workspaces: {
        default: {
          services: {
            shop: { mode: "dev-managed", path: "/new/shop" },
          },
        },
      },
    });

    expect(mockFs.unlinkSync).toHaveBeenCalled();
    expect(mockFs.symlinkSync).toHaveBeenCalledWith(
      "/new/shop",
      path.join(GWD, "default", "shop"),
    );
  });

  it("skips existing symlinks already pointing to correct target", async () => {
    const { syncJetBrainsWorkspaceSymlinks } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    (mockFs.lstatSync as jest.Mock).mockReturnValue({
      isSymbolicLink: () => true,
    });
    (mockFs.readlinkSync as jest.Mock).mockReturnValue("/external/shop");

    syncJetBrainsWorkspaceSymlinks({
      active: "default",
      workspaces: {
        default: {
          services: {
            shop: { mode: "dev-managed", path: "/external/shop" },
          },
        },
      },
    });

    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    expect(mockFs.symlinkSync).not.toHaveBeenCalled();
  });

  it("does not overwrite real files/dirs at symlink path", async () => {
    const { syncJetBrainsWorkspaceSymlinks } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    (mockFs.lstatSync as jest.Mock).mockReturnValue({
      isSymbolicLink: () => false,
    });

    syncJetBrainsWorkspaceSymlinks({
      active: "default",
      workspaces: {
        default: {
          services: {
            shop: { mode: "dev-managed", path: "/external/shop" },
          },
        },
      },
    });

    expect(mockFs.unlinkSync).not.toHaveBeenCalled();
    expect(mockFs.symlinkSync).not.toHaveBeenCalled();
  });

  it("deduplicates repos with the same path", async () => {
    const { syncJetBrainsWorkspaceSymlinks } =
      await import("../../../src/shared/environment-manager/workspaces.js");
    (mockFs.lstatSync as jest.Mock).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    syncJetBrainsWorkspaceSymlinks({
      active: "default",
      workspaces: {
        default: {
          services: {
            "shop/api": { mode: "dev-managed", path: "/external/shop" },
            "shop/worker": {
              mode: "dev-managed",
              path: "/external/shop",
            },
          },
        },
      },
    });

    // Only one symlink call despite two services pointing to the same path
    expect(mockFs.symlinkSync).toHaveBeenCalledTimes(1);
  });
});
