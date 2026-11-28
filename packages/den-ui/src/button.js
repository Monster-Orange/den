/**
 * The general button (issue 556): `.den-btn` from button.css, for any page,
 * inside the frame or not. Pure (no DOM): it runs in Node and in the page.
 *
 *   buttonHtml({
 *     label,                       the host's words (escaped)
 *     variant: "secondary" | "primary" | "danger" | "ghost" | "link"
 *              | "icon",           default secondary (DS #7)
 *     primary: true,               with danger: a dialog's filled confirm
 *     size: "sm" | "md" | "lg",    28, 36 or 44px; default md
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
import { icon as iconSvg, ICONS } from "./icons.js";
import { holdDots } from "./busy.js";

const VARIANTS = {
  secondary: "",
  primary: "primary",
  danger: "danger",
  ghost: "ghost",
  link: "link",
  icon: "icon",
};
const SIZES = { md: "", sm: "sm", lg: "lg" };
const TYPES = ["button", "submit", "reset"];
const LONG = 32;
let whySeq = 0;

function extra(attrs) {
  if (!attrs || typeof attrs !== "object") return "";
  let s = "";
  for (const [k, v] of Object.entries(attrs))
    if (/^(data|aria)-[a-z0-9-]+$/.test(k) && v != null)
      s += " " + k + '="' + esc(v) + '"';
  return s;
}

export function buttonClass(variant, size, primary) {
  const v = VARIANTS[variant] || "";
  return [
    "den-btn",
    v,
    primary && v === "danger" ? "primary" : "",
    SIZES[size] || "",
  ]
    .filter(Boolean)
    .join(" ");
}

function inner(label, glyph, expanded) {
  if (!glyph && expanded == null && label.length <= LONG) return esc(label);
  const svg = glyph && Object.hasOwn(ICONS, glyph) ? iconSvg(glyph) : "";
  return (
    (svg ? `<span class="den-btn-ic" aria-hidden="true">${svg}</span>` : "") +
    (label ? `<span class="den-btn-lbl">${esc(label)}</span>` : "") +
    (expanded != null
      ? '<span class="den-btn-chev" aria-hidden="true">▾</span>'
      : "")
  );
}

export function buttonHtml({
  label,
  variant,
  primary,
  size,
  href,
  type,
  icon,
  disabled,
  disabledWhy,
  pressed,
  expanded,
  as,
  id,
  attrs,
} = {}) {
  const text = label == null ? "" : String(label);
  if (variant === "icon" && !text && !attrs?.["aria-label"]) return "";
  const cls = ' class="' + buttonClass(variant, size, primary) + '"';
  const why = disabledWhy ? String(disabledWhy) : "";
  const whyId = why ? (id ? id + "-why" : "den-btn-why-" + ++whySeq) : "";
  const idA = id ? ' id="' + esc(id) + '"' : "";
  const st =
    (pressed != null ? ` aria-pressed="${pressed ? "true" : "false"}"` : "") +
    (expanded != null
      ? ` aria-expanded="${expanded ? "true" : "false"}"`
      : "") +
    (why
      ? ` aria-disabled="true" aria-describedby="${esc(whyId)}" title="${esc(why)}"`
      : text.length > LONG
        ? ` title="${esc(text)}"`
        : "");
  const note = why
    ? `<span class="den-btn-why" id="${esc(whyId)}" hidden>${esc(why)}</span>`
    : "";
  const content = inner(text, icon, expanded);
  if (as === "summary")
    return `<summary${cls}${idA}${extra(attrs)}${st}>${content}</summary>${note}`;
  if (href != null)
    return (
      "<a" +
      cls +
      (disabled || why
        ? ' role="link"' + (why ? "" : ' aria-disabled="true"')
        : ' href="' + esc(href) + '"') +
      idA +
      extra(attrs) +
      st +
      ">" +
      content +
      "</a>" +
      note
    );
  return (
    '<button type="' +
    (TYPES.includes(type) ? type : "button") +
    '"' +
    cls +
    idA +
    extra(attrs) +
    st +
    (disabled && !why ? " disabled" : "") +
    ">" +
    content +
    "</button>" +
    note
  );
}

export function holdButton(el, o = {}) {
  if (!el) return () => {};
  if (!o.instant) {
    holdDots(el, true);
    return () => holdDots(el, false);
  }
  const had = el.getAttribute("aria-disabled");
  el.setAttribute("aria-busy", "true");
  el.setAttribute("aria-disabled", "true");
  return () => {
    el.removeAttribute("aria-busy");
    if (had == null) el.removeAttribute("aria-disabled");
  };
}

globalThis.window?.addEventListener?.(
  "click",
  (e) => {
    const b = e.target?.closest?.(".den-btn");
    if (
      b &&
      b.getAttribute("aria-disabled") === "true" &&
      b.hasAttribute("aria-describedby")
    ) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);

let watch;
function fits(b) {
  const l = b.querySelector(":scope > .den-btn-lbl");
  if (!l) return;
  const own = !b.hasAttribute("aria-describedby");
  if (!own) return;
  if (l.scrollWidth > l.clientWidth) b.title = l.textContent;
  else if (b.title === l.textContent) b.removeAttribute("title");
}

export function hydrateButtons(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  watch ??=
    globalThis.ResizeObserver &&
    new globalThis.ResizeObserver((es) => es.forEach((e) => fits(e.target)));
  for (const b of root.querySelectorAll(".den-btn:not(.icon)")) {
    const n = b.firstChild;
    if (
      b.childNodes.length === 1 &&
      n.nodeType === 3 &&
      n.data.trim() &&
      b.getAttribute("aria-busy") !== "true"
    ) {
      const l = b.ownerDocument.createElement("span");
      l.className = "den-btn-lbl";
      b.replaceChild(l, n);
      l.append(n);
    }
    fits(b);
    watch?.observe(b);
  }
}
