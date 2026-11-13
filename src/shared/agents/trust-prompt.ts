/**
 * SRV-1b: a runtime's "trust this folder?" prompt (Claude Code asks once
 * per folder, in its own file Den never writes). Den sees it at the end of
 * the agent's terminal output, so the server agent's page offers Trust /
 * Not now; the person's Trust types the runtime's own accept key. Pure.
 */

export interface TrustPrompt {
  /** The prompt's words, in the output with escapes taken out. */
  match: RegExp;
  /** What answers yes (Claude Code: Enter, on its first choice). */
  accept: string;
}

/** How much of the output's end is looked at (the prompt is the last screen). */
const TAIL = 2000;

/** Terminal output as plain text: no CSI, OSC or other escapes, no CRs. */
export function plainTerminalText(s: string): string {
  return (
    s
      // OSC (titles, links): ESC ] … BEL or ESC \. Control characters: intentional.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CSI: ESC [ params final.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
      // Any other two-byte escape.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-_]/g, "")
      .replace(/\r/g, "")
  );
}

/** Whether the end of `output` is `tp`'s prompt, waiting for an answer. */
export function trustPromptIn(
  output: string,
  tp: TrustPrompt | undefined,
): boolean {
  if (!tp || !output) return false;
  const plain = plainTerminalText(output.slice(-TAIL * 4));
  return tp.match.test(plain.slice(-TAIL));
}
