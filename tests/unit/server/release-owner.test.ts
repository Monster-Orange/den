/**
 * REL-1: the owner a repo is released from. A repo's own `gh: owner/repo`
 * in the release config wins; then an explicit `release.org` (its meaning is
 * unchanged, C2); then the repo's non-empty catalog owner; `github_org`
 * (readReleaseConfig's fallback for `org`) last. Before REL-1 every repo
 * without a slug released from `github_org`, so a client org's repo
 * targeted the wrong owner.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("child_process", () => ({ execFile: jest.fn() }));
jest.mock("../../../src/shared/den-config.js", () => ({
  ...jest.requireActual<object>("../../../src/shared/den-config.js"),
  readReleaseConfig: jest.fn(),
  readExplicitReleaseOrg: jest.fn(),
}));
jest.mock("../../../src/shared/manifest/workspace-manifests.js", () => ({
  listReposWithManifests: jest.fn(() => []),
}));
jest.mock("../../../src/shared/environment-manager/catalog.js", () => ({
  readCatalog: jest.fn(() => ({})),
}));

import { readCatalog } from "../../../src/shared/environment-manager/catalog.js";
import * as denConfig from "../../../src/shared/den-config.js";
import { ReleaseService } from "../../../src/ui/server/release-service.js";

const mockReadReleaseConfig = denConfig.readReleaseConfig as jest.Mock;
const mockExplicit = (
  denConfig as unknown as { readExplicitReleaseOrg: jest.Mock }
).readExplicitReleaseOrg;
const mockCatalog = readCatalog as jest.Mock;

/** The config readReleaseConfig gives: `org` is github_org when unset. */
function release(org: string | undefined): void {
  mockReadReleaseConfig.mockReturnValue({
    deploy: true,
    org,
    environments: ["dev"],
    staggerSeconds: 0,
    pollSeconds: 0,
    repos: [
      { name: "acme-api", workflow: "cd.yml", wave: 0 },
      { name: "globex-web", workflow: "cd.yml", wave: 0 },
      { name: "pinned", workflow: "cd.yml", wave: 0, gh: "initech/pinned" },
      { name: "unlisted", workflow: "cd.yml", wave: 0 },
      { name: "blank", workflow: "cd.yml", wave: 0 },
    ],
  });
}

beforeEach(() => {
  mockExplicit.mockReset();
  mockCatalog.mockReturnValue({
    "acme-api": { gh: "acme/acme-api" },
    "globex-web": { gh: "globex/globex-web" },
    pinned: { gh: "globex/pinned" },
    blank: { gh: "" },
  });
});

describe("release owner per repo (REL-1)", () => {
  it("no release.org: each repo's catalog owner, then github_org", () => {
    release("acme"); // github_org, filled in by readReleaseConfig
    mockExplicit.mockReturnValue(undefined);
    const svc = new ReleaseService();
    expect(svc.slug("acme-api")).toBe("acme/acme-api");
    expect(svc.slug("globex-web")).toBe("globex/globex-web");
    expect(svc.slug("unlisted")).toBe("acme/unlisted");
    expect(svc.slug("blank")).toBe("acme/blank"); // gh: "" is no owner
  });

  it("an explicit release.org still wins over the catalog owner", () => {
    release("example-org");
    mockExplicit.mockReturnValue("example-org");
    const svc = new ReleaseService();
    expect(svc.slug("globex-web")).toBe("example-org/globex-web");
    expect(svc.slug("acme-api")).toBe("example-org/acme-api");
  });

  it("a repo's own gh: owner/repo in the release config wins over everything", () => {
    release("example-org");
    mockExplicit.mockReturnValue("example-org");
    expect(new ReleaseService().slug("pinned")).toBe("initech/pinned");
  });
});

describe("releaseOwnerFor", () => {
  it("explicit, then catalog owner, then github_org; blanks skipped", () => {
    const { releaseOwnerFor } = jest.requireActual<typeof denConfig>(
      "../../../src/shared/den-config.js",
    );
    expect(
      releaseOwnerFor({
        explicitOrg: "a",
        catalogOwner: "b",
        githubOrg: "c",
      }),
    ).toBe("a");
    expect(
      releaseOwnerFor({ explicitOrg: " ", catalogOwner: "b", githubOrg: "c" }),
    ).toBe("b");
    expect(releaseOwnerFor({ catalogOwner: "", githubOrg: "c" })).toBe("c");
    expect(releaseOwnerFor({})).toBe("");
  });
});
