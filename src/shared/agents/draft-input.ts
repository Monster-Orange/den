/**
 * Issue 1311: whether a person has an unsent draft on an agent's input
 * line, from the keys they send through Den's terminal. Den never types
 * into a prompt that holds one: a delivery waits, in order, until it is
 * sent or cleared.
 *
 * Per session (the session host's id), in this server process only. A
 * draft typed outside Den's terminal (a local tmux attach) is not seen
 * here; the screen check (agent-ops inputState) only clears one.
 *
 * Printable text and pastes make a draft. Enter sends it (a backslash just
 * before Enter is a new line in it); Ctrl-C and Ctrl-U clear it, and so
 * does backspacing over every character typed. Arrow keys, focus and mouse
 * reports and every other escape sequence change nothing.
 */

interface Draft {
  /** Characters typed and not yet erased (backspace takes one). */
  chars: number;
  /** When it began (ms). */
  since: number;
  /** The last printable character typed (a backslash before Enter). */
  last: string;
  /** Inside a bracketed paste. */
  paste: boolean;
}

const drafts = new Map<string, Draft>();
const ESC = "\x1b";

/**
 * An escape sequence cut at the end of one frame (ESC, then "[A" in the
 * next): kept per session and read with the next frame, so its rest is
 * never taken for typed text. Only for a frame that follows soon: an
 * Escape key on its own isn't the start of what comes much later.
 */
const tails = new Map<string, { text: string; at: number }>();
/** How soon the next frame must follow to continue a cut sequence (ms). */
const TAIL_MS = 500;
/** A cut sequence longer than this is dropped (no key sends one). */
const TAIL_MAX = 256;

/** Whether session `sessionId` holds its person's unsent draft. */
export function draftPending(sessionId: string): boolean {
  const d = drafts.get(sessionId);
  return Boolean(d && (d.chars > 0 || d.paste));
}

/** When session `sessionId`'s draft began (ms), or undefined: none. */
export function draftSince(sessionId: string): number | undefined {
  return draftPending(sessionId) ? drafts.get(sessionId)!.since : undefined;
}

/**
 * How long a key takes to show on the screen Den reads (its echo): a
 * draft younger than this at the read may not be drawn on it yet.
 */
export const ECHO_MS = 500;

/**
 * An empty input line on a screen read at `readAt` (ms): session
 * `sessionId`'s draft goes only when it began before that read by at least
 * ECHO_MS. A draft begun later, or just before (its echo may not be drawn
 * yet), stays. True when there is no draft now.
 */
export function clearDraftSeenEmpty(
  sessionId: string,
  readAt: number,
): boolean {
  const since = draftSince(sessionId);
  if (since === undefined) return true;
  if (since > readAt - ECHO_MS) return false;
  clearDraft(sessionId);
  return true;
}

/** Forget session `sessionId`'s draft (sent, cleared, or the session ended). */
export function clearDraft(sessionId: string): void {
  drafts.delete(sessionId);
  tails.delete(sessionId);
}

/**
 * The person sent `bytes` to session `sessionId` through Den's terminal.
 * Never throws.
 */
export function noteInput(sessionId: string, bytes: Buffer): void {
  const now = Date.now();
  const tail = tails.get(sessionId);
  tails.delete(sessionId);
  const s =
    (tail && now - tail.at <= TAIL_MS ? tail.text : "") +
    bytes.toString("utf-8");
  let d = drafts.get(sessionId);
  const draft = (): Draft => {
    if (!d) {
      d = { chars: 0, since: Date.now(), last: "", paste: false };
      drafts.set(sessionId, d);
    }
    return d;
  };
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ESC) {
      const end = escapeEnd(chars, i, (start) => {
        // A bracketed paste: its content is the person's text.
        if (start === "[200~") {
          draft().paste = true;
        } else if (start === "[201~" && d) {
          d.paste = false;
        }
      });
      if (end < 0) {
        // Cut at the frame's end: the next frame finishes it.
        const text = chars.slice(i).join("");
        if (text.length <= TAIL_MAX) tails.set(sessionId, { text, at: now });
        return;
      }
      i = end;
      continue;
    }
    if (d?.paste) {
      if (ch !== "\r" && ch !== "\n") d.chars++;
      d.last = ch;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (ch === "\r" || ch === "\n") {
      // Enter sends the draft; after a backslash, it is a new line in it.
      if (d && d.chars > 0 && d.last === "\\") {
        d.last = "";
        continue;
      }
      drafts.delete(sessionId);
      d = undefined;
    } else if (code === 0x03 || code === 0x15) {
      // Ctrl-C, Ctrl-U: the line is cleared.
      drafts.delete(sessionId);
      d = undefined;
    } else if (code === 0x7f || code === 0x08) {
      if (d) {
        d.chars--;
        d.last = "";
        if (d.chars <= 0) {
          drafts.delete(sessionId);
          d = undefined;
        }
      }
    } else if (code >= 0x20) {
      const x = draft();
      x.chars++;
      x.last = ch;
    }
    // Other control keys (Tab, Ctrl-W, …): Den can't say what they did.
  }
}

/**
 * The index of the last character of the escape sequence that starts at
 * `chars[i]` (ESC), or -1 when the chunk ends before it does (the next
 * frame has its rest). `seen` gets a CSI's parameters and final (e.g.
 * "[200~"). ESC and one other character (an Alt key) is two characters.
 */
function escapeEnd(
  chars: string[],
  i: number,
  seen: (start: string) => void,
): number {
  const next = chars[i + 1];
  if (next === undefined) return -1;
  if (next === "[") {
    // X10 mouse: ESC [ M and three bytes.
    if (chars[i + 2] === "M") return i + 5 < chars.length ? i + 5 : -1;
    let j = i + 2;
    while (j < chars.length && /[0-?]/.test(chars[j])) j++;
    while (j < chars.length && /[ -/]/.test(chars[j])) j++;
    if (j >= chars.length) return -1;
    seen(chars.slice(i + 1, j + 1).join(""));
    return j;
  }
  if (next === "]" || next === "P" || next === "_" || next === "^") {
    // OSC, DCS, APC, PM: up to BEL or ST (ESC \).
    for (let j = i + 2; j < chars.length; j++) {
      if (chars[j] === "\x07") return j;
      if (chars[j] === ESC && chars[j + 1] === "\\") return j + 1;
    }
    return -1;
  }
  // SS3 (ESC O A: an arrow in application mode): three characters.
  if (next === "O") return i + 2 < chars.length ? i + 2 : -1;
  // An Alt key (ESC and one character): neither sends nor types.
  return i + 1;
}
