import { describe, expect, it, jest, afterEach } from "@jest/globals";
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

jest.mock("child_process");
jest.mock("fs");
// The clone-destination preflight does real fs/git probing — covered by its
// own suite (clone-guard.test.ts); neutralize it under the fs/cp mocks here.
jest.mock("../../../src/shared/environment-manager/clone-guard.js");

const mockCp = cp as jest.Mocked<typeof cp>;
const mockFs = fs as jest.Mocked<typeof fs>;

afterEach(() => {
  jest.resetAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Default execSync behaviour: git commands return empty Buffer; gitCapture returns "0". */
function stubExecSync() {
  (mockCp.execSync as jest.Mock).mockImplementation(
    (_cmd: string, opts?: Record<string, unknown>) =>
      opts?.encoding === "utf-8" ? "0" : Buffer.from(""),
  );
}

// ── renameWorkspaceDirectory ──────────────────────────────────────────────────

describe("renameWorkspaceDirectory", () => {
  let renameWorkspaceDirectory: typeof import("../../../src/shared/environment-manager/workspace-manager.js").renameWorkspaceDirectory;
  let DEN_WORKSPACES_DIR: string;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    renameWorkspaceDirectory = mod.renameWorkspaceDirectory;
    const ws =
      await import("../../../src/shared/environment-manager/workspaces.js");
    DEN_WORKSPACES_DIR = ws.DEN_WORKSPACES_DIR;
  });

  it("returns null when oldDir does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = renameWorkspaceDirectory("/workspaces/Test", "Test2");
    expect(result).toBeNull();
    expect(mockFs.renameSync).not.toHaveBeenCalled();
  });

  it("renames oldDir to den-workspaces/<newName> when destination is clear", () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s === "/workspaces/Test") return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.renameSync.mockReturnValue(undefined);

    const result = renameWorkspaceDirectory("/workspaces/Test", "Test2");

    const expectedNewDir = path.join(DEN_WORKSPACES_DIR, "Test2");
    expect(result).toBe(expectedNewDir);
    expect(mockFs.renameSync).toHaveBeenCalledWith(
      "/workspaces/Test",
      expectedNewDir,
    );
  });

  it("backs up conflicting destination before renaming", () => {
    const newDir = path.join(DEN_WORKSPACES_DIR, "Test2");
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s === "/workspaces/Test" || s === newDir;
    });
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.renameSync.mockReturnValue(undefined);

    renameWorkspaceDirectory("/workspaces/Test", "Test2");

    const calls = (mockFs.renameSync as jest.Mock).mock.calls as [
      string,
      string,
    ][];
    // First call: backup the conflicting dir
    expect(calls[0][0]).toBe(newDir);
    expect(calls[0][1]).toMatch(
      new RegExp(`${path.join(DEN_WORKSPACES_DIR, "Test2-backup-")}\\d+`),
    );
    // Second call: rename src to dest
    expect(calls[1]).toEqual(["/workspaces/Test", newDir]);
  });

  it("renames <oldName>.code-workspace to <newName>.code-workspace", () => {
    const newDir = path.join(DEN_WORKSPACES_DIR, "Test2");
    const oldCodeWs = path.join(newDir, "Test.code-workspace");
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s === "/workspaces/Test" || s === oldCodeWs;
    });
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.renameSync.mockReturnValue(undefined);

    renameWorkspaceDirectory("/workspaces/Test", "Test2");

    const calls = (mockFs.renameSync as jest.Mock).mock.calls as [
      string,
      string,
    ][];
    const codeWsCall = calls.find(([src]) => src === oldCodeWs);
    expect(codeWsCall).toBeDefined();
    expect(codeWsCall![1]).toBe(path.join(newDir, "Test2.code-workspace"));
  });

  it("skips .code-workspace rename when no old file exists", () => {
    const _newDir = path.join(DEN_WORKSPACES_DIR, "Test2");
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s === "/workspaces/Test";
    });
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.renameSync.mockReturnValue(undefined);

    renameWorkspaceDirectory("/workspaces/Test", "Test2");

    const calls = (mockFs.renameSync as jest.Mock).mock.calls as [
      string,
      string,
    ][];
    // Only one rename call: the directory itself
    const codeWsCalls = calls.filter(([src]) =>
      src.endsWith(".code-workspace"),
    );
    expect(codeWsCalls).toHaveLength(0);
  });
});

// ── deleteWorkspaceDirectory ──────────────────────────────────────────────────

describe("deleteWorkspaceDirectory", () => {
  let deleteWorkspaceDirectory: typeof import("../../../src/shared/environment-manager/workspace-manager.js").deleteWorkspaceDirectory;
  let DEN_WORKSPACES_DIR: string;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    deleteWorkspaceDirectory = mod.deleteWorkspaceDirectory;
    const ws =
      await import("../../../src/shared/environment-manager/workspaces.js");
    DEN_WORKSPACES_DIR = ws.DEN_WORKSPACES_DIR;
    stubExecSync();
  });

  it("does nothing when the workspace directory does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    deleteWorkspaceDirectory("Test");
    expect(mockFs.rmSync).not.toHaveBeenCalled();
  });

  it("removes the workspace directory recursively", () => {
    const wsDir = path.join(DEN_WORKSPACES_DIR, "Test");
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([] as unknown as fs.Dirent[]);
    mockFs.rmSync.mockReturnValue(undefined);

    deleteWorkspaceDirectory("Test");

    expect(mockFs.rmSync).toHaveBeenCalledWith(wsDir, {
      recursive: true,
      force: true,
    });
  });

  it("warns about unpushed commits but still deletes", () => {
    const wsDir = path.join(DEN_WORKSPACES_DIR, "Test");
    mockFs.existsSync.mockReturnValue(true);
    const entry = { name: "my-repo", isDirectory: () => true } as fs.Dirent;
    mockFs.readdirSync.mockReturnValue([entry] as unknown as fs.Dirent[]);
    mockFs.rmSync.mockReturnValue(undefined);
    // gitCapture returns "3" unpushed commits for the repo
    (mockCp.execSync as jest.Mock).mockReturnValue("3");
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    deleteWorkspaceDirectory("Test");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("my-repo"));
    expect(mockFs.rmSync).toHaveBeenCalledWith(wsDir, {
      recursive: true,
      force: true,
    });
    warnSpy.mockRestore();
  });

  it("skips unpushed-commit check when readdirSync entry is not a directory", () => {
    mockFs.existsSync.mockReturnValue(true);
    const entry = { name: "file.txt", isDirectory: () => false } as fs.Dirent;
    mockFs.readdirSync.mockReturnValue([entry] as unknown as fs.Dirent[]);
    mockFs.rmSync.mockReturnValue(undefined);

    deleteWorkspaceDirectory("Test");

    expect(mockCp.execSync).not.toHaveBeenCalled();
  });
});

// ── ensureManagedServiceClone ─────────────────────────────────────────────────

describe("ensureManagedServiceClone", () => {
  let ensureManagedServiceClone: typeof import("../../../src/shared/environment-manager/workspace-manager.js").ensureManagedServiceClone;
  let DEN_SERVICES_DIR: string;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    ensureManagedServiceClone = mod.ensureManagedServiceClone;
    const ws =
      await import("../../../src/shared/environment-manager/workspaces.js");
    DEN_SERVICES_DIR = ws.DEN_SERVICES_DIR;
    stubExecSync();
    mockFs.mkdirSync.mockReturnValue(undefined);
  });

  it("clones when the clone directory does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = ensureManagedServiceClone("my-repo", "org/my-repo", "main");

    const expectedDir = path.join(DEN_SERVICES_DIR, "my-repo", "main");
    expect(result).toBe(expectedDir);
    expect(mockFs.mkdirSync).toHaveBeenCalled();
    const calls = (mockCp.execSync as jest.Mock).mock.calls as [string][];
    expect(calls.some(([cmd]) => cmd.includes("clone"))).toBe(true);
  });

  it("pulls when the clone directory already exists", () => {
    mockFs.existsSync.mockReturnValue(true);

    ensureManagedServiceClone("my-repo", "org/my-repo", "main");

    const calls = (mockCp.execSync as jest.Mock).mock.calls as [string][];
    expect(calls.some(([cmd]) => cmd.includes("pull --ff-only"))).toBe(true);
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it("uses 'main' as the default branch", () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = ensureManagedServiceClone("my-repo", "org/my-repo");

    expect(result).toBe(path.join(DEN_SERVICES_DIR, "my-repo", "main"));
  });
});

// ── ensureManagedServiceCloneNewBranch ────────────────────────────────────────

describe("ensureManagedServiceCloneNewBranch", () => {
  let ensureManagedServiceCloneNewBranch: typeof import("../../../src/shared/environment-manager/workspace-manager.js").ensureManagedServiceCloneNewBranch;
  let DEN_SERVICES_DIR: string;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    ensureManagedServiceCloneNewBranch = mod.ensureManagedServiceCloneNewBranch;
    const ws =
      await import("../../../src/shared/environment-manager/workspaces.js");
    DEN_SERVICES_DIR = ws.DEN_SERVICES_DIR;
    stubExecSync();
    mockFs.mkdirSync.mockReturnValue(undefined);
  });

  it("clones the base branch then creates the new branch", () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = ensureManagedServiceCloneNewBranch(
      "repo",
      "org/repo",
      "main",
      "feature-x",
    );

    const expectedDir = path.join(DEN_SERVICES_DIR, "repo", "feature-x");
    expect(result).toBe(expectedDir);
    const calls = (mockCp.execSync as jest.Mock).mock.calls as [string][];
    expect(
      calls.some(([cmd]) => cmd.includes("clone") && cmd.includes("main")),
    ).toBe(true);
    expect(calls.some(([cmd]) => cmd.includes('checkout -b "feature-x"'))).toBe(
      true,
    );
  });

  it("returns the existing directory without cloning when already present", () => {
    mockFs.existsSync.mockReturnValue(true);

    const result = ensureManagedServiceCloneNewBranch(
      "repo",
      "org/repo",
      "main",
      "feature-x",
    );

    expect(result).toBe(path.join(DEN_SERVICES_DIR, "repo", "feature-x"));
    expect(mockCp.execSync).not.toHaveBeenCalled();
  });
});

// ── ensureDevManagedClone ─────────────────────────────────────────────────────

describe("ensureDevManagedClone", () => {
  let ensureDevManagedClone: typeof import("../../../src/shared/environment-manager/workspace-manager.js").ensureDevManagedClone;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    ensureDevManagedClone = mod.ensureDevManagedClone;
    stubExecSync();
    mockFs.mkdirSync.mockReturnValue(undefined);
  });

  it("returns targetDir without cloning when it already exists", () => {
    mockFs.existsSync.mockReturnValue(true);

    const result = ensureDevManagedClone(
      "/repos/my-repo",
      "org/my-repo",
      "main",
    );

    expect(result).toBe("/repos/my-repo");
    expect(mockCp.execSync).not.toHaveBeenCalled();
  });

  it("clones with the specified branch when directory is missing", () => {
    mockFs.existsSync.mockReturnValue(false);

    ensureDevManagedClone("/repos/my-repo", "org/my-repo", "feature-x");

    const calls = (mockCp.execSync as jest.Mock).mock.calls as [string][];
    expect(calls[0][0]).toMatch(/clone.*--branch.*feature-x/);
  });

  it("falls back to clone-default-then-checkout when branch clone fails", () => {
    mockFs.existsSync.mockReturnValue(false);
    (mockCp.execSync as jest.Mock)
      .mockImplementationOnce(() => {
        throw new Error("remote branch not found");
      })
      .mockReturnValue(Buffer.from(""));

    ensureDevManagedClone("/repos/my-repo", "org/my-repo", "feature-x");

    const calls = (mockCp.execSync as jest.Mock).mock.calls as [string][];
    // Second call: clone without --branch
    expect(calls[1][0]).toMatch(/clone(?!.*--branch)/);
    // Third call: checkout existing branch
    expect(calls[2][0]).toMatch(/checkout "feature-x"/);
  });

  it("creates a new branch when checkout of existing branch also fails", () => {
    mockFs.existsSync.mockReturnValue(false);
    (mockCp.execSync as jest.Mock)
      .mockImplementationOnce(() => {
        throw new Error("remote branch not found");
      }) // clone --branch
      .mockReturnValueOnce(Buffer.from("")) // clone default
      .mockImplementationOnce(() => {
        throw new Error("pathspec not found");
      }) // checkout existing
      .mockReturnValue(Buffer.from("")); // checkout -b

    ensureDevManagedClone("/repos/my-repo", "org/my-repo", "feature-x");

    const calls = (mockCp.execSync as jest.Mock).mock.calls as [string][];
    expect(calls[3][0]).toMatch(/checkout -b "feature-x"/);
  });
});

// ── ensureWorkspaceClone ──────────────────────────────────────────────────────

describe("ensureWorkspaceClone", () => {
  let ensureWorkspaceClone: typeof import("../../../src/shared/environment-manager/workspace-manager.js").ensureWorkspaceClone;
  let DEN_WORKSPACES_DIR: string;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    ensureWorkspaceClone = mod.ensureWorkspaceClone;
    const ws =
      await import("../../../src/shared/environment-manager/workspaces.js");
    DEN_WORKSPACES_DIR = ws.DEN_WORKSPACES_DIR;
    stubExecSync();
    mockFs.mkdirSync.mockReturnValue(undefined);
  });

  it("returns the existing clone path without re-cloning", () => {
    mockFs.existsSync.mockReturnValue(true);

    const result = ensureWorkspaceClone(
      "my-ws",
      "my-repo",
      "org/my-repo",
      "main",
    );

    expect(result).toBe(path.join(DEN_WORKSPACES_DIR, "my-ws", "my-repo"));
    expect(mockCp.execSync).not.toHaveBeenCalled();
  });

  it("clones with the given branch when directory is missing", () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = ensureWorkspaceClone(
      "my-ws",
      "my-repo",
      "org/my-repo",
      "feature-x",
    );

    expect(result).toBe(path.join(DEN_WORKSPACES_DIR, "my-ws", "my-repo"));
    const calls = (mockCp.execSync as jest.Mock).mock.calls as [string][];
    expect(
      calls.some(([cmd]) => cmd.includes("clone") && cmd.includes("feature-x")),
    ).toBe(true);
  });

  it("creates the branch locally when remote branch does not yet exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    (mockCp.execSync as jest.Mock)
      .mockImplementationOnce(() => {
        throw new Error("remote branch not found");
      }) // clone --branch
      .mockReturnValue(Buffer.from("")); // clone default + checkout -b

    ensureWorkspaceClone("my-ws", "my-repo", "org/my-repo", "feature-x");

    const calls = (mockCp.execSync as jest.Mock).mock.calls as [string][];
    expect(calls.some(([cmd]) => cmd.includes('checkout -b "feature-x"'))).toBe(
      true,
    );
  });
});

// ── branch/slug validation (shell-injection guard) ────────────────────────────
// git() runs through a shell, so every clone entry point must reject unsafe
// branch names / GitHub slugs BEFORE any git command runs — CLI callers pass
// config-sourced values (workspaces.yml, service-catalog.yml) unvalidated.

describe("branch/slug validation", () => {
  let mod: typeof import("../../../src/shared/environment-manager/workspace-manager.js");

  beforeEach(async () => {
    mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    stubExecSync();
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.existsSync.mockReturnValue(false);
  });

  it("ensureManagedServiceClone rejects a branch with shell metacharacters before any git call", () => {
    expect(() =>
      mod.ensureManagedServiceClone("repo", "org/repo", "main$(rm -rf ~)"),
    ).toThrow(/Invalid branch name/);
    expect(mockCp.execSync).not.toHaveBeenCalled();
  });

  it("ensureManagedServiceClone rejects a malformed ghSlug before any git call", () => {
    expect(() =>
      mod.ensureManagedServiceClone("repo", 'org/repo" --evil "', "main"),
    ).toThrow(/Invalid GitHub slug/);
    expect(mockCp.execSync).not.toHaveBeenCalled();
  });

  it("a rejected remote carrying a token is never echoed in the error", () => {
    let msg = "";
    try {
      mod.ensureManagedServiceClone(
        "repo",
        "https://user:sekrit-probe@git.example.test/a b.git",
        "main",
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Invalid GitHub slug/);
    expect(msg).not.toContain("sekrit-probe");
    expect(mockCp.execSync).not.toHaveBeenCalled();
  });

  it("ensureManagedServiceCloneNewBranch validates baseBranch and newBranch", () => {
    expect(() =>
      mod.ensureManagedServiceCloneNewBranch(
        "repo",
        "org/repo",
        "main;id",
        "feature-x",
      ),
    ).toThrow(/Invalid branch name/);
    expect(() =>
      mod.ensureManagedServiceCloneNewBranch(
        "repo",
        "org/repo",
        "main",
        "x`touch pwned`",
      ),
    ).toThrow(/Invalid branch name/);
    expect(mockCp.execSync).not.toHaveBeenCalled();
  });

  it("ensureDevManagedClone and ensureWorkspaceClone validate their inputs", () => {
    expect(() =>
      mod.ensureDevManagedClone("/repos/r", "org/repo", 'b" && evil "'),
    ).toThrow(/Invalid branch name/);
    expect(() =>
      mod.ensureWorkspaceClone("my-ws", "repo", "not-a-slug", "main"),
    ).toThrow(/Invalid GitHub slug/);
    expect(mockCp.execSync).not.toHaveBeenCalled();
  });

  it("accepts ordinary slugs and branch names (slashes, dots, dashes, underscores)", () => {
    expect(() =>
      mod.ensureManagedServiceClone(
        "my.repo",
        "org-1/my.repo",
        "feat/some-branch_1.2",
      ),
    ).not.toThrow();
    const calls = (mockCp.execSync as jest.Mock).mock.calls as [string][];
    expect(calls.some(([cmd]) => cmd.includes("clone"))).toBe(true);
  });
});

// ── runSetupIfDefined (via ensureManagedServiceClone) ─────────────────────────
// runSetupIfDefined is private; we verify its behaviour through the clone entry points.

describe("runSetupIfDefined", () => {
  let ensureManagedServiceClone: typeof import("../../../src/shared/environment-manager/workspace-manager.js").ensureManagedServiceClone;
  let DEN_SERVICES_DIR: string;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    ensureManagedServiceClone = mod.ensureManagedServiceClone;
    const ws =
      await import("../../../src/shared/environment-manager/workspaces.js");
    DEN_SERVICES_DIR = ws.DEN_SERVICES_DIR;
    stubExecSync();
    mockFs.mkdirSync.mockReturnValue(undefined);
  });

  function cloneDir(branch = "main") {
    return path.join(DEN_SERVICES_DIR, "my-repo", branch);
  }

  // Helper: extract the content written to the .command script by runSetupIfDefined.
  function commandScriptContent(): string | undefined {
    const calls = (mockFs.writeFileSync as jest.Mock).mock.calls as [
      string,
      string,
    ][];
    const hit = calls.find(([p]) => String(p).includes("den-setup-"));
    return hit?.[1];
  }

  it("runs the manifest setup command (string) when commands.local.setup is defined", () => {
    const dir = cloneDir();
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s === dir) return false;
      if (s.endsWith(".den.yml")) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue(
      "name: my-repo\nservices:\n  api:\n    commands:\n      local:\n        setup: make setup-service\n",
    );

    ensureManagedServiceClone("my-repo", "org/my-repo");

    expect(commandScriptContent()).toContain("make setup-service");
    expect(mockCp.spawnSync).toHaveBeenCalledWith(
      "open",
      expect.any(Array),
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it("runs the cmd field when setup command is an object definition", () => {
    const dir = cloneDir();
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s === dir) return false;
      if (s.endsWith(".den.yml")) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue(
      "name: my-repo\nservices:\n  api:\n    commands:\n      local:\n        setup:\n          cmd: make setup-obj\n          detachable: false\n",
    );

    ensureManagedServiceClone("my-repo", "org/my-repo");

    expect(commandScriptContent()).toContain("make setup-obj");
  });

  it("uses entrypoint service's setup command before other services", () => {
    const dir = cloneDir();
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s === dir) return false;
      if (s.endsWith(".den.yml")) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue(
      "name: my-repo\nentrypoint: api\nservices:\n  api:\n    commands:\n      local:\n        setup: make setup-api\n  worker:\n    commands:\n      local:\n        setup: make setup-worker\n",
    );

    ensureManagedServiceClone("my-repo", "org/my-repo");

    const script = commandScriptContent();
    expect(script).toContain("make setup-api");
    expect(script).not.toContain("make setup-worker");
  });

  it("falls back to make setup when no manifest but Makefile exists", () => {
    const dir = cloneDir();
    const makefilePath = path.join(dir, "Makefile");
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s === dir) return false;
      if (s === makefilePath) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue("");

    ensureManagedServiceClone("my-repo", "org/my-repo");

    expect(commandScriptContent()).toContain("make setup");
  });

  it("warns but does not throw when the setup command fails", () => {
    const dir = cloneDir();
    const makefilePath = path.join(dir, "Makefile");
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s === dir) return false;
      if (s === makefilePath) return true;
      return false;
    });
    mockFs.readFileSync.mockReturnValue("");
    mockFs.writeFileSync.mockImplementation(() => {
      throw new Error("disk write failed");
    });

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      ensureManagedServiceClone("my-repo", "org/my-repo"),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Setup failed"),
    );
    warnSpy.mockRestore();
  });
});

// ── checkBehindCount ──────────────────────────────────────────────────────────

describe("checkBehindCount", () => {
  let checkBehindCount: typeof import("../../../src/shared/environment-manager/workspace-manager.js").checkBehindCount;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    checkBehindCount = mod.checkBehindCount;
  });

  it("returns the number of commits the repo is behind its upstream", () => {
    (mockCp.execSync as jest.Mock)
      .mockReturnValueOnce("") // git fetch
      .mockReturnValueOnce("3"); // git rev-list --count

    expect(checkBehindCount("/some/repo")).toBe(3);
  });

  it("returns 0 when the repo is up to date", () => {
    (mockCp.execSync as jest.Mock)
      .mockReturnValueOnce("")
      .mockReturnValueOnce("0");

    expect(checkBehindCount("/some/repo")).toBe(0);
  });

  it("returns -1 when execSync throws (e.g. no upstream configured)", () => {
    (mockCp.execSync as jest.Mock).mockImplementation(() => {
      throw new Error("no upstream configured");
    });

    expect(checkBehindCount("/some/repo")).toBe(-1);
  });
});

// ── pullRepo ──────────────────────────────────────────────────────────────────

describe("pullRepo", () => {
  let pullRepo: typeof import("../../../src/shared/environment-manager/workspace-manager.js").pullRepo;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    pullRepo = mod.pullRepo;
    stubExecSync();
  });

  it("restores codegen-dirtied files, then pulls --ff-only in the repo directory", () => {
    pullRepo("/my/repo");

    // ORG-1d's credential-mark lookup (`git config --get den.credential`) is
    // not part of the restore → pull order.
    const calls = (
      (mockCp.execSync as jest.Mock).mock.calls as [
        string,
        Record<string, unknown>,
      ][]
    ).filter(([c]) => !/config --local --get/.test(c));
    // `make up` codegen (datestamped gen/openapi/README.md etc.) dirties
    // managed clones and blocks ff-only pulls — restore must come FIRST.
    expect(calls[0][0]).toMatch(/restore \./);
    expect(calls[0][1]).toMatchObject({ cwd: "/my/repo" });
    expect(calls[1][0]).toMatch(/pull --ff-only/);
    expect(calls[1][1]).toMatchObject({ cwd: "/my/repo" });
  });

  it("ORG-1d: a clone Den made from a remote: pulls through plain git, never gh", () => {
    (mockCp.execSync as jest.Mock).mockImplementation(
      (cmd: string, opts?: Record<string, unknown>) =>
        /config --local --get den\.credential/.test(cmd)
          ? "git\n"
          : opts?.encoding === "utf-8"
            ? "0"
            : Buffer.from(""),
    );
    pullRepo("/my/plain");
    const pull = (
      (mockCp.execSync as jest.Mock).mock.calls as [string, unknown][]
    ).find(([c]) => /pull --ff-only/.test(c));
    expect(pull?.[0]).toBe("git pull --ff-only");
  });

  it("ORG-1d: an unmarked (GitHub) clone still pulls with gh as credential helper", () => {
    pullRepo("/my/repo");
    const pull = (
      (mockCp.execSync as jest.Mock).mock.calls as [string, unknown][]
    ).find(([c]) => /pull --ff-only/.test(c));
    expect(pull?.[0]).toContain('credential.helper="!gh auth git-credential"');
  });
});

// ── syncManagedClone (async git — doesn't block the event loop) ──────────────

describe("syncManagedClone", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let syncManagedClone: (...args: any[]) => Promise<any>;

  // Each test stages spawn to return a fake ChildProcess emitting the given
  // stdout + close code on the next tick.
  function stageSpawn(
    sequence: Array<{
      stdout?: string;
      stderr?: string;
      code?: number;
      err?: Error;
    }>,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { EventEmitter } = require("events");
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { Readable } = require("stream");
    let i = 0;
    (mockCp.spawn as jest.Mock).mockImplementation(() => {
      const opts = sequence[i++] ?? { code: 0 };
      const proc = new EventEmitter();
      const stdoutStream = new Readable({ read() {} });
      const stderrStream = new Readable({ read() {} });
      (proc as unknown as { stdout: unknown }).stdout = stdoutStream;
      (proc as unknown as { stderr: unknown }).stderr = stderrStream;
      (proc as unknown as { kill: () => void }).kill = jest.fn();
      setImmediate(() => {
        if (opts.stdout) stdoutStream.push(opts.stdout);
        stdoutStream.push(null);
        if (opts.stderr) stderrStream.push(opts.stderr);
        stderrStream.push(null);
        if (opts.err) proc.emit("error", opts.err);
        else proc.emit("close", opts.code ?? 0);
      });
      return proc as unknown as ReturnType<typeof cp.spawn>;
    });
  }

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    syncManagedClone = mod.syncManagedClone as typeof syncManagedClone;
  });

  it("returns behind=0, pulled=false when the upstream is at HEAD", async () => {
    stageSpawn([
      { code: 0 }, // git fetch
      { stdout: "0\n", code: 0 }, // git rev-list --count
    ]);

    const r = await syncManagedClone("/some/repo");
    expect(r).toEqual({ behind: 0, pulled: false });
  });

  it("returns behind=N, pulled=true when upstream has N commits and pull succeeds", async () => {
    stageSpawn([
      { code: 0 }, // fetch
      { stdout: "3\n", code: 0 }, // rev-list
      { code: 0 }, // restore . (discard local codegen)
      { code: 0 }, // pull --ff-only
    ]);

    const r = await syncManagedClone("/some/repo");
    expect(r).toEqual({ behind: 3, pulled: true });
  });

  it("returns behind=-1 when fetch fails (no upstream, offline, auth error)", async () => {
    stageSpawn([{ code: 128 }]); // git fetch exit code 128

    const r = await syncManagedClone("/some/repo");
    expect(r).toEqual({ behind: -1, pulled: false });
  });

  it("returns pulled=false with error detail when the pull step fails", async () => {
    stageSpawn([
      { code: 0 }, // fetch
      { stdout: "2\n", code: 0 }, // rev-list
      { code: 0 }, // restore . (discard local codegen)
      { code: 1, stderr: "fatal: Not possible to fast-forward, aborting." }, // pull non-ff
    ]);

    const r = await syncManagedClone("/some/repo");
    expect(r.behind).toBe(2);
    expect(r.pulled).toBe(false);
    expect(r.error).toMatch(/pull failed: fatal: Not possible to fast-forward/);
  });

  it("bails out with cancelled=true when isCancelled returns true between ops", async () => {
    stageSpawn([
      { code: 0 }, // fetch completes
      // ...but we cancel before rev-list runs
    ]);
    let flipped = false;
    const isCancelled = () => flipped;
    // Cancel after the first spawn call starts.
    (mockCp.spawn as jest.Mock).mockImplementationOnce((...args: unknown[]) => {
      // Default fake proc for fetch; also flip the flag once it completes.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { EventEmitter } = require("events");
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const { Readable } = require("stream");
      const proc = new EventEmitter();
      (proc as unknown as { stdout: unknown }).stdout = new Readable({
        read() {},
      });
      (proc as unknown as { stderr: unknown }).stderr = new Readable({
        read() {},
      });
      (proc as unknown as { kill: () => void }).kill = jest.fn();
      setImmediate(() => {
        flipped = true;
        proc.emit("close", 0);
      });
      void args;
      return proc as unknown as ReturnType<typeof cp.spawn>;
    });

    const r = await syncManagedClone("/some/repo", isCancelled);
    expect(r.cancelled).toBe(true);
  });

  it("runs `git restore .` before the fast-forward pull (managed clones are dirtied by codegen)", async () => {
    (mockCp.spawn as jest.Mock).mockClear();
    stageSpawn([
      { code: 0 }, // fetch
      { stdout: "1\n", code: 0 }, // rev-list
      { code: 0 }, // restore .
      { code: 0 }, // pull --ff-only
    ]);

    await syncManagedClone("/some/repo");

    const gitArgs = (mockCp.spawn as jest.Mock).mock.calls.map(
      (c) => c[1] as string[],
    );
    const restoreIdx = gitArgs.findIndex((a) => a[0] === "restore");
    const pullIdx = gitArgs.findIndex((a) => a[0] === "pull");
    expect(gitArgs).toContainEqual(["restore", "."]);
    expect(pullIdx).toBeGreaterThan(restoreIdx);
  });
});

// ── fetchAndFastForward (den up --pull) ───────────────────────────────────

describe("fetchAndFastForward", () => {
  let fetchAndFastForward: typeof import("../../../src/shared/environment-manager/workspace-manager.js").fetchAndFastForward;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/workspace-manager.js");
    fetchAndFastForward = mod.fetchAndFastForward;
  });

  /** Route execSync by command: rev-list returns a count string; fetch/merge run thunks. */
  function route(opts: {
    fetch?: () => Buffer;
    revList?: string | (() => string);
    merge?: () => Buffer;
  }): void {
    (mockCp.execSync as jest.Mock).mockImplementation((cmd: string) => {
      if (cmd.includes("rev-list")) {
        const rl = opts.revList ?? "0";
        return typeof rl === "function" ? rl() : rl;
      }
      if (cmd.includes("fetch"))
        return (opts.fetch ?? (() => Buffer.from("")))();
      if (cmd.includes("merge"))
        return (opts.merge ?? (() => Buffer.from("")))();
      return Buffer.from("");
    });
  }

  it("reports up to date when 0 commits behind", () => {
    route({ revList: "0" });
    expect(fetchAndFastForward("/r")).toEqual({ behind: 0, pulled: false });
  });

  it("fast-forwards when behind the upstream", () => {
    route({ revList: "3" });
    expect(fetchAndFastForward("/r")).toEqual({ behind: 3, pulled: true });
  });

  it("authenticates the fetch + merge via the gh credential helper", () => {
    route({ revList: "1" });
    fetchAndFastForward("/r");
    const calls = (mockCp.execSync as jest.Mock).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(
      calls.some(
        (c) => c.includes("fetch") && c.includes("gh auth git-credential"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.includes("merge --ff-only") && c.includes("gh auth git-credential"),
      ),
    ).toBe(true);
  });

  it("reports diverged (no pull) when the fast-forward merge fails", () => {
    route({
      revList: "2",
      merge: () => {
        throw new Error("Not possible to fast-forward, aborting.");
      },
    });
    const r = fetchAndFastForward("/r");
    expect(r.behind).toBe(2);
    expect(r.pulled).toBe(false);
    expect(r.error).toContain("fast-forward");
  });

  it("returns behind -1 when the fetch fails (unreachable / auth)", () => {
    route({
      fetch: () => {
        throw new Error("could not read Username");
      },
    });
    expect(fetchAndFastForward("/r")).toMatchObject({
      behind: -1,
      pulled: false,
    });
  });

  it("returns behind -1 when there is no upstream tracking ref", () => {
    route({
      revList: () => {
        throw new Error("no upstream configured");
      },
    });
    expect(fetchAndFastForward("/r")).toEqual({ behind: -1, pulled: false });
  });
});
