/**
 * den-ui shell markup: the global shell (top bar and left rail), the
 * version chip and the Report button, as HTML strings. Pure: no DOM, so it
 * runs in Node (a server renders the page with it from the first byte) and
 * in the page (a client draws or redraws the rail with it). The client
 * script (shell-client.js) only hydrates what this drew.
 *
 * No inline style attributes, no inline handlers: the markup is clean
 * under `script-src 'self'; style-src 'self'`. Its look is shell.css.
 *
 *   shellHtml({ product, nav, groups, foot, lang, slots, collapsed, report })
 *     product  { name, title?, version?, href? }   the brand: `name` is the
 *              word beside the mark, `title` its tooltip (default name),
 *              `version` the chip's text ("v" + version; "v…" when unknown),
 *              `href` where the brand goes (default "/")
 *     nav      [{ id, label, href, group, icon?, tip?, current?, badge?,
 *              lead?, mono?, cls?, attrs?, pin?, after? }]   rail entries
 *     groups   [{ id, label, from? }]   in rail order; a group with no
 *              entry is left out
 *     foot     entries under the rail's spacer (Settings, say), then the
 *              kit's collapse toggle
 *     lang     "en", "es" or "ja" (the kit's words; else en)
 *     slots    { start, end, bell, account }: the product's own HTML in
 *              the top bar. start: after the brand; end: the right group's
 *              start, before Report; bell, account: after Report, so the
 *              right group reads Report · bell · version · account
 *     collapsed  the rail drawn collapsed (the toggle says Expand)
 *     report   false: no Report button (reports off)
 *
 *   An entry: `badge` { n, bad?, label? } (label is read with the name);
 *   `lead` HTML in place of the icon (a status dot); `attrs` more
 *   attributes { name: value } (escaped); `cls` more classes; `pin` the
 *   pinned id (the row is a pin row: Delete unpins it); `after` HTML after
 *   the link inside the pin row (a Visit link).
 */
import { esc, kitT } from "./strings.js";
import { icon } from "./icons.js";

export { icon } from "./icons.js";
export { esc } from "./strings.js";

function attrs(o) {
  let s = "";
  if (!o) return s;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v == null || v === false) continue;
    s += v === true ? ` ${k}` : ` ${k}="${esc(v)}"`;
  }
  return s;
}

/** One rail entry (a link, .den-ni). */
export function navItemHtml(n) {
  const b = n.badge || null;
  const extra = b
    ? '<span class="den-bdg' +
      (b.bad ? " bad" : "") +
      '" aria-hidden="true">' +
      esc(b.n) +
      "</span>"
    : "";
  const more = { ...(n.attrs || {}) };
  if (b && b.label && more["aria-label"] == null)
    more["aria-label"] = n.label + ", " + b.label;
  const link =
    '<a class="den-ni' +
    (n.cls ? " " + esc(n.cls) : "") +
    '" href="' +
    esc(n.href) +
    '" data-nav="' +
    esc(n.id) +
    '"' +
    (n.current ? ' aria-current="page"' : "") +
    attrs(more) +
    ' title="' +
    esc(n.tip || n.label) +
    '">' +
    (n.lead || icon(n.icon)) +
    '<span class="den-lbl' +
    (n.mono ? " den-mono" : "") +
    '">' +
    esc(n.label) +
    "</span>" +
    extra +
    "</a>";
  return n.pin != null
    ? '<div class="den-pin-row">' + link + (n.after || "") + "</div>"
    : link;
}

/** A rail group: its heading (and "from <d>" tag) and its entries. */
export function railGroupHtml(g, body, lang) {
  const id = esc(g.id);
  const from = g.from;
  return (
    '<div class="den-rail-group" role="group" aria-labelledby="den-gh-' +
    id +
    '"' +
    (from ? ' aria-describedby="den-gd-' + id + '"' : "") +
    '><div class="den-gh"><span id="den-gh-' +
    id +
    '">' +
    esc(g.label) +
    "</span>" +
    (from
      ? '<span class="den-tagx" aria-hidden="true" title="' +
        esc(kitT(lang, "kit.from", { d: from })) +
        '">' +
        esc(from) +
        "</span>"
      : "") +
    "</div>" +
    (from
      ? '<span class="den-sr" id="den-gd-' +
        id +
        '">' +
        esc(kitT(lang, "kit.from", { d: from })) +
        "</span>"
      : "") +
    body +
    "</div>"
  );
}

/** The collapse toggle at the rail's foot. */
function collapseHtml(collapsed, lang) {
  const word = kitT(lang, collapsed ? "kit.expand" : "kit.collapse");
  return (
    '<button class="den-ni den-collapse-btn" type="button" data-act="collapse" aria-expanded="' +
    (collapsed ? "false" : "true") +
    '" title="' +
    esc(word) +
    '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' +
    (collapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6") +
    '"/></svg><span class="den-lbl">' +
    esc(word) +
    "</span></button>"
  );
}

/** The rail's content: the groups, the spacer, the foot, the toggle. */
export function railHtml({
  nav = [],
  groups = [],
  foot = [],
  lang,
  collapsed,
} = {}) {
  let html = "";
  for (const g of groups) {
    const items = nav.filter((n) => n.group === g.id);
    if (!items.length) continue;
    html += railGroupHtml(g, items.map(navItemHtml).join(""), lang);
  }
  html += '<div class="den-rail-grow"></div>';
  html += foot
    .map((n) => (typeof n === "string" ? n : navItemHtml(n)))
    .join("");
  html += collapseHtml(!!collapsed, lang);
  return html;
}

/** The version chip: "v<version>" (v… until known); a click opens What's new. */
export function versionChipHtml({ version, lang } = {}) {
  return (
    '<button class="den-ib v-pill" id="version-pill" title="' +
    esc(kitT(lang, "kit.version.title")) +
    '"><span class="v-txt">' +
    esc(version ? "v" + String(version).replace(/^v/, "") : "v…") +
    '</span><span class="v-pip" id="v-pip"></span></button>'
  );
}

/**
 * The Report button: the flat speech bubble, the word, ⌘⇧F (hidden on a
 * phone). `inFoot`: a pop-up's footer; `inTop`: the top bar. A click on
 * any [data-den-report] opens the Report form (the client's job).
 */
export function reportButtonHtml({ inFoot, inTop, lang } = {}) {
  return (
    '<button type="button" class="den-rb' +
    (inFoot ? " den-rb-in" : "") +
    (inTop ? " den-rb-top" : "") +
    '" data-den-report aria-keyshortcuts="Meta+Shift+F Control+Shift+F" title="' +
    esc(kitT(lang, "kit.report.tip")) +
    '">' +
    icon("report") +
    "<span>" +
    esc(kitT(lang, "kit.report.word")) +
    '</span><kbd aria-hidden="true">⌘⇧F</kbd></button>'
  );
}

/** The top bar (header.den-top). */
export function topBarHtml({
  product = {},
  lang,
  slots = {},
  report = true,
} = {}) {
  const name = product.name ?? "";
  return (
    '<header class="den-top">' +
    '<button class="den-ib den-menu-btn" id="den-menu-btn" aria-label="' +
    esc(kitT(lang, "kit.menu")) +
    '" aria-expanded="false" aria-controls="den-rail">☰</button>' +
    '<a class="den-brand" href="' +
    esc(product.href || "/") +
    '" title="' +
    esc(product.title || name) +
    '">' +
    '<span class="den-mark" id="den-mark" aria-hidden="true"></span>' +
    // The brand is a name, not a heading: the page's own h1 is its one.
    '<span class="den-title">' +
    esc(name) +
    "</span></a>" +
    (slots.start || "") +
    '<div class="den-chips">' +
    (slots.end || "") +
    (report === false ? "" : reportButtonHtml({ inTop: true, lang })) +
    (slots.bell || "") +
    versionChipHtml({ version: product.version, lang }) +
    (slots.account || "") +
    "</div>" +
    "</header>"
  );
}

/**
 * The whole shell: the skip link, the top bar and the rail (in its box:
 * no box of its own, display: contents; as ☰'s drawer it is the modal
 * dialog the rail sits in, so the rail stays a nav).
 */
export function shellHtml(o = {}) {
  const lang = o.lang;
  return (
    '<a class="den-skip" href="#den-content">' +
    esc(kitT(lang, "kit.skip")) +
    "</a>" +
    topBarHtml(o) +
    '<div class="den-rail-box" id="den-rail-box">' +
    '<nav class="den-rail" id="den-rail" aria-label="' +
    esc(kitT(lang, "kit.pages")) +
    '">' +
    railHtml(o) +
    "</nav></div>"
  );
}
