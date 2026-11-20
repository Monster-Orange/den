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
  return (
    after.replace(/[^\p{L}\p{N}]/gu, "").length <= (tp.afterMax ?? AFTER_MAX)
  );
}

/**
 * Issue 664: a runtime's input prompt, the positive sign that it waits
 * for typed text: `match` finds its prompt line on the screen, and at
 * most `afterMax` letters and digits may follow it (its footer and status
 * lines). See typingCheck.
 */
export interface InputPrompt {
  match: RegExp;
  afterMax?: number;
}

/** Letters and digits an input prompt's footer may have (see InputPrompt). */
const INPUT_AFTER_MAX = 400;

/** The screen's last lines that count as on screen. */
const SCREEN_ROWS = 60;

/** How much of the output is drawn (after the last clear). */
const DRAW_MAX = 64 * 1024;

/**
 * A choice list waiting for an answer, in any runtime's words: a pointer
 * on a numbered choice, or a confirm hint. Any of these on screen means a
 * dialog, whatever its wording.
 */
const ANY_DIALOG = [
  /^[ \t]*(?:[│|][ \t]*)?(?:[❯›▶►→][ \t]*\d+|>[ \t]*1)[.)][ \t]/mu,
  /\b(?:Enter|Return) to (?:confirm|select|continue)\b/i,
  /\bEsc to cancel\b/i,
];

/**
 * The screen as text: the output after its last clear, drawn on a grid of
 * lines (cursor moves, erases and redraws in place applied), its last
 * SCREEN_ROWS rows. Rough (no wrapping, no wide cells): a doubt reads as
 * text still there, never as text gone.
 */
export function screenText(output: string): string {
  let raw = output.slice(-DRAW_MAX);
  let last = -1;
  for (const m of raw.matchAll(CLEARS)) last = m.index + m[0].length;
  if (last >= 0) raw = raw.slice(last);
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;
  const line = (): string[] => {
    while (lines.length <= row) lines.push([]);
    return lines[row];
  };
  const chars = Array.from(raw);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\x1b") {
      const next = chars[i + 1];
      if (next === "[") {
        let j = i + 2;
        let params = "";
        while (j < chars.length && /[0-?]/.test(chars[j])) params += chars[j++];
        while (j < chars.length && /[ -/]/.test(chars[j])) j++;
        const fin = chars[j] ?? "";
        i = j;
        // Private modes (cursor shown, sync output, …) draw nothing.
        if (/^[?<=>]/.test(params)) continue;
        const nums = params.split(";").map((p) => parseInt(p, 10));
        const n = nums[0] > 0 ? nums[0] : 1;
        const arg0 = Number.isFinite(nums[0]) ? nums[0] : 0;
        switch (fin) {
          case "A":
            row = Math.max(0, row - n);
            break;
          case "B":
            row += n;
            break;
          case "E":
            row += n;
            col = 0;
            break;
          case "F":
            row = Math.max(0, row - n);
            col = 0;
            break;
          case "C":
            col += n;
            break;
          case "D":
            col = Math.max(0, col - n);
            break;
          case "G":
            col = n - 1;
            break;
          case "H":
          case "f":
            row = Math.max(0, lines.length - SCREEN_ROWS) + n - 1;
            col = (nums[1] > 0 ? nums[1] : 1) - 1;
            break;
          case "K": {
            const l = line();
            if (arg0 === 2) l.length = 0;
            else if (arg0 === 1)
              for (let x = 0; x <= col && x < l.length; x++) l[x] = " ";
            else l.length = Math.min(l.length, col);
            break;
          }
          case "J":
            if (arg0 === 0) {
              const l = line();
              l.length = Math.min(l.length, col);
              lines.length = row + 1;
            }
            break;
          default:
            break;
        }
        continue;
      }
      if (next === "]") {
        // OSC (titles, links): up to BEL or ESC \.
        let j = i + 2;
        while (j < chars.length && chars[j] !== "\x07" && chars[j] !== "\x1b")
          j++;
        i = chars[j] === "\x1b" ? j + 1 : j;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "\n") {
      row++;
      line();
    } else if (ch === "\r") col = 0;
    else if (ch === "\b") col = Math.max(0, col - 1);
    else if (ch >= " " && ch !== "\x7f") {
      const l = line();
      while (l.length < col) l.push(" ");
      l[col++] = ch;
    }
  }
  const out = lines.map((l) => l.join("").replace(/\s+$/u, ""));
  while (out.length && !out[out.length - 1]) out.pop();
  return out.slice(-SCREEN_ROWS).join("\n");
}

/** What of a runtime's screen Den reads before typing (issue 664). */
export interface TypingScreen {
  inputPrompt?: InputPrompt;
  permissionPrompt?: ScreenPrompt;
  trustPrompt?: TrustPrompt;
}

/** Issue 664: what the screen says about typing into it now. */
export type TypingCheck = "ok" | "dialog" | "not_at_prompt";

/**
 * Issue 664, the one screen check before Den types into an agent. "ok"
 * only when the screen ends with the runtime's input prompt (its footer
 * at most after it) and no dialog shows anywhere on it. "dialog": a
 * dialog for its person is on screen (in its runtime's words, or any
 * choice list). "not_at_prompt": anything else, including a runtime that
 * declares no input prompt (it can't be shown at one). Pure.
 */
export function typingCheck(
  output: string,
  rt: TypingScreen | undefined,
): TypingCheck {
  if (
    promptOnScreen(output, rt?.permissionPrompt) ||
    promptOnScreen(output, rt?.trustPrompt)
  )
    return "dialog";
  const screen = screenText(output);
  const theirs = [rt?.permissionPrompt?.match, rt?.trustPrompt?.match].filter(
    (m): m is RegExp => Boolean(m),
  );
  for (const re of [...theirs, ...ANY_DIALOG])
    if (new RegExp(re.source, re.flags.replace("g", "")).test(screen))
      return "dialog";
  const ip = rt?.inputPrompt;
  if (!ip) return "not_at_prompt";
  const re = new RegExp(ip.match.source, ip.match.flags.replace("g", "") + "g");
  let m: RegExpExecArray | null = null;
  for (let x = re.exec(screen); x; x = re.exec(screen)) {
    m = x;
    if (x[0] === "") re.lastIndex++;
  }
  if (!m) return "not_at_prompt";
  const after = screen.slice(m.index + m[0].length);
  return after.replace(/[^\p{L}\p{N}]/gu, "").length <=
    (ip.afterMax ?? INPUT_AFTER_MAX)
    ? "ok"
    : "not_at_prompt";
}
