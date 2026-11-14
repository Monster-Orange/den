/**
 * BUSY-1: the working pop-up (Hub Design's pattern, the same in Den).
 *
 *   busyAction({ button, title, done, failed, who, run, stay, onDone })
 *     button  the button pressed: disabled and aria-busy at once, focused
 *             again when the pop-up closes.
 *     title   "Linking projects…" (Working's title).
 *     done    "Done: …" or (data) => "…" (Success's title).
 *     failed  "Couldn't link the projects." (Failure's title).
 *     who     whose answer it waits for: "Den", "Hub" or "GitHub".
 *     run     (headers) => Promise: the request. It must send `headers`
 *             (X-Den-Request-Id): Try again resends the same id, so Den
 *             runs it once; Check again asks /api/requests/<id>.
 *     stay    Success stays open until Done (Send report, Update Den).
 *     onDone  (data) => void, after Success.
 *     onFail  (err) => void, after each Failure (the row can say it too).
 *     toastFast  a fast Success (no pop-up) still says what happened, in a
 *             toast (default true; false where the page shows it itself).
 *   Resolves with the answer's data, or null when it didn't succeed.
 *
 * States: Working, Success, Failure, No answer. The pop-up opens only after
 * OPEN_MS with no answer (a fast action never flashes one) and then stays
 * at least MIN_MS. After STILL_MS a "Still working (N s)" line counts up;
 * after NO_ANSWER_MS it says No answer. While working there are no buttons,
 * and Esc and the backdrop do nothing.
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

export const OPEN_MS = 300;
export const MIN_MS = 600;
export const STILL_MS = 10_000;
export const NO_ANSWER_MS = 60_000;
export const SUCCESS_CLOSE_MS = 1200;

const ICONS = {
  clock:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ok: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l3 3 5-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  bad: '<path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.5v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const icon = (k) =>
  `<svg class="bz-ico bz-${k}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

const CSS = `
.bz-dlg{font-family:var(--sans);width:min(420px,calc(100vw - 32px));max-width:100%;padding:0;border:1px solid var(--border-strong, var(--border));border-radius:8px;background:var(--raised, var(--surface, var(--bg)));color:var(--text);box-shadow:var(--shadow)}
.bz-dlg::backdrop{background:rgba(0,0,0,.25)}
.bz-b{padding:16px 18px;display:grid;gap:10px}
.bz-b h2{font-size:15px;margin:0;outline:none;display:flex;gap:8px;align-items:center}
.bz-b p{margin:0;font-size:13px;line-height:1.5}
.bz-ico{width:18px;height:18px;flex:none}
.bz-ok{color:var(--ok)}.bz-bad{color:var(--bad, var(--err))}
.bz-dlg[data-state="noanswer"] .bz-clock{color:var(--warn)}
.bz-bar{height:2px;background:color-mix(in srgb,var(--accent) 22%,transparent);position:relative;overflow:hidden;border-radius:2px}
.bz-bar i{position:absolute;inset:0 auto 0 0;width:35%;background:var(--accent);animation:bz-ind 1.4s ease-in-out infinite}
@keyframes bz-ind{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
@media (prefers-reduced-motion: reduce){.bz-bar i{animation:none;width:100%;opacity:.7}}
.bz-b details{font-size:12.5px;color:var(--muted)}
.bz-b pre{margin:6px 0 0;font:11.5px/1.5 var(--mono);background:var(--sunken, var(--bg));padding:8px;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere}
.bz-ft{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:center}
.bz-ft .bz-r{margin-inline-end:auto}
`;

function ensureCss() {
  if (document.getElementById("bz-css")) return;
  const s = document.createElement("style");
  s.id = "bz-css";
  s.textContent = CSS;
  document.head.append(s);
}

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return (
      Date.now().toString(16) +
      "-" +
      Math.random().toString(16).slice(2, 12).padEnd(10, "0")
    );
  }
}

const later = (ms) => new Promise((r) => setTimeout(r, ms));

/** How the server last answered, for the Details line and the Report form. */
function detailsText(err, id, at) {
  const lines = [];
  if (err?.method || err?.url)
    lines.push(`${err.method ?? ""} ${err.url ?? ""}`.trim());
  const bits = [];
  if (err?.status) bits.push(`status ${err.status}`);
  bits.push(`request ${id}`);
  bits.push(at.toLocaleTimeString([], { hour12: false }));
  lines.push(bits.join(" · "));
  if (err?.message) lines.push(String(err.message));
  return lines.join("\n");
}

export function busyAction(opts) {
  const { button, who, run } = opts;
  const id = newId();
  const headers = { "X-Den-Request-Id": id };
  let d = null;
  let openedAt = 0;
  let state = "working";
  let ticker = 0;
  let settled = false;
  let finish;
  const result = new Promise((r) => (finish = r));

  const btnBusy = (on) => {
    if (!button) return;
    button.disabled = on;
    if (on) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  };

  function ensureDialog() {
    if (d) return d;
    ensureCss();
    d = document.createElement("dialog");
    d.className = "bz-dlg";
    d.setAttribute("aria-labelledby", "bz-h");
    d.setAttribute("aria-modal", "true");
    // Working: Esc does nothing. Otherwise Esc is Close.
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      if (state !== "working") close(null);
    });
    // The backdrop: a press on the dialog itself, outside its body.
    d.addEventListener("click", (e) => {
      if (e.target === d && state !== "working") close(null);
    });
    document.body.append(d);
    return d;
  }

  function paint(html, focusSel) {
    const dl = ensureDialog();
    dl.dataset.state = state;
    dl.setAttribute("aria-busy", String(state === "working"));
    dl.innerHTML = `<div class="bz-b">${html}</div>`;
    if (!dl.open) {
      if (typeof dl.showModal === "function") dl.showModal();
      else dl.setAttribute("open", "");
      openedAt = Date.now();
    }
    const f = dl.querySelector(focusSel ?? "#bz-h");
    f?.focus?.();
  }

  const title = (ic, text) =>
    `<h2 id="bz-h" tabindex="-1">${icon(ic)}${esc(text)}</h2>`;

  function paintWorking(secs) {
    state = "working";
    const line =
      secs >= STILL_MS / 1000
        ? t("busy.still", { s: secs })
        : t("busy.wait", { who });
    paint(
      title("clock", opts.title) +
        `<p aria-live="polite" class="bz-live">${esc(line)}</p>` +
        `<div class="bz-bar" role="progressbar" aria-label="${esc(t("busy.wait", { who }))}"><i></i></div>`,
    );
  }

  function tick(startedAt) {
    clearInterval(ticker);
    ticker = setInterval(() => {
      if (state !== "working") return clearInterval(ticker);
      const ms = Date.now() - startedAt;
      if (ms >= NO_ANSWER_MS) {
        clearInterval(ticker);
        return paintNoAnswer();
      }
      if (ms >= STILL_MS) {
        const live = d?.querySelector(".bz-live");
        const line = t("busy.still", { s: Math.floor(ms / 1000) });
        if (live) live.textContent = line;
      }
    }, 1000);
  }

  const footer = (primary, primaryKey) =>
    `<div class="bz-ft">` +
    (window.denShell?.report
      ? `<button type="button" class="den-btn sm bz-r" data-bz="report">${esc(t("busy.report"))}</button>`
      : "") +
    `<button type="button" class="den-btn sm" data-bz="close">${esc(t("busy.close"))}</button>` +
    `<button type="button" class="den-btn sm primary" data-bz="${primary}">${esc(t(primaryKey))}</button></div>`;

  let lastErr = null;
  let okData = null;
  let lastAt = new Date();

  function wire() {
    d.querySelector('[data-bz="close"]')?.addEventListener("click", () =>
      close(null),
    );
    d.querySelector('[data-bz="done"]')?.addEventListener("click", () =>
      close(okData),
    );
    d.querySelector('[data-bz="retry"]')?.addEventListener("click", () =>
      attempt(),
    );
    d.querySelector('[data-bz="check"]')?.addEventListener("click", () =>
      checkAgain(),
    );
    d.querySelector('[data-bz="report"]')?.addEventListener("click", () =>
      window.denShell?.report?.({
        title: opts.failed,
        details: detailsText(lastErr, id, lastAt),
        requestId: id,
      }),
    );
  }

  function paintFailure(err) {
    state = "failure";
    lastErr = err;
    lastAt = new Date();
    const why = err?.network
      ? t("busy.network", { who })
      : err?.status
        ? t("busy.errCode", { who, code: err.status })
        : err?.message || t("busy.network", { who });
    // The server's own words, when it said more than its code.
    const said =
      err?.status && !err?.network && err?.message ? String(err.message) : "";
    opts.onFail?.(err);
    paint(
      title("bad", opts.failed) +
        `<p>${esc(why)}</p>` +
        (said ? `<p class="bz-said">${esc(said)}</p>` : "") +
        `<details><summary>${esc(t("busy.details"))}</summary><pre>${esc(detailsText(err, id, lastAt))}</pre></details>` +
        footer("retry", "busy.retry"),
      '[data-bz="retry"]',
    );
    wire();
  }

  function paintNoAnswer() {
    state = "noanswer";
    paint(
      title("clock", t("busy.noansT", { who })) +
        `<p>${esc(t("busy.noansB"))}</p>` +
        footer("check", "busy.check"),
      '[data-bz="check"]',
    );
    wire();
  }

  function paintSuccess(data) {
    state = "success";
    const text = typeof opts.done === "function" ? opts.done(data) : opts.done;
    paint(
      title("ok", text) +
        `<div class="bz-ft"><button type="button" class="den-btn sm primary" data-bz="done">${esc(t("busy.done"))}</button></div>`,
      '[data-bz="done"]',
    );
    wire();
    if (!opts.stay)
      setTimeout(() => {
        if (state === "success") close(data);
      }, SUCCESS_CLOSE_MS);
  }

  function close(data) {
    if (settled) return;
    settled = true;
    clearInterval(ticker);
    if (d?.open && typeof d.close === "function") d.close();
    d?.remove();
    btnBusy(false);
    button?.focus?.();
    finish(data);
  }

  /** The answer came; the pop-up may not be open (a fast action). */
  async function answered(ok, data, err) {
    if (settled) return;
    if (d?.open) {
      const shown = Date.now() - openedAt;
      if (shown < MIN_MS) await later(MIN_MS - shown);
    }
    if (ok) {
      okData = data;
      opts.onDone?.(data);
      if (!d?.open && !opts.stay) {
        if (opts.toastFast !== false)
          window.denShell?.toast?.(
            typeof opts.done === "function" ? opts.done(data) : opts.done,
          );
        return close(data);
      }
      return paintSuccess(data);
    }
    paintFailure(err);
  }

  function attempt() {
    const startedAt = Date.now();
    state = "working";
    btnBusy(true);
    if (d?.open) {
      paintWorking(0);
      tick(startedAt);
    }
    const opener = setTimeout(() => {
      if (state === "working" && !settled && !d?.open) {
        paintWorking(0);
        tick(startedAt);
      }
    }, OPEN_MS);
    Promise.resolve()
      .then(() => run(headers))
      .then(
        (data) => {
          clearTimeout(opener);
          clearInterval(ticker);
          return answered(true, data);
        },
        (err) => {
          clearTimeout(opener);
          clearInterval(ticker);
          return answered(false, null, err);
        },
      );
  }

  /** Check again: how did this id end? Never resends. */
  async function checkAgain() {
    state = "working";
    paintWorking(0);
    let st = null;
    try {
      const r = await fetch(`/api/requests/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      st = r.ok ? await r.json() : null;
    } catch {
      st = null;
    }
    if (settled) return;
    if (st?.state === "running") {
      paintWorking(0);
      return tick(Date.now());
    }
    if (st?.state === "done" && st.status < 400) return answered(true, okData);
    if (st?.state === "done")
      return answered(false, null, { status: st.status });
    if (st?.state === "unknown")
      return answered(false, null, { message: t("busy.unknown", { who }) });
    return answered(false, null, { network: true });
  }

  attempt();
  return result;
}

if (typeof window !== "undefined") window.denBusy = { busyAction };
