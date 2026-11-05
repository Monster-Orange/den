/**
 * Unit tests for GitHubService
 *
 * Tests the extracted GitHub integration: branch listing, repo listing,
 * org detection, and caching behavior.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("child_process");
jest.mock("../../../src/shared/den-config.js", () => ({
  ...jest.requireActual<object>("../../../src/shared/den-config.js"),
  readDenConfig: jest.fn(() => ({
    environments: ["local"],
    github_org: "",
  })),
}));
jest.mock("../../../src/shared/environment-manager/catalog.js", () => ({
  readCatalog: jest.fn(() => ({})),
}));

import { execSync, execFileSync } from "child_process";
import * as path from "path";
import { readDenConfig } from "../../../src/shared/den-config.js";
import { readCatalog } from "../../../src/shared/environment-manager/catalog.js";
import { GitHubService } from "../../../src/ui/server/github-service.js";

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockExecFileSync = execFileSync as jest.MockedFunction<
  typeof execFileSync
>;
const mockReadDenConfig = readDenConfig as jest.MockedFunction<
  typeof readDenConfig
>;
const mockReadCatalog = readCatalog as jest.MockedFunction<typeof readCatalog>;

describe("GitHubService", () => {
  let svc: GitHubService;

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new GitHubService();
  });

  // ── listBranches ──────────────────────────────────────────────────────────

  describe("listBranches", () => {
    it("returns branch names from gh api", () => {
      mockExecFileSync.mockReturnValue('["main","dev","feature-x"]\n');
      const result = svc.listBranches("org/repo");
      expect(result).toEqual(["main", "dev", "feature-x"]);
    });

    it("returns empty array for invalid slug", () => {
      expect(svc.listBranches("")).toEqual([]);
      expect(svc.listBranches("noslash")).toEqual([]);
    });

    it("rejects slugs with shell metacharacters", () => {
      expect(svc.listBranches("org/repo; rm -rf /")).toEqual([]);
      expect(svc.listBranches("org/repo$(evil)")).toEqual([]);
    });

    it("caches results and returns from cache on second call", () => {
      mockExecFileSync.mockReturnValue('["main"]\n');
      svc.listBranches("org/repo");
      svc.listBranches("org/repo");
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when gh api throws", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("gh not found");
      });
      expect(svc.listBranches("org/repo")).toEqual([]);
    });

    it("handles multi-page paginated output", () => {
      mockExecFileSync.mockReturnValue('["main","dev"]\n["feature-a"]\n');
      expect(svc.listBranches("org/repo")).toEqual([
        "main",
        "dev",
        "feature-a",
      ]);
    });
  });

  // ── listOrgRepos ──────────────────────────────────────────────────────────

  describe("listOrgRepos", () => {
    it("returns repos with hasDen flag", () => {
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Globex-Corp",
      });
      mockExecSync
        .mockReturnValueOnce(
          JSON.stringify([
            {
              name: "shop",
              nameWithOwner: "Globex-Corp/shop",
              defaultBranchRef: { name: "main" },
            },
            {
              name: "tools",
              nameWithOwner: "Globex-Corp/tools",
              defaultBranchRef: null,
            },
          ]),
        )
        .mockReturnValueOnce('["shop"]');

      const result = svc.listOrgRepos();
      expect(result).toEqual([
        expect.objectContaining({
          name: "shop",
          hasDen: true,
          defaultBranch: "main",
        }),
        expect.objectContaining({
          name: "tools",
          hasDen: false,
          defaultBranch: "main",
        }),
      ]);
    });

    it("lists every org in the catalog, not just the first", () => {
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Hooli",
      });
      mockReadCatalog.mockReturnValue({
        "hooli-app": { gh: "Hooli/hooli-app" },
        "initech-web": { gh: "Initech/initech-web" },
        bad: { gh: "evil$(x)/repo" },
      });
      const repo = (owner: string, name: string) =>
        JSON.stringify([{ name, nameWithOwner: `${owner}/${name}` }]);
      mockExecSync
        .mockReturnValueOnce(repo("Hooli", "hooli-app"))
        .mockReturnValueOnce("[]")
        .mockReturnValueOnce(repo("Initech", "initech-web"))
        .mockReturnValueOnce("[]");

      expect(svc.listOrgRepos().map((r) => r.nameWithOwner)).toEqual([
        "Hooli/hooli-app",
        "Initech/initech-web",
      ]);
      expect(mockExecSync).toHaveBeenCalledTimes(4);
      for (const [cmd] of mockExecSync.mock.calls)
        expect(String(cmd)).not.toContain("evil");
    });

    it("github_org unset: GitHub is not configured, and no gh runs (not even for catalog owners)", () => {
      mockReadDenConfig.mockReturnValue({ environments: ["local"] });
      mockReadCatalog.mockReturnValue({ shop: { gh: "MyOrg/shop" } });
      expect(svc.listOrgRepos()).toEqual([]);
      expect(mockExecSync).not.toHaveBeenCalled();
      // No fallback to any checkout's git remote either.
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it.each(["your-github-org", "your-org", "<your-org>", "example-org"])(
      "a placeholder github_org (%s) is not configured: no gh runs",
      (org) => {
        mockReadDenConfig.mockReturnValue({
          environments: ["local"],
          github_org: org,
        });
        mockReadCatalog.mockReturnValue({ shop: { gh: "MyOrg/shop" } });
        expect(svc.listOrgRepos()).toEqual([]);
        expect(mockExecSync).not.toHaveBeenCalled();
        expect(mockExecFileSync).not.toHaveBeenCalled();
      },
    );

    it("caches results", () => {
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Org",
      });
      mockExecSync.mockReturnValue("[]");

      svc.listOrgRepos();
      svc.listOrgRepos();
      // Only 2 execSync calls (repo list + den search) for the first call
      expect(mockExecSync).toHaveBeenCalledTimes(2);
    });

    it("bypasses cache when forceRefresh is true", () => {
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Org",
      });
      mockExecSync.mockReturnValue("[]");

      svc.listOrgRepos();
      svc.listOrgRepos(true);
      expect(mockExecSync).toHaveBeenCalledTimes(4);
    });

    it("returns empty array when gh CLI throws", () => {
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Org",
      });
      mockExecSync.mockImplementation(() => {
        throw new Error("gh auth fail");
      });
      expect(svc.listOrgRepos()).toEqual([]);
    });

    it("excludes the den repo itself", () => {
      // The service identifies "itself" by the basename of process.cwd(),
      // which differs from "den" in worktree checkouts — derive it.
      const thisRepo = path.basename(process.cwd());
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Org",
      });
      mockExecSync
        .mockReturnValueOnce(
          JSON.stringify([
            { name: thisRepo, nameWithOwner: `Org/${thisRepo}` },
            { name: "shop", nameWithOwner: "Org/shop" },
          ]),
        )
        .mockReturnValueOnce("[]");

      const result = svc.listOrgRepos();
      expect(result.every((r) => r.name !== thisRepo)).toBe(true);
      expect(result.some((r) => r.name === "shop")).toBe(true);
    });
  });
});
