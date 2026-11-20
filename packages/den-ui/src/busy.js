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
 *     request: (id) => Promise<state>  Check again through the product's
 *                                   adapter instead ({ state, result?,
 *                                   error? }); statusUrl is then unused
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
 *     opts.next           a failure trying again won't fix: { label, href },
 *                         or (err) => { label, href } | null. The Failure
 *                         pop-up then offers that link (the primary) in
 *                         place of Try again. With no href ({ label }: who
 *                         to ask, say), it says the words instead and
 *                         Close is the primary.
 *
 *   run(headers, progress)  progress(text) adds a line under the working
 *                       title (in order; the newest is the brightest),
 *                       shown when the pop-up opens and as it works.
 *
 * Its look is busy.css (linked from beside this file).
 *
 * Issue 699, the held button: every button the kit holds (opts.button,
 * pending()'s button, a plain POST form's submitter) shows three pulsing
 * dots in place of its label at once, at the same size, disabled with
 * aria-busy="true". The label stays (in .bz-lbl, hidden) and stays the
 * accessible name. The working pop-up then opens only after dotsMs
 * (configureBusy({ dotsMs }), default DOTS_MS, 3 s), the dots behind it;
 * an answer before that gives the label back. The button never shows an
 * error itself: a quick failure gives the label back and the error goes
 * where it goes today (the caller, or the failure pop-up); after the
 * pop-up, the pop-up shows it, Try again holds the button again and
 * Close gives the label back. opts.dots: false holds it the old way.
 *
 *   pending(button, (headers) => fetch(url, { method: "POST", headers }),
 *           opts?) → Promise<answer | null>
 *     A fetch-driven button. An answer that is not ok (a Response with
 *     ok false) or no answer at all is the failure pop-up with Try again;
 *     null after Close, or at once for a button already held. opts are
 *     busyAction's, plus action (a registered name; default the kit's own
 *     "send": Sending…, Sent., Not sent.) and who (default: the server).
 *
 *   watchForms(root = document) → stop()
 *     One submit listener for plain POST forms: the submitter is held
 *     until the next page comes (or the page shows again from the back
 *     button). A form the page sends itself (its submit handler called
 *     preventDefault) is left alone.
 *
 * A button that never waits opts out with a reason, data-instant="<why>":
 * held without dots, its pop-up at OPEN_MS. An empty reason doesn't count
 * (instantProblems(html) is the check).
 *
 * Reconnect mode: the request may get no answer (the product stopped
 * first); that counts as going down, and the pop-up waits for it to come
 * back. busyAction then resolves with the new answer from reconnect.url.
 * Each ask of reconnect.url gives up after ASK_MS: an ask in flight as the
 * product goes down (or one a proxy holds) may never be answered, and the
 * next ask must still come.
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
export const ASK_MS = 3000;
/** Issue 699: the working pop-up's wait once a button shows dots. */
export const DOTS_MS = 3000;

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
  dotsMs: DOTS_MS,
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
  const out = fill(s, vars);
  // A sentence that starts with who it waits for starts with a capital.
  return /^\{who\}/.test(s) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
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

/**
 * The look is busy.css, beside this file: linked once, never injected, so
 * a page under style-src 'self' takes it. A page that links it itself (in
 * its <head>, say) keeps its own link.
 */
const CSS_URL = new URL("./busy.css", import.meta.url).href;

function ensureCss() {
  if (document.getElementById("bz-css")) return;
  for (const l of document.querySelectorAll('link[rel="stylesheet"]'))
    if (/(^|\/)busy\.css(\?|$)/.test(new URL(l.href, location.href).pathname))
      return;
  const l = document.createElement("link");
  l.id = "bz-css";
  l.rel = "stylesheet";
  l.href = CSS_URL;
  document.head.append(l);
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

/** One ask of the reconnect url: its JSON, or null (no answer in ASK_MS). */
async function askOnce(url) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ASK_MS);
  try {
    const r = await fetch(url, { cache: "no-store", signal: stop.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

/**
 * Issue 699: the reason a button never waits (data-instant="<why>"), or
 * null. An empty reason doesn't count.
 */
function instantReason(b) {
  const why = b?.getAttribute?.("data-instant");
  if (why == null) return null;
  if (String(why).trim()) return String(why).trim();
  console.warn("data-instant needs a reason (issue 699)", b);
  return null;
}

/** Each data-instant in a page's markup with no reason (the kit's check). */
export function instantProblems(html) {
  const out = [];
  const re =
    /<[a-zA-Z][^<>]*?\sdata-instant(?![\w-])(\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  for (const m of String(html ?? "").matchAll(re)) {
    const why = m[3] ?? m[4] ?? m[5] ?? "";
    if (!why.trim()) out.push(m[0].slice(0, 120));
  }
  return out;
}

/** The buttons held with dots now, with what to give back. */
const held = new Map();

/**
 * Holds a button (disabled, aria-busy) or lets it go. dots: the label goes
 * into .bz-lbl (hidden, so the size stays) and three dots go over it; the
 * accessible name stays the label. later: disabled on the next turn (a
 * form's submitter, once the browser took its name and value).
 */
function holdButton(b, on, dots, later = false) {
  if (!b) return;
  if (!on) {
    b.disabled = false;
    b.removeAttribute("aria-busy");
    const h = held.get(b);
    if (!h) return;
    held.delete(b);
    clearTimeout(h.timer);
    if (h.dots.parentNode === b) h.dots.remove();
    // The page may have drawn the button again while it waited: its own
    // label then stays as it drew it.
    if (h.lbl.parentNode === b) {
      const at = h.lbl.nextSibling;
      while (h.lbl.firstChild) b.insertBefore(h.lbl.firstChild, at);
      h.lbl.remove();
    }
    if (h.name == null) b.removeAttribute("aria-label");
    return;
  }
  b.setAttribute("aria-busy", "true");
  let timer = 0;
  if (later) timer = setTimeout(() => held.has(b) && (b.disabled = true), 0);
  else b.disabled = true;
  if (!dots || held.has(b)) return;
  ensureCss();
  const name = b.getAttribute("aria-label");
  const text = String(b.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const lbl = document.createElement("span");
  lbl.className = "bz-lbl";
  while (b.firstChild) lbl.append(b.firstChild);
  const d = document.createElement("span");
  d.className = "bz-dots";
  d.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) d.append(document.createElement("i"));
  b.append(lbl, d);
  if (name == null && text) b.setAttribute("aria-label", text);
  held.set(b, { lbl, dots: d, name, timer });
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
  /** progress(text)'s lines, this attempt. */
  let lines = [];
  let finish;
  let fail;
  const result = new Promise((res, rej) => {
    finish = res;
    fail = rej;
  });

  // Issue 699: a held button shows dots (unless it never waits), and the
  // pop-up then waits dotsMs instead of OPEN_MS.
  const dots = !!button && opts.dots !== false && !instantReason(button);
  const openMs = !dots
    ? OPEN_MS
    : Number.isFinite(Number(hook.dotsMs)) && hook.dotsMs !== null
      ? Number(hook.dotsMs)
      : DOTS_MS;
  const hold = (on) => holdButton(button, on, dots);

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

  /**
   * Report · Close · [Open the log] · the primary, last. `next`: the
   * caller's link ({ label, href }) is the primary.
   */
  const footer = (primary, withLog, next) =>
    `<div class="bz-ft">` +
    (hook.report ? btn("report") : "") +
    // A next step with no link: its words are in the body; Close leads.
    btn("close", !!next && !next.href) +
    (withLog && hook.logUrl ? btn("log") : "") +
    (next
      ? next.href
        ? `<a class="bz-btn bz-primary" href="${esc(next.href)}">${esc(next.label)}</a>`
        : ""
      : btn(primary, true)) +
    `</div>`;

  /** The caller's next step for this failure, or null (then Try again). */
  function nextStep(err) {
    let n = opts.next;
    if (typeof n === "function") {
      try {
        n = n(err);
      } catch {
        n = null;
      }
    }
    return n && n.label ? n : null;
  }

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
        progressHtml() +
        `<div class="bz-bar" role="progressbar" aria-label="${esc(word("wait", { who }))}"><i></i></div>`,
    );
  }

  /** The progress lines so far ("" with none). */
  function progressHtml() {
    if (!lines.length) return "";
    return (
      `<ol class="bz-prog" aria-label="${esc(word("progress"))}" aria-live="polite">` +
      lines.map((l) => `<li>${esc(l)}</li>`).join("") +
      `</ol>`
    );
  }

  /** run's progress(text): a new line, in the open pop-up too. */
  function progress(text) {
    if (settled || text == null || text === "") return;
    lines.push(String(text));
    if (state !== "working" || !d?.open) return;
    const ol = d.querySelector(".bz-prog");
    if (ol) {
      const li = document.createElement("li");
      li.textContent = String(text);
      ol.append(li);
    } else {
      d.querySelector(".bz-live")?.insertAdjacentHTML(
        "afterend",
        progressHtml(),
      );
    }
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
    const next = nextStep(err);
    paint(
      title("bad", actionWord(a, "failure", vars)) +
        `<p>${esc(why)}</p>` +
        (said && said !== why ? `<p class="bz-said">${esc(said)}</p>` : "") +
        (next ? `<p class="bz-next">${esc(word("next"))}</p>` : "") +
        (next && !next.href
          ? `<p class="bz-step">${esc(next.label)}</p>`
          : "") +
        `<details><summary>${esc(word("details"))}</summary><pre>${esc(detailsText(err, id, lastAt))}</pre></details>` +
        footer("retry", false, next),
      next
        ? next.href
          ? ".bz-ft a.bz-primary"
          : '[data-bz="close"]'
        : '[data-bz="retry"]',
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
    // Issue 699: the button never shows an error; before the pop-up, its
    // label comes back and the failure pop-up says it.
    if (!d?.open) hold(false);
    paintFailure(err);
  }

  function attempt() {
    // Try again: the same id only when no answer came back.
    if (answeredWithError(lastErr)) id = newId();
    lastErr = null;
    lines = [];
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
    }, openMs);
    Promise.resolve()
      .then(() => run({ [hook.idHeader]: id }, progress))
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
      // The product's adapter when it has one (its request(id)), else
      // a GET of statusUrl(id).
      if (hook.request) st = (await hook.request(id)) ?? null;
      else {
        const r = await fetch(hook.statusUrl(id), { cache: "no-store" });
        st = r.ok ? await r.json() : null;
      }
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
      const now = await askOnce(rc.url);
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
    askOnce(hook.reconnect.url).then((b) => {
      before = b;
      attempt();
    });
  else attempt();
  return result;
}

/** The kit's own action for pending(): Sending…, Sent., Not sent. */
const SEND = "send";
function sendAction(who) {
  const w = {};
  for (const l of Object.keys(BUSY_WORDS))
    w[l] = {
      working: BUSY_WORDS[l].send_working,
      success: BUSY_WORDS[l].send_success,
      failure: BUSY_WORDS[l].send_failure,
    };
  return {
    // The server, in the page's language, unless the caller names it.
    get who() {
      return who || word("server");
    },
    words: w,
  };
}

const isResponse = (r) =>
  !!r &&
  typeof r === "object" &&
  typeof r.ok === "boolean" &&
  typeof r.status === "number";

/** Issue 699: a fetch-driven button (see the top of this file). */
export function pending(button, run, opts = {}) {
  if (button?.getAttribute?.("aria-busy") === "true")
    return Promise.resolve(null);
  const { action, who, ...rest } = opts;
  let name = action;
  if (!name) {
    name = who ? `${SEND}:${who}` : SEND;
    if (!actions.has(name)) actions.set(name, sendAction(who));
  }
  return busyAction(
    name,
    async (headers, progress) => {
      let r;
      try {
        r = await run(headers, progress);
      } catch (e) {
        // fetch's own failure: no answer at all.
        throw e instanceof TypeError ? { network: true } : e;
      }
      if (isResponse(r) && !r.ok) {
        let body = null;
        try {
          body = await (r.clone ? r.clone() : r).json();
        } catch {
          body = null;
        }
        throw { status: r.status, body };
      }
      return r;
    },
    { toastFast: false, ...rest, button },
  );
}

/** Issue 699: plain POST forms' submitters (see the top of this file). */
export function watchForms(root = document) {
  const mine = new Set();
  const onSubmit = (e) => {
    const form = e.target;
    const b = e.submitter;
    if (!form || !b || e.defaultPrevented) return;
    const method = String(
      b.getAttribute?.("formmethod") ||
        form.getAttribute?.("method") ||
        form.method ||
        "",
    ).toLowerCase();
    if (method !== "post") return;
    const target = String(
      b.getAttribute?.("formtarget") || form.target || "",
    ).toLowerCase();
    if (target && target !== "_self") return;
    // A second submit while the first waits: stopped.
    if (b.getAttribute?.("aria-busy") === "true") {
      e.preventDefault?.();
      return;
    }
    if (instantReason(b)) return;
    holdButton(b, true, true, true);
    mine.add(b);
  };
  // Back from the next page (the back-forward cache): the label is back.
  const onShow = () => {
    for (const b of mine) holdButton(b, false, true);
    mine.clear();
  };
  root.addEventListener("submit", onSubmit);
  window.addEventListener("pageshow", onShow);
  return () => {
    root.removeEventListener("submit", onSubmit);
    window.removeEventListener("pageshow", onShow);
  };
}
