/**
 * The general button (issue 556): `.den-btn` from button.css, for any page,
 * inside the frame or not. Pure (no DOM): it runs in Node and in the page.
 *
 *   buttonHtml({
 *     label,                       the host's words (escaped)
 *     variant: "secondary" | "primary" | "danger",   default secondary
 *                                  (the base); danger takes something away
 *     size: "md" | "sm",           default md
 *     href,                        a link drawn as a button
 *     type: "button" | "submit" | "reset",   default button
 *     disabled,                    a disabled button; a link with no href
 *                                  and aria-disabled
 *     id,
 *     attrs: { "data-x": "…", "aria-…": "…" },   data- and aria- only
 *   })
 *
 * Any other variant, size or attribute is dropped. Link button.css after
 * tokens.css.
 */
import { esc } from "./strings.js";

const VARIANTS = { secondary: "", primary: "primary", danger: "danger" };
const SIZES = { md: "", sm: "sm" };
const TYPES = ["button", "submit", "reset"];

/** The extra data-/aria- attributes, escaped; anything else is dropped. */
function extra(attrs) {
  if (!attrs || typeof attrs !== "object") return "";
  let s = "";
  for (const [k, v] of Object.entries(attrs))
    if (/^(data|aria)-[a-z0-9-]+$/.test(k) && v != null)
      s += " " + k + '="' + esc(v) + '"';
  return s;
}

/** The class list for a variant and size: "den-btn primary sm". */
export function buttonClass(variant, size) {
  return ["den-btn", VARIANTS[variant] || "", SIZES[size] || ""]
    .filter(Boolean)
    .join(" ");
}

/** A `.den-btn`: a button, or a link drawn as one (see the top). */
export function buttonHtml({
  label,
  variant,
  size,
  href,
  type,
  disabled,
  id,
  attrs,
} = {}) {
  const cls = ' class="' + buttonClass(variant, size) + '"';
  const idA = id ? ' id="' + esc(id) + '"' : "";
  if (href != null)
    return (
      "<a" +
      cls +
      (disabled
        ? ' role="link" aria-disabled="true"'
        : ' href="' + esc(href) + '"') +
      idA +
      extra(attrs) +
      ">" +
      esc(label) +
      "</a>"
    );
  return (
    '<button type="' +
    (TYPES.includes(type) ? type : "button") +
    '"' +
    cls +
    idA +
    extra(attrs) +
    (disabled ? " disabled" : "") +
    ">" +
    esc(label) +
    "</button>"
  );
}
