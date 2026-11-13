/**
 * The Workspace ▾ menu's model (R4, 0.3.0-dev.18): the view scope, with
 * the focus (the CLI default) marked. Since 0.4.11, choosing a workspace
 * also makes it the CLI default, so there is no separate item for it: the
 * model names the focus, and each workspace row says so in its tooltip.
 */
import { describe, expect, it } from "@jest/globals";
import {
  buildScopeMenuModel,
  ownersLabel,
} from "../../../src/ui/server/public/workspace-picker.js";

const TIP =
  "Picking a project here also makes it the CLI default, so __DEN_CLI__ commands run there.";

const payload = {
  workspaces: { "files-api": {}, "tasks-api": {}, default: {} },
  active: ["files-api", "tasks-api"],
  focus: "files-api",
};

describe("buildScopeMenuModel", () => {
  it("lists All active and each active workspace, the focus marked", () => {
    const m = buildScopeMenuModel(
      {
        scope: "all",
        inView: ["files-api", "tasks-api"],
        focus: "files-api",
      },
      payload,
    );
    expect(m.label).toBe("All active");
    expect(m.focus).toBe("files-api");
    expect("focusable" in m).toBe(false);
    expect(m.items).toEqual([
      {
        value: "all",
        label: "All active (2)",
        checked: true,
        focused: false,
        title: "Every active project; a service several define is listed once",
      },
      {
        value: "files-api",
        label: "files-api",
        checked: false,
        focused: true,
        title: TIP,
      },
      {
        value: "tasks-api",
        label: "tasks-api",
        checked: false,
        focused: false,
        title: TIP,
      },
    ]);
    expect(m.title).toBe(
      "View: what every page shows (files-api, tasks-api). It starts, stops and routes nothing. CLI default: files-api.",
    );
  });

  it("one workspace in view: checked; the focus is named, never offered as a separate item", () => {
    const m = buildScopeMenuModel(
      { scope: "tasks-api", inView: ["tasks-api"], focus: "files-api" },
      payload,
    );
    expect(m.label).toBe("tasks-api");
    expect(m.focus).toBe("files-api");
    expect(m.items.filter((i) => i.checked).map((i) => i.value)).toEqual([
      "tasks-api",
    ]);
    expect("focusable" in m).toBe(false);
  });

  it("a scope that is no longer active falls back to All active", () => {
    const m = buildScopeMenuModel({ scope: "gone" }, payload);
    expect(m.label).toBe("All active");
    expect(m.items[0]).toMatchObject({ value: "all", checked: true });
  });

  it("one active workspace: no All active (the same view), that workspace checked", () => {
    const m = buildScopeMenuModel(null, { active: "default" });
    expect(m.label).toBe("default");
    expect(m.items).toEqual([
      {
        value: "default",
        label: "default",
        checked: true,
        focused: true,
        title: TIP,
      },
    ]);
  });

  it("none active: an empty menu labelled none", () => {
    const m = buildScopeMenuModel(null, { workspaces: {}, active: [] });
    expect([m.label, m.items, m.focus]).toEqual(["none", [], null]);
  });
});

describe("ownersLabel", () => {
  it("names the workspaces that share a service, else nothing", () => {
    expect(ownersLabel(["a", "b"])).toBe(" · a, b");
    expect(ownersLabel(["a"])).toBe("");
    expect(ownersLabel(undefined)).toBe("");
  });
});
