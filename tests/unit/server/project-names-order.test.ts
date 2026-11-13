/**
 * 0.4.45 project names v5 (LOGICAL-ERD, Ward-approved mock v5): a project
 * linked to Hub shows Hub's name; an unlinked one its own. The picker lists
 * projects A to Z by the name shown (case- and accent-insensitive), "All
 * active" first, unless this person saved an order; a project not in that
 * order slots in A to Z among the others until it is moved.
 */
import { describe, expect, it } from "@jest/globals";
import {
  buildScopeMenuModel,
  moveProject,
  orderProjects,
  projectLabel,
  projectNameSource,
} from "../../../src/ui/server/public/workspace-picker.js";
import {
  mergeShellPrefs,
  shellPrefs,
  storedShell,
} from "../../../src/ui/server/shell-prefs.js";
import { projectDisplayName } from "../../../src/shared/workspace-name.js";

const data = (projectOrder?: string[]) => ({
  workspaces: {
    zeta: { name: "zeta" },
    alpha: {},
    north: {
      name: "north (local)",
      hub_project: { id: "p1", slug: "north-star", name: "North Star" },
    },
    beta: { name: "Écrin" },
  },
  active: ["zeta", "alpha", "north", "beta"],
  ...(projectOrder ? { projectOrder } : {}),
});

describe("the name a project shows", () => {
  it("Hub's name when linked, else its own, else its slug", () => {
    const d = data();
    expect(projectLabel(d, "north")).toBe("North Star");
    expect(projectNameSource(d, "north")).toBe("hub");
    expect(projectLabel(d, "beta")).toBe("Écrin");
    expect(projectNameSource(d, "beta")).toBe("local");
    expect(projectLabel(d, "alpha")).toBe("alpha");
  });

  it("the server resolves it the same way", () => {
    const d = data();
    expect(projectDisplayName("north", d.workspaces.north)).toBe("North Star");
    expect(projectDisplayName("beta", d.workspaces.beta)).toBe("Écrin");
    expect(projectDisplayName("alpha", {})).toBe("alpha");
  });
});

describe("project order", () => {
  it("A to Z by the name shown, ignoring case and accents", () => {
    const d = data();
    expect(orderProjects(d.active, d)).toEqual([
      "alpha",
      "beta", // Écrin
      "north", // North Star
      "zeta",
    ]);
  });

  it("a saved order wins; a project not in it slots in A to Z", () => {
    const d = data(["zeta", "alpha"]);
    // Each new one goes before the first saved project whose name sorts
    // after its own: Écrin and North Star both before zeta.
    expect(orderProjects(d.active, d, d.projectOrder)).toEqual([
      "beta",
      "north",
      "zeta",
      "alpha",
    ]);
  });

  it("a saved slug no longer listed is skipped", () => {
    const d = data(["gone", "north", "alpha", "zeta", "beta"]);
    expect(orderProjects(d.active, d, d.projectOrder)).toEqual([
      "north",
      "alpha",
      "zeta",
      "beta",
    ]);
  });

  it("the picker lists All active first, then the order", () => {
    const d = data(["zeta", "north", "beta", "alpha"]);
    const m = buildScopeMenuModel({ scope: "all" }, d);
    expect(m.items.map((i: { value: string }) => i.value)).toEqual([
      "all",
      "zeta",
      "north",
      "beta",
      "alpha",
    ]);
    expect(m.items[2].label).toBe("North Star");
  });

  it("with no saved order the picker is A to Z", () => {
    const m = buildScopeMenuModel({ scope: "all" }, data());
    expect(m.items.map((i: { value: string }) => i.value)).toEqual([
      "all",
      "alpha",
      "beta",
      "north",
      "zeta",
    ]);
  });
});

describe("the stored order (per person, user config shell.projectOrder)", () => {
  it("is kept, deduplicated, and dropped when cleared", () => {
    const m = mergeShellPrefs(shellPrefs({}), {
      projectOrder: ["zeta", "alpha", "zeta"],
    });
    expect(m.ok && m.value.projectOrder).toEqual(["zeta", "alpha"]);
    expect(m.ok && storedShell(m.value)?.projectOrder).toEqual([
      "zeta",
      "alpha",
    ]);
    const reset = m.ok && mergeShellPrefs(m.value, { projectOrder: null });
    expect(reset && reset.ok && storedShell(reset.value)).toBeUndefined();
  });

  it("refuses what is not a project slug", () => {
    const m = mergeShellPrefs(shellPrefs({}), { projectOrder: ["../x"] });
    expect(m.ok).toBe(false);
  });

  it("a hand-broken stored order reads as none", () => {
    expect(shellPrefs({ projectOrder: "zeta" }).projectOrder).toEqual([]);
  });
});

describe("moving a project (Manage projects)", () => {
  const list = ["a", "b", "c", "d"];
  it("Move up and Move down swap with a neighbour; the ends stay", () => {
    expect(moveProject(list, "c", -1)).toEqual(["a", "c", "b", "d"]);
    expect(moveProject(list, "c", 1)).toEqual(["a", "b", "d", "c"]);
    expect(moveProject(list, "a", -1)).toEqual(list);
    expect(moveProject(list, "d", 1)).toEqual(list);
  });
  it("a drop puts it before the row it lands on, or last", () => {
    expect(moveProject(list, "d", { before: "b" })).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
    expect(moveProject(list, "a", { before: null })).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
  });
  it("an unknown slug changes nothing, and the list is not mutated", () => {
    expect(moveProject(list, "x", 1)).toEqual(list);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });
});
