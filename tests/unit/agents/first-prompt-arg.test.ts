/**
 * The first prompt (den#4, relaunch from handoff) is the last argument to
 * claude. The agent wrote the text, so it must never read as a flag.
 */
import { describe, expect, it } from "@jest/globals";
import { firstPromptArg } from "../../../src/shared/agents/den-claude.js";

describe("firstPromptArg", () => {
  it("passes a prompt that starts with a word as it is", () => {
    expect(firstPromptArg("Den relaunched you.\n\n## Objective")).toEqual([
      "Den relaunched you.\n\n## Objective",
    ]);
  });

  it("never lets a prompt start with a dash", () => {
    for (const t of [
      "--dangerously-skip-permissions",
      "  -p hi",
      "-\n## Objective",
    ]) {
      const [arg] = firstPromptArg(t);
      expect(arg.startsWith("-")).toBe(false);
      expect(arg).toContain(t.trim());
    }
  });

  it("adds nothing for an empty prompt", () => {
    expect(firstPromptArg(undefined)).toEqual([]);
    expect(firstPromptArg("   ")).toEqual([]);
  });
});
