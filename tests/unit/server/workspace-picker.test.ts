/**
 * The owners label a shared service carries (R4). The Workspace menu
 * itself is workspace-status.js's (WS-6, 0.4.3: workspace-status.test.ts).
 */
import { describe, expect, it } from "@jest/globals";
import { ownersLabel } from "../../../src/ui/server/public/workspace-picker.js";

describe("ownersLabel", () => {
  it("names the owners of a shared service, nothing for one owner", () => {
    expect(ownersLabel(["a", "b"])).toBe(" · a, b");
    expect(ownersLabel(["a"])).toBe("");
    expect(ownersLabel(undefined)).toBe("");
  });
});
