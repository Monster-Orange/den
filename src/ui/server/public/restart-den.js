/**
 * D64: Restart Den from the browser, in place.
 *
 *   restartDen({ confirm })  confirm: first a dialog that says what keeps
 *                            running and what pauses (Settings › Server, the
 *                            header menu, the palette); the stale pill skips
 *                            it (the pill is already the ask).
 *
 * Then a small dialog, "Restarting Den… 4s", asks GET /api/server-info
 * every second. Den counts as back only on a 200 from a NEW pid or
 * startedAt (the old server can answer for a moment before it stops). Back:
 * "Den is back" for about a second, then it closes by itself and fires
 * `den:server-back` on window, so a page reconnects its live connections
 * (terminals, events) without a reload: typed text and scroll stay. A
 * changed build is the update pill's to offer (D61).
 *
 * After `ui.restart_wait_seconds` (server-info's restartWaitSeconds,
 * default 90) the dialog shows the CLI line and Keep waiting; it never
 * closes by itself while the server is down.
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

const CLI = "__DEN_CLI__";
/** How often it asks, and how long "Den is back" shows. */
export const RESTART_POLL_MS = 1000;
export const RESTART_BACK_MS = 1000;
const DEFAULT_WAIT_S = 90;

const CSS = `
.rd-dlg{font-family:var(--sans);width:min(420px,calc(100vw - 32px));padding:0;border:1px solid var(--border-strong, var(--border));border-radius:10px;background:var(--raised, var(--surface, var(--bg)));color:var(--text);box-shadow:var(--shadow)}
.rd-dlg::backdrop{background:rgba(0,0,0,.25)}
.rd-b{padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.rd-b h2{font-size:15px;margin:0;outline:none}
.rd-b ul{margin:0;padding-left:18px;font-size:13px;line-height:1.5;color:var(--muted)}
.rd-b p{margin:0;font-size:13px;line-height:1.5}
.rd-st{display:flex;align-items:center;gap:10px;font-size:14px}
.rd-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--accent);animation:rd-spin .8s linear infinite;flex:none}
.rd-dlg[data-state="back"] .rd-spin{animation:none;border-color:var(--ok)}
.rd-slow code{font-family:var(--mono);font-size:12px}
.rd-acts{display:flex;gap:8px;justify-content:flex-end}
@keyframes rd-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.rd-spin{animation:none}}
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
export function restartDen({ confirm = true, before = null } = {}) {
  if (running) return running;
  running = (async () => {
    const d = dialog();
    if (confirm && !(await confirmRestart(d))) return null;
    const was = before ?? (await serverInfo());
    const waitS =
      Number(was?.restartWaitSeconds) > 0
        ? Number(was.restartWaitSeconds)
        : DEFAULT_WAIT_S;
    d.dataset.state = "waiting";
    d.innerHTML =
      `<div class="rd-b" role="status" aria-live="polite"><div class="rd-st"><span class="rd-spin" aria-hidden="true"></span>` +
      `<h2 id="rd-h" tabindex="-1" class="rd-msg"></h2></div>` +
      `<p class="rd-slow" hidden></p>` +
      `<div class="rd-acts" hidden><button type="button" class="den-btn sm" data-rd="keep">${esc(t("rd.keep"))}</button></div></div>`;
    // Esc never hides a restart that's still under way.
    const noEsc = (e) => e.preventDefault();
    d.addEventListener("cancel", noEsc);
    show(d);
    const msg = d.querySelector(".rd-msg");
    const slow = d.querySelector(".rd-slow");
    const acts = d.querySelector(".rd-acts");
    let t0 = Date.now();
    let since = t0;
    const paint = () => {
      msg.textContent = t("rd.wait", {
        n: Math.floor((Date.now() - t0) / 1000),
      });
    };
    paint();
    acts.querySelector('[data-rd="keep"]').addEventListener("click", () => {
      since = Date.now();
      slow.hidden = true;
      acts.hidden = true;
    });
    try {
      const api = window.denShell?.api;
      if (api) await api("POST", "/api/web/restart", {});
      else
        await fetch("/api/web/restart", {
          method: "POST",
          signal: AbortSignal.timeout(4000),
        });
    } catch {
      // The server often stops before it answers: wait for the new one.
    }
    for (;;) {
      await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
      paint();
      const info = await serverInfo();
      const isNew =
        info &&
        info.pid != null &&
        (!was ||
          info.pid !== was.pid ||
          String(info.startedAt) !== String(was.startedAt));
      if (isNew) {
        d.dataset.state = "back";
        msg.textContent = t("rd.back");
        slow.hidden = true;
        acts.hidden = true;
        window.dispatchEvent(
          new CustomEvent("den:server-back", { detail: info }),
        );
        await new Promise((r) => setTimeout(r, RESTART_BACK_MS));
        d.removeEventListener("cancel", noEsc);
        hide(d);
        return info;
      }
      if (Date.now() - since > waitS * 1000 && slow.hidden) {
        slow.innerHTML = esc(t("rd.slow", { cmd: "\u0000" })).replace(
          "\u0000",
          `<code>${esc(`${CLI} web restart`)}</code>`,
        );
        slow.hidden = false;
        acts.hidden = false;
      }
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

if (typeof window !== "undefined") window.denRestart = restartDen;
