import { describe, expect, it } from "@jest/globals";
import {
  linksFor,
  listOrgs,
  openUrlFor,
  orgOf,
} from "../../../src/shared/manifest/service-links.js";

describe("openUrlFor", () => {
  it("prefers the declared URL for the env", () => {
    expect(
      openUrlFor(
        {
          urls: { beta: "https://beta.example.com/app" },
          health: { beta: { url: "https://beta.example.com/readyz" } },
        },
        "beta",
      ),
    ).toBe("https://beta.example.com/app");
  });

  it("falls back to the origin of the HTTP health check, not its path", () => {
    expect(
      openUrlFor(
        { health: { local: { url: "https://local.example.com/api/health" } } },
        "local",
      ),
    ).toBe("https://local.example.com/");
  });

  it("has no URL for shell checks, missing envs, or non-web schemes", () => {
    expect(
      openUrlFor(
        { health: { local: { type: "shell", cmd: "true" } } },
        "local",
      ),
    ).toBeNull();
    expect(
      openUrlFor({ health: { local: { url: "https://x.test/" } } }, "beta"),
    ).toBeNull();
    expect(
      openUrlFor({ urls: { local: "javascript:alert(1)" } }, "local"),
    ).toBeNull();
    expect(openUrlFor(undefined, "local")).toBeNull();
  });
});

describe("linksFor", () => {
  it("keeps the links that have a URL for the env", () => {
    expect(
      linksFor(
        {
          links: [
            { label: "Admin", urls: { local: "https://l.test/admin" } },
            { label: "Docs", urls: { beta: "https://b.test/docs" } },
            { label: "Bad", urls: { local: "file:///etc/passwd" } },
          ],
        },
        "local",
      ),
    ).toEqual([{ label: "Admin", url: "https://l.test/admin" }]);
  });
});

describe("orgs", () => {
  const catalog = {
    "hooli-app": { gh: "Hooli/hooli-app" },
    "initech-web": { gh: "Initech/initech-web" },
    "umbrella-hello": { gh: "Umbrella/umbrella-hello" },
    loose: { gh: "" },
  };

  it("reads the owner from the catalog slug", () => {
    expect(orgOf("initech-web", catalog)).toBe("Initech");
    expect(orgOf("loose", catalog)).toBe("");
    expect(orgOf("missing", catalog)).toBe("");
  });

  it("lists configured orgs first, then every catalog owner", () => {
    expect(
      listOrgs(catalog, {
        Umbrella: { label: "Umbrella Inc", color: "#a371f7" },
      }),
    ).toEqual([
      // configured: an org of Den's own (a company); else a repo's owner.
      {
        id: "Umbrella",
        label: "Umbrella Inc",
        color: "#a371f7",
        configured: true,
      },
      { id: "Hooli", label: "Hooli", configured: false },
      { id: "Initech", label: "Initech", configured: false },
    ]);
  });
});
