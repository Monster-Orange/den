/**
 * The settings on/off row (issue 554): a checkbox and its label, a help
 * line, Save, the save state, and a line "who can change this · last
 * changed". The host passes data and a callback; the kit draws the row and
 * owns its own words (en, es, ja).
 *
 *   settingRowHtml({
 *     id,                 the row's id (safe characters; its parts' ids
 *                         start with it)
 *     name,               the checkbox's form name (default: id)
 *     label, help,        the host's words (help may be "")
 *     checked,            on or off
 *     who: ["Admins"],    who can change it, the host's words ([]: nobody)
 *     last: { by, at },   the last change: who (the host's words) and an
 *                         ISO time; null: no changes yet
 *     readOnly,           this person can't change it: the box and Save
 *                         are disabled
 *     state,              "idle" | "saving" | "saved" | "error"
 *     form: { action, method?, csrf?, field? },   a form that posts with
 *                         no script (csrf in a hidden field named `field`,
 *                         "csrf" by default); without it, Save is a plain
 *                         button the client wires
 *     lang, now?, zone?   the words' language; the time's clock and zone
 *   })
 *
 *   const row = hydrateSettingRow(el, { onSave(checked) → Promise, lang })
 *   const row = mountSettingRow(el, opts)    draws it into el, then hydrates
 *   row.set(state)     draws a state the host decides
 *   row.checked()      the box's state
 *   row.destroy()
 *
 * Save calls onSave with the box's state: "Saving…" when it takes more
 * than SAVING_AFTER_MS (savestate.js), then "Saved", or "Not saved. Try
 * again." (a reject). Save says it is busy (aria-disabled) while it saves,
 * and keeps focus. A change to the box clears "Saved". The state line
 * wears savestate.css's look (link it) and is a polite status. A form row
 * hydrated with onSave saves through it instead of posting.
 *
 * Its look is setting-row.css, with button.css and savestate.css.
 *
 * The field variant (issue 584): a label, a single-line input or a
 * multi-line textarea, an error line under it, a help line, Save and the
 * save state. The host's words (label, help, placeholder, error,
 * saveLabel) are its own text or { key, vars } in the kit's tables.
 *
 *   settingFieldHtml({
 *     id, name?,          as above
 *     label, help?,       the host's words
 *     value,              the saved value (text; a list is one per line)
 *     placeholder?,       the host's words
 *     multiline, rows?,   a textarea (rows: 4 by default); else an input
 *     error?,             the host's words under the input (null: none);
 *                         state "error" with none says the kit's
 *     saveLabel?,         Save's words: the kit's shared verb by default;
 *                         a host-only action keeps its own ("Save folders")
 *     readOnly, state, form, who?, last?, lang, now?, zone?
 *                         as above; the who/last line only when given
 *   })
 *
 *   const f = hydrateSettingField(el, {
 *     onSave(value, headers?) → Promise<string | void>,
 *     action?,            a working pop-up action the host registered
 *                         (busy.js registerActions): Save runs through
 *                         busyAction, and headers carry its request id
 *     lang,
 *   })
 *   const f = mountSettingField(el, opts)   draws it into el, then hydrates
 *   f.value()  f.set(state)  f.setError(words | null)  f.save()  f.destroy()
 *
 * Save is disabled until the value differs from the saved one. It calls
 * onSave with the value: "Saving…" past SAVING_AFTER_MS, as the on/off
 * row; with `action`, the working pop-up too (it holds Save, opens past
 * OPEN_MS and closes when it saved). Saved: the field shows the saved
 * value (what onSave resolved with, when text; else what it sent), which
 * is the new baseline, and Save waits again. A reject: the error line says
 * the rejection's fieldError (the host's words) or the kit's "Not saved.
 * Try again.", the input is aria-invalid, and Save stays to try again.
 * When Save had focus and waits again after a save, focus goes to the
 * field. busy.js is loaded only when `action` is first used.
 * A form row (no script) draws Save enabled; hydrating disables it.
 */
import { buttonHtml } from "./button.js";
import { SAVING_AFTER_MS } from "./savestate.js";
import { esc, hostWords, kitT, kitVerb } from "./strings.js";
import { timeHtml, upgradeTimes } from "./time.js";

const STATES = ["idle", "saving", "saved", "error"];

/** An id made of safe characters: letters, digits, - and _. */
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-");

/** "Admins and Owners", in the row's language. */
function joinWho(lang, who) {
  try {
    return new Intl.ListFormat(lang || "en", {
      style: "long",
      type: "conjunction",
    }).format(who);
  } catch {
    return who.join(", ");
  }
}

/**
 * A kit sentence with {time} as markup: the words escaped, the <time>
 * dropped in whole.
 */
function sentenceHtml(lang, key, vars, time) {
  const mark = "\u0000t\u0000";
  return esc(kitT(lang, key, { ...vars, time: mark })).replace(
    mark,
    () => time,
  );
}

/** The state line's words for a state ("" for idle). */
export function settingStateText(state, lang) {
  return state === "saving"
    ? kitT(lang, "kit.savestate.saving")
    : state === "saved"
      ? kitT(lang, "kit.savestate.saved")
      : state === "error"
        ? kitT(lang, "kit.setrow.error")
        : "";
}

/** The line under the row: who can change it · its last change. */
export function settingMetaHtml({ who, last, lang, now, zone } = {}) {
  const names = (who || []).filter((w) => w != null && w !== "").map(String);
  const can = names.length
    ? esc(kitT(lang, "kit.setrow.who", { who: joinWho(lang, names) }))
    : esc(kitT(lang, "kit.setrow.nobody"));
  const t =
    last && last.at
      ? timeHtml(last.at, { style: "relative", locale: lang, now, zone })
      : "";
  const changed = t
    ? sentenceHtml(lang, "kit.setrow.last", { who: last.by ?? "" }, t)
    : esc(kitT(lang, "kit.setrow.never"));
  return can + " · " + changed;
}

/** The row's markup (see the top). */
export function settingRowHtml(o = {}) {
  const id = safeId(o.id || "den-setrow");
  const lang = o.lang;
  const state = STATES.includes(o.state) ? o.state : "idle";
  const f = o.form && o.form.action ? o.form : null;
  const tag = f ? "form" : "div";
  const help = o.help ? String(o.help) : "";
  const describedBy = (help ? id + "-help " : "") + id + "-meta";
  return (
    "<" +
    tag +
    ' class="den-setrow" id="' +
    id +
    '" data-den-setrow' +
    (f
      ? ' method="' +
        esc(f.method || "post") +
        '" action="' +
        esc(f.action) +
        '">' +
        (f.csrf != null
          ? '<input type="hidden" name="' +
            esc(f.field || "csrf") +
            '" value="' +
            esc(f.csrf) +
            '">'
          : "")
      : ">") +
    '<label class="den-setrow-l"><input type="checkbox" id="' +
    id +
    '-cb" name="' +
    esc(o.name || id) +
    '" value="on" aria-describedby="' +
    describedBy +
    '"' +
    (o.checked ? " checked" : "") +
    (o.readOnly ? " disabled" : "") +
    "> <span>" +
    esc(o.label) +
    "</span></label>" +
    (help
      ? '<p class="den-setrow-help" id="' + id + '-help">' + esc(help) + "</p>"
      : "") +
    '<div class="den-setrow-act">' +
    buttonHtml({
      label: kitT(lang, "kit.setrow.save"),
      type: f ? "submit" : "button",
      disabled: !!o.readOnly,
      attrs: { "data-den-setrow-save": "" },
    }).replace(' data-den-setrow-save=""', " data-den-setrow-save") +
    '<p class="den-savestate den-setrow-state" id="' +
    id +
    '-state" data-state="' +
    state +
    '" role="status">' +
    esc(settingStateText(state, lang)) +
    "</p></div>" +
    '<p class="den-setrow-meta" id="' +
    id +
    '-meta">' +
    settingMetaHtml({
      who: o.who,
      last: o.last,
      lang,
      now: o.now,
      zone: o.zone,
    }) +
    "</p></" +
    tag +
    ">"
  );
}

/** Wires a drawn row (see the top). */
export function hydrateSettingRow(el, opts = {}) {
  const lang = () =>
    typeof opts.lang === "function"
      ? opts.lang()
      : opts.lang ||
        (el.closest && el.closest("[lang]")
          ? el.closest("[lang]").getAttribute("lang")
          : undefined);
  const box = el.querySelector('input[type="checkbox"]');
  const save = el.querySelector("[data-den-setrow-save]");
  const line = el.querySelector(".den-setrow-state");
  let busy = false;
  let slow = 0;
  let dead = false;

  function set(state) {
    if (!line || dead) return;
    const s = STATES.includes(state) ? state : "idle";
    line.setAttribute("data-state", s);
    line.textContent = settingStateText(s, lang());
  }

  function run(e) {
    if (e) e.preventDefault();
    if (busy || dead || !opts.onSave || (box && box.disabled)) return;
    busy = true;
    save.setAttribute("aria-disabled", "true");
    clearTimeout(slow);
    slow = setTimeout(() => busy && set("saving"), SAVING_AFTER_MS);
    let p;
    try {
      p = Promise.resolve(opts.onSave(box ? box.checked : false));
    } catch (err) {
      p = Promise.reject(err);
    }
    return p.then(
      () => done("saved"),
      () => done("error"),
    );
  }

  function done(state) {
    clearTimeout(slow);
    busy = false;
    if (dead) return;
    save.removeAttribute("aria-disabled");
    set(state);
  }

  const onChange = () => {
    if (!busy) set("idle");
  };
  const onClick = (e) => {
    // A form with no onSave posts on its own.
    if (!opts.onSave) return;
    run(e);
  };
  const onSubmit = (e) => {
    if (opts.onSave) run(e);
  };
  if (box) box.addEventListener("change", onChange);
  if (save) save.addEventListener("click", onClick);
  if (el.tagName === "FORM") el.addEventListener("submit", onSubmit);
  upgradeTimes(el);

  return {
    set,
    checked: () => !!(box && box.checked),
    save: () => run(null),
    destroy() {
      dead = true;
      clearTimeout(slow);
      if (box) box.removeEventListener("change", onChange);
      if (save) save.removeEventListener("click", onClick);
      if (el.tagName === "FORM") el.removeEventListener("submit", onSubmit);
    },
  };
}

/** Draws the row into `el` (its contents), then wires it. */
export function mountSettingRow(el, opts = {}) {
  el.innerHTML = settingRowHtml(opts);
  return hydrateSettingRow(el.firstElementChild, opts);
}

/** A textarea drops one leading newline of its text: give it one. */
const areaText = (v) => "\n" + esc(v);

/** The field row's markup (see the top). */
export function settingFieldHtml(o = {}) {
  const id = safeId(o.id || "den-setfield");
  const lang = o.lang;
  const state = STATES.includes(o.state) ? o.state : "idle";
  const f = o.form && o.form.action ? o.form : null;
  const tag = f ? "form" : "div";
  const help = hostWords(o.help, lang);
  const err =
    hostWords(o.error, lang) ||
    (state === "error" ? kitT(lang, "kit.setrow.error") : "");
  const meta = o.who != null || o.last !== undefined;
  const describedBy =
    id +
    "-err" +
    (help ? " " + id + "-help" : "") +
    (meta ? " " + id + "-meta" : "");
  const value = o.value == null ? "" : String(o.value);
  const ph = hostWords(o.placeholder, lang);
  const common =
    ' class="den-setfield-in" id="' +
    id +
    '-in" name="' +
    esc(o.name || id) +
    '"';
  const tail =
    (ph ? ' placeholder="' + esc(ph) + '"' : "") +
    ' aria-describedby="' +
    describedBy +
    '"' +
    (err ? ' aria-invalid="true"' : "") +
    (o.readOnly ? " readonly" : "");
  const rows = Math.max(1, Math.floor(Number(o.rows) || 4));
  const input = o.multiline
    ? "<textarea" +
      common +
      ' rows="' +
      rows +
      '"' +
      tail +
      ">" +
      areaText(value) +
      "</textarea>"
    : '<input type="text"' +
      common +
      ' value="' +
      esc(value) +
      '"' +
      tail +
      ">";
  return (
    "<" +
    tag +
    ' class="den-setrow den-setfield" id="' +
    id +
    '" data-den-setfield' +
    (f
      ? ' method="' +
        esc(f.method || "post") +
        '" action="' +
        esc(f.action) +
        '">' +
        (f.csrf != null
          ? '<input type="hidden" name="' +
            esc(f.field || "csrf") +
            '" value="' +
            esc(f.csrf) +
            '">'
          : "")
      : ">") +
    '<label class="den-setfield-l" for="' +
    id +
    '-in">' +
    esc(hostWords(o.label, lang)) +
    "</label>" +
    input +
    '<p class="den-setfield-err" id="' +
    id +
    '-err" aria-live="polite">' +
    esc(err) +
    "</p>" +
    (help
      ? '<p class="den-setrow-help" id="' + id + '-help">' + esc(help) + "</p>"
      : "") +
    '<div class="den-setrow-act">' +
    buttonHtml({
      label: hostWords(o.saveLabel, lang) || kitVerb(lang, "save"),
      type: f ? "submit" : "button",
      // Nothing has changed yet. A form keeps it for a page with no script.
      disabled: !!o.readOnly || !f,
      attrs: { "data-den-setfield-save": "" },
    }).replace(' data-den-setfield-save=""', " data-den-setfield-save") +
    '<p class="den-savestate den-setrow-state" id="' +
    id +
    '-state" data-state="' +
    (state === "error" ? "idle" : state) +
    '" role="status">' +
    (state === "error" ? "" : esc(settingStateText(state, lang))) +
    "</p></div>" +
    (meta
      ? '<p class="den-setrow-meta" id="' +
        id +
        '-meta">' +
        settingMetaHtml({
          who: o.who,
          last: o.last,
          lang,
          now: o.now,
          zone: o.zone,
        }) +
        "</p>"
      : "") +
    "</" +
    tag +
    ">"
  );
}

/** Wires a drawn field row (see the top). */
export function hydrateSettingField(el, opts = {}) {
  const lang = () =>
    typeof opts.lang === "function"
      ? opts.lang()
      : opts.lang ||
        (el.closest && el.closest("[lang]")
          ? el.closest("[lang]").getAttribute("lang")
          : undefined);
  const input = el.querySelector(".den-setfield-in");
  const save = el.querySelector("[data-den-setfield-save]");
  const line = el.querySelector(".den-setrow-state");
  const errLine = el.querySelector(".den-setfield-err");
  let base = input ? input.defaultValue : "";
  let busy = false;
  let slow = 0;
  let dead = false;
  const locked = () => !input || input.readOnly || input.disabled;
  const value = () => (input ? input.value : "");

  /** Save waits while nothing changed, the field is locked, or it saves. */
  function sync() {
    if (!save || busy) return;
    save.disabled = locked() || value() === base;
  }

  function set(state) {
    if (!line || dead) return;
    const s = STATES.includes(state) && state !== "error" ? state : "idle";
    line.setAttribute("data-state", s);
    line.textContent = settingStateText(s, lang());
    if (state === "error") setError(null, true);
  }

  /** The error line: the host's words; null clears it; kit: the kit's. */
  function setError(words, kit) {
    if (!errLine || dead) return;
    const t =
      hostWords(words, lang()) || (kit ? kitT(lang(), "kit.setrow.error") : "");
    errLine.textContent = t;
    if (!input) return;
    if (t) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  function run(e) {
    if (e) e.preventDefault();
    if (busy || dead || !opts.onSave || locked() || value() === base) return;
    const sent = value();
    busy = true;
    if (!opts.action) save.setAttribute("aria-disabled", "true");
    clearTimeout(slow);
    slow = setTimeout(() => busy && set("saving"), SAVING_AFTER_MS);
    let p;
    try {
      if (opts.action) {
        let ok = false;
        let got;
        // Loaded when first used: a server drawing the row never needs it.
        p = import("./busy.js")
          .then(({ busyAction }) =>
            busyAction(opts.action, (headers) => opts.onSave(sent, headers), {
              button: save,
              quietFail: true,
              inlineError: true,
              onDone: (d) => {
                ok = true;
                got = d;
              },
            }),
          )
          .then(() => {
            // Closed after a failure the pop-up showed: not saved.
            if (!ok) throw new Error("not saved");
            return got;
          });
      } else p = Promise.resolve(opts.onSave(sent));
    } catch (err) {
      p = Promise.reject(err);
    }
    return p.then(
      (got) => done(true, sent, got),
      (err) => done(false, sent, err),
    );
  }

  function done(ok, sent, got) {
    clearTimeout(slow);
    busy = false;
    if (dead) return;
    save.removeAttribute("aria-disabled");
    if (ok) {
      base = typeof got === "string" ? got : sent;
      // Typed on while it saved: keep what the person typed.
      if (input && input.value === sent) input.value = base;
      setError(null);
      set("saved");
    } else {
      set("idle");
      setError(got && got.fieldError, true);
    }
    // Saved, Save waits again: focus goes to the field, never to nothing.
    const had =
      typeof document !== "undefined" && document.activeElement === save;
    sync();
    if (had && save.disabled && input) input.focus();
  }

  const onInput = () => {
    if (!busy) set("idle");
    sync();
  };
  const onClick = (e) => {
    // A form with no onSave posts on its own.
    if (!opts.onSave) return;
    run(e);
  };
  const onSubmit = (e) => {
    if (opts.onSave) run(e);
  };
  if (input) input.addEventListener("input", onInput);
  if (save) save.addEventListener("click", onClick);
  if (el.tagName === "FORM") el.addEventListener("submit", onSubmit);
  sync();
  upgradeTimes(el);

  return {
    set,
    setError: (w) => setError(w, false),
    value,
    save: () => run(null),
    destroy() {
      dead = true;
      clearTimeout(slow);
      if (input) input.removeEventListener("input", onInput);
      if (save) save.removeEventListener("click", onClick);
      if (el.tagName === "FORM") el.removeEventListener("submit", onSubmit);
    },
  };
}

/** Draws the field row into `el` (its contents), then wires it. */
export function mountSettingField(el, opts = {}) {
  el.innerHTML = settingFieldHtml(opts);
  return hydrateSettingField(el.firstElementChild, opts);
}
