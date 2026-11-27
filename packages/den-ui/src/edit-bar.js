import { esc } from "./strings.js";
import { askConfirm } from "./dialog.js";
import { holdDots } from "./busy.js";

export const EDIT_BAR_WORDS = {
  en: {
    unsaved: "Unsaved changes",
    notePh: "What changed (optional)",
    cancel: "Cancel",
    saveAs: "Save as v{n}",
    errEmpty: "The doc is empty. Write something, or Cancel.",
    leaveTitle: "Leave without saving?",
    leaveBody: "Your changes will be lost.",
    keep: "Keep editing",
    leave: "Leave",
    notSaved: "Not saved. Hub didn't answer. Your text is safe here.",
    still: "Still working ({s} s). You can leave this open.",
  },
  es: {
    unsaved: "Cambios sin guardar",
    notePh: "Qué cambió (opcional)",
    cancel: "Cancelar",
    saveAs: "Guardar como v{n}",
    errEmpty: "El documento está vacío. Escribe algo o pulsa Cancelar.",
    leaveTitle: "¿Salir sin guardar?",
    leaveBody: "Se perderán tus cambios.",
    keep: "Seguir editando",
    leave: "Salir",
    notSaved: "No se guardó. Hub no respondió. Tu texto sigue aquí.",
    still: "Sigue en curso ({s} s). Puedes dejarlo abierto.",
  },
  ja: {
    unsaved: "未保存の変更",
    notePh: "変更内容（任意）",
    cancel: "キャンセル",
    saveAs: "v{n} として保存",
    errEmpty: "ドキュメントが空です。何か書くか、キャンセルしてください。",
    leaveTitle: "保存せずに移動しますか？",
    leaveBody: "変更内容は失われます。",
    keep: "編集を続ける",
    leave: "移動する",
    notSaved:
      "保存されませんでした。Hub から応答がありません。テキストはこのまま残っています。",
    still: "処理中です（{s} 秒）。このまま開いておけます。",
  },
};
const STILL_AFTER_MS = 5000;

const wordsOf = (lang, words) => ({
  ...EDIT_BAR_WORDS.en,
  ...(EDIT_BAR_WORDS[lang] ?? {}),
  ...(words ?? {}),
});
const fill = (s, v) =>
  String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));

export function editBarHtml(o = {}) {
  const w = wordsOf(o.lang, o.words);
  const formA = o.form ? ` form="${esc(o.form)}"` : "";
  const note = o.note
    ? `<textarea class="eb-note"${o.note.id ? ` id="${esc(o.note.id)}"` : ""}` +
      ` name="${esc(o.note.name)}" rows="1" maxlength="${Number(o.note.max) || 2000}"` +
      ` autocomplete="off" placeholder="${esc(w.notePh)}" aria-label="${esc(w.notePh)}"` +
      `${formA} data-eb-note>${esc(o.note.value ?? "")}</textarea>`
    : "";
  const c = o.cancel ?? {};
  const cancel =
    c.href != null
      ? `<a class="den-btn sm" href="${esc(c.href)}" data-eb-cancel>${esc(c.label ?? w.cancel)}</a>`
      : `<button type="submit" class="den-btn sm" form="${esc(c.form ?? "")}" data-eb-cancel formnovalidate>${esc(c.label ?? w.cancel)}</button>`;
  const save = o.save ?? fill(w.saveAs, { n: o.version ?? "" });
  return (
    `<div class="den-edit-bar" data-edit-bar>` +
    `<div class="eb-start">` +
    `<span class="eb-dot" aria-hidden="true" data-unsaved hidden></span>` +
    `<span class="eb-mark" data-unsaved hidden>${esc(w.unsaved)}</span>` +
    note +
    (o.line ? `<span class="eb-line">${esc(o.line)}</span>` : "") +
    `<p class="eb-line eb-still" role="status" data-eb-still hidden></p>` +
    `<p class="eb-line eb-err" role="alert" data-eb-err hidden></p>` +
    `</div>` +
    `<div class="eb-acts">${cancel}` +
    `<button type="submit" class="den-btn sm primary" data-eb-save aria-keyshortcuts="Meta+S Control+S"${formA}>` +
    `<span class="eb-save-t">${esc(save)}</span> <kbd aria-hidden="true">⌘S</kbd></button>` +
    `</div></div>`
  );
}

export function wireEditBar(bar, opts = {}) {
  const none = { dirty: () => false, setSave() {}, fail() {}, destroy() {} };
  const save = bar?.querySelector("[data-eb-save]");
  const form = save?.form;
  if (!save || !form) return none;
  const doc = bar.ownerDocument;
  const win = doc.defaultView;
  const w = wordsOf(opts.lang ?? doc.documentElement.lang, opts.words);
  const cancel = bar.querySelector("[data-eb-cancel]");
  const noteEl = bar.querySelector("[data-eb-note]");
  const errLine = bar.querySelector("[data-eb-err]");
  const stillLine = bar.querySelector("[data-eb-still]");
  const kbd = save.querySelector("kbd");
  if (kbd && !/Mac|iPhone|iPad/.test(win.navigator.platform ?? ""))
    kbd.textContent = "Ctrl+S";

  const snap = () => {
    const out = [];
    for (const [k, v] of new win.FormData(form))
      if (k !== "csrf" && k !== noteEl?.name)
        out.push(`${k}=${typeof v === "string" ? v : v.name}`);
    return out.join("&");
  };
  let was = snap();
  let forced = false;
  let leaving = false;
  let busy = false;
  const dirty = () => forced || snap() !== was;
  const mark = () => {
    const d = dirty();
    if (!busy) save.disabled = !d;
    for (const m of bar.querySelectorAll("[data-unsaved]")) m.hidden = !d;
  };
  const say = (text) => {
    if (!errLine) return;
    errLine.textContent = text ?? "";
    errLine.hidden = !text;
  };
  const status = (text) => {
    if (!stillLine) return;
    stillLine.textContent = text ?? "";
    stillLine.hidden = !text;
  };
  const edited = () => {
    leaving = false;
    mark();
  };
  const onChanged = (e) => {
    forced = e.detail?.dirty ?? true;
    edited();
  };

  let still = 0;
  const hold = (on) => {
    busy = on;
    holdDots(save, on);
    if (cancel) cancel.toggleAttribute("aria-disabled", on);
    win.clearTimeout(still);
    status("");
    if (on)
      still = win.setTimeout(
        () => status(fill(w.still, { s: STILL_AFTER_MS / 1000 })),
        STILL_AFTER_MS,
      );
    mark();
  };
  const onSubmit = async (e) => {
    if (e.submitter && e.submitter !== save) return;
    if (busy || !dirty()) {
      e.preventDefault();
      return;
    }
    say("");
    if (!opts.onSave) {
      leaving = true;
      hold(true);
      return;
    }
    e.preventDefault();
    hold(true);
    let r;
    try {
      r = await opts.onSave(new win.FormData(form), { form, bar });
    } catch {
      r = false;
    }
    hold(false);
    if (r === false) return say(w.notSaved);
    if (r && typeof r === "object" && r.error) return say(r.error);
    leaving = true;
    was = snap();
    forced = false;
    mark();
  };

  const leave = () => {
    leaving = true;
    if (opts.onLeave) return opts.onLeave();
    if (cancel instanceof win.HTMLAnchorElement)
      win.location.href = cancel.href;
    else if (cancel) form.requestSubmit(cancel);
  };
  let asking = false;
  const goCancel = async () => {
    if (busy || asking) return;
    if (!dirty()) return leave();
    asking = true;
    const at = doc.activeElement;
    const back = at && at !== doc.body ? at : (cancel ?? save);
    const ok = await askConfirm({
      title: w.leaveTitle,
      message: opts.leaveBody ?? w.leaveBody,
      okLabel: w.leave,
      cancelLabel: w.keep,
      danger: true,
      opener: back,
    });
    asking = false;
    if (ok) leave();
  };
  const onCancel = (e) => {
    if (leaving) return;
    e.preventDefault();
    void goCancel();
  };
  const othersOpen = () =>
    !!doc.querySelector(
      'dialog[open], .den-popover, [role="listbox"]:not([hidden])',
    );
  const onKey = (e) => {
    if (e.defaultPrevented || e.altKey || e.isComposing) return;
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      e.key.toLowerCase() === "s"
    ) {
      if (doc.querySelector("dialog[open]")) return;
      e.preventDefault();
      if (!save.disabled && !busy) form.requestSubmit(save);
    } else if (e.key === "Escape" && !e.metaKey && !e.ctrlKey) {
      if (othersOpen()) return;
      e.preventDefault();
      void goCancel();
    }
  };
  const onUnload = (e) => {
    if (leaving || !dirty()) return;
    e.preventDefault();
    e.returnValue = "";
  };
  const grow = () => {
    if (!noteEl) return;
    noteEl.style.height = "auto";
    noteEl.style.height = `${noteEl.scrollHeight + 2}px`;
  };
  const onNoteKey = (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (!save.disabled && !busy) form.requestSubmit(save);
  };
  const vv = win.visualViewport;
  const lift = () =>
    bar.style.setProperty(
      "--eb-kb",
      `${Math.max(0, Math.round(win.innerHeight - vv.height - vv.offsetTop))}px`,
    );

  const scroller = (() => {
    for (
      let el = bar.parentElement;
      el && el !== doc.body;
      el = el.parentElement
    ) {
      const oy = win.getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") return el;
    }
    return doc.scrollingElement || doc.documentElement;
  })();
  const inner =
    scroller !== doc.scrollingElement && scroller !== doc.documentElement;
  const was0 = {
    spb: scroller.style.scrollPaddingBottom,
    pb: scroller.style.paddingBottom,
  };
  const basePad = parseFloat(win.getComputedStyle(scroller).paddingBottom) || 0;
  const keepRoom = () => {
    const room = bar.offsetHeight + 16;
    scroller.style.scrollPaddingBottom = `${room}px`;
    if (inner) scroller.style.paddingBottom = `${basePad + room}px`;
  };
  const ro = win.ResizeObserver ? new win.ResizeObserver(keepRoom) : null;
  ro?.observe(bar);
  keepRoom();
  const caretRect = () => {
    if (bar.contains(doc.activeElement)) return null;
    const cm = form.querySelector(".cm-cursor-primary, .cm-cursor");
    if (cm) return cm.getBoundingClientRect();
    const sel = win.getSelection();
    if (!sel || !sel.rangeCount || !form.contains(sel.anchorNode)) return null;
    const r = sel.getRangeAt(0).getClientRects();
    return r.length ? r[r.length - 1] : null;
  };
  let pending = 0;
  const clearCaret = () => {
    if (pending) return;
    pending = win.requestAnimationFrame(() => {
      pending = 0;
      const r = caretRect();
      if (!r || (!r.height && !r.width)) return;
      const over = r.bottom - (bar.getBoundingClientRect().top - 8);
      if (over > 0) scroller.scrollBy({ top: over, behavior: "instant" });
    });
  };
  const onSel = () => {
    if (form.contains(doc.activeElement)) clearCaret();
  };

  form.addEventListener("input", edited);
  form.addEventListener("change", edited);
  form.addEventListener("edit-bar:changed", onChanged);
  form.addEventListener("submit", onSubmit, true);
  cancel?.addEventListener("click", onCancel);
  doc.addEventListener("keydown", onKey);
  win.addEventListener("beforeunload", onUnload);
  noteEl?.addEventListener("input", grow);
  noteEl?.addEventListener("keydown", onNoteKey);
  for (const t of ["keyup", "input", "click"])
    form.addEventListener(t, clearCaret);
  doc.addEventListener("selectionchange", onSel);
  vv?.addEventListener("resize", lift);
  vv?.addEventListener("scroll", lift);
  grow();
  mark();

  return {
    dirty,
    setSave(text) {
      const t = save.querySelector(".eb-save-t");
      if (t) t.textContent = text;
    },
    fail: (text) => say(text ?? w.notSaved),
    destroy() {
      form.removeEventListener("input", edited);
      form.removeEventListener("change", edited);
      form.removeEventListener("edit-bar:changed", onChanged);
      form.removeEventListener("submit", onSubmit, true);
      cancel?.removeEventListener("click", onCancel);
      doc.removeEventListener("keydown", onKey);
      win.removeEventListener("beforeunload", onUnload);
      noteEl?.removeEventListener("input", grow);
      noteEl?.removeEventListener("keydown", onNoteKey);
      vv?.removeEventListener("resize", lift);
      vv?.removeEventListener("scroll", lift);
      for (const t of ["keyup", "input", "click"])
        form.removeEventListener(t, clearCaret);
      doc.removeEventListener("selectionchange", onSel);
      ro?.disconnect();
      if (pending) win.cancelAnimationFrame(pending);
      scroller.style.scrollPaddingBottom = was0.spb;
      scroller.style.paddingBottom = was0.pb;
      win.clearTimeout(still);
    },
  };
}
