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

/** Tokens only (UK-1): no colour of its own. */
const CSS = `
.dk-dlg{font-family:var(--sans);position:fixed;inset-block:auto;inset-inline:0;top:50%;transform:translateY(-50%);margin:0 auto;height:auto;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow:auto;width:min(440px,calc(100vw - 32px));max-width:100%;padding:0;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--surface);color:var(--text);box-shadow:var(--shadow-dialog);box-sizing:border-box}
.dk-dlg::backdrop{background:color-mix(in srgb,var(--sunken) 70%,transparent)}
.dk-b{padding:var(--space-4) calc(var(--space-4) + 2px);display:grid;gap:10px;margin:0}
.dk-b h2{font-size:var(--fs-l);margin:0;overflow-wrap:anywhere}
.dk-msg{margin:0;font-size:var(--fs-s);line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;max-height:50dvh;overflow:auto}
.dk-in{font:inherit;font-size:var(--fs-s);min-height:var(--tap-min);padding:0 var(--space-2);border:1px solid var(--border-strong);border-radius:var(--radius-button);background:var(--bg);color:var(--text);width:100%;box-sizing:border-box}
.dk-in:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.dk-ft{display:flex;flex-wrap:wrap;gap:var(--space-2);justify-content:flex-end;align-items:center}
.dk-ft > :first-child:not(.dk-btn){margin-right:auto}
.dk-btn{font:inherit;font-size:var(--fs-s);min-height:var(--tap-min);padding:0 var(--space-3);border-radius:var(--radius-button);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);cursor:pointer}
.dk-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dk-btn.dk-primary{background:var(--accent-fill);border-color:var(--accent-fill);color:var(--on-accent)}
.dk-btn.dk-danger{background:var(--bad);border-color:var(--bad);color:var(--on-accent)}
@media (max-width:480px){.dk-btn{min-height:var(--tap)}}
`;

function ensureCss() {
  if (document.getElementById("dk-css")) return;
  const s = document.createElement("style");
  s.id = "dk-css";
  s.textContent = CSS;
  document.head.append(s);
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
