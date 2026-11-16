/**
 * UK-2: the working pop-up, <den-busy>, and busyAction.
 *
 * A slow click never looks dead: the button is held at once; after OPEN_MS
 * with no answer the pop-up names what is happening; it stays until the
 * server answers, then says what happened. Framework-free; the product
 * plugs in its words, its Report, its toast and its routes:
 *
 *   configureBusy({
 *     lang: () => "en",             the page's language (en, es, ja)
 *     words: { en: {...}, ... },    extra or replaced shared words
 *     idHeader: "X-Request-Id",     the header the request id rides in
 *     statusUrl: (id) => url,       Check again's GET (never resends)
 *     report: (info) => void,       Report: { title, details, requestId }
 *     toast: (text) => void,        a fast success, said without a pop-up
 *     open: (url) => void,          a held answer's page (default: go)
 *     logUrl: "/logs",              Open the log (reconnect mode)
 *     reconnect: {                  reconnect mode (a product restarting)
 *       url,                        polled until the product is back
 *       back: (now, before) => bool,  is this a new run of the product?
 *       waitMs: (before) => number,   how long before "not back" (60 s)
 *       version: (now) => string,
 *       done: (now) => void,        after "back" (default: reload)
 *     },
 *   })
 *
 *   registerActions({ name: {
 *     who: "Hub",                   whose answer it waits for (a name)
 *     autoClose: true,              (kept for older callers: every success
 *                                   now closes at once, with the toast)
 *     inline: true,                 its place shows a quick failure itself
 *     mode: "reconnect",
 *     words: { en: { working, success, failure, ... }, es: {...}, ja: {...} },
 *   } })
 *
 *   busyAction(name, run, opts) → Promise<data | null>
 *     run(headers)        the request; it must send `headers` (the id).
 *     opts.button         held (disabled, aria-busy) and focused again.
 *     opts.vars           words' {placeholders}.
 *     opts.success(data)  the success line, worked out from the answer.
 *     opts.onDone(data), opts.onFail(err)
 *     opts.toastFast      a fast success says so in a toast (default true).
 *     opts.quietFail      a refusal under OPEN_MS goes back to the caller
 *                         (the promise rejects with it).
 *     opts.inlineError    a network error before the pop-up opens goes back
 *                         to the caller.
 *     opts.skipDone(res)  true: no success line (closes quietly).
 *     opts.extra(res)     a node under the success line; waits for Close.
 *     opts.before         reconnect: the product's answer from before (else
 *                         the kit asks reconnect.url first).
 *
 * Reconnect mode: the request may get no answer (the product stopped
 * first); that counts as going down, and the pop-up waits for it to come
 * back. busyAction then resolves with the new answer from reconnect.url.
 *
 * The request contract (Settled in v2): Try again sends the same id only
 * when no answer came back; after the server answered with an error it
 * sends a new one. Check again asks statusUrl(id) and never resends:
 * done, failed, running ("still running") or unknown ("no record").
 * An answer { held: { id, url } } closes the pop-up with no success line
 * and opens url.
 */
import { BUSY_WORDS } from "./busy-words.js";

export const OPEN_MS = 300;
export const MIN_MS = 600;
export const STILL_MS = 10_000;
export const NO_ANSWER_MS = 60_000;
export const SUCCESS_CLOSE_MS = 1200;
export const POLL_MS = 1000;
export const POLL_MAX_MS = 3000;

const hook = {
  lang: () =>
    (typeof document !== "undefined" &&
      document.documentElement.lang?.slice(0, 2)) ||
    "en",
  words: {},
  idHeader: "X-Request-Id",
  statusUrl: (id) => `/requests/${encodeURIComponent(id)}`,
  report: null,
  toast: null,
  open: (url) => window.location.assign(url),
  logUrl: null,
  reconnect: null,
};
const actions = new Map();

/** The product's words, routes and services (see the top of this file). */
export function configureBusy(h) {
  Object.assign(hook, h ?? {});
}

/** Each action's words and rules, by name. */
export function registerActions(map) {
  for (const [name, a] of Object.entries(map ?? {})) actions.set(name, a);
}

/** The registered action, for a product's own checks. */
export function busyActionOf(name) {
  return actions.get(name) ?? null;
}

const fill = (s, vars) =>
  String(s ?? "").replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] !== undefined ? String(vars[k]) : m,
  );

/** A shared word, in the page's language, with the product's own on top. */
function word(key, vars) {
  const l = hook.lang();
  const s =
    hook.words?.[l]?.[key] ??
    BUSY_WORDS[l]?.[key] ??
    hook.words?.en?.[key] ??
    BUSY_WORDS.en[key] ??
    key;
  return fill(s, vars);
}

/** One of the action's own words (working, success, failure, …). */
function actionWord(a, key, vars) {
  const l = hook.lang();
  return fill(a.words?.[l]?.[key] ?? a.words?.en?.[key] ?? "", vars);
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const ICONS = {
  clock:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ok: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l3 3 5-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  bad: '<path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.5v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const icon = (k) =>
  `<svg class="bz-ico bz-${k}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

/* Tokens only (UK-1): no colour of its own. */
const CSS = `
.bz-dlg{font-family:var(--sans);height:fit-content;width:min(420px,calc(100vw - 32px));max-width:100%;padding:0;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--surface);color:var(--text);box-shadow:var(--shadow-dialog)}
.bz-dlg::backdrop{background:color-mix(in srgb,var(--sunken) 70%,transparent)}
.bz-b{padding:var(--space-4) calc(var(--space-4) + 2px);display:grid;gap:10px}
.bz-b h2{font-size:var(--fs-l);margin:0;outline:none;display:flex;gap:var(--space-2);align-items:center}
.bz-b p{margin:0;font-size:var(--fs-s);line-height:1.5}
.bz-ico{width:18px;height:18px;flex:none}
.bz-ok{color:var(--ok)}.bz-bad{color:var(--bad)}
.bz-dlg[data-state="noanswer"] .bz-clock{color:var(--warn)}
.bz-bar{height:2px;background:color-mix(in srgb,var(--accent) 22%,transparent);position:relative;overflow:hidden;border-radius:2px}
.bz-bar i{position:absolute;inset:0 auto 0 0;width:35%;background:var(--accent);animation:bz-ind 1.4s ease-in-out infinite}
@keyframes bz-ind{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
@media (prefers-reduced-motion: reduce){.bz-bar i{animation:none;width:100%;opacity:.7}}
.bz-b details{font-size:var(--fs-xs);color:var(--muted)}
.bz-b pre{margin:6px 0 0;font:11.5px/1.5 var(--mono);background:var(--sunken);padding:var(--space-2);border-radius:var(--radius-button);white-space:pre-wrap;overflow-wrap:anywhere}
.bz-ft{display:flex;flex-wrap:wrap;gap:var(--space-2);justify-content:flex-end;align-items:center}
.bz-btn{font:inherit;font-size:var(--fs-s);min-height:var(--tap-min);padding:0 var(--space-3);border-radius:var(--radius-button);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);cursor:pointer}
.bz-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.bz-btn.bz-primary{background:var(--accent-fill);border-color:var(--accent-fill);color:var(--on-accent)}
@media (max-width:480px){.bz-btn{min-height:var(--tap)}.bz-ft .bz-primary{flex-basis:100%;order:9}}
`;

function ensureCss() {
  if (document.getElementById("bz-css")) return;
  const s = document.createElement("style");
  s.id = "bz-css";
  s.textContent = CSS;
  document.head.append(s);
}

/** <den-busy>: the pop-up's element, defined on first use (a browser only). */
function defineElement() {
  if (typeof customElements === "undefined" || customElements.get("den-busy"))
    return;
  customElements.define("den-busy", class extends HTMLElement {});
}

function makeDialog(host) {
  const d = document.createElement("dialog");
  d.className = "bz-dlg";
  d.setAttribute("aria-labelledby", "bz-h");
  d.setAttribute("aria-modal", "true");
  host.append(d);
  return d;
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

/** The first message with words: the error's own, its answer's, nothing. */
export function messageOf(err) {
  const tries = [
    err?.message,
    err?.error?.message,
    err?.error,
    err?.body?.message,
    err?.body?.error?.message,
    err?.body?.error,
  ];
  for (const m of tries)
    if (typeof m === "string" && m.trim() !== "") return m.trim();
  return "";
}

/** The server answered (with an error), as opposed to no answer at all. */
const answeredWithError = (err) =>
  !!err && !err.network && typeof err.status === "number";

/** Details: status code · request id · time (never the API path). */
function detailsText(err, id, at) {
  const bits = [];
  if (err?.status) bits.push(`status ${err.status}`);
  bits.push(`request ${id}`);
  bits.push(at.toLocaleTimeString([], { hour12: false }));
  const said = messageOf(err);
  return said ? `${bits.join(" · ")}\n${said}` : bits.join(" · ");
}

export function busyAction(name, run, opts = {}) {
  const a = actions.get(name);
  if (!a) throw new Error(`busyAction: no action named "${name}"`);
  const { button } = opts;
  const who = a.who ?? "";
  const vars = { ...(opts.vars ?? {}), who };
  const reconnect = a.mode === "reconnect";
  let id = newId();
  let el = null;
  let d = null;
  let openedAt = 0;
  let state = "working";
  let ticker = 0;
  let settled = false;
  let lastErr = null;
  let okData = null;
  let lastAt = new Date();
  let finish;
  let fail;
  const result = new Promise((res, rej) => {
    finish = res;
    fail = rej;
  });

  const hold = (on) => {
    if (!button) return;
    button.disabled = on;
    if (on) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  };

  function ensureDialog() {
    if (d) return d;
    ensureCss();
    defineElement();
    el = document.createElement("den-busy");
    document.body.append(el);
    d = makeDialog(el);
    // Working: Esc does nothing. Otherwise Esc is Close.
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      if (state !== "working") close(null);
    });
    // The backdrop: a press on the dialog itself, outside its body.
    d.addEventListener("click", (e) => {
      if (e.target === d && state !== "working") close(null);
    });
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
    dl.querySelector(focusSel ?? "#bz-h")?.focus?.();
  }

  const title = (ic, text) =>
    `<h2 id="bz-h" tabindex="-1">${icon(ic)}${esc(text)}</h2>`;
  const btn = (key, primary) =>
    `<button type="button" class="bz-btn${primary ? " bz-primary" : ""}" data-bz="${key}">${esc(word(key))}</button>`;

  /** Report · Close · [Open the log] · the primary, last. */
  const footer = (primary, withLog) =>
    `<div class="bz-ft">` +
    (hook.report ? btn("report") : "") +
    btn("close") +
    (withLog && hook.logUrl ? btn("log") : "") +
    btn(primary, true) +
    `</div>`;

  function paintWorking(secs, note) {
    state = "working";
    const line = note
      ? note
      : secs >= STILL_MS / 1000
        ? word("still", { s: secs })
        : reconnect && actionWord(a, "working_body", vars)
          ? actionWord(a, "working_body", vars)
          : word("wait", { who });
    paint(
      title("clock", actionWord(a, "working", vars)) +
        `<p aria-live="polite" class="bz-live">${esc(line)}</p>` +
        `<div class="bz-bar" role="progressbar" aria-label="${esc(word("wait", { who }))}"><i></i></div>`,
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
      if (ms >= STILL_MS && !reconnect) {
        const live = d?.querySelector(".bz-live");
        if (live)
          live.textContent = word("still", { s: Math.floor(ms / 1000) });
      }
    }, 1000);
  }

  function wire() {
    const on = (k, fn) =>
      d.querySelector(`[data-bz="${k}"]`)?.addEventListener("click", fn);
    on("close", () => close(state === "success" ? okData : null));
    on("done", () => close(okData));
    on("retry", () => attempt());
    on("check", () => (reconnect ? waitBack(Date.now()) : checkAgain()));
    on("log", () => hook.open(hook.logUrl));
    on("report", () =>
      hook.report?.({
        title: actionWord(a, "failure", vars),
        details: detailsText(lastErr, id, lastAt),
        requestId: id,
      }),
    );
  }

  function paintFailure(err) {
    state = "failure";
    lastErr = err;
    lastAt = new Date();
    // The server's own words, only when it answered (a network error's
    // message is the client's, not the server's).
    const said = answeredWithError(err) ? messageOf(err) : "";
    const why = err?.network
      ? word("network", { who })
      : err?.status
        ? word("err_code", { who, code: err.status })
        : messageOf(err) || word("network", { who });
    opts.onFail?.(err);
    paint(
      title("bad", actionWord(a, "failure", vars)) +
        `<p>${esc(why)}</p>` +
        (said && said !== why ? `<p class="bz-said">${esc(said)}</p>` : "") +
        `<details><summary>${esc(word("details"))}</summary><pre>${esc(detailsText(err, id, lastAt))}</pre></details>` +
        footer("retry"),
      '[data-bz="retry"]',
    );
    wire();
  }

  function paintNoAnswer(note) {
    state = "noanswer";
    const t = reconnect
      ? actionWord(a, "failure", vars)
      : word("noans_t", { who });
    const b = reconnect ? actionWord(a, "failure_body", vars) : word("noans_b");
    paint(
      title("clock", t) +
        `<p>${esc(b)}</p>` +
        (note ? `<p class="bz-note">${esc(note)}</p>` : "") +
        footer("check", reconnect),
      '[data-bz="check"]',
    );
    wire();
  }

  function paintSuccess(data, node) {
    state = "success";
    const text = opts.success
      ? opts.success(data)
      : actionWord(a, "success", vars);
    paint(
      title("ok", text) +
        (reconnect && data?.version
          ? `<p>${esc(actionWord(a, "success_body", { ...vars, v: data.version }))}</p>`
          : "") +
        `<div class="bz-extra"></div>` +
        `<div class="bz-ft">${btn(node ? "close" : "done", true)}</div>`,
      node ? '[data-bz="close"]' : '[data-bz="done"]',
    );
    if (node) d.querySelector(".bz-extra")?.append(node);
    else d.querySelector(".bz-extra")?.remove();
    wire();
    if (a.autoClose && !node)
      setTimeout(() => {
        if (state === "success") close(data);
      }, SUCCESS_CLOSE_MS);
  }

  function close(data) {
    if (settled) return;
    settled = true;
    clearInterval(ticker);
    if (d?.open && typeof d.close === "function") d.close();
    el?.remove();
    hold(false);
    button?.focus?.();
    finish(data);
  }

  /** Back to the caller, with the error: its place shows it. */
  function giveBack(err) {
    if (settled) return;
    settled = true;
    clearInterval(ticker);
    el?.remove();
    hold(false);
    opts.onFail?.(err);
    fail(err);
  }

  /** The answer came; the pop-up may not be open (a fast action). */
  async function answered(ok, data, err) {
    if (settled) return;
    if (!ok && !d?.open) {
      // Settled 5: a quick failure goes back where the place says it
      // itself; elsewhere the Failure pop-up opens at once.
      const network = !!err?.network || !answeredWithError(err);
      if ((opts.inlineError || a.inline) && network) return giveBack(err);
      if ((opts.quietFail || a.inline) && !network) return giveBack(err);
    }
    if (d?.open) {
      const shown = Date.now() - openedAt;
      if (shown < MIN_MS) await later(MIN_MS - shown);
    }
    if (settled) return;
    if (ok) {
      okData = data;
      // Settled 6: held for a person: no success line, its page instead.
      if (data && typeof data === "object" && data.held?.url) {
        close(data);
        hook.open(data.held.url);
        return;
      }
      opts.onDone?.(data);
      if (opts.skipDone?.(data)) return close(data);
      if (reconnect) return waitBack(Date.now());
      const node = opts.extra?.(data) ?? null;
      // UK-2 (Ward): success never waits for a click. The pop-up closes at
      // once and the toast says it, as for a fast action. Only `extra`
      // (something to read) keeps it open, with Close.
      if (!node) {
        if (d?.open || opts.toastFast !== false)
          hook.toast?.(
            opts.success ? opts.success(data) : actionWord(a, "success", vars),
          );
        return close(data);
      }
      return paintSuccess(data, node);
    }
    // Reconnect: no answer is the product going down; wait for it.
    if (reconnect && !answeredWithError(err)) return waitBack(Date.now());
    paintFailure(err);
  }

  function attempt() {
    // Try again: the same id only when no answer came back.
    if (answeredWithError(lastErr)) id = newId();
    lastErr = null;
    const startedAt = Date.now();
    state = "working";
    hold(true);
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
      .then(() => run({ [hook.idHeader]: id }))
      .then(
        (data) => {
          clearTimeout(opener);
          clearInterval(ticker);
          return answered(true, data);
        },
        (err) => {
          clearTimeout(opener);
          clearInterval(ticker);
          lastErr = err;
          return answered(false, null, err);
        },
      );
  }

  /** Check again: how did this id end? Never resends. */
  async function checkAgain() {
    let st = null;
    try {
      const r = await fetch(hook.statusUrl(id), { cache: "no-store" });
      st = r.ok ? await r.json() : null;
    } catch {
      st = null;
    }
    if (settled) return;
    if (st?.state === "done") return answered(true, st.result ?? okData);
    if (st?.state === "failed")
      return answered(false, null, {
        status: st.error?.code,
        message: st.error?.message || undefined,
      });
    if (st?.state === "running") return paintNoAnswer(word("still_running"));
    if (st?.state === "unknown")
      return paintNoAnswer(word("noans_unknown", { who }));
    return answered(false, null, { network: true });
  }

  /** Reconnect mode: poll until the product is back, 1 s backing off to 3 s. */
  async function waitBack(startedAt) {
    const rc = hook.reconnect;
    if (!rc) return paintNoAnswer();
    state = "working";
    paintWorking(0);
    let gap = POLL_MS;
    const limit = Number(rc.waitMs?.(before)) || NO_ANSWER_MS;
    while (!settled && Date.now() - startedAt < limit) {
      await later(gap);
      gap = Math.min(POLL_MAX_MS, gap + 500);
      let now = null;
      try {
        const r = await fetch(rc.url, { cache: "no-store" });
        now = r.ok ? await r.json() : null;
      } catch {
        now = null;
      }
      if (settled) return;
      if (now && rc.back(now, before)) {
        const v = rc.version?.(now) ?? "";
        paintSuccess({ version: v }, null);
        setTimeout(() => {
          if (settled) return;
          (rc.done ?? (() => location.reload()))(now);
          close(now);
        }, SUCCESS_CLOSE_MS);
        return;
      }
    }
    if (!settled) paintNoAnswer();
  }

  // Reconnect mode: how the product answered before it went away.
  let before = opts.before ?? null;
  if (reconnect && hook.reconnect && !before)
    fetch(hook.reconnect.url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((b) => {
        before = b;
        attempt();
      });
  else attempt();
  return result;
}
