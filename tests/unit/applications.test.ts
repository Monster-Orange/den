import { describe, it, expect } from "@jest/globals";
import {
  findApplication,
  resolveApplications,
} from "../../src/shared/applications.js";
import { resolveOrg } from "../../src/shared/org.js";
import {
  appRepos,
  takeAppFlag,
} from "../../src/ui/cli/applications-command.js";
import { unknownCommandFlags } from "../../src/ui/cli/flag-parser.js";

describe("resolveApplications", () => {
  it("puts declared repos in their application and makes every other repo its own", () => {
    const apps = resolveApplications({
      repos: ["web", "api", "db", "notes"],
      config: {
        shop: {
          title: "Shop",
          owner: "Team A",
          description: "The shop",
          repos: ["web", "api"],
        },
      },
    });
    expect(apps.map((a) => [a.name, a.source, a.repos])).toEqual([
      ["shop", "declared", ["api", "web"]],
      ["db", "repo", ["db"]],
      ["notes", "repo", ["notes"]],
    ]);
    expect(apps[0]).toMatchObject({
      title: "Shop",
      owner: "Team A",
      description: "The shop",
    });
    // Application == Repo: titled after the repo, no owner.
    expect(apps[1].title).toBe("db");
    expect(apps[1].owner).toBeUndefined();
  });

  it("does not join undeclared repos by their dependency links", () => {
    const apps = resolveApplications({ repos: ["a", "b"] });
    expect(apps.map((a) => [a.name, a.repos])).toEqual([
      ["a", ["a"]],
      ["b", ["b"]],
    ]);
  });

  it("lets a repo's manifest application win over the team list", () => {
    const apps = resolveApplications({
      repos: ["web", "api"],
      config: { shop: { repos: ["web", "api"] } },
      manifestApplications: { api: "portal" },
    });
    expect(findApplication(apps, "portal")?.repos).toEqual(["api"]);
    expect(findApplication(apps, "shop")?.repos).toEqual(["web"]);
    expect(findApplication(apps, "portal")?.source).toBe("declared");
  });

  it("lists declared applications in config order, then manifest-only ones", () => {
    const apps = resolveApplications({
      repos: ["a", "b", "c"],
      config: { first: { repos: ["a"] }, second: { repos: ["b"] } },
      manifestApplications: { b: "second", c: "extra" },
    });
    expect(apps.map((a) => a.name)).toEqual(["first", "second", "extra"]);
  });

  it("keeps declared applications with no repos in scope, and ignores out-of-scope repos", () => {
    const apps = resolveApplications({
      repos: ["notes"],
      config: { shop: { repos: ["web"] } },
    });
    expect(apps).toEqual([
      expect.objectContaining({ name: "shop", repos: [] }),
      expect.objectContaining({ name: "notes", repos: ["notes"] }),
    ]);
  });

  it("places an undeclared repo in a declared application of the same name", () => {
    const apps = resolveApplications({
      repos: ["shop", "api"],
      config: { shop: { title: "Shop", repos: ["api"] } },
    });
    expect(apps.map((a) => [a.name, a.repos])).toEqual([
      ["shop", ["api", "shop"]],
    ]);
  });

  it("lists modules and libraries as contributors of their application", () => {
    const apps = resolveApplications({
      repos: ["core", "feature-x", "lib-y"],
      config: { smb: { repos: ["core", "feature-x"] } },
      kinds: { "feature-x": "module", "lib-y": "library" },
      contributesTo: { "feature-x": ["core"], "lib-y": [] },
    });
    expect(apps).toEqual([
      expect.objectContaining({
        name: "smb",
        repos: ["core"],
        contributors: [
          { repo: "feature-x", kind: "module", contributesTo: ["core"] },
        ],
      }),
      expect.objectContaining({
        name: "lib-y",
        source: "repo",
        repos: [],
        contributors: [{ repo: "lib-y", kind: "library", contributesTo: [] }],
      }),
    ]);
  });
});

describe("resolveOrg", () => {
  it("reads org id and title", () => {
    expect(
      resolveOrg({
        org: { id: "acme", title: "Acme Inc" },
        edge: { org: "other" },
      }),
    ).toEqual({ id: "acme", title: "Acme Inc" });
  });

  it("defaults the id from edge.org and the title from the id", () => {
    expect(resolveOrg({ edge: { org: "globex" } })).toEqual({
      id: "globex",
      title: "globex",
    });
    expect(
      resolveOrg({ org: { title: "Acme" }, edge: { org: "acme" } }),
    ).toEqual({ id: "acme", title: "Acme" });
  });

  it("is undefined when nothing names the org", () => {
    expect(resolveOrg({})).toBeUndefined();
    expect(resolveOrg(null)).toBeUndefined();
  });
});

describe("--app / -A", () => {
  it("takes the application in every form and leaves the rest", () => {
    expect(takeAppFlag(["-A", "shop", "-n"])).toEqual({
      app: "shop",
      rest: ["-n"],
    });
    expect(takeAppFlag(["--app", "shop"]).app).toBe("shop");
    expect(takeAppFlag(["--app=shop"]).app).toBe("shop");
    expect(takeAppFlag(["web"])).toEqual({ app: undefined, rest: ["web"] });
    expect(() => takeAppFlag(["-A"])).toThrow(/needs an application name/);
    expect(() => takeAppFlag(["--app", "-n"])).toThrow(
      /needs an application name/,
    );
  });

  it("no longer accepts -g/--group", () => {
    expect(takeAppFlag(["-g", "shop"])).toEqual({
      app: undefined,
      rest: ["-g", "shop"],
    });
    expect(unknownCommandFlags("up", ["-g", "shop"])).toEqual(["-g"]);
  });

  it("is an accepted flag for up, down and restart", () => {
    for (const cmd of ["up", "down", "restart"]) {
      expect(unknownCommandFlags(cmd, ["-A", "shop"])).toEqual([]);
      expect(unknownCommandFlags(cmd, ["--app", "shop"])).toEqual([]);
      expect(unknownCommandFlags(cmd, ["--app=shop"])).toEqual([]);
    }
    expect(unknownCommandFlags("up", ["--appx"])).toEqual(["--appx"]);
  });

  it("resolves an application's runtime repos, or explains why not", () => {
    const apps = resolveApplications({
      repos: ["web", "feature-x"],
      config: { shop: { repos: ["web"] }, mods: { repos: ["feature-x"] } },
      kinds: { "feature-x": "module" },
    });
    expect([...appRepos(apps, "shop")]).toEqual(["web"]);
    expect(() => appRepos(apps, "nope")).toThrow(/No application "nope"/);
    expect(() => appRepos(apps, "mods")).toThrow(/only modules\/libraries/);
  });
});
