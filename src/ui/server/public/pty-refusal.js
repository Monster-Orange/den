/**
 * Issue 503: the words for a terminal that couldn't open because the
 * machine gave it no PTY. The server answers that refusal with code
 * "pty_open" and the terminal host's reason; any other failure keeps its
 * own words. No DOM here, so it runs without a browser
 * (tests/unit/server/pty-refusal.test.ts).
 */

/** The Terminal's toast for failure `err` (`t` is the page's words). */
export function terminalFailText(err, t) {
  const e = err?.message || String(err);
  return t(err?.code === "pty_open" ? "ag.term.ptyFailed" : "ag.term.failed", {
    e,
  });
}

/** The start dialog's error line for failure `err`. */
export function startFailText(err, t) {
  const e = err?.message || String(err);
  return err?.code === "pty_open" ? t("ag.term.ptyFailed", { e }) : e;
}
