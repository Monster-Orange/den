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
 */
import { buttonHtml } from "./button.js";
import { SAVING_AFTER_MS } from "./savestate.js";
import { esc, kitT, safeId } from "./strings.js";
import { timeHtml, upgradeTimes } from "./time.js";

const STATES = ["idle", "saving", "saved", "error"];


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
