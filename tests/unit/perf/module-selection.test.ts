import { describe, expect, it } from "@jest/globals";
import { resolvePerformanceModules } from "../../../src/ui/cli/module-selection.js";

const availableModules = [
  { name: "api-health" },
  { name: "sample-service/items-root" },
  { name: "sample-service/search" },
  { name: "sample-service/tree" },
];

describe("resolvePerformanceModules", () => {
  it("returns all available performance modules when no selection is provided", () => {
    expect(
      resolvePerformanceModules({
        availableModules,
      }),
    ).toEqual([
      "api-health",
      "sample-service/items-root",
      "sample-service/search",
      "sample-service/tree",
    ]);
  });

  it("returns only the explicitly selected module when provided", () => {
    expect(
      resolvePerformanceModules({
        availableModules,
        selectedModule: "sample-service/search",
      }),
    ).toEqual(["sample-service/search"]);
  });

  it("filters to all modules owned by a repo when repo is provided", () => {
    expect(
      resolvePerformanceModules({
        availableModules,
        repoName: "sample-service",
      }),
    ).toEqual([
      "sample-service/items-root",
      "sample-service/search",
      "sample-service/tree",
    ]);
  });

  it("throws when a repo filter matches no modules", () => {
    expect(() =>
      resolvePerformanceModules({
        availableModules,
        repoName: "missing-repo",
      }),
    ).toThrow('No performance modules found for repo "missing-repo"');
  });
});
