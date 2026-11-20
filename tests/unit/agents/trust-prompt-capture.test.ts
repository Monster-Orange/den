/**
 * Issues 658 and 659: Claude Code 2.1.329's folder-trust question, from a
 * real capture (tests/fixtures/claude-code-2.1.329, a temp folder only).
 *
 * It now reads "Quick safety check: Is this a project you created or one
 * you trust?" with two unnumbered choices, and the one highlighted at
 * first is "No, exit":
 *
 *   ❯ No, exit
 *     Yes, I trust this folder
 *
 * Den's pattern wanted "1. Yes", so it never saw this question. Den then
 * judged the agent ready once its screen went quiet and typed its first
 * instruction with Enter, and that Enter chose "No, exit".
 *
 *   1. The pattern sees both shapes (the older numbered one too).
 *   2. A first instruction is never typed while the question is on screen.
 *   3. Den's own answer (the server agent's Trust) never sends a bare
 *      Enter on "No, exit": it moves to Yes first, and Enter only once Yes
 *      is the highlighted choice.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { denClaude } from "../../../src/shared/agents/den-claude.js";
import {
  trustAnswerKey,
  trustPromptIn,
} from "../../../src/shared/agents/trust-prompt.js";
import * as ops from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cleanupRigs, rig, settle } from "./helpers/rig.js";

afterEach(cleanupRigs);

const FIX = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "claude-code-2.1.329",
);
const raw = (f: string) => fs.readFileSync(path.join(FIX, f), "utf-8");
const ASKING = raw("trust.raw");
const YES_SELECTED = raw("trust-yes-selected.raw");
const OLD =
  "\x1b[2J Do you trust the files in this folder?\r\n\r\n /work/north\r\n\r\n" +
  " ❯ 1. Yes, proceed\r\n   2. No, exit\r\n\r\n Enter to confirm · Esc to cancel\r\n";

const tp = denClaude.trustPrompt!;

describe("the question as Claude Code 2.1.329 asks it", () => {
  it("is seen, with No highlighted and with Yes highlighted", () => {
    expect(trustPromptIn(ASKING, tp)).toBe(true);
    expect(trustPromptIn(YES_SELECTED, tp)).toBe(true);
    expect(ops.personDialogOnScreen("den-claude", ASKING)).toBe(true);
  });

  it("the older numbered shape is still seen", () => {
    expect(trustPromptIn(OLD, tp)).toBe(true);
  });

  it("Den's own answer: Down while No is highlighted, Enter only on Yes", () => {
    expect(trustAnswerKey(ASKING, tp)).toBe("down");
    expect(trustAnswerKey(YES_SELECTED, tp)).toBe("enter");
    expect(trustAnswerKey(OLD, tp)).toBe("enter");
    expect(trustAnswerKey("> ready\r\n", tp)).toBeNull();
  });
});

describe("a first instruction waits while the question is on screen", () => {
  it("nothing is typed (no Enter to pick No, exit); the dialog is reported", async () => {
    const r = await rig();
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "be-dev"], r.deps),
    ).toBe(0);
    const p = r.made[r.made.length - 1];
    p.emit(ASKING);
    await settle();
    const before = p.writes.length;
    let dialog = false;
    const sent = await ops.sendFirstInstruction(
      ops.resolveAgentsDeps(r.deps),
      readRecord(r.stateDir, "be-dev")!.session.id,
      "den-claude",
      "Den relaunched you from the handoff your last session wrote.",
      { quietMs: 100, maxMs: 1_000, onDialog: () => (dialog = true) },
    );
    await settle();
    expect(sent).toBe(false);
    expect(dialog).toBe(true);
    expect(p.writes.slice(before)).toEqual([]);
  }, 20_000);
});
