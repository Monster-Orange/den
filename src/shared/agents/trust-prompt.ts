/**
 * SRV-1b: a runtime's "trust this folder?" prompt (Claude Code asks once
 * per folder, in its own file Den never writes). Den sees it at the end of
 * the agent's terminal output, so the server agent's page offers Trust /
 * Not now; the person's Trust types the runtime's own accept key. Pure.
 */

export interface TrustPrompt {
  /** The prompt's words, in the output with escapes taken out. */
  match: RegExp;
  /** What confirms the highlighted choice (Claude Code: Enter). */
  accept: string;
  /**
   * Issues 658, 659: how Den tells Yes is the highlighted choice: the
   * cursor mark, and what a Yes choice starts with after it. Claude Code
   * 2.1.329 highlights "No, exit" first, so Enter alone would decline.
   */
  cursor?: string;
  yes?: RegExp;
  /** What moves the highlight to the next choice (Down). */
  down?: string;
}

/**
 * Issue 369: a prompt Den looks for at the end of the screen: its words,
 * and how many letters and digits may follow its match (its other
 * choices and key hint) before it counts as gone (default AFTER_MAX).
 */
export interface ScreenPrompt {
  match: RegExp;
  afterMax?: number;
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
  return promptOnScreen(output, tp);
}

/**
 * Whether the screen ends with prompt `p` (see trustPromptIn): the
 * trust question, or (issue 369) a permission dialog.
 */
export function promptOnScreen(
  output: string,
  tp: ScreenPrompt | undefined,
): boolean {
  if (!tp || !output) return false;
  const plain = lastScreen(output);
  // The last copy: a runtime redraws its prompt in place, with no clear.
  const re = new RegExp(tp.match.source, tp.match.flags.replace("g", "") + "g");
  let m: RegExpExecArray | null = null;
  for (let x = re.exec(plain); x; x = re.exec(plain)) {
    m = x;
    if (x[0] === "") re.lastIndex++;
  }
  if (!m) return false;
  const after = plain.slice(m.index + m[0].length);
  return (
    after.replace(/[^\p{L}\p{N}]/gu, "").length <= (tp.afterMax ?? AFTER_MAX)
  );
}

/** The output's last screen as plain text: after its last clear, its end. */
function lastScreen(output: string): string {
  let raw = output.slice(-TAIL * 4);
  let last = -1;
  for (const m of raw.matchAll(CLEARS)) last = m.index + m[0].length;
  if (last >= 0) raw = raw.slice(last);
  return plainTerminalText(raw).slice(-TAIL);
}

/**
 * Issues 658, 659: the key Den's own answer sends next (the server agent's
 * Trust, a person's choice made on its page): "enter" when Yes is the
 * highlighted choice, "down" when another is (move to Yes first; never
 * a bare Enter on "No, exit"), null when the question isn't on screen.
 * A runtime that doesn't say how it marks its choice: "enter" (its accept).
 */
export function trustAnswerKey(
  output: string,
  tp: TrustPrompt | undefined,
): "enter" | "down" | null {
  if (!tp || !trustPromptIn(output, tp)) return null;
  if (!tp.cursor || !tp.yes) return "enter";
  const plain = lastScreen(output);
  const at = plain.lastIndexOf(tp.cursor);
  if (at >= 0 && tp.yes.test(plain.slice(at + tp.cursor.length)))
    return "enter";
  return tp.down ? "down" : null;
}
