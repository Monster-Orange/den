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
 * field for askText, else OK) and goes back to what had it on close.
 * Enter in askText's field is OK.
 */

export const DIALOG_WORDS = {
  en: { ok: "OK", cancel: "Cancel" },
  es: { ok: "Aceptar", cancel: "Cancelar" },
  ja: { ok: "OK", cancel: "キャンセル" },
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

/** The dialog's markup, for one kind: confirm, text or tell. */
export function dialogHtml(kind, opts, ids) {
  const o = opts ?? {};
  const okCls = o.danger ? "dk-danger" : "dk-primary";
  const report = (typeof hook.report === "function" && hook.report()) || "";
  const title = o.title ?? "";
  const message = o.message ?? "";
  return (
    `<form class="dk-b" method="dialog">` +
    (title ? `<h2 id="${ids.h}">${esc(title)}</h2>` : "") +
    (message ? `<p class="dk-msg" id="${ids.m}">${esc(message)}</p>` : "") +
    (kind === "text"
      ? `<input class="dk-in" type="text" data-dk="field" autocomplete="off" spellcheck="false" aria-label="${esc(o.label ?? title)}" value="${esc(o.value ?? "")}">`
      : "") +
    `<div class="dk-ft">${report}` +
    (kind === "tell"
      ? ""
      : `<button type="button" class="dk-btn" data-dk="cancel">${esc(o.cancelLabel ?? dialogWord("cancel"))}</button>`) +
    `<button type="submit" class="dk-btn ${okCls}" data-dk="ok">${esc(o.okLabel ?? dialogWord("ok"))}</button>` +
    `</div></form>`
  );
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

function open(kind, opts = {}) {
  ensureCss();
  const n = ++seq;
  const ids = { h: `dk-h-${n}`, m: `dk-m-${n}` };
  const opener = document.activeElement;
  const d = document.createElement("dialog");
  d.className = "dk-dlg";
  d.dataset.dkKind = kind;
  d.setAttribute("role", kind === "text" ? "dialog" : "alertdialog");
  d.setAttribute("aria-modal", "true");
  d.innerHTML = dialogHtml(kind, opts, ids);
  if (d.querySelector(`#${ids.h}`)) d.setAttribute("aria-labelledby", ids.h);
  else if (d.querySelector(`#${ids.m}`))
    d.setAttribute("aria-labelledby", ids.m);
  if (opts.title && d.querySelector(`#${ids.m}`))
    d.setAttribute("aria-describedby", ids.m);
  document.body.append(d);

  return new Promise((resolve) => {
    let done = false;
    const field = d.querySelector('[data-dk="field"]');
    const finish = (ok) => {
      if (done) return;
      done = true;
      const answer = answerOf(kind, ok, field?.value);
      if (d.open) d.close();
      d.remove();
      try {
        if (opener && opener.isConnected && opener !== document.body)
          opener.focus?.();
      } catch {
        /* nothing to go back to */
      }
      resolve(answer);
    };
    // Esc is Cancel (for tell, it closes). Handled on the dialog's own
    // keydown too: a page that takes Esc first (or a browser that closes
    // without a cancel event) must never leave it open or unanswered.
    d.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(kind === "tell");
    });
    d.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      finish(kind === "tell");
    });
    d.addEventListener("close", () => finish(kind === "tell"));
    d.querySelector('[data-dk="cancel"]')?.addEventListener("click", () =>
      finish(false),
    );
    d.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      finish(true);
    });
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
    const first = d.querySelector(`[data-dk="${firstFocus(kind, opts)}"]`);
    first?.focus();
    if (first === field) field.select?.();
  });
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
