/**
 * D64: Restart Den from the browser, in place.
 *
 *   restartDen({ confirm })  confirm: first a dialog that says what keeps
 *                            running and what pauses (Settings › Server, the
 *                            header menu, the palette); the stale pill skips
 *                            it (the pill is already the ask).
 *
 * Then the kit's working pop-up in reconnect mode (UK-2, busy-den.js's
 * "restart-den") asks GET /api/server-info, every second backing off to
 * three. Den counts as back only on a 200 from a NEW pid or startedAt (the
 * old server can answer for a moment before it stops). Back: "Den is back"
 * with its version, then it closes by itself and fires `den:server-back`
 * on window, so a page reconnects its live connections (terminals, events)
 * without a reload: typed text and scroll stay. A changed build is the
 * update pill's to offer (D61).
 *
 * After `ui.restart_wait_seconds` (server-info's restartWaitSeconds,
 * default 90) it says Den didn't come back, with Report, Close, Open the
 * log and Check again.
 */

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

async function serverInfo() {
  try {
    const r = await fetch("/api/server-info", {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (r.status !== 200) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Asks first: what keeps running, what pauses. Resolves true on Restart.
 * Issue 669: the kit's confirm frame (/dialog-den.js), no dialog of its own.
 */
async function confirmRestart() {
  const { dialogHtml, mountDialog } = await import("/dialog-den.js");
  const html = dialogHtml({
    kind: "confirm",
    id: "rd-dlg",
    ids: { h: "rd-h" },
    className: "rd-dlg",
    attrs: { "data-state": "confirm" },
    title: t("rd.title"),
    body:
      `<p>${esc(t("rd.keepsHead"))}</p>` +
      `<ul><li>${esc(t("rd.keepsAgents"))}</li><li>${esc(t("rd.keepsServices"))}</li></ul>` +
      `<p>${esc(t("rd.pausesHead"))}</p>` +
      `<ul><li>${esc(t("rd.pausesLive"))}</li></ul>`,
    actions: [
      {
        label: t("rd.cancel"),
        value: "cancel",
        attrs: { "data-rd": "cancel" },
      },
      {
        label: t("rd.go"),
        value: "go",
        kind: "primary",
        attrs: { "data-rd": "go" },
      },
    ],
  });
  const h = mountDialog(html, { focus: '[data-rd="go"]' });
  return (await h.closed) === "go";
}

let running = null;

/**
 * Restart this Den's web server and wait for the new one, in place.
 * Resolves with the new server's info, or null when the person cancelled.
 */
export function restartDen({
  confirm = true,
  before = null,
  // SRV-1a: false when the restart is already under way (an Allow ran it).
  post = true,
  // Issue 227: the page action that asked, for the audit row
  // ("update-pill", "menu", "settings").
  from = undefined,
} = {}) {
  if (running) return running;
  running = (async () => {
    if (confirm && !(await confirmRestart())) return null;
    const was = before ?? (await serverInfo());
    // UK-2: the kit's working pop-up in reconnect mode (busy-den.js):
    // no answer to the POST is Den going down; it waits for a NEW pid or
    // start time, says the version, then fires den:server-back.
    const { busyAction } = await import("/busy-den.js");
    return busyAction(
      "restart-den",
      (headers) => {
        if (!post) return Promise.resolve({});
        const api = window.denShell?.api;
        const body = from ? { from } : {};
        // 0.4.71: only through the shell, which carries this browser's
        // session (a restart needs a sign-in); never a bare request.
        if (api) return api("POST", "/api/web/restart", body, { headers });
        return Promise.reject(new Error("restart needs the page's shell"));
      },
      { before: was ?? undefined },
    );
  })().finally(() => {
    running = null;
  });
  return running;
}

if (typeof window !== "undefined") window.denRestart = restartDen;
