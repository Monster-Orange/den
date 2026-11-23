/**
 * Issue 1334: an empty project (no repos, no services, no agents) is a
 * normal state. Nothing proposes a Hub link for it.
 */
import { describe, it, expect } from "@jest/globals";
import {
  isEmptyProject,
  emptyProjectTest,
} from "../../../src/shared/empty-project.js";
import type { WorkspaceConfig } from "../../../src/shared/types/index.js";

const cfg = (o: Partial<WorkspaceConfig> = {}): WorkspaceConfig =>
  ({ services: {}, ...o }) as WorkspaceConfig;

describe("isEmptyProject (issue 1334)", () => {
  it("no repos, services or agents: empty; a missing entry is empty too", () => {
    expect(isEmptyProject("default", cfg(), [])).toBe(true);
    expect(isEmptyProject("default", undefined, [])).toBe(true);
    expect(isEmptyProject("default", cfg({ repos: {} }), [])).toBe(true);
  });

  it("one repo, one service, one seeded repo or one agent: not empty", () => {
    expect(isEmptyProject("x", cfg({ repos: { shop: "main" } }), [])).toBe(
      false,
    );
    expect(
      isEmptyProject(
        "x",
        cfg({ services: { "shop/api": {} } } as Partial<WorkspaceConfig>),
        [],
      ),
    ).toBe(false);
    expect(isEmptyProject("x", cfg({ seeded_repos: ["shop"] }), [])).toBe(
      false,
    );
    expect(isEmptyProject("x", cfg(), [{ workspace: "x" }])).toBe(false);
    expect(
      isEmptyProject("x", cfg(), [{ workspace: "other", project: "x" }]),
    ).toBe(false);
  });

  it("another project's agents don't count", () => {
    expect(isEmptyProject("x", cfg(), [{ workspace: "other" }])).toBe(true);
  });

  it("emptyProjectTest reads the file and the records once", () => {
    let reads = 0;
    const t = emptyProjectTest(
      () => {
        reads++;
        return {
          workspaces: {
            default: cfg(),
            shop: cfg({ repos: { shop: "main" } }),
          },
        };
      },
      () => [{ workspace: "solo" }],
    );
    expect(t("default")).toBe(true);
    expect(t("shop")).toBe(false);
    expect(t("solo")).toBe(false);
    expect(reads).toBe(1);
  });

  it("a file that won't read: nothing counts as empty (never hide a project on an error)", () => {
    const t = emptyProjectTest(
      () => {
        throw new Error("bad yaml");
      },
      () => [],
    );
    expect(t("default")).toBe(false);
  });
});
