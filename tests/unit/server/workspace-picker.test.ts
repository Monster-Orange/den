/**
 * The Workspace ▾ menu's model (R4, 0.3.0-dev.18): the view scope, with
 * the focus marked and a separate "Make <ws> the CLI default".
 */
import { describe, expect, it } from "@jest/globals";
import {
  buildScopeMenuModel,
  ownersLabel,
} from "../../../src/ui/server/public/workspace-picker.js";

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
    expect(m.focusable).toBeNull();
    expect(m.items).toEqual([
      {
        value: "all",
        label: "All active (2)",
        checked: true,
        focused: false,
        title:
          "Every active workspace; a service several define is listed once",
      },
      { value: "files-api", label: "files-api", checked: false, focused: true },
      {
        value: "tasks-api",
        label: "tasks-api",
        checked: false,
        focused: false,
      },
    ]);
    expect(m.title).toBe(
      "View: what every page shows (files-api, tasks-api). A view filter only: it starts, stops and routes nothing, and the CLI default (files-api) stays the target for commands.",
    );
  });

  it("one workspace in view: checked, and offered as the focus when it isn't", () => {
    const m = buildScopeMenuModel(
      { scope: "tasks-api", inView: ["tasks-api"], focus: "files-api" },
      payload,
    );
    expect(m.label).toBe("tasks-api");
    expect(m.focusable).toBe("tasks-api");
    expect(m.items.filter((i) => i.checked).map((i) => i.value)).toEqual([
      "tasks-api",
    ]);
    // The focused workspace in view: nothing to offer.
    expect(
      buildScopeMenuModel({ scope: "files-api", focus: "files-api" }, payload)
        .focusable,
    ).toBeNull();
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
      { value: "default", label: "default", checked: true, focused: true },
    ]);
  });

  it("none active: an empty menu labelled none", () => {
    const m = buildScopeMenuModel(null, { workspaces: {}, active: [] });
    expect([m.label, m.items, m.focusable]).toEqual(["none", [], null]);
  });
});

describe("ownersLabel", () => {
  it("names the workspaces that share a service, else nothing", () => {
    expect(ownersLabel(["a", "b"])).toBe(" · a, b");
    expect(ownersLabel(["a"])).toBe("");
    expect(ownersLabel(undefined)).toBe("");
  });
});
