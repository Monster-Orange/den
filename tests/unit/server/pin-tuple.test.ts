/**
 * Issue 402 (the model set on 11-18): a pin is (company, project or none,
 * person, item). The company and the person are the install's own user
 * config (user.yml is one person's, in one install of one company); the
 * stored pin carries the item and the project picked when it was made.
 *
 *   1. a stored pin is { item, project }; project null is "none";
 *   5. the same item pinned in two projects is two pins;
 *   6. a pin saved before this change (a bare id) takes the item's own
 *      project when exactly one project has it, else none; on read and on
 *      write.
 */
import { describe, expect, it } from "@jest/globals";
import {
  MAX_PINS,
  mergeShellPrefs,
  shellPrefs,
  storedShell,
} from "../../../src/ui/server/shell-prefs.js";

/** Two projects: "shop" only in alpha, "billing" only in beta, "common" in both. */
const OWNERS: Record<string, string[]> = {
  shop: ["alpha"],
  billing: ["beta"],
  common: ["alpha", "beta"],
};
const projectsOf = (item: string) => OWNERS[item.split("/")[0]] ?? [];

describe("issue 402: the stored pin is (project or none, item)", () => {
  it("clause 1: a pin keeps its project; none is null", () => {
    expect(
      shellPrefs(
        {
          pins: [
            { item: "shop/api", project: "alpha" },
            { item: "billing", project: null },
            { item: "billing" },
          ],
        },
        projectsOf,
      ).pins,
    ).toEqual([
      { item: "shop/api", project: "alpha" },
      { item: "billing", project: null },
    ]);
  });

  it("clause 5: one item in two projects is two pins, and stays two", () => {
    const two = [
      { item: "common/web", project: "alpha" },
      { item: "common/web", project: "beta" },
    ];
    expect(shellPrefs({ pins: two }, projectsOf).pins).toEqual(two);
    const cur = shellPrefs({ pins: two }, projectsOf);
    const r = mergeShellPrefs(
      cur,
      { pins: [{ item: "common/web", project: "beta" }] },
      projectsOf,
    );
    expect(r.ok && r.value.pins).toEqual([
      { item: "common/web", project: "beta" },
    ]);
  });

  it("clause 6: an old id-only pin takes the project its repo is in; in two, each (issue 1217); in none, none (on read)", () => {
    expect(
      shellPrefs(
        { pins: ["shop", "billing/api", "common/web", "gone"] },
        projectsOf,
      ).pins,
    ).toEqual([
      { item: "shop", project: "alpha" },
      { item: "billing/api", project: "beta" },
      { item: "common/web", project: "alpha" },
      { item: "common/web", project: "beta" },
      { item: "gone", project: null },
    ]);
    // No project map at all: every old pin is none.
    expect(shellPrefs({ pins: ["shop"] }).pins).toEqual([
      { item: "shop", project: null },
    ]);
  });

  it("clause 6: an old id-only list posted is migrated the same way (on write)", () => {
    const r = mergeShellPrefs(
      shellPrefs(undefined),
      { pins: ["shop", "common"] },
      projectsOf,
    );
    expect(r.ok && r.value.pins).toEqual([
      { item: "shop", project: "alpha" },
      { item: "common", project: "alpha" },
      { item: "common", project: "beta" },
    ]);
  });

  it("an old pin that migrates onto an existing pin is one pin", () => {
    expect(
      shellPrefs(
        { pins: [{ item: "shop", project: "alpha" }, "shop"] },
        projectsOf,
      ).pins,
    ).toEqual([{ item: "shop", project: "alpha" }]);
  });

  it("stores the tuple; none leaves project out", () => {
    const p = shellPrefs(
      {
        pins: [
          { item: "shop", project: "alpha" },
          { item: "billing", project: null },
        ],
      },
      projectsOf,
    );
    expect(storedShell(p)?.pins).toEqual([
      { item: "shop", project: "alpha" },
      { item: "billing" },
    ]);
    // Read back, the stored block is the same pins.
    expect(shellPrefs(storedShell(p), projectsOf).pins).toEqual(p.pins);
  });

  it("refuses a pin whose item or project isn't a name", () => {
    const cur = shellPrefs(undefined);
    for (const pins of [
      [{ item: "../etc", project: "alpha" }],
      [{ item: "shop", project: "../x" }],
      [{ item: "shop", project: 3 }],
      [{ project: "alpha" }],
      Array.from({ length: MAX_PINS + 1 }, (_, i) => ({
        item: `r${i}`,
        project: null,
      })),
    ])
      expect([pins, mergeShellPrefs(cur, { pins }, projectsOf).ok]).toEqual([
        pins,
        false,
      ]);
  });
});
