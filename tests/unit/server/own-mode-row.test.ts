/**
 * Issue 199: the Agents page row of an agent with a mode of its own says
 * so, and which project mode it doesn't follow. Issue 225 words it as its
 * source: "mode: Auto, from its own setting (project: All)". An agent that follows says its mode as before.
 * persona-ui.js's words, in English (i18n/en.js).
 */
import { beforeAll, describe, expect, it } from "@jest/globals";
import { installEnShell } from "./helpers/en-catalog.js";

let ownModeLabel: (r: Record<string, unknown>) => string;

beforeAll(async () => {
  installEnShell();
  ({ ownModeLabel } =
    await import("../../../src/ui/server/public/persona-ui.js"));
});

describe("issue 199: an agent's own mode on its row", () => {
  it("own mode, and the project's it doesn't follow", () => {
    expect(
      ownModeLabel({
        kind: "agent",
        mode: "auto",
        modeOwn: true,
        modeFollowed: "all",
      }),
    ).toBe("mode: Auto, from its own setting (project: All)");
  });

  it("own mode, the project's the same or none: no 'not following'", () => {
    expect(ownModeLabel({ kind: "agent", mode: "auto", modeOwn: true })).toBe(
      "mode: Auto, from its own setting",
    );
    expect(
      ownModeLabel({
        kind: "agent",
        mode: "auto",
        modeOwn: true,
        modeFollowed: "auto",
      }),
    ).toBe("mode: Auto, from its own setting");
  });

  it("an agent that follows: nothing here", () => {
    expect(ownModeLabel({ kind: "agent", mode: "all" })).toBe("");
  });
});
