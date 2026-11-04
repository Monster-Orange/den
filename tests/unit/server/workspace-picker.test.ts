import { describe, expect, it } from "@jest/globals";
import {
  buildWorkspaceMenuModel,
  buildWorkspacePillModel,
} from "../../../src/ui/server/public/workspace-picker.js";

const payload = {
  workspaces: {
    "files-api": {},
    "tasks-api": {},
    default: {},
  },
  active: ["files-api", "tasks-api"],
  focus: "files-api",
};

describe("buildWorkspacePillModel", () => {
  it("labels the pill with the focused workspace", () => {
    expect(buildWorkspacePillModel(payload)).toEqual({
      label: "files-api",
      title: "Active: files-api, tasks-api · Focus: files-api",
    });
  });

  it("falls back to the first active workspace when no focus is set", () => {
    expect(
      buildWorkspacePillModel({ workspaces: {}, active: ["tasks-api"] }),
    ).toEqual({ label: "tasks-api", title: "Switch workspace" });
  });

  it("accepts the legacy single-active payload", () => {
    expect(buildWorkspacePillModel({ active: "default" }).label).toBe(
      "default",
    );
  });

  it("never renders empty", () => {
    expect(buildWorkspacePillModel({}).label).toBe("default");
    expect(buildWorkspacePillModel(null).label).toBe("default");
  });
});

describe("buildWorkspaceMenuModel", () => {
  it("lists active workspaces first, alphabetical within each group", () => {
    expect(buildWorkspaceMenuModel(payload)).toEqual({
      focus: "files-api",
      items: [
        { name: "files-api", active: true, focused: true },
        { name: "tasks-api", active: true, focused: false },
        { name: "default", active: false, focused: false },
      ],
    });
  });

  it("keeps an active workspace missing from the catalog selectable", () => {
    const model = buildWorkspaceMenuModel({
      workspaces: { default: {} },
      active: ["ghost"],
      focus: "ghost",
    });
    expect(model.items).toEqual([
      { name: "ghost", active: true, focused: true },
      { name: "default", active: false, focused: false },
    ]);
  });

  it("returns an empty list when no workspaces exist", () => {
    expect(buildWorkspaceMenuModel({ workspaces: {}, active: [] })).toEqual({
      focus: null,
      items: [],
    });
  });
});
