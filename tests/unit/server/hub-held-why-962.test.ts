/**
 * Issue 962: why an agent holds its Hub deliveries, as Hub delivery asks
 * it (heldWhyOf). A list or a question on its screen, which the screen
 * check reads as a dialog but isn't a trust or permission one, is "the
 * agent isn't at its prompt", never left as a plain busy turn. Fake ops;
 * no server.
 */
import { describe, expect, it } from "@jest/globals";
import { heldWhyOf } from "../../../src/ui/server/hub-delivery-service.js";

const ops = (o: {
  dialog?: "trust" | "permission" | null;
  screen?: boolean;
  draft?: boolean;
}) =>
  ({
    agentDialogKind: async () => o.dialog ?? null,
    agentScreenShowsDialog: async () => o.screen ?? false,
    heldForDraft: () => o.draft ?? false,
  }) as never;
const d = {} as never;

describe("issue 962: why Hub delivery holds an agent's items", () => {
  it("a list or a question on its screen: not_at_prompt", async () => {
    expect(await heldWhyOf(ops({ screen: true }), d, "ag-1")).toBe(
      "not_at_prompt",
    );
  });

  it("a trust or permission dialog is named for what it is", async () => {
    for (const dialog of ["trust", "permission"] as const)
      expect(await heldWhyOf(ops({ dialog, screen: true }), d, "ag-1")).toBe(
        dialog,
      );
  });

  it("Den's own holds (an Allow, a pause) come before what the screen shows", async () => {
    expect(
      await heldWhyOf(ops({ screen: true }), d, "ag-1", () => "approval"),
    ).toBe("approval");
  });

  it("issue 1311: its person's unsent draft on the line: draft", async () => {
    expect(await heldWhyOf(ops({ draft: true }), d, "ag-1", () => null)).toBe(
      "draft",
    );
  });

  it("nothing on screen and no hold: null (mid-turn)", async () => {
    expect(await heldWhyOf(ops({}), d, "ag-1", () => null)).toBeNull();
  });
});
