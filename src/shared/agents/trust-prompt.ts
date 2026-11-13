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

/**
 * What clears the screen: erase display (ESC[2J), erase scrollback
 * (ESC[3J), reset (ESC c). Nothing before the last one is on screen.
 */
// eslint-disable-next-line no-control-regex
const CLEARS = /\x1b\[[23]J|\x1bc/g;

/**
 * Letters and digits a prompt may still have after its "1. Yes" match:
 * the rest of that line, the other choices and the key hint ("Enter to
 * confirm · Esc to cancel"). More than this is the runtime going on.
 */
const AFTER_MAX = 120;

/**
 * Whether the screen ends with `tp`'s prompt, waiting for an answer: only
 * what follows the last screen clear counts (gate 0.4.44-dev.0: a prompt
 * answered in the terminal stayed in the tail until 2 KB more came), and
 * after the prompt's match only its own lines may follow.
 */
export function trustPromptIn(
  output: string,
  tp: TrustPrompt | undefined,
): boolean {
  if (!tp || !output) return false;
  let raw = output.slice(-TAIL * 4);
  let last = -1;
  for (const m of raw.matchAll(CLEARS)) last = m.index + m[0].length;
  if (last >= 0) raw = raw.slice(last);
  const plain = plainTerminalText(raw).slice(-TAIL);
  // The last copy: a runtime redraws its prompt in place, with no clear.
  const re = new RegExp(tp.match.source, tp.match.flags.replace("g", "") + "g");
  let m: RegExpExecArray | null = null;
  for (let x = re.exec(plain); x; x = re.exec(plain)) {
    m = x;
    if (x[0] === "") re.lastIndex++;
  }
  if (!m) return false;
  const after = plain.slice(m.index + m[0].length);
  return after.replace(/[^\p{L}\p{N}]/gu, "").length <= AFTER_MAX;
}
