import { describe, it, expect } from "@jest/globals";

import { computeSeedRepos } from "../../../src/scripts/setup-default-workspace.js";

/**
 * The default-workspace wizard used to derive its repo set ONLY by walking the
 * dependency graph from the entry repo. That misses islands — control-plane has no
 * deps and nothing depends on it — and on a machine with no sibling checkouts
 * the walk finds nothing at all (it can only read manifests that exist on
 * disk). The seed is now fleet-first; these tests pin that contract.
 */
describe("computeSeedRepos — default-workspace seed derivation", () => {
  const FLEET = [
    "links-api",
    "files-api",
    "notes-api",
    "search-api",
    "billing-api",
    "tokens",
    "jobs-runtime",
    "control-plane",
    "shop",
    "shop-web",
  ];

  it("includes graph islands like control-plane even when the walk misses them", () => {
    const walkWithoutControlPlane = [
      "shop",
      "files-api",
      "links-api",
      "infra-stack",
    ];
    const seed = computeSeedRepos(
      FLEET,
      walkWithoutControlPlane,
      ["infra-stack"],
      "shop-web",
    );
    expect(seed).toContain("control-plane");
  });

  it("produces the full standard set on a bare machine (empty graph walk)", () => {
    const seed = computeSeedRepos(FLEET, [], ["infra-stack"], "shop-web");
    // Every fleet repo, plus infra-stack — which only exists as a dependency
    // inside other repos' manifests, so no config or walk can surface it here.
    for (const repo of FLEET) expect(seed).toContain(repo);
    expect(seed).toContain("infra-stack");
    expect(seed).toHaveLength(FLEET.length + 1);
  });

  it("puts shop-web first and dedupes it against the fleet", () => {
    const seed = computeSeedRepos(FLEET, ["shop-web", "shop"], [], "shop-web");
    expect(seed[0]).toBe("shop-web");
    expect(seed.filter((r) => r === "shop-web")).toHaveLength(1);
  });

  it("keeps walk-discovered deps that are not in the fleet", () => {
    const seed = computeSeedRepos(FLEET, ["some-shared-sidecar"]);
    expect(seed).toContain("some-shared-sidecar");
  });

  it("drops empty names and duplicate extras", () => {
    const seed = computeSeedRepos(
      ["a", "", "b"],
      ["b", ""],
      ["infra-stack", "infra-stack"],
      "shop-web",
    );
    expect(seed).toEqual(["shop-web", "a", "b", "infra-stack"]);
  });
});

describe("computeSeedRepos — no entry repo configured", () => {
  it("seeds the fleet alone, with nothing hard-wired", () => {
    expect(computeSeedRepos(["a", "b"], [])).toEqual(["a", "b"]);
  });
});
