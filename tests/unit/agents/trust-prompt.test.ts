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

  it("gate 0.4.44-dev.0: not once the screen was cleared and the runtime went on", () => {
    // Answered in the terminal: Claude clears and draws its welcome.
    const answered =
      claudeOld + `${ESC}[2J${ESC}[H Welcome to Claude Code\r\n cwd: /dens/acme\r\n> `;
    expect(trustPromptIn(answered, tp)).toBe(false);
    for (const clear of [`${ESC}[3J`, `${ESC}c`])
      expect(trustPromptIn(claudeNew + clear + " working…", tp)).toBe(false);
    // A clear before the prompt (its own screen) still shows it.
    expect(trustPromptIn(`old screen${ESC}[2J${ESC}[H${claudeNew}`, tp)).toBe(true);
  });

  it("not when more than the prompt's own lines follow it, cleared or not", () => {
    const more = claudeNew + "\r\n" + " Welcome to Claude Code. Tips: run /init.".repeat(6);
    expect(trustPromptIn(more, tp)).toBe(false);
    // Redraw noise (cursor moves, colours) after it is not more text.
    expect(trustPromptIn(claudeNew + `${ESC}[?25l${ESC}[1A${ESC}[2K${ESC}[39m`.repeat(40), tp)).toBe(true);
    // Redrawn in place (cursor up, no clear): the last copy counts.
    expect(trustPromptIn(claudeNew + `${ESC}[6A${ESC}[J` + claudeNew + `${ESC}[6A${ESC}[J` + claudeNew, tp)).toBe(true);
  });

  it("a runtime with no trust prompt never has one", () => {
    expect(trustPromptIn(claudeOld, undefined)).toBe(false);
  });
});
