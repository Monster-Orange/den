/**
 * ORG-1d (ORG-SPEC §1): orgs are Den's own concept, sources are bindings.
 *   - `orgs.<id>.sources` / `.repos` are checked when den.yml is read; a bad
 *     value names its key, and a repo or owner claimed twice names both.
 *     Configs without the new keys are never rejected (C1).
 *   - orgOf resolves an explicit `repos` entry, then a source that claims
 *     the owner, then the bare GitHub owner (unchanged without new keys).
 *   - A claimed owner is not listed as an org of its own.
 *   - The clone source is the repo's source (GitHub), else its `remote:`
 *     through plain git, else the legacy slug.
 *   - Inference (§2 step 3), the GitHub owner of a workspace, and discovery
 *     (`register`) follow the org's sources.
 *
 * Pure: every test builds its own config. Invented orgs only.
 */
import { describe, expect, it } from "@jest/globals";
import type { DenConfig } from "../../../src/shared/den-config.js";
import type { ServiceCatalog } from "../../../src/shared/types/index.js";
import {
  githubOwnersOf,
  orgHasGithub,
  parseRemote,
  repoSource,
  validateOrgSources,
  type WorkOrgsConfig,
} from "../../../src/shared/org-sources.js";
import { listOrgs, orgOf } from "../../../src/shared/manifest/service-links.js";
import {
  needsGhRepair,
  resolveRepoCloneSource,
} from "../../../src/shared/environment-manager/catalog.js";
import {
  checkedRemote,
  isGitRemote,
  redactRemote,
} from "../../../src/shared/environment-manager/git-remote.js";
import {
  githubOrgFor,
  resolveWorkspaceOrg,
  type OrgContext,
} from "../../../src/shared/environment-manager/workspace-org.js";
import { catalogFill } from "../../../src/shared/environment-manager/default-workspace.js";
import { registerOrg } from "../../../src/ui/cli/org-command.js";
import { ConfigError } from "../../../src/shared/config-error.js";

const FILE = "config/den.yml";
const bad = (orgs: unknown) => () => validateOrgSources(orgs, FILE);

const ORGS: WorkOrgsConfig = {
  "acme-group": {
    label: "Acme Group",
    sources: [
      { host: "github", owner: "acme" },
      { host: "github", owner: "Acme-Labs" },
    ],
  },
  "globex-red": { repos: ["globex-billing"] },
  "globex-blue": { sources: [{ host: "github", owner: "globex" }] },
  initech: { sources: [], repos: ["widget"] },
  hooli: { sources: [{ host: "gitlab", group: "hooli" }] },
  legacy: { label: "Legacy" },
};

const CATALOG: ServiceCatalog = {
  "acme-api": { gh: "acme/acme-api" },
  "labs-tool": { gh: "acme-labs/labs-tool" },
  "globex-billing": { gh: "globex/globex-billing" },
  "globex-web": { gh: "Globex/globex-web" },
  widget: { remote: "/srv/git/widget.git" },
  "hooli-app": { remote: "git@gitlab.example.com:hooli/apps/hooli-app.git" },
  "umbrella-api": { gh: "umbrella/umbrella-api" },
  loose: { gh: "" },
};

describe("validateOrgSources: errors name the key", () => {
  it("accepts configs without the new keys, whatever else they hold (C1)", () => {
    expect(bad(undefined)).not.toThrow();
    expect(bad({ acme: { label: "Acme" }, globex: {} })).not.toThrow();
    expect(bad(ORGS)).not.toThrow();
  });

  it.each([
    [{ acme: { sources: "github" } }, "orgs.acme.sources must be a list"],
    [{ acme: { sources: ["x"] } }, "orgs.acme.sources[0] must be a map"],
    [
      { acme: { sources: [{ host: "GitHub", owner: "acme" }] } },
      "orgs.acme.sources[0].host must be a git host id",
    ],
    [
      { acme: { sources: [{ host: "github" }] } },
      "orgs.acme.sources[0] needs exactly one of owner or group",
    ],
    [
      { acme: { sources: [{ host: "github", owner: "a/b" }] } },
      "orgs.acme.sources[0].owner must be a GitHub owner name",
    ],
    [
      { acme: { sources: [{ host: "github", owner: "acme", token: "x" }] } },
      'orgs.acme.sources[0]: unknown key "token"',
    ],
    [
      { acme: { repos: "widget" } },
      "orgs.acme.repos must be a list of repo names",
    ],
  ])("%j", (orgs, msg) => {
    expect(bad(orgs)).toThrow(`${FILE}: ${msg}`);
  });

  it("a repo listed by two orgs names both", () => {
    expect(bad({ a: { repos: ["w"] }, b: { repos: ["w"] } })).toThrow(
      "repo w is claimed by both orgs.a.repos and orgs.b.repos",
    );
  });

  it("an owner claimed by two orgs' sources names both, case-insensitively", () => {
    expect(
      bad({
        a: { sources: [{ host: "github", owner: "acme" }] },
        b: { sources: [{ host: "github", owner: "ACME" }] },
      }),
    ).toThrow(
      "github owner ACME is claimed by both orgs.a.sources[0] and orgs.b.sources[0]",
    );
  });

  it("a source claiming a legacy org's own owner names both", () => {
    expect(
      bad({
        acme: { label: "Acme" },
        group: { sources: [{ host: "github", owner: "acme" }] },
      }),
    ).toThrow(
      "github owner acme is claimed by both orgs.group.sources[0] and orgs.acme",
    );
  });

  it("one org may name an owner twice; another host's group never clashes with GitHub", () => {
    expect(
      bad({
        a: {
          sources: [
            { host: "github", owner: "acme" },
            { host: "github", owner: "acme" },
          ],
        },
        b: { sources: [{ host: "gitlab", group: "acme" }] },
      }),
    ).not.toThrow();
  });
});

describe("orgOf: repos, then a source, then the GitHub owner", () => {
  it.each([
    ["acme-api", "acme-group"],
    ["labs-tool", "acme-group"],
    ["globex-billing", "globex-red"],
    ["globex-web", "globex-blue"],
    ["widget", "initech"],
    ["hooli-app", "hooli"],
    ["umbrella-api", "umbrella"],
    ["loose", ""],
    ["missing", ""],
  ])("%s → %s", (repo, org) => {
    expect(orgOf(repo, CATALOG, ORGS)).toBe(org);
  });

  it("without the new keys it is the GitHub owner, as spelled", () => {
    for (const orgs of [undefined, { acme: { label: "A" } }])
      expect(Object.keys(CATALOG).map((r) => orgOf(r, CATALOG, orgs))).toEqual([
        "acme",
        "acme-labs",
        "globex",
        "Globex",
        "",
        "",
        "umbrella",
        "",
      ]);
  });

  it("listOrgs does not list an owner a source claims", () => {
    expect(listOrgs(CATALOG, ORGS).map((o) => o.id)).toEqual([
      "acme-group",
      "globex-red",
      "globex-blue",
      "initech",
      "hooli",
      "legacy",
      "umbrella",
    ]);
    expect(listOrgs(CATALOG, ORGS)[0]).toEqual({
      id: "acme-group",
      label: "Acme Group",
    });
  });
});

describe("sources and remotes", () => {
  it("parses a remote's host and owner path", () => {
    expect(parseRemote("https://github.com/acme/x.git")).toEqual({
      host: "github",
      hostname: "github.com",
      owner: "acme",
    });
    expect(parseRemote("git@gitlab.example.com:hooli/apps/x.git")).toEqual({
      host: "gitlab.example.com",
      hostname: "gitlab.example.com",
      owner: "hooli/apps",
    });
    expect(parseRemote("/srv/git/x.git")).toBeNull();
    expect(parseRemote("file:///srv/git/x.git")).toBeNull();
  });

  it("a repo's source is one of its own org's that claims its owner", () => {
    expect(repoSource("acme-api", CATALOG, ORGS)).toEqual({
      host: "github",
      owner: "acme",
    });
    expect(repoSource("globex-billing", CATALOG, ORGS)).toBeNull();
    expect(repoSource("widget", CATALOG, ORGS)).toBeNull();
    expect(repoSource("umbrella-api", CATALOG, ORGS)).toBeNull();
  });

  it("GitHub owners: a legacy org is its own; a sourced org has its GitHub sources'", () => {
    expect(githubOwnersOf("legacy", ORGS)).toEqual(["legacy"]);
    expect(githubOwnersOf("umbrella", ORGS)).toEqual(["umbrella"]);
    expect(githubOwnersOf("ACME-GROUP", ORGS)).toEqual(["acme", "Acme-Labs"]);
    expect(orgHasGithub("initech", ORGS)).toBe(false);
    expect(orgHasGithub("hooli", ORGS)).toBe(false);
  });
});

describe("resolveRepoCloneSource", () => {
  const src = (repo: string, catalog = CATALOG, orgs = ORGS) =>
    resolveRepoCloneSource(repo, catalog, () => "fallback", orgs);

  it("a repo with a GitHub source clones its slug", () => {
    expect(src("acme-api")).toBe("acme/acme-api");
    expect(
      src("labs-new", {
        "labs-new": { remote: "https://github.com/acme-labs/x.git" },
      }),
    ).toBe("acme-labs/labs-new");
  });

  it("a repo with no source clones its remote: through plain git", () => {
    expect(src("widget")).toBe("/srv/git/widget.git");
    expect(isGitRemote(src("widget"))).toBe(true);
    expect(src("hooli-app")).toBe(
      "git@gitlab.example.com:hooli/apps/hooli-app.git",
    );
  });

  it("without a remote: it is the legacy slug, unchanged", () => {
    expect(src("umbrella-api")).toBe("umbrella/umbrella-api");
    expect(src("loose")).toBe("fallback/loose");
    expect(src("loose", CATALOG, {})).toBe("fallback/loose");
  });

  it("a remote: that could run a command is refused, naming the key and not the value", () => {
    const evil = { w: { remote: 'ext::sh -c "touch x"' } };
    expect(() => src("w", evil, {})).toThrow(
      "service catalog: w.remote is not a git URL Den can clone",
    );
    expect(() => src("w", evil, {})).not.toThrow(/touch/);
    expect(() => checkedRemote("w", "/a/$(id)")).toThrow();
    expect(() => checkedRemote("w", "-uhttps://x")).toThrow();
  });

  it("masks a remote's user info for display", () => {
    expect(redactRemote("https://user:tok@git.example.com/a/b.git")).toBe(
      "https://***@git.example.com/a/b.git",
    );
    expect(redactRemote("acme/x")).toBe("acme/x");
  });

  it("a remote clone is never written back as gh", () => {
    expect(needsGhRepair({ gh: "" }, "acme/x")).toBe(true);
    expect(needsGhRepair({ remote: "/srv/x.git" }, "/srv/x.git")).toBe(false);
    expect(needsGhRepair({ gh: "acme/x" }, "acme/x")).toBe(false);
  });
});

function ctx(): OrgContext {
  return {
    config: {
      environments: ["local"],
      github_org: "acme",
      orgs: ORGS,
    } as DenConfig,
    catalog: CATALOG,
    file: {
      active: ["main", "lab", "red"],
      focus: "main",
      workspaces: {
        main: {
          services: {
            "acme-api": { mode: "managed" },
            "labs-tool": { mode: "managed" },
          },
        },
        lab: { services: { widget: { mode: "managed" } } },
        red: { services: { "globex-billing": { mode: "managed" } } },
      },
    },
    blueprints: [
      {
        name: "fresh",
        repos: ["initech-new"],
        branch: "main",
        autostartOff: [],
        focus: false,
        org: "initech",
      },
    ],
  };
}

describe("workspaces follow the org's sources", () => {
  it("inference (§2 step 3) uses orgOf: two owners, one org", () => {
    expect(resolveWorkspaceOrg("main", ctx())).toMatchObject({
      org: "acme-group",
      source: "catalog",
      warnings: [],
    });
    expect(resolveWorkspaceOrg("lab", ctx()).org).toBe("initech");
    expect(resolveWorkspaceOrg("red", ctx()).org).toBe("globex-red");
  });

  it("github_org naming a claimed owner makes the claiming org the default", () => {
    const c = ctx();
    c.file.workspaces.empty = { services: {} };
    expect(resolveWorkspaceOrg("empty", c)).toMatchObject({
      org: "acme-group",
      source: "default",
    });
  });

  it("a workspace's GitHub owner is its org's first GitHub source; none throws, naming the key", () => {
    expect(githubOrgFor("main", ctx())).toBe("acme");
    expect(() => githubOrgFor("lab", ctx())).toThrow(
      "org initech has no GitHub source (orgs.initech.sources)",
    );
  });

  it("discovery: register lists nothing for an org with no GitHub source", () => {
    expect(registerOrg("main", undefined, ctx())).toBe("acme");
    expect(registerOrg("lab", undefined, ctx())).toBeUndefined();
    expect(registerOrg("main", "initech", ctx())).toBeUndefined();
    expect(registerOrg("main", "acme-group", ctx())).toBe("acme");
  });

  it("seeding gives a no-source org's repos no GitHub slug", () => {
    const fill = catalogFill(
      [
        { name: "fresh", repos: ["initech-new"] },
        { name: "main", repos: ["acme-new"] },
      ],
      CATALOG,
      ctx(),
    );
    expect([...fill]).toEqual([["acme-new", "acme/acme-new"]]);
  });
});

describe("a validation failure is a ConfigError (0.2.8-dev.2)", () => {
  it("so the CLI and the web server can tell it from a crash", () => {
    const claimed = bad({
      initech: { repos: ["widget"] },
      globex: { repos: ["widget"] },
    });
    expect(claimed).toThrow(ConfigError);
    try {
      claimed();
    } catch (e) {
      expect((e as ConfigError).code).toBe("config_invalid");
    }
    expect(bad({ acme: { sources: "x" } })).toThrow(ConfigError);
  });
});
