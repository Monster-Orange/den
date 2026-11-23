/**
 * The switch (issue 551): a labelled on/off control, role=switch, with a
 * disabled state and help text. The label and the help are the host's own
 * words (the name of its setting, what it does), as a page's name in the
 * rail is; the switch adds no words of its own. On and off are its state
 * (aria-checked through the checkbox), which a screen reader says in its
 * own language. Pure builder, runs in Node too:
 *
 *   switchHtml({ label, on, disabled, help, id, attrs })
 *     <label class="den-switch" for=id>: the label (and the help under
 *     it, its description), then <input type="checkbox" role="switch">.
 *     No label: nothing is drawn (a switch must have a name). No id: one
 *     of the kit's own (den-sw-N). attrs: more attributes on the input
 *     (a host's data-*, for its handler).
 *
 *   switchInputHtml({ id, on, disabled, labelledBy, describedBy, attrs })
 *     The bare switch (issue 680), for a row that draws its own label (a
 *     settings row): the same input switchHtml draws, named by the row's
 *     label (its <label for=id>, or labelledBy) and described by
 *     describedBy. attrs: more attributes, escaped (data-* for the host).
 *
 * In the page:
 *
 *   const sw = hydrateSwitch(inputOrLabel, { onChange: (on) => … });
 *     A change (a click on the switch or its words, Space, Enter) calls
 *     onChange(on). The host keeps the state: sw.set(on) moves it with no
 *     call; sw.setDisabled(off); sw.on(); sw.destroy().
 *
 * The look is switch.css: link it after tokens.css. 44px tall, so a
 * phone's tap is the whole row.
 */
import { esc } from "./strings.js";

let seq = 0;

/** The bare switch input (see the top of this file). */
export function switchInputHtml(o = {}) {
  const id = o.id ? String(o.id) : `den-sw-${++seq}`;
  const more = Object.entries(o.attrs ?? {})
    .map(([k, v]) => ` ${esc(k)}="${esc(v)}"`)
    .join("");
  return (
    `<input type="checkbox" role="switch" class="den-switch-input" id="${esc(id)}"` +
    (o.labelledBy ? ` aria-labelledby="${esc(o.labelledBy)}"` : "") +
    (o.describedBy ? ` aria-describedby="${esc(o.describedBy)}"` : "") +
    more +
    (o.on ? " checked" : "") +
    (o.disabled ? " disabled" : "") +
    " data-den-switch>"
  );
}

/** The switch's markup (see the top of this file). */
export function switchHtml(o = {}) {
  const label = o.label == null ? "" : String(o.label);
  if (!label.trim()) return "";
  const id = o.id ? String(o.id) : `den-sw-${++seq}`;
  const help = o.help == null ? "" : String(o.help);
  const helpId = `${id}-help`;
  // Named by the label alone (aria-labelledby): the help inside the same
  // <label> would else be read as part of its name.
  const labelId = `${id}-label`;
  return (
    `<label class="den-switch" for="${esc(id)}"${o.disabled ? " data-disabled" : ""}>` +
    `<span class="den-switch-text"><span class="den-switch-label" id="${esc(labelId)}">${esc(label)}</span>` +
    (help
      ? `<span class="den-switch-help" id="${esc(helpId)}">${esc(help)}</span>`
      : "") +
    "</span>" +
    switchInputHtml({
      id,
      on: o.on,
      disabled: o.disabled,
      labelledBy: labelId,
      describedBy: help ? helpId : "",
      attrs: o.attrs,
    }) +
    "</label>"
  );
}

/** The switch in the page (see the top of this file). */
export function hydrateSwitch(el, opts = {}) {
  const input = el?.matches?.("input[data-den-switch]")
    ? el
    : el?.querySelector?.("input[data-den-switch]");
  const label = input?.closest(".den-switch");
  const onChange = () => opts.onChange?.(input.checked);
  // Space is the checkbox's own; Enter toggles it too (a switch's keys).
  const onKey = (e) => {
    if (e.key !== "Enter" || e.isComposing || input.disabled) return;
    e.preventDefault();
    input.click();
  };
  input?.addEventListener("change", onChange);
  input?.addEventListener("keydown", onKey);
  return {
    set(on) {
      if (input) input.checked = Boolean(on);
    },
    setDisabled(off) {
      if (!input) return;
      input.disabled = Boolean(off);
      label?.toggleAttribute("data-disabled", Boolean(off));
    },
    on: () => Boolean(input?.checked),
    destroy() {
      input?.removeEventListener("change", onChange);
      input?.removeEventListener("keydown", onKey);
    },
  };
}
