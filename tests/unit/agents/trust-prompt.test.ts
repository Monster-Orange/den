/**
 * SRV-1b: the runtime's "trust this folder?" prompt, seen in the end of
 * the agent's terminal output (escapes taken out), so the server agent's
 * page can offer Trust / Not now. Pure: text in, answer out.
 */
import { describe, expect, it } from "@jest/globals";
import {
  plainTerminalText,
  trustPromptIn,
} from "../../../src/shared/agents/trust-prompt.js";
import { denClaude as denClaudeRuntime } from "../../../src/shared/agents/den-claude.js";

const ESC = "\x1b";
const claudeOld =
  `${ESC}[2J${ESC}[1;1H${ESC}[1m Do you trust the files in this folder?${ESC}[22m\r\n\r\n` +
  ` /dens/acme\r\n\r\n ${ESC}[36m❯ 1. Yes, proceed${ESC}[39m\r\n   2. No, exit\r\n`;
const claudeNew =
  `${ESC}]0;claude${ESC}\\ Accessing workspace:\r\n /dens/acme\r\n` +
  ` Quick safety check: Is this a project you created or one you trust?\r\n` +
  ` ❯ 1. Yes, I trust this folder\r\n   2. No, exit\r\n Enter to confirm · Esc to cancel`;

describe("trust prompt (SRV-1b)", () => {
  const tp = denClaudeRuntime.trustPrompt!;

  it("Claude's runtime says what its prompt looks like and how to accept it", () => {
    expect(tp.accept).toBe("\r");
  });

  it("escapes out: colours, cursor moves, titles", () => {
    expect(plainTerminalText(claudeOld)).not.toContain(ESC);
    expect(plainTerminalText(claudeNew)).not.toContain(ESC);
    expect(plainTerminalText(claudeNew)).not.toContain("0;claude");
  });

  it("seen at the end of the output, either wording", () => {
    expect(trustPromptIn(`some banner\r\n${claudeOld}`, tp)).toBe(true);
    expect(trustPromptIn(claudeNew, tp)).toBe(true);
  });

  it("not once the conversation went on past it", () => {
    const after = claudeOld + "\r\n" + "x".repeat(3000) + "\r\n> ";
    expect(trustPromptIn(after, tp)).toBe(false);
    expect(trustPromptIn("Welcome to Claude Code\r\n> ", tp)).toBe(false);
    expect(trustPromptIn("", tp)).toBe(false);
  });

  it("a runtime with no trust prompt never has one", () => {
    expect(trustPromptIn(claudeOld, undefined)).toBe(false);
  });
});
