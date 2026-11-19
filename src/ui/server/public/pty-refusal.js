/**
 * Issue 503: the words for a terminal that couldn't open because the
 * machine gave it no PTY. The server answers that refusal with code
 * "pty_open" and the terminal host's reason; any other failure keeps its
 * own words. Issue 500: a terminal host that doesn't answer (code
 * "host_stuck") has its own words, and Terminal offers Restart. No DOM
 * here, so it runs without a browser (tests/unit/server/pty-refusal.test.ts).
 */

/** The catalog key for failure `err` on Terminal. */
function failKey(err) {
  if (err?.code === "pty_open") return "ag.term.ptyFailed";
  if (err?.code === "host_stuck") return "ag.term.stuck";
  return "ag.term.failed";
}

/** The Terminal's toast for failure `err` (`t` is the page's words). */
export function terminalFailText(err, t) {
  const e = err?.message || String(err);
  return t(failKey(err), { e });
}

/** Issue 500: whether failure `err` offers Restart (the host doesn't answer). */
export function offersHostRestart(err) {
  return err?.code === "host_stuck";
}

/** The start dialog's error line for failure `err`. */
export function startFailText(err, t) {
  const e = err?.message || String(err);
  return err?.code === "pty_open" || err?.code === "host_stuck"
    ? t(failKey(err), { e })
    : e;
}
