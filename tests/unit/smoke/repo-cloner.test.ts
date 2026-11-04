import { execSync } from "child_process";
import * as fs from "fs";
import {
  cloneDirFor,
  ensureRepoAtSha,
} from "../../../src/shared/smoke/repo-cloner.js";
import type { DeployedRef } from "../../../src/shared/smoke/branch-resolver.js";

jest.mock("child_process");
jest.mock("fs");
// The clone-destination preflight does real fs/git probing — covered by its
// own suite (clone-guard.test.ts); neutralize it under the fs/cp mocks here.
jest.mock("../../../src/shared/environment-manager/clone-guard.js");

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockFs = fs as jest.Mocked<typeof fs>;

const REF: DeployedRef = {
  sha: "abc123def456abc123def456abc123def456abc1",
  ref: "main",
  environment: "staging",
  deployedAt: "2024-01-15T10:00:00Z",
  deploymentId: 123,
};

const OLD_SHA = "old0000000000000000000000000000000000000";

describe("cloneDirFor", () => {
  it("returns a path rooted at .smoke-clones with repo/env components", () => {
    const result = cloneDirFor("app", "staging");
    expect(result).toMatch(/\.smoke-clones[/\\]app[/\\]staging$/);
  });

  it("uses the exact names passed in", () => {
    expect(cloneDirFor("other-repo", "production")).toMatch(
      /other-repo[/\\]production$/,
    );
  });
});

describe("ensureRepoAtSha", () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => logSpy.mockRestore());

  it("fast-path: returns immediately when .deployed-sha matches target SHA", () => {
    // shaFile exists and matches
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(REF.sha as unknown as Buffer);

    const result = ensureRepoAtSha(
      "app",
      "staging",
      "https://github.com/org/app.git",
      REF,
    );

    expect(result).toMatch(/app[/\\]staging$/);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already at"));
  });

  it("clones the repo and writes the SHA stamp on a fresh install", () => {
    // No .deployed-sha and no cloneDir
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockImplementation(() => undefined);
    mockFs.writeFileSync.mockImplementation(() => undefined);

    // git rev-parse HEAD returns target SHA → no fetch needed
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("rev-parse"))
        return (REF.sha + "\n") as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    const result = ensureRepoAtSha(
      "app",
      "staging",
      "https://github.com/org/app.git",
      REF,
    );

    expect(result).toMatch(/app[/\\]staging$/);
    const cmds = mockExecSync.mock.calls.map(([c]) => String(c));
    expect(cmds.some((c) => c.includes("git clone"))).toBe(true);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".deployed-sha"),
      REF.sha,
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("cloning"));
  });

  it("fetches and checks out the new SHA when the existing clone is stale", () => {
    // shaFile exists with an old SHA; cloneDir also exists
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(OLD_SHA as unknown as Buffer);
    mockFs.mkdirSync.mockImplementation(() => undefined);
    mockFs.writeFileSync.mockImplementation(() => undefined);

    // rev-parse returns old SHA → triggers fetch + checkout
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("rev-parse"))
        return (OLD_SHA + "\n") as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    ensureRepoAtSha("app", "staging", "https://github.com/org/app.git", REF);

    const cmds = mockExecSync.mock.calls.map(([c]) => String(c));
    expect(cmds.some((c) => c.includes("fetch"))).toBe(true);
    expect(cmds.some((c) => c.includes("checkout"))).toBe(true);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".deployed-sha"),
      REF.sha,
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("updating"));
  });

  it("falls back to branch fetch when SHA fetch fails", () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockImplementation(() => undefined);
    mockFs.writeFileSync.mockImplementation(() => undefined);

    let fetchCalls = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      const s = String(cmd);
      if (s.includes("rev-parse")) return (OLD_SHA + "\n") as unknown as Buffer;
      if (s.includes("fetch") && s.includes(REF.sha)) {
        fetchCalls++;
        throw new Error("server does not allow fetching by SHA");
      }
      return "" as unknown as Buffer;
    });

    ensureRepoAtSha("app", "staging", "https://github.com/org/app.git", REF);

    const cmds = mockExecSync.mock.calls.map(([c]) => String(c));
    // Fallback fetch should use the branch name
    expect(cmds.some((c) => c.includes("fetch") && c.includes(REF.ref))).toBe(
      true,
    );
    expect(fetchCalls).toBe(1); // SHA fetch was attempted once before fallback
  });

  it("uses gh auth git-credential in git commands", () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockImplementation(() => undefined);
    mockFs.writeFileSync.mockImplementation(() => undefined);
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("rev-parse"))
        return (REF.sha + "\n") as unknown as Buffer;
      return "" as unknown as Buffer;
    });

    ensureRepoAtSha("app", "staging", "https://github.com/org/app.git", REF);

    const cmds = mockExecSync.mock.calls.map(([c]) => String(c));
    const cloneCmd = cmds.find((c) => c.includes("git clone"));
    expect(cloneCmd).toContain("gh auth git-credential");
  });
});
