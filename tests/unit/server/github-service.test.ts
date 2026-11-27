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

import { execFile } from "child_process";
import * as path from "path";
import { readDenConfig } from "../../../src/shared/den-config.js";
import { readCatalog } from "../../../src/shared/environment-manager/catalog.js";
import { GitHubService } from "../../../src/ui/server/github-service.js";
import { decodeCursor } from "../../../src/ui/server/paging.js";

const mockExecFile = execFile as unknown as jest.Mock;
type Reply = string | Error;
const replies: Reply[] = [];
let always: Reply | null = null;
const replyWith = (...r: Reply[]) => replies.push(...r);
const replyAlways = (r: Reply) => (always = r);
const gqlPage = (nodes: object[], end: string | null = null) =>
  JSON.stringify({
    nodes,
    pageInfo: { hasNextPage: end !== null, endCursor: end },
  });
const ghArgs = () =>
  mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(" "));
const mockReadDenConfig = readDenConfig as jest.MockedFunction<
  typeof readDenConfig
>;
const mockReadCatalog = readCatalog as jest.MockedFunction<typeof readCatalog>;

describe("GitHubService", () => {
  let svc: GitHubService;

  beforeEach(() => {
    jest.resetAllMocks();
    replies.length = 0;
    always = null;
    mockExecFile.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1] as (
        e: Error | null,
        o?: string,
        s?: string,
      ) => void;
      const r = replies.length ? replies.shift()! : (always ?? "[]");
      if (r instanceof Error) cb(r, "", "");
      else cb(null, r, "");
    });
    svc = new GitHubService();
  });

  // ── listBranches ──────────────────────────────────────────────────────────

  describe("listBranches", () => {
    it("returns branch names from gh api", async () => {
      replyAlways('["main","dev","feature-x"]\n');
      const result = (await svc.listBranches("org/repo")).items;
      expect(result).toEqual(["main", "dev", "feature-x"]);
    });

    it("returns empty array for invalid slug", async () => {
      expect((await svc.listBranches("")).items).toEqual([]);
      expect((await svc.listBranches("noslash")).items).toEqual([]);
    });

    it("rejects slugs with shell metacharacters", async () => {
      expect((await svc.listBranches("org/repo; rm -rf /")).items).toEqual([]);
      expect((await svc.listBranches("org/repo$(evil)")).items).toEqual([]);
    });

    it("rejects a . or .. segment (another API path), and asks gh nothing", async () => {
      // And an owner GitHub would refuse (a dot, a leading "-").
      for (const s of [
        "../..",
        "./repo",
        "org/..",
        "../repo",
        "org/.",
        "my.org/repo",
        "-org/repo",
      ])
        expect((await svc.listBranches(s)).items).toEqual([]);
      expect(mockExecFile).not.toHaveBeenCalled();
      replyAlways('["main"]\n');
      expect((await svc.listBranches("my-org/re..po")).items).toEqual(["main"]);
    });

    it("caches results and returns from cache on second call", async () => {
      replyAlways('["main"]\n');
      await svc.listBranches("org/repo");
      await svc.listBranches("org/repo");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("returns empty array when gh api throws", async () => {
      replyAlways(new Error("gh not found"));
      expect((await svc.listBranches("org/repo")).items).toEqual([]);
    });

    it("asks GitHub for one page, never --paginate, and puts the default branch first", async () => {
      const page = Array.from({ length: 100 }, (_, i) => `feat/${i}`);
      replyWith(JSON.stringify(page), "main\n");
      const names = (await svc.listBranches("org/repo")).items;
      expect(names.slice(0, 2)).toEqual(["main", "feat/0"]);
      expect(names).toHaveLength(101);
      expect(ghArgs()).toEqual([
        "api repos/org/repo/branches?per_page=100&page=1 --jq [.[].name]",
        "api repos/org/repo --jq .default_branch",
      ]);
    });
  });

  // ── listOrgRepos ──────────────────────────────────────────────────────────

  describe("listOrgRepos", () => {
    it("returns repos with hasDen flag", async () => {
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Globex-Corp",
      });
      replyWith(
        gqlPage([
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
        '["shop"]',
      );

      const result = (await svc.listOrgRepos()).items;
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

    it("lists every org in the catalog, not just the first", async () => {
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
        gqlPage([{ name, nameWithOwner: `${owner}/${name}` }]);
      replyWith(
        repo("Hooli", "hooli-app"),
        "[]",
        repo("Initech", "initech-web"),
        "[]",
      );

      const first = await svc.listOrgRepos();
      const second = await svc.listOrgRepos({
        limit: 100,
        after: decodeCursor(first.next!),
      });
      expect(
        [...first.items, ...second.items].map((r) => r.nameWithOwner),
      ).toEqual(["Hooli/hooli-app", "Initech/initech-web"]);
      expect(second.next).toBeNull();
      expect(mockExecFile).toHaveBeenCalledTimes(4);
      for (const args of ghArgs()) expect(args).not.toContain("evil");
    });

    it("github_org unset: GitHub is not configured, and no gh runs (not even for catalog owners)", async () => {
      mockReadDenConfig.mockReturnValue({ environments: ["local"] });
      mockReadCatalog.mockReturnValue({ shop: { gh: "MyOrg/shop" } });
      expect((await svc.listOrgRepos()).items).toEqual([]);
      // No fallback to any checkout's git remote either.
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it.each(["your-github-org", "your-org", "<your-org>", "example-org"])(
      "a placeholder github_org (%s) is not configured: no gh runs",
      async (org) => {
        mockReadDenConfig.mockReturnValue({
          environments: ["local"],
          github_org: org,
        });
        mockReadCatalog.mockReturnValue({ shop: { gh: "MyOrg/shop" } });
        expect((await svc.listOrgRepos()).items).toEqual([]);
        expect(mockExecFile).not.toHaveBeenCalled();
      },
    );

    it("caches results", async () => {
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Org",
      });
      replyAlways(gqlPage([{ name: "shop", nameWithOwner: "Org/shop" }]));
      await svc.listOrgRepos();
      await svc.listOrgRepos();
      // Only 2 gh calls (repo list + den search) for the first call
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("bypasses cache when forceRefresh is true", async () => {
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Org",
      });
      replyAlways(gqlPage([{ name: "shop", nameWithOwner: "Org/shop" }]));
      await svc.listOrgRepos();
      await svc.listOrgRepos(undefined, "", true);
      expect(mockExecFile).toHaveBeenCalledTimes(4);
    });

    it("returns empty array when gh CLI throws", async () => {
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Org",
      });
      replyAlways(new Error("gh auth fail"));
      expect((await svc.listOrgRepos()).items).toEqual([]);
    });

    it("excludes the den repo itself", async () => {
      // The service identifies "itself" by the basename of process.cwd(),
      // which differs from "den" in worktree checkouts — derive it.
      const thisRepo = path.basename(process.cwd());
      mockReadDenConfig.mockReturnValue({
        environments: ["local"],
        github_org: "Org",
      });
      replyWith(
        gqlPage([
          { name: thisRepo, nameWithOwner: `Org/${thisRepo}` },
          { name: "shop", nameWithOwner: "Org/shop" },
        ]),
        "[]",
      );

      const result = (await svc.listOrgRepos()).items;
      expect(result.every((r) => r.name !== thisRepo)).toBe(true);
      expect(result.some((r) => r.name === "shop")).toBe(true);
    });
  });
});
