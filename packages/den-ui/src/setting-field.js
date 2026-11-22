/**
 * The text-field settings row (issue 584): a label, a single-line input or
 * a multi-line box, help text, Save, and an error line under the input.
 * The host passes data and a callback; the kit draws the row, owns Save's
 * shared verb (en, es, ja) and runs the save through the working pop-up.
 *
 *   settingFieldHtml({
 *     id,                 the row's id (safe characters; its parts' ids
 *                         start with it)
 *     name,               the input's form name (default: id)
 *     label, help,        the host's words, as text or { key, vars } (a
 *                         key the host added with addStrings); help may
 *                         be ""
 *     value,              a string, or a list (one per line, multi-line)
 *     multiline, rows,    a multi-line box (rows: 4 by default)
 *     placeholder,        the host's words
 *     save,               Save's words: a shared verb { verb: "save" |
 *                         "cancel" | "delete" | "close" | "tryAgain" }
 *                         (Save by default), or the host's own words
 *     error,              an error drawn at once (the host's words)
 *     readOnly,           this person can't change it
 *     lang
 *   })
 *
 *   const row = hydrateSettingField(el, {
 *     onSave(value, lines) → Promise<saved value?>,
 *     busy?(button, run),  the working pop-up (busy.js `pending` by default)
 *     lang?,
 *   })
 *   const row = mountSettingField(el, opts)   draws it into el, then hydrates
 *   row.value()      the box's value
 *   row.save()       saves as Save does
 *   row.error(text)  shows the host's words under the box ("" hides them)
 *   row.destroy()
 *
 * Save is disabled until the value differs from the saved one. onSave gets
 * the value and its lines (trimmed, blank ones dropped). Done, the row
 * shows what onSave returned (the value as saved; the typed value when it
 * returns nothing) and Save is disabled again. Refused, the error line
 * says why (the error's own `message` is not shown: the host passes words
 * through row.error) and Save stays on. Typing clears the error.
 *
 * Its look is setting-field.css, with button.css.
 */
import { buttonHtml } from "./button.js";
import { esc, kitT } from "./strings.js";

/** The kit's shared button verbs (strings.js kit.verb.*). */
export const VERBS = ["save", "cancel", "delete", "close", "tryAgain"];

/** An id made of safe characters: letters, digits, - and _. */
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "-");

/** The host's words: its own text, or a key it added ({ key, vars }). */
function words(lang, w) {
  if (w && typeof w === "object" && typeof w.key === "string")
    return kitT(lang, w.key, w.vars);
  return w == null ? "" : String(w);
}

/** Save's words: a shared verb, or the host's own. */
function saveWords(lang, save) {
  if (save && typeof save === "object" && VERBS.includes(save.verb))
    return kitT(lang, "kit.verb." + save.verb);
  if (save == null || save === "") return kitT(lang, "kit.verb.save");
  return words(lang, save);
}

const asText = (v) =>
  Array.isArray(v) ? v.map(String).join("\n") : v == null ? "" : String(v);

/** A value's lines: trimmed, blank ones dropped. */
export function fieldLines(v) {
  return asText(v)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function settingFieldHtml(o = {}) {
  const lang = o.lang;
  const id = safeId(o.id || "setfield");
  const name = o.name ? String(o.name) : id;
  const inId = id + "-in";
  const help = words(lang, o.help);
  const err = o.error ? words(lang, o.error) : "";
  const described = (help ? id + "-help " : "") + id + "-err";
  const ph = o.placeholder
    ? ' placeholder="' + esc(words(lang, o.placeholder)) + '"'
    : "";
  const ro = o.readOnly ? " readonly" : "";
  const value = asText(o.value);
  const rows = Number.isInteger(o.rows) && o.rows > 0 ? o.rows : 4;
  const box = o.multiline
    ? '<textarea id="' +
      inId +
      '" name="' +
      esc(name) +
      '" rows="' +
      rows +
      '"' +
      ph +
      ' aria-describedby="' +
      described +
      '"' +
      ro +
      ">" +
      esc(value) +
      "</textarea>"
    : '<input type="text" id="' +
      inId +
      '" name="' +
      esc(name) +
      '" value="' +
      esc(value) +
      '"' +
      ph +
      ' aria-describedby="' +
      described +
      '"' +
      ro +
      ">";
  return (
    '<div class="den-setfield" id="' +
    id +
    '" data-den-setfield>' +
    '<label class="den-setfield-l" for="' +
    inId +
    '">' +
    esc(words(lang, o.label)) +
    "</label>" +
    box +
    (help
      ? '<p class="den-setfield-help" id="' +
        id +
        '-help">' +
        esc(help) +
        "</p>"
      : "") +
    '<p class="den-setfield-err" id="' +
    id +
    '-err" role="alert"' +
    (err ? "" : " hidden") +
    ">" +
    esc(err) +
    "</p>" +
    '<div class="den-setfield-do">' +
    buttonHtml({
      label: saveWords(lang, o.save),
      variant: "primary",
      size: "sm",
      disabled: true,
      attrs: { "data-den-setfield-save": "" },
    }) +
    "</div></div>"
  );
}

export function hydrateSettingField(el, opts = {}) {
  const lang = () =>
    typeof opts.lang === "function"
      ? opts.lang()
      : opts.lang ||
        (el.closest && el.closest("[lang]")
          ? el.closest("[lang]").getAttribute("lang")
          : undefined);
  const box = el.querySelector("textarea, input");
  const save = el.querySelector("[data-den-setfield-save]");
  const line = el.querySelector(".den-setfield-err");
  // The working pop-up: busy.js's pending, loaded when a save first runs.
  const busy =
    typeof opts.busy === "function"
      ? opts.busy
      : (button, go) => import("./busy.js").then((m) => m.pending(button, go));
  let saved = box ? box.value : "";
  let saving = false;
  let dead = false;

  function error(text) {
    if (!line || dead) return;
    line.textContent = text || "";
    line.hidden = !text;
  }
  function follow() {
    if (!save || dead) return;
    save.disabled =
      saving || !box || box.readOnly || box.disabled || box.value === saved;
  }

  async function run(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (saving || dead || !opts.onSave || !box || box.value === saved) return;
    saving = true;
    error("");
    const typed = box.value;
    let ok = false;
    try {
      await busy(save, async () => {
        const r = await opts.onSave(typed, fieldLines(typed));
        if (!dead) {
          saved = typeof r === "string" ? r : typed;
          box.value = saved;
        }
        ok = true;
        return r;
      });
    } catch {
      ok = false;
    }
    saving = false;
    if (dead) return;
    if (!ok) error(kitT(lang(), "kit.setrow.error"));
    follow();
  }

  const onInput = () => {
    error("");
    follow();
  };
  const onClick = (e) => run(e);
  const onKey = (e) => {
    // Enter saves a single-line field; a multi-line box keeps its newline.
    if (e && e.key === "Enter" && box && box.tagName === "INPUT") run(e);
  };
  if (box) {
    box.addEventListener("input", onInput);
    box.addEventListener("keydown", onKey);
  }
  if (save) save.addEventListener("click", onClick);
  follow();

  return {
    value: () => (box ? box.value : ""),
    save: () => run(null),
    error,
    destroy() {
      dead = true;
      if (box) {
        box.removeEventListener("input", onInput);
        box.removeEventListener("keydown", onKey);
      }
      if (save) save.removeEventListener("click", onClick);
    },
  };
}

/** Draws the row into `el` (its contents), then wires it. */
export function mountSettingField(el, opts = {}) {
  el.innerHTML = settingFieldHtml(opts);
  return hydrateSettingField(el.firstElementChild, opts);
}
