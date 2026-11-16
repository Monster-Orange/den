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

const CSS = `
.rd-dlg{font-family:var(--sans);width:min(420px,calc(100vw - 32px));padding:0;border:1px solid var(--border-strong, var(--border));border-radius:10px;background:var(--raised, var(--surface, var(--bg)));color:var(--text);box-shadow:var(--shadow)}
.rd-dlg::backdrop{background:rgba(0,0,0,.25)}
.rd-b{padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.rd-b h2{font-size:15px;margin:0;outline:none}
.rd-b ul{margin:0;padding-left:18px;font-size:13px;line-height:1.5;color:var(--muted)}
.rd-b p{margin:0;font-size:13px;line-height:1.5}
.rd-acts{display:flex;gap:8px;justify-content:flex-end}
.rd-dlg [hidden]{display:none}
`;

function ensureCss() {
  if (document.getElementById("rd-css")) return;
  const s = document.createElement("style");
  s.id = "rd-css";
  s.textContent = CSS;
  document.head.append(s);
}

function dialog() {
  ensureCss();
  let d = document.getElementById("rd-dlg");
  if (d) return d;
  d = document.createElement("dialog");
  d.id = "rd-dlg";
  d.className = "rd-dlg";
  d.setAttribute("aria-labelledby", "rd-h");
  document.body.append(d);
  return d;
}

function show(d) {
  if (d.open) return;
  if (typeof d.showModal === "function") d.showModal();
  else d.setAttribute("open", "");
}

function hide(d) {
  if (d.open && typeof d.close === "function") d.close();
  else d.removeAttribute("open");
}

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

/** Asks first: what keeps running, what pauses. Resolves true on Restart. */
function confirmRestart(d) {
  d.dataset.state = "confirm";
  d.innerHTML =
    `<div class="rd-b"><h2 id="rd-h" tabindex="-1">${esc(t("rd.title"))}</h2>` +
    `<p>${esc(t("rd.keepsHead"))}</p>` +
    `<ul><li>${esc(t("rd.keepsAgents"))}</li><li>${esc(t("rd.keepsServices"))}</li></ul>` +
    `<p>${esc(t("rd.pausesHead"))}</p>` +
    `<ul><li>${esc(t("rd.pausesLive"))}</li></ul>` +
    `<div class="rd-acts"><button type="button" class="den-btn sm" data-rd="cancel">${esc(t("rd.cancel"))}</button>` +
    `<button type="button" class="den-btn sm primary" data-rd="go">${esc(t("rd.go"))}</button></div></div>`;
  show(d);
  d.querySelector('[data-rd="go"]').focus();
  return new Promise((resolve) => {
    const done = (v) => {
      d.removeEventListener("close", onClose);
      resolve(v);
    };
    const onClose = () => done(false);
    d.addEventListener("close", onClose);
    d.querySelector('[data-rd="cancel"]').addEventListener("click", () => {
      hide(d);
    });
    d.querySelector('[data-rd="go"]').addEventListener("click", () =>
      done(true),
    );
  });
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
    const d = dialog();
    if (confirm && !(await confirmRestart(d))) return null;
    hide(d);
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
        if (api) return api("POST", "/api/web/restart", body, { headers });
        return fetch("/api/web/restart", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(4000),
        }).then(
          (r) => r.json().catch(() => ({})),
          () => {
            throw { network: true };
          },
        );
      },
      { before: was ?? undefined },
    );
  })().finally(() => {
    running = null;
  });
  return running;
}

if (typeof window !== "undefined") window.denRestart = restartDen;
