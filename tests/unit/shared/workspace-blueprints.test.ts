/**
 * readWorkspaceBlueprints: `defaults.workspace` (one, named `default`) or
 * `defaults.workspaces` (named), validated; both at once is an error.
 */
import { describe, expect, it } from "@jest/globals";
import {
  readWorkspaceBlueprints,
  type DenConfig,
} from "../../../src/shared/den-config.js";

const cfg = (defaults: unknown): DenConfig =>
  ({ environments: ["local"], defaults }) as DenConfig;

describe("readWorkspaceBlueprints", () => {
  it("is empty without a blueprint", () => {
    expect(readWorkspaceBlueprints(cfg(undefined))).toEqual({
      shape: "none",
      workspaces: [],
    });
  });

  it("reads the single shape as the default workspace, branch main", () => {
    expect(
      readWorkspaceBlueprints(
        cfg({ workspace: { repos: ["a", "b"], entry: "a" } }),
      ),
    ).toEqual({
      shape: "single",
      workspaces: [
        {
          name: "default",
          repos: ["a", "b"],
          branch: "main",
          autostartOff: [],
          focus: false,
        },
      ],
    });
  });

  it("reads the multi shape in order, with focus and per-workspace branch", () => {
    const bp = readWorkspaceBlueprints(
      cfg({
        workspaces: {
          web: { repos: ["a"] },
          data: { repos: ["b"], branch: "dev", focus: true },
        },
      }),
    );
    expect(bp.shape).toBe("multi");
    expect(bp.workspaces.map((w) => [w.name, w.branch, w.focus])).toEqual([
      ["web", "main", false],
      ["data", "dev", true],
    ]);
  });

  it.each([
    [
      "both shapes",
      { workspace: { repos: ["a"] }, workspaces: { web: { repos: ["a"] } } },
      /sets both defaults\.workspace and defaults\.workspaces/,
    ],
    [
      "a list instead of a map",
      { workspaces: [{ repos: ["a"] }] },
      /defaults\.workspaces must be a map/,
    ],
    [
      "repos not a list",
      { workspaces: { web: { repos: "a" } } },
      /defaults\.workspaces\.web\.repos must be a list of repo names/,
    ],
    [
      "an unknown key",
      { workspaces: { web: { repos: ["a"], mode: "managed" } } },
      /defaults\.workspaces\.web: unknown key "mode"/,
    ],
    [
      "focus not a boolean",
      { workspaces: { web: { repos: ["a"], focus: "yes" } } },
      /defaults\.workspaces\.web\.focus must be true or false/,
    ],
    [
      "two focused workspaces",
      {
        workspaces: {
          web: { repos: ["a"], focus: true },
          data: { repos: ["b"], focus: true },
        },
      },
      /only one workspace may set focus: true \(got web, data\)/,
    ],
    [
      "a bad workspace name",
      { workspaces: { "a/b": { repos: ["a"] } } },
      /"a\/b" is not a valid workspace name/,
    ],
  ])("rejects %s", (_label, defaults, message) => {
    expect(() => readWorkspaceBlueprints(cfg(defaults))).toThrow(message);
  });
});
