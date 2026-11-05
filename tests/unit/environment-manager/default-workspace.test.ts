/**
 * Default-workspace seeding: builds the out-of-the-box `default` workspace from
 * config/den.yml `defaults.workspace` (all repos managed) and derives
 * catalog clone URLs from github_org. Uses real fs in a temp DEN_ROOT.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp: string;
let mod: typeof import("../../../src/shared/environment-manager/default-workspace.js");
let readWorkspacesFile: typeof import("../../../src/shared/environment-manager/workspaces.js").readWorkspacesFile;
let readCatalog: typeof import("../../../src/shared/environment-manager/catalog.js").readCatalog;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-defws-"));
  fs.mkdirSync(path.join(tmp, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(tmp, "config", "den.yml"),
    [
      "github_org: TestOrg",
      "defaults:",
      "  workspace:",
      "    branch: main",
      "    repos:",
      "      - shop-web",
      "      - shop",
      "      - infra-stack",
      "    autostart_off:",
      "      - shop",
      "",
    ].join("\n"),
  );

  process.env.DEN_ROOT = tmp;
  delete process.env.DEN_WORKSPACE_OVERRIDE;
  mod =
    await import("../../../src/shared/environment-manager/default-workspace.js");
  ({ readWorkspacesFile } =
    await import("../../../src/shared/environment-manager/workspaces.js"));
  ({ readCatalog } =
    await import("../../../src/shared/environment-manager/catalog.js"));
});

afterAll(() => {
  delete process.env.DEN_ROOT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("default workspace seeding", () => {
  it("reads the blueprint repo list from config", () => {
    expect(mod.defaultWorkspaceRepos()).toEqual([
      "shop-web",
      "shop",
      "infra-stack",
    ]);
  });

  it("needs seeding on a fresh clone (no workspaces.yml)", () => {
    expect(mod.defaultWorkspaceNeedsSeeding()).toBe(true);
    expect(mod.defaultWorkspaceHasServices()).toBe(false);
  });

  it("seeds all blueprint repos as managed + derives catalog slugs", () => {
    const seeded = mod.seedDefaultWorkspace();
    expect(seeded).toEqual(["shop-web", "shop", "infra-stack"]);

    const ws = readWorkspacesFile();
    const services = ws.workspaces.default.services;
    expect(Object.keys(services).sort()).toEqual([
      "infra-stack",
      "shop",
      "shop-web",
    ]);
    // Blueprint autostart_off repos get the toggle stamped; others don't.
    expect(services["shop"]).toEqual({
      mode: "managed",
      branch: "main",
      autostart: false,
    });
    for (const repo of ["shop-web", "infra-stack"]) {
      expect(services[repo]).toEqual({
        mode: "managed",
        branch: "main",
      });
    }
    expect(ws.active).toEqual(["default"]);
    expect(ws.focus).toBe("default");
    // Seeding records the blueprint it applied — top-up converges on deltas
    // against this list, so later removals stick.
    expect(ws.workspaces.default.seeded_repos).toEqual([
      "shop-web",
      "shop",
      "infra-stack",
    ]);

    const catalog = readCatalog();
    expect(catalog["shop-web"]).toEqual({ gh: "TestOrg/shop-web" });
    expect(catalog["infra-stack"]).toEqual({ gh: "TestOrg/infra-stack" });
  });

  it("no longer needs seeding once seeded", () => {
    expect(mod.defaultWorkspaceNeedsSeeding()).toBe(false);
    expect(mod.defaultWorkspaceHasServices()).toBe(true);
  });
});

describe("default workspace top-up (blueprint grows after seeding)", () => {
  // Self-contained fixtures: each test writes the exact blueprint + workspace
  // state it needs — no test chains on another's leftovers, so `it.only` and
  // reordering stay safe.
  const writeBlueprint = (repos: string[], autostartOff: string[] = []) =>
    fs.writeFileSync(
      path.join(tmp, "config", "den.yml"),
      [
        "github_org: TestOrg",
        "defaults:",
        "  workspace:",
        "    branch: main",
        "    repos:",
        ...repos.map((r) => `      - ${r}`),
        ...(autostartOff.length
          ? ["    autostart_off:", ...autostartOff.map((r) => `      - ${r}`)]
          : []),
        "",
      ].join("\n"),
    );

  const wsPath = () => path.join(tmp, "config", "local", "workspaces.yml");

  /** Write a default workspace of managed entries (+ optional seeded_repos). */
  const writeWorkspace = (repos: string[], seededRepos?: string[]) =>
    fs.writeFileSync(
      wsPath(),
      [
        "active:",
        "  - default",
        "focus: default",
        "workspaces:",
        "  default:",
        "    services:",
        ...repos.flatMap((r) => [
          `      ${r}:`,
          "        mode: managed",
          "        branch: main",
        ]),
        ...(seededRepos
          ? ["    seeded_repos:", ...seededRepos.map((r) => `      - ${r}`)]
          : []),
        "",
      ].join("\n"),
    );

  it("is a no-op once converged — and stops writing the file at all", () => {
    writeBlueprint(["alpha", "beta"]);
    writeWorkspace(["alpha", "beta"], ["alpha", "beta"]);
    const before = fs.readFileSync(wsPath(), "utf-8");
    expect(mod.topUpDefaultWorkspace()).toEqual([]);
    // Read-only commands run top-up on every invocation — converged means
    // byte-identical file, not a rewrite of equal content.
    expect(fs.readFileSync(wsPath(), "utf-8")).toBe(before);
  });

  it("adds a repo that newly joined the blueprint, preserving user edits", () => {
    writeBlueprint(["alpha", "beta", "tasks-api"]);
    writeWorkspace(["alpha", "beta"], ["alpha", "beta"]);
    // User flipped alpha to a dev-managed checkout — must survive top-up.
    fs.writeFileSync(
      wsPath(),
      fs
        .readFileSync(wsPath(), "utf-8")
        .replace(
          /alpha:\n {8}mode: managed/,
          "alpha:\n        mode: dev-managed",
        ),
    );

    expect(mod.topUpDefaultWorkspace()).toEqual(["tasks-api"]);

    const def = readWorkspacesFile().workspaces.default;
    expect(def.services["tasks-api"]).toEqual({
      mode: "managed",
      branch: "main",
    });
    expect(def.services["alpha"].mode).toBe("dev-managed"); // untouched
    expect(def.seeded_repos).toEqual(["alpha", "beta", "tasks-api"]);
    expect(readCatalog()["tasks-api"]).toEqual({ gh: "TestOrg/tasks-api" });

    // Converged — second run adds nothing.
    expect(mod.topUpDefaultWorkspace()).toEqual([]);
  });

  it("stamps the team autostart default on topped-up repos", () => {
    writeBlueprint(["alpha", "billing-api"], ["billing-api"]);
    writeWorkspace(["alpha"], ["alpha"]);
    expect(mod.topUpDefaultWorkspace()).toEqual(["billing-api"]);
    expect(
      readWorkspacesFile().workspaces.default.services["billing-api"],
    ).toEqual({
      mode: "managed",
      branch: "main",
      autostart: false,
    });
  });

  it("does NOT resurrect a standard repo the user removed", () => {
    // billing-api was applied once (in seeded_repos) and then removed from
    // the workspace — top-up must respect the removal, not re-add it.
    writeBlueprint(["alpha", "billing-api"]);
    writeWorkspace(["alpha"], ["alpha", "billing-api"]);
    expect(mod.topUpDefaultWorkspace()).toEqual([]);
    expect(
      readWorkspacesFile().workspaces.default.services["billing-api"],
    ).toBeUndefined();
  });

  it("migrates pre-seeded_repos workspaces once; afterwards removals stick", () => {
    // A workspace from before seeded_repos existed: the migration cannot
    // tell "removed" from "seeded before the repo joined", so missing
    // blueprint repos are added ONCE and the blueprint is recorded.
    writeBlueprint(["alpha", "beta", "gamma"]);
    writeWorkspace(["alpha", "beta"]); // no seeded_repos
    expect(mod.topUpDefaultWorkspace()).toEqual(["gamma"]);
    expect(readWorkspacesFile().workspaces.default.seeded_repos).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);

    // User removes gamma — with the blueprint now recorded, it stays gone.
    writeWorkspace(["alpha", "beta"], ["alpha", "beta", "gamma"]);
    expect(mod.topUpDefaultWorkspace()).toEqual([]);
    expect(
      readWorkspacesFile().workspaces.default.services["gamma"],
    ).toBeUndefined();
  });

  it("never adds a duplicate bare entry for a subsystem-keyed repo", () => {
    // A repo held as `repo/subsystem` addresses has no bare key — presence
    // must resolve at repo level or shop would be added a second time.
    writeBlueprint(["shop", "extra"]);
    fs.writeFileSync(
      wsPath(),
      [
        "active:",
        "  - default",
        "focus: default",
        "workspaces:",
        "  default:",
        "    services:",
        "      shop/api:",
        "        mode: dev-managed",
        "        path: /tmp/shop",
        "      shop/web:",
        "        mode: managed",
        "        branch: main",
        "",
      ].join("\n"),
    );
    expect(mod.topUpDefaultWorkspace()).toEqual(["extra"]);
    const services = readWorkspacesFile().workspaces.default.services;
    expect(services["shop"]).toBeUndefined();
    expect(Object.keys(services).sort()).toEqual([
      "extra",
      "shop/api",
      "shop/web",
    ]);
  });

  it("never tops up next to other workspaces, nor adds a repo another holds", () => {
    writeBlueprint(["alpha", "beta", "gamma"]);
    fs.writeFileSync(
      wsPath(),
      [
        "active:",
        "  - default",
        "focus: default",
        "workspaces:",
        "  default:",
        "    services:",
        "      alpha:",
        "        mode: managed",
        "        branch: main",
        "  proj:",
        "    services:",
        "      beta:",
        "        mode: managed",
        "        branch: main",
        "",
      ].join("\n"),
    );
    const before = fs.readFileSync(wsPath(), "utf-8");
    expect(mod.topUpDefaultWorkspace()).toEqual([]);
    expect(fs.readFileSync(wsPath(), "utf-8")).toBe(before);
  });

  it("records a blueprint repo removed from default so top-up never re-adds it", () => {
    writeBlueprint(["alpha", "beta"]);
    writeWorkspace(["alpha", "beta"]); // predates seeded_repos
    const file = readWorkspacesFile();
    mod.recordRemovedFromWorkspace(file, "default", "beta");
    mod.recordRemovedFromWorkspace(file, "default", "not-in-blueprint");
    mod.recordRemovedFromWorkspace(file, "other", "alpha");
    delete file.workspaces.default.services["beta"];
    expect(file.workspaces.default.seeded_repos).toEqual(["beta"]);
    fs.writeFileSync(wsPath(), JSON.stringify(file));
    expect(mod.topUpDefaultWorkspace()).toEqual([]);
    expect(
      Object.keys(readWorkspacesFile().workspaces.default.services),
    ).toEqual(["alpha"]);
  });

  it("a declined offer is not a fresh setup, so it is not asked again", () => {
    writeBlueprint(["alpha"]);
    fs.rmSync(wsPath(), { force: true });
    expect(mod.defaultWorkspaceNeedsSeeding()).toBe(true);
    mod.markDefaultWorkspaceDeclined();
    expect(mod.defaultWorkspaceNeedsSeeding()).toBe(false);
  });

  it("an emptied, once-seeded default is not a fresh setup", () => {
    writeBlueprint(["alpha"]);
    writeWorkspace([], ["alpha"]);
    expect(mod.defaultWorkspaceNeedsSeeding()).toBe(false);
  });

  it("leaves an empty (declined) default workspace to the seeding flow", () => {
    writeBlueprint(["alpha"]);
    fs.writeFileSync(
      wsPath(),
      "active:\n  - default\nfocus: default\nworkspaces:\n  default:\n    services: {}\n",
    );
    expect(mod.topUpDefaultWorkspace()).toEqual([]);
  });
});
