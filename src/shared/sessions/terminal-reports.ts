/**
 * Issue 142: input to a session that is only the terminal answering the
 * program, not a person. xterm.js answers a TUI's questions by itself
 * (focus in/out, the cursor's place, its kind, a mode's state, its
 * colours), and a pane that opens replays them; they reach the session as
 * input like keys do. Opening a pane to read an agent's question must not
 * count as answering it.
 */

/* eslint-disable no-control-regex -- terminal escape sequences, on purpose */
const REPORT = new RegExp(
  [
    "\\x1b\\[[IO]", // focus in / out (DECSET 1004)
    "\\x1b\\[\\d+;\\d+R", // cursor position (DSR 6)
    "\\x1b\\[\\?[\\d;]*R", // DECXCPR
    "\\x1b\\[[?>=][\\d;]*c", // primary / secondary / tertiary device attributes
    "\\x1b\\[\\?[\\d;]*\\$y", // DECRPM (private mode state)
    "\\x1b\\[[\\d;]*\\$y", // DECRPM (ANSI mode state)
    "\\x1b\\[\\d+n", // device status (DSR 5: "0n")
    "\\x1b\\[[\\d;]*t", // window reports (size in cells or pixels)
    "\\x1bP[^\\x1b]*\\x1b\\\\", // DCS replies (DECRQSS, XTGETTCAP)
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // OSC replies (colours)
  ].join("|"),
  "y",
);
/* eslint-enable no-control-regex */

/** True when `data` is one or more terminal reports and nothing else. */
export function terminalReportOnly(data: Buffer): boolean {
  const s = data.toString("latin1");
  if (!s) return false;
  let i = 0;
  while (i < s.length) {
    REPORT.lastIndex = i;
    const m = REPORT.exec(s);
    if (!m || !m[0].length) return false;
    i += m[0].length;
  }
  return true;
}
