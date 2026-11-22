/**
 * Issue 168 (mock v2, approved 11-15): each project has a colour, and its
 * agents inherit it. Eight colours, none orange or red. Each project gets
 * one on its own, the same every time; a person may choose another (or
 * Automatic) for themselves: user settings, shell.projectColours, never
 * shared and never sent to Hub. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  PROJECT_COLOURS as SERVER_COLOURS,
  mergeShellPrefs,
  shellPrefs,
  storedShell,
} from "../../../src/ui/server/shell-prefs.js";
import {
  PROJECT_COLOURS,
  buildScopeMenuModel,
  projectColour,
  projectColours,
} from "../../../src/ui/server/public/workspace-picker.js";

describe("the stored choice (shell.projectColours)", () => {
  it("keeps a valid choice and drops a hand-broken one", () => {
    expect(
      shellPrefs({
        projectColours: { alpha: "teal", beta: "orange", "bad name": "blue" },
      }).projectColours,
    ).toEqual({ alpha: "teal" });
    expect(shellPrefs({ projectColours: "teal" }).projectColours).toEqual({});
    expect(shellPrefs(undefined).projectColours).toEqual({});
  });

  it("a save sets one project's colour and keeps the others'; null is Automatic again", () => {
    const cur = shellPrefs({ projectColours: { alpha: "teal" } });
    const a = mergeShellPrefs(cur, { projectColours: { beta: "gold" } });
    expect(a.ok && a.value.projectColours).toEqual({
      alpha: "teal",
      beta: "gold",
    });
    const b = mergeShellPrefs(cur, { projectColours: { alpha: null } });
    expect(b.ok && b.value.projectColours).toEqual({});
    const c = mergeShellPrefs(cur, { projectColours: null });
    expect(c.ok && c.value.projectColours).toEqual({});
  });

  it("refuses a colour outside the eight, and a name that isn't a project", () => {
    const cur = shellPrefs(undefined);
    expect(mergeShellPrefs(cur, { projectColours: { alpha: "red" } }).ok).toBe(
      false,
    );
    expect(
      mergeShellPrefs(cur, { projectColours: { "../x": "teal" } }).ok,
    ).toBe(false);
    expect(mergeShellPrefs(cur, { projectColours: ["teal"] }).ok).toBe(false);
  });

  it("is stored only when set, so user.yml stays lean", () => {
    expect(storedShell(shellPrefs(undefined))).toBeUndefined();
    expect(
      storedShell(shellPrefs({ projectColours: { alpha: "slate" } })),
    ).toEqual({ projectColours: { alpha: "slate" } });
  });
});

describe("a project's colour on the page", () => {
  const data = {
    workspaces: { alpha: {}, beta: {}, gamma: {}, delta: {} },
  };

  it("the page and the server know the same eight, none orange or red", () => {
    expect([...PROJECT_COLOURS]).toEqual([...SERVER_COLOURS]);
    expect(PROJECT_COLOURS).toHaveLength(8);
    for (const c of PROJECT_COLOURS) expect(c).not.toMatch(/orange|red/);
  });

  it("two projects have different colours by default, the same every time", () => {
    const one = projectColours(data);
    expect(new Set(Object.values(one)).size).toBe(4);
    expect(projectColours({ ...data })).toEqual(one);
    for (const c of Object.values(one)) expect(PROJECT_COLOURS).toContain(c);
    // A project's own pick doesn't depend on the order the server lists them.
    const rev = {
      workspaces: Object.fromEntries(
        Object.keys(data.workspaces)
          .reverse()
          .map((k) => [k, {}]),
      ),
    };
    expect(projectColours(rev)).toEqual(one);
  });

  it("the person's choice wins; a choice two projects share is theirs to make", () => {
    const auto = projectColours(data);
    const pick = PROJECT_COLOURS.find((c) => c !== auto.alpha)!;
    const saved = { ...data, projectColours: { alpha: pick, beta: pick } };
    expect(projectColour(saved, "alpha")).toBe(pick);
    expect(projectColour(saved, "beta")).toBe(pick);
    // Automatic projects never take a colour someone picked while one is free.
    expect([pick]).not.toContain(projectColour(saved, "gamma"));
    expect([pick]).not.toContain(projectColour(saved, "delta"));
  });

  it("the server agent has none (neutral grey), and nor does no project", () => {
    expect(projectColour(data, "den-server")).toBeNull();
    expect(projectColour(data, "")).toBeNull();
    expect(projectColour(data, null)).toBeNull();
  });
});

describe("the top bar's project chip", () => {
  const data = {
    workspaces: { alpha: {}, beta: {} },
    active: ["alpha", "beta"],
    projectColours: { beta: "pink" },
  };
  it("carries the project in view's colour, none under All active", () => {
    expect(buildScopeMenuModel({ scope: "beta" }, data).colour).toBe("pink");
    expect(buildScopeMenuModel({ scope: "alpha" }, data).colour).toBe(
      projectColour(data, "alpha"),
    );
    expect(buildScopeMenuModel({ scope: "all" }, data).colour).toBeNull();
  });
});

describe("choosing a colour (Manage projects, Settings › Project setup)", () => {
  const t = (k: string, v?: Record<string, unknown>) =>
    v ? `${k}${JSON.stringify(v)}` : k;
  const data = {
    workspaces: { alpha: {}, beta: {} },
    projectColours: { beta: "gold" },
  };

  it("offers Automatic and the eight, each named, the current one checked", async () => {
    const { colourChoiceHtml, automaticColour, chosenColour } =
      await import("../../../src/ui/server/public/project-colour-picker.js");
    expect(chosenColour(data, "beta")).toBe("gold");
    expect(chosenColour(data, "alpha")).toBe("");
    const html = colourChoiceHtml(
      { slug: "beta", chosen: "gold", auto: automaticColour(data, "beta") },
      t,
    );
    const values = [...html.matchAll(/value="([a-z]*)"/g)].map((m) => m[1]);
    expect(values).toEqual(["", ...PROJECT_COLOURS]);
    expect(html).toMatch(/value="gold" checked/);
    for (const c of PROJECT_COLOURS) expect(html).toContain(`pc.${c}`);
    expect(html).toContain("pc.autoIs");
  });

  it("Settings says the colour by name, and whether it is Automatic", async () => {
    const { projectColourHtml } =
      await import("../../../src/ui/server/public/settings-registry.js");
    expect(projectColourHtml(data, "beta", t)).toContain(">pc.gold<");
    expect(projectColourHtml(data, "alpha", t)).toContain("pc.autoIs");
    expect(projectColourHtml(data, "alpha", t)).toContain("data-pc-change");
    expect(projectColourHtml(data, "den-server", t)).toBe("");
  });
});
