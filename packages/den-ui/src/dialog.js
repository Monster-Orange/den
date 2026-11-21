/**
 * The kit's ask-and-tell dialogs: askConfirm, askText and tell, in place of
 * the browser's confirm(), prompt() and alert(), which speak only the
 * browser's language and carry no Report. Framework-free; the product
 * plugs in its language, its words and its Report:
 *
 *   configureDialog({
 *     lang: () => "en",            the page's language (en, es, ja)
 *     words: { en: {...}, ... },   extra or replaced shared words (ok, cancel)
 *     report: () => html,          the Report button's HTML for the footer
 *                                  ("" or null: none)
 *     css: "/kit/dialog.css",      where dialog.css is, for a page that
 *                                  doesn't link it (default: beside
 *                                  another kit stylesheet on the page)
 *   })
 *
 *   askConfirm(opts) → Promise<boolean>      OK true; Cancel or Esc false
 *   askText(opts)    → Promise<string|null>  the text; Cancel or Esc null
 *   tell(opts)       → Promise<void>         resolves when it closes
 *
 *   opts.title        the heading (the dialog's name)
 *   opts.message      the body; line breaks show as written
 *   opts.okLabel      OK's word (default: the kit's "OK")
 *   opts.cancelLabel  Cancel's word (default: the kit's "Cancel")
 *   opts.danger       OK destroys something: styled as danger, and focus
 *                     starts on Cancel, the safe answer
 *   opts.value        askText: the field's first text (selected)
 *   opts.label        askText: the field's own name (default: the title)
 *
 * askConfirm and tell are role="alertdialog"; askText is role="dialog".
 * Each is named by its title (aria-labelledby) and described by its
 * message (aria-describedby). Focus moves in (Cancel for danger, the
 * field for askText, else OK) and goes back to what opened it on close
 * (opts.opener, else the focused element or the control just pressed).
 * Enter in askText's field is OK.
 *
 * Issues 669, 670: all three are drawn by the kit's one dialog frame,
 * which a product also uses for its own Yes/No questions and large
 * dialogs, in a browser or on a server:
 *
 *   dialogHtml({ kind: "confirm" | "panel", ... })  the whole <dialog>,
 *                                     working with no script (pure)
 *   mountDialog(htmlOrDialog, opts)  the browser half: modal, focus kept
 *                                     inside, Esc, focus back, Report
 *
 * One look (dialog.css): the theme's radius, backdrop and font.
 */

// Focus goes back to what opened a pop-up (here, Report, What's new). The
// browser's own dialog restore isn't enough: Safari doesn't focus a button
// on a click, so the element "focused before" a dialog opened from a click
// is the body. openerOf(hint) at open: the hint, else the focused element,
// else the control just pressed. focusBack(el) at close: focus it again,
// without scrolling, if it is still on the page and can take focus. Kept
// here, not in a file of its own: hosts that serve a list of kit files
// already serve this one.

const FOCUSABLE =
  'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

/** A press counts as the opener for this long (ms). */
const PRESS_MS = 1500;

let pressed = null;
let pressedAt = 0;

function focusable(el) {
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  if (typeof document !== "undefined" && el === document.body) return false;
  if (el.disabled) return false;
  return !!el.matches?.(FOCUSABLE);
}

const controlOf = (t) =>
  t && t.nodeType === 1 && t.closest ? t.closest(FOCUSABLE) : null;

// The control a pointer or key just pressed, seen before any page handler.
if (typeof document !== "undefined" && document.addEventListener) {
  const note = (e) => {
    const c = controlOf(e.target);
    if (!c) return;
    pressed = c;
    pressedAt = Date.now();
  };
  for (const type of ["pointerdown", "mousedown", "click", "keydown"])
    document.addEventListener(type, note, true);
}

/** What opened the pop-up: `hint`, the focused element, or the press. */
export function openerOf(hint) {
  if (focusable(hint)) return hint;
  const h = controlOf(hint);
  if (focusable(h)) return h;
  const at = typeof document !== "undefined" ? document.activeElement : null;
  if (focusable(at)) return at;
  const ev = typeof window !== "undefined" ? window.event : null;
  const t = controlOf(ev?.target);
  if (focusable(t)) return t;
  if (focusable(pressed) && Date.now() - pressedAt < PRESS_MS) return pressed;
  return null;
}

/**
 * Issue 793: a page's own focus while a kit pop-up is open (a field that
 * came in under it). The page behind a modal can't take focus, so the
 * field is kept here and gets it when the pop-up closes, in place of
 * what opened the pop-up. With no pop-up open it is focused at once.
 */
let wanted = null;
export function focusWhenFree(el) {
  if (!el) return;
  const modal =
    typeof document !== "undefined" &&
    [...document.querySelectorAll("dialog.dk-dlg[open]")].find(
      (d) => d.matches(":modal") && !d.contains(el),
    );
  if (modal) wanted = el;
  else el.focus?.();
}

/** Focus `el` again (no scroll), when it is still there and focusable. */
export function focusBack(el) {
  if (!focusable(el)) return false;
  try {
    el.focus({ preventScroll: true });
  } catch {
    return false;
  }
  return document.activeElement === el;
}

export const DIALOG_WORDS = {
  en: { ok: "OK", cancel: "Cancel", close: "Close" },
  es: { ok: "Aceptar", cancel: "Cancelar", close: "Cerrar" },
  ja: { ok: "OK", cancel: "キャンセル", close: "閉じる" },
};

const hook = {
  lang: () =>
    (typeof document !== "undefined" &&
      document.documentElement.lang?.slice(0, 2)) ||
    "en",
  words: {},
  report: null,
  css: null,
};

/** The product's language, words and Report (see the top of this file). */
export function configureDialog(h) {
  Object.assign(hook, h ?? {});
}

/** A shared word, in the page's language, with the product's own on top. */
export function dialogWord(key) {
  const l = hook.lang();
  return (
    hook.words?.[l]?.[key] ??
    DIALOG_WORDS[l]?.[key] ??
    hook.words?.en?.[key] ??
    DIALOG_WORDS.en[key] ??
    key
  );
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/**
 * The look is dialog.css: linked, never injected, so a page under
 * style-src 'self' takes it. A page that links it (in its <head>) keeps
 * its own link. Else it is linked from configureDialog({ css }), or from
 * the folder of another kit stylesheet on the page (tokens.css, say).
 */
const KIT_SHEET = /(^|\/)(tokens|base|fonts|busy|shell|update-pill)\.css$/;
function ensureCss() {
  if (document.getElementById("dk-css")) return;
  let near = null;
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
    const u = new URL(l.href, location.href);
    if (/(^|\/)dialog\.css$/.test(u.pathname)) return;
    if (!near && KIT_SHEET.test(u.pathname)) near = u;
  }
  const href =
    hook.css ||
    (near ? new URL("dialog.css", near).href.replace(/\?.*$/, "") : null);
  if (!href) return;
  const l = document.createElement("link");
  l.id = "dk-css";
  l.rel = "stylesheet";
  l.href = href;
  document.head.append(l);
}

let seq = 0;

const NAME = /^[A-Za-z_:][-\w:.]*$/;

/** Extra attributes: true is a bare attribute; false and null are none. */
function attrsOf(o) {
  let s = "";
  for (const [k, v] of Object.entries(o ?? {})) {
    if (!NAME.test(k) || v === false || v == null) continue;
    s += v === true ? ` ${k}` : ` ${k}="${esc(v)}"`;
  }
  return s;
}

/**
 * One action: a link (href), else a button. A submit (the default) closes
 * a method=dialog form with its value as the answer, with no script. A
 * plain one (no kind) never validates the form: it is a way out.
 */
function actionHtml(a) {
  const cls =
    "dk-btn" +
    (a.kind === "primary"
      ? " dk-primary"
      : a.kind === "danger"
        ? " dk-danger"
        : "") +
    (a.className ? ` ${a.className}` : "");
  if (a.href != null)
    return `<a class="${esc(cls)}" href="${esc(a.href)}"${attrsOf(a.attrs)}>${esc(a.label)}</a>`;
  const type = a.type === "button" ? "button" : "submit";
  const v = a.value == null ? "" : String(a.value);
  return (
    `<button type="${type}" class="${esc(cls)}"` +
    (v ? ` value="${esc(v)}" data-dk="${esc(v)}"` : "") +
    (type === "submit" && !a.kind ? " formnovalidate" : "") +
    attrsOf(a.attrs) +
    `>${esc(a.label)}</button>`
  );
}

const actionsHtml = (list) => (list ?? []).map(actionHtml).join("");

/** The ids a frame names its parts by: the product's, else from its id. */
function idsOf(spec) {
  const id = spec.id || "dk-dlg";
  return {
    id,
    h: spec.ids?.h ?? `${id}-h`,
    m: spec.ids?.m ?? `${id}-m`,
    body: spec.ids?.body ?? `${id}-body`,
    sub: spec.ids?.sub ?? `${id}-sub`,
  };
}

/** Inside a confirm: one method=dialog form, its heading, body, footer. */
function confirmInner(spec, ids) {
  return (
    `<form class="dk-b" method="dialog">` +
    (spec.title
      ? `<h2 id="${esc(ids.h)}" tabindex="-1">${esc(spec.title)}</h2>`
      : "") +
    (spec.body
      ? `<div class="dk-msg" id="${esc(ids.m)}">${spec.body}</div>`
      : "") +
    (spec.extra ?? "") +
    `<div class="dk-ft">${spec.report ?? ""}${actionsHtml(spec.actions)}</div>` +
    `</form>`
  );
}

/** Inside a large dialog: header (heading, close), body, footer. */
function panelInner(spec, ids) {
  const close = spec.closeLabel ?? dialogWord("close");
  const foot =
    spec.actions?.length || spec.report
      ? `<form class="dk-ft" method="dialog">${spec.report ?? ""}${actionsHtml(spec.actions)}</form>`
      : "";
  return (
    `<div class="dk-hd"><h2 id="${esc(ids.h)}" tabindex="-1">${esc(spec.title ?? "")}</h2>` +
    (spec.subtitle != null
      ? `<span class="dk-sub" id="${esc(ids.sub)}">${esc(spec.subtitle)}</span>`
      : "") +
    `<span class="dk-acts">${actionsHtml(spec.headActions)}` +
    `<form class="dk-x-f" method="dialog"><button type="submit" class="dk-btn dk-x" value="close" data-dk="close"${attrsOf(spec.closeAttrs)}>${esc(close)}</button></form>` +
    `</span></div>` +
    `<div class="dk-body" id="${esc(ids.body)}"${attrsOf(spec.bodyAttrs)}>${spec.body ?? ""}</div>` +
    (spec.foot ?? "") +
    foot
  );
}

/**
 * Issues 669, 670: the kit's one dialog frame, for every product. A pure
 * function, the same in a browser and on a server: the whole <dialog>,
 * working with no script (its actions submit method=dialog forms, so the
 * dialog closes with the action's value as its returnValue; Esc closes it
 * too). mountDialog adds the rest in a browser. See dialog.d.ts.
 *
 *   kind "confirm"  a Yes/No question: heading, body, actions in the footer
 *   kind "panel"    a large dialog: heading (and subtitle), the header's
 *                   own actions and Close, a body that scrolls, a footer;
 *                   with sheet: true, a full-screen sheet on a phone (no
 *                   radius, nothing dimmed behind it)
 *
 * title and labels are text (escaped); body, extra and foot are HTML the
 * caller has escaped. Called with a kind string first (kind, opts, ids),
 * it is the 0.9 form: the inside of askConfirm, askText or tell's dialog.
 */
export function dialogHtml(spec, opts, askIds) {
  if (typeof spec === "string") {
    const s = askSpec(spec, opts, "dk");
    s.ids = { h: askIds?.h, m: askIds?.m };
    s.report = (typeof hook.report === "function" && hook.report()) || "";
    return confirmInner(s, idsOf(s));
  }
  const s = spec ?? {};
  const kind = s.kind === "panel" ? "panel" : "confirm";
  const ids = idsOf(s);
  const role = s.role ?? (kind === "panel" ? "dialog" : "alertdialog");
  let named = "";
  if (kind === "panel" || s.title) named = ` aria-labelledby="${esc(ids.h)}"`;
  else if (s.label) named = ` aria-label="${esc(s.label)}"`;
  else if (s.body) named = ` aria-labelledby="${esc(ids.m)}"`;
  const described =
    kind === "confirm" && s.title && s.body
      ? ` aria-describedby="${esc(ids.m)}"`
      : "";
  return (
    `<dialog id="${esc(ids.id)}" class="dk-dlg dk-${kind}${kind === "panel" && s.sheet ? " dk-sheet" : ""}${s.className ? ` ${esc(s.className)}` : ""}"` +
    ` data-dk-kind="${esc(s.dataKind ?? kind)}" role="${esc(role)}"${named}${described}` +
    attrsOf(s.attrs) +
    (s.report ? " data-dk-report" : "") +
    (s.open ? " open" : "") +
    `>` +
    (kind === "panel" ? panelInner(s, ids) : confirmInner(s, ids)) +
    `</dialog>`
  );
}

/**
 * askConfirm, askText and tell's options as a frame (a confirm): Cancel
 * (not for tell), then OK, as the kit's words; the message as text, line
 * breaks kept; askText's field after it.
 */
export function askSpec(kind, opts, id) {
  const o = opts ?? {};
  const actions = [];
  if (kind !== "tell")
    actions.push({
      label: o.cancelLabel ?? dialogWord("cancel"),
      value: "cancel",
    });
  actions.push({
    label: o.okLabel ?? dialogWord("ok"),
    value: "ok",
    kind: o.danger ? "danger" : "primary",
  });
  return {
    kind: "confirm",
    dataKind: kind,
    role: kind === "text" ? "dialog" : "alertdialog",
    id,
    title: o.title ?? "",
    body: o.message ? `<p class="dk-text">${esc(o.message)}</p>` : "",
    extra:
      kind === "text"
        ? `<input class="dk-in" type="text" data-dk="field" autocomplete="off" spellcheck="false" aria-label="${esc(o.label ?? o.title ?? "")}" value="${esc(o.value ?? "")}">`
        : "",
    actions,
  };
}

/** Where focus starts: Cancel for danger, the field for text, else OK. */
export function firstFocus(kind, opts) {
  if (kind === "text") return "field";
  if (kind === "confirm" && opts?.danger) return "cancel";
  return "ok";
}

/** What a closed dialog answers: OK's answer, else Cancel's (Esc too). */
export function answerOf(kind, ok, text) {
  if (kind === "confirm") return ok;
  if (kind === "text") return ok ? String(text ?? "") : null;
  return undefined;
}

/** The product's Report, first in the footer (a footer of its own if none). */
function addReport(d) {
  if (d.hasAttribute("data-dk-report")) return;
  const html = (typeof hook.report === "function" && hook.report()) || "";
  if (!html) return;
  d.setAttribute("data-dk-report", "");
  const foot = [...d.querySelectorAll(".dk-ft")].pop();
  if (foot) foot.insertAdjacentHTML("afterbegin", html);
  else d.insertAdjacentHTML("beforeend", `<div class="dk-ft">${html}</div>`);
}

const shownIn = (d) =>
  [...d.querySelectorAll(FOCUSABLE)].filter(
    (el) =>
      !el.disabled &&
      el.tabIndex >= 0 &&
      !el.closest("[hidden]") &&
      (el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  );

/** Where focus starts in a frame (see mountDialog). */
function startOf(d, sel) {
  if (sel) return d.querySelector(sel);
  const auto = d.querySelector("[autofocus]");
  if (auto) return auto;
  if (d.classList.contains("dk-panel")) return d.querySelector(".dk-hd h2");
  const field = d.querySelector('[data-dk="field"]');
  if (field) return field;
  if (d.querySelector(".dk-ft .dk-danger"))
    return d.querySelector(".dk-ft .dk-btn:not(.dk-danger):not(.dk-primary)");
  return (
    d.querySelector(".dk-ft .dk-primary") || d.querySelector(".dk-ft .dk-btn")
  );
}

/**
 * The browser half of the frame: it shows a dialog from dialogHtml (its
 * HTML, or the element) as a modal and adds focus kept inside (Tab and
 * Shift+Tab go round), Esc as "cancel", Enter in a field as the main
 * action, focus back to what opened it, and the product's Report first in
 * the footer (configureDialog's report).
 *
 *   mountDialog(htmlOrDialog, {
 *     opener,      focus goes back here (default: what opened it)
 *     focus,       a selector to focus first (default: [autofocus]; the
 *                  heading of a panel; the field; the safe answer next to
 *                  a danger action; else the main action)
 *     onClose,     (value, dialog) when it closes: the action's value,
 *                  "cancel" for Esc, "close" for Close
 *     remove,      take it off the page once closed (default: true for
 *                  HTML, false for an element)
 *     show,        false: mount only; show() later
 *   }) → { dialog, show(opener?), close(value?), closed }
 *
 * `closed` is a promise of the value, renewed on each show().
 */
export function mountDialog(target, o = {}) {
  ensureCss();
  let d = target;
  const fromHtml = typeof target === "string";
  if (fromHtml) {
    const tpl = document.createElement("template");
    tpl.innerHTML = target.trim();
    d = tpl.content.firstElementChild;
    if (d.id) document.getElementById(d.id)?.remove();
  }
  if (!d.isConnected) document.body.append(d);
  d.setAttribute("aria-modal", "true");
  const remove = o.remove ?? fromHtml;
  let opener = null;
  let settle = null;
  let gone = false;
  let shown = false;
  const handle = { dialog: d, show, close, closed: Promise.resolve("") };

  function close(value = "cancel") {
    if (gone) return;
    if (d.open && typeof d.close === "function") d.close(value);
    else {
      d.removeAttribute("open");
      d.returnValue = value;
      d.dispatchEvent(new Event("close"));
    }
  }

  function show(from) {
    if (gone) return handle;
    addReport(d);
    if (!d.open) {
      opener = openerOf(from ?? o.opener);
      d.returnValue = "";
      handle.closed = new Promise((r) => (settle = r));
      shown = true;
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
      // A modal the page's own style hides would leave the page dead
      // under nothing to see: it closes at once, and the keyboard stays
      // where it was.
      if (getComputedStyle(d).display === "none") {
        opener = null;
        close("cancel");
        return handle;
      }
    }
    const first = startOf(d, o.focus);
    first?.focus?.();
    if (first?.matches?.('[data-dk="field"]')) first.select?.();
    return handle;
  }

  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    close("cancel");
  });
  d.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close("cancel");
      return;
    }
    if (e.key === "Tab") {
      const all = shownIn(d);
      if (!all.length) return;
      const at = document.activeElement;
      const first = all[0];
      const last = all[all.length - 1];
      // Anything not a stop (a focused heading, say) counts as outside:
      // Shift+Tab from it goes round to the last stop, never out.
      const inside = all.includes(at);
      if (e.shiftKey && (at === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    // Enter in a field is the main action, never the first button (Cancel).
    const t = e.target;
    if (
      e.key === "Enter" &&
      t?.matches?.("input:not([type=checkbox]):not([type=radio])")
    ) {
      const main = t.form?.querySelector(".dk-primary, .dk-danger");
      if (main) {
        e.preventDefault();
        main.click();
      }
    }
  });
  // Issue 793: what a close does runs once per showing, as soon as the
  // dialog is closed (its open attribute goes, seen in a microtask), not
  // only at the close event, which the browser fires a task later: so a
  // pop-up's state and focus are right the moment it is shut.
  const finish = () => {
    if (!shown || d.open) return;
    shown = false;
    const value = d.returnValue || "cancel";
    o.onClose?.(value, d);
    const s = settle;
    settle = null;
    s?.(value);
    // The page's own field, if one wanted the keyboard meanwhile (issue
    // 793), else what opened it.
    const w = wanted;
    wanted = null;
    if (!(w && focusBack(w))) focusBack(opener);
    opener = null;
    if (remove) {
      gone = true;
      watch?.disconnect();
      d.remove();
    }
  };
  d.addEventListener("close", finish);
  const watch =
    typeof MutationObserver === "function"
      ? new MutationObserver(finish)
      : null;
  watch?.observe(d, { attributes: true, attributeFilter: ["open"] });
  if (o.show !== false) show();
  return handle;
}

/** askConfirm, askText and tell, on the frame. */
function open(kind, opts = {}) {
  const id = `dk-q-${++seq}`;
  let text = "";
  const h = mountDialog(dialogHtml(askSpec(kind, opts, id)), {
    opener: opts.opener,
    focus: `[data-dk="${firstFocus(kind, opts)}"]`,
    onClose: (v, d) => {
      text = d.querySelector('[data-dk="field"]')?.value ?? "";
    },
    show: false,
  });
  h.show(opts.opener);
  return h.closed.then((v) => answerOf(kind, v === "ok", text));
}

/** In place of confirm(): true on OK; false on Cancel or Esc. */
export function askConfirm(opts) {
  return open("confirm", opts);
}

/** In place of prompt(): the text on OK (Enter too); null on Cancel or Esc. */
export function askText(opts) {
  return open("text", opts);
}

/** In place of alert(): resolves once it is closed (OK or Esc). */
export function tell(opts) {
  return open("tell", opts);
}
