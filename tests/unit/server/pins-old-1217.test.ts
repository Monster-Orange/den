/**
 * Issue 1217: an old-format pin never vanishes.
 *
 * Old id-only pins (`shell.pins: [repo/service, …]`) move to project pins
 * on load (issue 402, clause 6). Now:
 * - its repo in one project: pinned in that project (as before);
 * - in two or more: pinned in each of them;
 * - in none: kept with no project (shown under All), and doctor lists it
 *   as "kept, no project";
 * - a bare id (no "/") is its own repo, and follows the same rules.
 * And loading never drops the list for one bad entry: before, one entry
 * that failed the check (a hand edit, a name that isn't a repo) dropped
 * every pin. The bad entry is skipped and named in doctor; the rest stay.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  MAX_PINS,
  mergeShellPrefs,
  pinNotes,
  shellPrefs,
} from "../../../src/ui/server/shell-prefs.js";
import { oldPinsLines } from "../../../src/ui/cli/doctor-command.js";

/** "shop" only in alpha, "billing" only in beta, "common" in both, "gone" in none. */
const OWNERS: Record<string, string[]> = {
  shop: ["alpha"],
  billing: ["beta"],
  common: ["alpha", "beta"],
};
const projectsOf = (item: string) => OWNERS[item.split("/")[0]] ?? [];

describe("issue 1217: an old-format pin never vanishes", () => {
  it("a repo in one project: pinned in that project", () => {
    expect(shellPrefs({ pins: ["shop/api"] }, projectsOf).pins).toEqual([
      { item: "shop/api", project: "alpha" },
    ]);
  });

  it("a repo in two projects: pinned in both", () => {
    expect(shellPrefs({ pins: ["common/web"] }, projectsOf).pins).toEqual([
      { item: "common/web", project: "alpha" },
      { item: "common/web", project: "beta" },
    ]);
  });

  it("a repo in no project: kept with no project, and doctor's note lists it", () => {
    const stored = { pins: ["gone/web", "shop"] };
    expect(shellPrefs(stored, projectsOf).pins).toEqual([
      { item: "gone/web", project: null },
      { item: "shop", project: "alpha" },
    ]);
    expect(pinNotes(stored, projectsOf)).toEqual({
      kept: ["gone/web"],
      skipped: [],
    });
  });

  it("a bare id (no '/') is its own repo: one, two and no projects", () => {
    const stored = { pins: ["shop", "common", "gone"] };
    expect(shellPrefs(stored, projectsOf).pins).toEqual([
      { item: "shop", project: "alpha" },
      { item: "common", project: "alpha" },
      { item: "common", project: "beta" },
      { item: "gone", project: null },
    ]);
    expect(pinNotes(stored, projectsOf).kept).toEqual(["gone"]);
  });

  it("an old list posted by an older page is moved by the same rules", () => {
    const r = mergeShellPrefs(
      shellPrefs(undefined),
      { pins: ["common", "gone"] },
      projectsOf,
    );
    expect(r.ok && r.value.pins).toEqual([
      { item: "common", project: "alpha" },
      { item: "common", project: "beta" },
      { item: "gone", project: null },
    ]);
  });

  it("one bad entry never drops the rest: it is skipped and named", () => {
    const stored = {
      pins: ["shop", "not a repo!", { item: 7 }, { item: "billing" }],
    };
    expect(shellPrefs(stored, projectsOf).pins).toEqual([
      { item: "shop", project: "alpha" },
      { item: "billing", project: null },
    ]);
    expect(pinNotes(stored, projectsOf).skipped).toEqual([
      '"not a repo!"',
      '{"item":7}',
    ]);
  });

  it("a stored list over the cap loses none on load", () => {
    const many = Array.from({ length: MAX_PINS + 3 }, (_, i) => `gone-${i}`);
    expect(shellPrefs({ pins: many }, projectsOf).pins).toHaveLength(
      MAX_PINS + 3,
    );
  });

  it("a person whose old pins load past the cap is never locked out: unpinning saves, adding past it is refused", () => {
    // 50 old pins, each of a repo in two projects: 100 pins on load.
    const both = (item: string) =>
      item.startsWith("two-") ? ["alpha", "beta"] : projectsOf(item);
    const old = Array.from({ length: 50 }, (_, i) => `two-${i}`);
    const loaded = shellPrefs({ pins: old }, both);
    expect(loaded.pins.length).toBeGreaterThan(MAX_PINS);
    // The page posts the whole list less the one unpinned.
    const fewer = mergeShellPrefs(loaded, { pins: loaded.pins.slice(1) }, both);
    expect(fewer.ok && fewer.value.pins.length).toBe(loaded.pins.length - 1);
    // The same list again (a save that changes no pin) is fine too.
    expect(mergeShellPrefs(loaded, { pins: loaded.pins }, both).ok).toBe(true);
    // One more than it had: refused, as any save past the cap is.
    const more = mergeShellPrefs(
      loaded,
      { pins: [...loaded.pins, { item: "shop", project: "alpha" }] },
      both,
    );
    expect(more.ok).toBe(false);
  });

  it("a list under the cap still can't grow past it", () => {
    const some = Array.from({ length: MAX_PINS }, (_, i) => `gone-${i}`);
    const loaded = shellPrefs({ pins: some }, projectsOf);
    const r = mergeShellPrefs(loaded, { pins: [...some, "shop"] }, projectsOf);
    expect(r.ok).toBe(false);
  });

  it("a posted list is still checked whole: a bad entry is refused, nothing stored", () => {
    const r = mergeShellPrefs(
      shellPrefs(undefined),
      { pins: ["shop", "not a repo!"] },
      projectsOf,
    );
    expect(r.ok).toBe(false);
  });

  it("doctor: kept and skipped pins are listed with their ids; nothing when there are none", () => {
    const read = () => ({
      shell: { pins: ["shop", "gone/web", "not a repo!"] },
    });
    const out = oldPinsLines("Den", read, projectsOf);
    expect(out.lines).toEqual([
      "",
      "Den doctor: Pins",
      "",
      "  kept, no project  ·  gone/web (shown under All)",
      '  skipped          ⚠  "not a repo!" (not a pin; left in user.yml, not shown)',
    ]);
    expect(out.check).toMatchObject({ id: "pins", status: "warn" });
    expect(
      oldPinsLines("Den", () => ({ shell: { pins: ["shop"] } }), projectsOf),
    ).toEqual({ lines: [], check: null });
  });
});
