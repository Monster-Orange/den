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

/**
 * Issue 89: the lines an agent printed before it exited at once (the
 * server's answer's `tail`, redacted there), or [] for any other failure.
 */
export function startFailTail(err) {
  const d = err?.data ?? err?.body ?? null;
  if ((err?.code ?? d?.code) !== "exited_at_once") return [];
  const tail = d?.tail;
  return Array.isArray(tail)
    ? tail.filter((l) => typeof l === "string").slice(-20)
    : [];
}

/** The start dialog's error line for failure `err`. */
export function startFailText(err, t) {
  const e = err?.message || String(err);
  return err?.code === "pty_open" ? t("ag.term.ptyFailed", { e }) : e;
}
