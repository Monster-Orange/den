import { esc, kitT } from "./strings.js";

export const PLAIN_MS = 3000;
export const UNDO_MS = 10_000;
/** A region just made or emptied waits this long for its toast, so a screen reader reads it. */
export const ANNOUNCE_MS = 50;

/** http(s) or relative, and mailto for a link; else null, so a host's javascript: or data: never runs. */
function safeHref(v, mail) {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const p = new URL(v, "http://relative.invalid/").protocol;
    return p === "http:" || p === "https:" || (mail && p === "mailto:")
      ? v
      : null;
  } catch {
    return null;
  }
}

/** "post" only: a toast's Undo form never changes state with a GET. */
function formMethod(m) {
  const v = m == null ? "post" : String(m).trim().toLowerCase();
  if (v !== "post")
    throw new TypeError(
      `den-ui toast: an Undo form's method is "post" (got ${JSON.stringify(m)})`,
    );
  return v;
}

function pageLang(lang) {
  if (lang) return lang;
  try {
    return document.documentElement.lang || "en";
  } catch {
    return "en";
  }
}

function untilOf(v) {
  if (v == null || v === "") return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : null;
}

function bodyHtml(o) {
  const lang = pageLang(o.lang);
  const error = o.kind === "error";
  let acts = "";
  if (o.undo && typeof o.undo === "object" && o.undo.form) {
    const f = o.undo.form;
    const method = formMethod(f.method);
    const action = safeHref(f.action, false);
    if (!action)
      throw new TypeError(
        `den-ui toast: an Undo form's action is http(s) or relative (got ${JSON.stringify(f.action)})`,
      );
    acts +=
      '<form class="den-toast-form" method="' +
      method +
      '" action="' +
      esc(action) +
      '">' +
      Object.entries(f.fields || {})
        .map(
          ([k, v]) =>
            '<input type="hidden" name="' +
            esc(k) +
            '" value="' +
            esc(v) +
            '">',
        )
        .join("") +
      '<button type="submit" class="den-toast-undo" data-toast-undo>' +
      esc(kitT(lang, "kit.toast.undo")) +
      "</button></form>";
  } else if (o.undo) {
    acts +=
      '<button type="button" class="den-toast-undo" data-toast-undo>' +
      esc(kitT(lang, "kit.toast.undo")) +
      "</button>";
  }
  (o.actions || []).forEach((a, i) => {
    acts +=
      '<button type="button" class="den-toast-act" data-toast-act="' +
      i +
      '">' +
      esc(a.label) +
      "</button>";
  });
  const href = o.link && safeHref(o.link.href, true);
  if (href)
    acts +=
      '<a class="den-toast-link" data-toast-link href="' +
      esc(href) +
      '">' +
      esc(o.link.label) +
      "</a>";
  const close = error
    ? '<button type="button" class="den-toast-close" data-toast-close aria-label="' +
      esc(kitT(lang, "kit.toast.close")) +
      '"><span aria-hidden="true">×</span></button>'
    : "";
  return (
    '<div class="den-toast" data-kind="' +
    (error ? "error" : "status") +
    '"' +
    (untilOf(o.until) != null ? ' data-until="' + untilOf(o.until) + '"' : "") +
    ">" +
    (error
      ? '<span class="den-toast-ic" data-toast-ic aria-hidden="true">⚠</span>'
      : "") +
    '<span class="den-toast-words" data-toast-words><span class="den-toast-msg" data-toast-msg>' +
    esc(o.message) +
    "</span>" +
    (o.detail
      ? '<span class="den-toast-detail" data-toast-detail>' +
        esc(o.detail) +
        "</span>"
      : "") +
    "</span>" +
    (acts
      ? '<span class="den-toast-acts" data-toast-acts>' + acts + "</span>"
      : "") +
    close +
    "</div>"
  );
}

const REGION = {
  status: ' role="status" aria-live="polite"',
  alert: ' role="alert" aria-live="assertive"',
};

export function toastHtml(o = {}) {
  const k = o.kind === "error" ? "alert" : "status";
  return (
    '<div class="den-toast-region" data-den-toast="' +
    k +
    '"' +
    REGION[k] +
    (o.ms ? ' data-ttl="' + esc(String(Number(o.ms) || "")) + '"' : "") +
    ">" +
    bodyHtml(o) +
    "</div>"
  );
}

export function toastClock({
  kind = "status",
  ms,
  undo = false,
  onExpire,
  set = setTimeout,
  clear = clearTimeout,
} = {}) {
  const held = new Set();
  let timer = null;
  let stopped = false;
  const error = kind === "error";
  const arm = (t) => {
    if (timer != null) clear(timer);
    timer = null;
    if (stopped || error || held.size) return;
    timer = set(() => {
      timer = null;
      if (!stopped) {
        stopped = true;
        onExpire && onExpire();
      }
    }, t);
  };
  return {
    start: () => arm(ms != null ? Number(ms) : undo ? UNDO_MS : PLAIN_MS),
    hold(why) {
      held.add(why);
      if (timer != null) clear(timer);
      timer = null;
    },
    release(why) {
      if (!held.delete(why) || held.size) return;
      arm(PLAIN_MS);
    },
    undone: () => arm(PLAIN_MS),
    stop() {
      stopped = true;
      if (timer != null) clear(timer);
      timer = null;
    },
    held: () => [...held],
    running: () => timer != null,
  };
}

function region(doc, k) {
  const sel =
    k === "status"
      ? '[data-den-toast="status"], #art-toast'
      : '[data-den-toast="alert"]';
  let r = doc.querySelector(sel);
  if (!r) {
    r = doc.createElement("div");
    r.className = "den-toast-region";
    r.setAttribute("data-den-toast", k);
    r.setAttribute("role", k === "status" ? "status" : "alert");
    r.setAttribute("aria-live", k === "status" ? "polite" : "assertive");
    doc.body.appendChild(r);
    return { r, fresh: true };
  }
  if (!r.classList.contains("den-toast-region"))
    r.classList.add("den-toast-region");
  return { r, fresh: false };
}

export function ensureToastRegions(doc = document) {
  if (!doc || !doc.body) return;
  region(doc, "status");
  region(doc, "alert");
}

function addLater(doc, reg, el, h) {
  (doc.defaultView || window).setTimeout(() => {
    if (!h.closed()) reg.appendChild(el);
  }, ANNOUNCE_MS);
}

function giveBack(doc, before) {
  if (before && before.isConnected && typeof before.focus === "function") {
    before.focus();
    if (doc.activeElement === before) return;
  }
  const main = doc.querySelector("main, [role=main]");
  if (main) {
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    main.focus();
  }
}

let current = null;

function wire(doc, reg, el, o) {
  const win = doc.defaultView || window;
  const lang = pageLang(o.lang);
  let before = null;
  let closed = false;
  const hasUndo = !!el.querySelector("[data-toast-undo]");
  const clock = toastClock({
    kind: o.kind,
    ms: o.ms,
    undo: hasUndo,
    onExpire: () => close(),
    set: (f, t) => win.setTimeout(f, t),
    clear: (t) => win.clearTimeout(t),
  });
  const inside = () => el.contains(doc.activeElement);
  // until closes it held or not, so an Undo never outlives the server's window.
  const until = untilOf(o.until);
  const deadline =
    until == null
      ? null
      : win.setTimeout(() => close(), Math.max(0, until - Date.now()));
  function close() {
    if (closed) return;
    closed = true;
    clock.stop();
    if (deadline != null) win.clearTimeout(deadline);
    const had = inside();
    el.remove();
    doc.removeEventListener("visibilitychange", onVis);
    if (current && current.el === el) current = null;
    if (had) giveBack(doc, before);
  }
  const onVis = () =>
    doc.visibilityState === "hidden"
      ? clock.hold("hidden")
      : clock.release("hidden");
  el.addEventListener("mouseenter", () => clock.hold("hover"));
  el.addEventListener("mouseleave", () => clock.release("hover"));
  el.addEventListener("focusin", (e) => {
    if (!before && e.relatedTarget && !el.contains(e.relatedTarget))
      before = e.relatedTarget;
    clock.hold("focus");
  });
  el.addEventListener("focusout", (e) => {
    if (!e.relatedTarget || !el.contains(e.relatedTarget))
      clock.release("focus");
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inside()) {
      e.preventDefault();
      close();
    }
  });
  el.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("button, a");
    if (!t || !el.contains(t)) return;
    if (t.hasAttribute("data-toast-close")) return close();
    if (t.hasAttribute("data-toast-act")) {
      const a = (o.actions || [])[Number(t.getAttribute("data-toast-act"))];
      const w = a && a.onClick ? a.onClick() : null;
      if (typeof w === "string") t.textContent = w;
      return;
    }
    if (t.hasAttribute("data-toast-undo") && t.type !== "submit") {
      const run = o.onUndo;
      if (!run) return;
      o.onUndo = null;
      const had = inside();
      const acts = el.querySelector(".den-toast-acts");
      if (acts) acts.remove();
      el.querySelector(".den-toast-msg").textContent = kitT(
        lang,
        "kit.toast.undone",
      );
      const d = el.querySelector(".den-toast-detail");
      if (d) d.remove();
      if (had) giveBack(doc, before);
      clock.release("focus");
      clock.undone();
      run();
    }
  });
  doc.addEventListener("visibilitychange", onVis);
  if (doc.visibilityState === "hidden") clock.hold("hidden");
  clock.start();
  return { el, close, clock, reg, closed: () => closed };
}

export function showToast(o = {}, doc = document) {
  const until = untilOf(o.until);
  if (until != null && until <= Date.now()) return { close() {} };
  if (current) current.close();
  const error = o.kind === "error";
  const { r: reg, fresh } = region(doc, error ? "alert" : "status");
  const opts = { ...o, undo: o.onUndo ? true : undefined };
  const tmp = doc.createElement("div");
  tmp.innerHTML = bodyHtml(opts);
  const el = tmp.firstElementChild;
  if (!fresh) reg.appendChild(el);
  current = wire(doc, reg, el, opts);
  if (fresh) addLater(doc, reg, el, current);
  return { close: current.close };
}

export function hydrateToast(doc = document, o = {}) {
  const reg = doc.querySelector(
    '[data-den-toast="status"], [data-den-toast="alert"], #art-toast',
  );
  const el = reg && reg.querySelector(".den-toast");
  if (!el) return null;
  if (current) current.close();
  const ttl = Number(reg.getAttribute("data-ttl")) || undefined;
  const kind = el.getAttribute("data-kind") === "error" ? "error" : "status";
  el.remove();
  const opts = {
    ...o,
    kind,
    ms: o.ms ?? ttl,
    until: o.until ?? el.getAttribute("data-until"),
  };
  current = wire(doc, reg, el, opts);
  addLater(doc, reg, el, current);
  return { close: current.close };
}
