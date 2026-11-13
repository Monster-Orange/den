/**
 * ORG-1a: a workspace's org resolves through the chain (ORG-SPEC §2), first
 * match wins: its own `org:` in workspaces.yml, the blueprint's `org:`, the
 * single non-empty catalog owner of its repos, then `github_org`. Owners
 * compare case-insensitively and show in the `orgs:` key's spelling; `gh: ""`
 * is ignored. Broken rules are warnings, never errors (C1). The org listing
 * only gains `default` and `workspaces` (C3).
 *
 * Pure: every test builds its own context. Invented orgs only.
 */
import { describe, expect, it } from "@jest/globals";
import type { DenConfig } from "../../../src/shared/den-config.js";
import type {
  ResolvedWorkspaceBlueprint,
  ServiceCatalog,
  WorkspacesFile,
} from "../../../src/shared/types/index.js";
import {
  githubOrgFor,
  resolveAllWorkspaceOrgs,
  resolveWorkspaceOrg,
  withOrgMembership,
  type OrgContext,
} from "../../../src/shared/environment-manager/workspace-org.js";
import { listOrgs } from "../../../src/shared/manifest/service-links.js";

type Bp = ResolvedWorkspaceBlueprint;

function ctx(opts: {
  config?: Partial<DenConfig>;
  catalog?: ServiceCatalog;
  workspaces?: WorkspacesFile["workspaces"];
  blueprints?: Partial<Bp>[];
}): OrgContext {
  return {
    config: { environments: ["local"], ...opts.config } as DenConfig,
    catalog: opts.catalog ?? {},
    file: {
      active: Object.keys(opts.workspaces ?? {}),
      focus: Object.keys(opts.workspaces ?? {})[0],
      workspaces: opts.workspaces ?? {},
    },
    blueprints: (opts.blueprints ?? []).map((b) => ({
      name: "default",
      repos: [],
      branch: "main",
      autostartOff: [],
      focus: false,
      ...b,
    })),
  };
}

const managed = (...repos: string[]) =>
  Object.fromEntries(repos.map((r) => [r, { mode: "managed" as const }]));

const CATALOG: ServiceCatalog = {
  "acme-api": { gh: "acme/acme-api" },
  "acme-web": { gh: "acme/acme-web" },
  "globex-api": { gh: "Globex/globex-api" },
  "globex-web": { gh: "globex/globex-web" },
  unknown: { gh: "" },
};

describe("the resolution chain", () => {
  it("an old config (no org anywhere, no catalog owners) resolves to github_org", () => {
    const c = ctx({
      config: { github_org: "acme" },
      workspaces: { default: { services: managed("alpha") } },
    });
    expect(resolveWorkspaceOrg("default", c)).toEqual({
      workspace: "default",
      org: "acme",
      source: "default",
      warnings: [],
    });
    expect(githubOrgFor("default", c)).toBe("acme");
  });

  it('infers the single catalog owner, case-insensitively, ignoring gh: ""', () => {
    const c = ctx({
      config: { github_org: "acme", orgs: { globex: { label: "Globex" } } },
      catalog: CATALOG,
      workspaces: {
        client: { services: managed("globex-api", "globex-web", "unknown") },
      },
    });
    const r = resolveWorkspaceOrg("client", c);
    expect(r.org).toBe("globex"); // the orgs: key's spelling
    expect(r.source).toBe("catalog");
    expect(r.warnings).toEqual([]);
  });

  it("the blueprint's org: beats inference", () => {
    const c = ctx({
      config: { github_org: "acme", orgs: { initech: {} } },
      catalog: CATALOG,
      workspaces: { client: { services: managed("acme-api") } },
      blueprints: [{ name: "client", org: "initech" }],
    });
    const r = resolveWorkspaceOrg("client", c);
    expect(r).toMatchObject({ org: "initech", source: "blueprint" });
    expect(r.warnings).toEqual([
      "project client: repo acme-api belongs to acme, not the project's org initech",
    ]);
  });

  it("workspaces.yml org: beats the blueprint's, with a warning", () => {
    const c = ctx({
      config: { github_org: "acme", orgs: { initech: {}, globex: {} } },
      workspaces: { client: { services: {}, org: "Globex" } },
      blueprints: [{ name: "client", org: "initech" }],
    });
    const r = resolveWorkspaceOrg("client", c);
    expect(r).toMatchObject({ org: "globex", source: "workspace" });
    expect(r.warnings).toEqual([
      "project client: org Globex in workspaces.yml overrides the blueprint's org initech",
    ]);
  });

  it("a workspace not set up yet resolves from its blueprint repos", () => {
    const c = ctx({
      config: { github_org: "acme" },
      catalog: CATALOG,
      blueprints: [{ name: "client", repos: ["globex-api"] }],
    });
    expect(resolveWorkspaceOrg("client", c)).toMatchObject({
      org: "Globex",
      source: "catalog",
    });
  });

  it("mixed owners: a warning, and github_org", () => {
    const c = ctx({
      config: { github_org: "acme" },
      catalog: CATALOG,
      workspaces: { mixed: { services: managed("acme-api", "globex-api") } },
    });
    const r = resolveWorkspaceOrg("mixed", c);
    expect(r).toMatchObject({ org: "acme", source: "default" });
    expect(r.warnings).toEqual([
      "project mixed: its repos belong to several owners (acme, Globex); using acme. Set org: on the project to choose one",
    ]);
  });

  it("an org: naming an unknown owner is a warning, not an error", () => {
    const c = ctx({
      config: { github_org: "acme" },
      workspaces: { w: { services: {}, org: "example-org" } },
    });
    const r = resolveWorkspaceOrg("w", c);
    expect(r.org).toBe("example-org");
    expect(r.warnings).toEqual([
      "project w: org example-org is not in orgs:, the catalog or github_org",
    ]);
  });

  it("a non-string org: in workspaces.yml is ignored with a warning", () => {
    const c = ctx({
      config: { github_org: "acme" },
      workspaces: {
        w: { services: {}, org: 7 as unknown as string },
      },
    });
    const r = resolveWorkspaceOrg("w", c);
    expect(r.org).toBe("acme");
    expect(r.warnings[0]).toMatch(/not an org id; ignored/);
  });

  it("with no org at all githubOrgFor throws like requireGithubOrg", () => {
    const c = ctx({ workspaces: { w: { services: managed("alpha") } } });
    expect(resolveWorkspaceOrg("w", c).org).toBeNull();
    expect(() => githubOrgFor("w", c)).toThrow(/github_org is not set/);
  });

  it("resolves every workspace, then blueprint-only ones", () => {
    const c = ctx({
      config: { github_org: "acme" },
      workspaces: { default: { services: {} } },
      blueprints: [{ name: "client", org: "acme" }],
    });
    expect(resolveAllWorkspaceOrgs(c).map((w) => w.workspace)).toEqual([
      "default",
      "client",
    ]);
  });
});

describe("withOrgMembership (/api/orgs, C3)", () => {
  const config = {
    environments: ["local"],
    github_org: "acme",
    orgs: { globex: { label: "Globex Corp", color: "#0af" } },
  } as DenConfig;

  it("adds only default and workspaces; same entries, order and fields", () => {
    const base = listOrgs(CATALOG, config.orgs);
    const c = ctx({
      config,
      catalog: CATALOG,
      workspaces: {
        default: { services: managed("acme-api") },
        client: { services: managed("globex-web") },
      },
      blueprints: [{ name: "not-here", org: "globex" }],
    });
    const out = withOrgMembership(
      base,
      resolveAllWorkspaceOrgs(c),
      c.file,
      config,
    );
    // Stripping the two new fields gives back the old listing byte for byte.
    const stripped = out.map(
      ({ default: _d, workspaces: _w, ...rest }) => rest,
    );
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(base));
    expect(out.map((o) => [o.id, o.default, o.workspaces])).toEqual([
      ["globex", false, ["client"]],
      ["acme", true, ["default"]],
      ["Globex", false, []],
    ]);
  });
});
