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
 *   shellHtml({ product, nav, groups, foot, settings, account, lang, slots,
 *               collapsed, report })
 *     product  { name, title?, version?, href?, mark? }   the brand: `name` is the
 *              word beside the mark, `title` its tooltip (default name),
 *              `version` the chip's text ("v" + version; "v…" when unknown),
 *              `href` where the brand goes (default "/"), `mark`
 *              { text?, svg?, label } the mark beside it (text escaped;
 *              svg the product's own markup; label its name)
 *     nav      [{ id, label, href, group, icon?, tip?, current?, badge?,
 *              lead?, mono?, cls?, attrs?, pin?, after? }]   rail entries
 *     groups   [{ id, label, from? }]   in rail order; a group with no
 *              entry is left out
 *     foot     entries under the rail's spacer (Settings, say), then the
 *              kit's collapse toggle
 *     settings (0.7.0) the Settings entry, after foot: { href, label?,
 *              current?, id? } (settingsHtml)
 *     account  (0.7.0) the account entry, last in the foot: { label,
 *              detail?, href? | action? } (accountHtml)
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
 *
 * 0.7.0, for the slots: scopeHtml (the scope crumbs), searchHtml (the
 * search field with ⌘K inside), bellButtonHtml and bellPanelHtml (the
 * bell and its panel); and accountHtml (the rail's account entry).
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
  settings,
  account,
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
  html += settingsHtml(settings, lang);
  html += accountHtml(account);
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
 * phone). `inFoot`: a pop-up's footer; `inTop`: the top bar. `label`:
 * the button's own words (a row's "Report this"), its name too. `prefill`:
 * { kind?, title?, description? }, kept as JSON on the button; the kit's
 * click opens Report with it. A click on any [data-den-report] opens the
 * Report form (the client's job).
 */
export function reportButtonHtml({ inFoot, inTop, lang, label, prefill } = {}) {
  return (
    '<button type="button" class="den-rb' +
    (inFoot ? " den-rb-in" : "") +
    (inTop ? " den-rb-top" : "") +
    '" data-den-report' +
    (prefill
      ? ' data-den-report-prefill="' + esc(JSON.stringify(prefill)) + '"'
      : "") +
    (label != null ? ' aria-label="' + esc(label) + '"' : "") +
    ' aria-keyshortcuts="Meta+Shift+F Control+Shift+F" title="' +
    esc(kitT(lang, "kit.report.tip")) +
    '">' +
    icon("report") +
    "<span>" +
    esc(label != null ? label : kitT(lang, "kit.report.word")) +
    '</span><kbd aria-hidden="true">⌘⇧F</kbd></button>'
  );
}

/** A Report button's prefill (data-den-report-prefill), or undefined. */
export function reportPrefillOf(el) {
  const raw =
    el && el.getAttribute && el.getAttribute("data-den-report-prefill");
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The brand's mark: none, the empty slot (a product may fill it itself);
 * `text`, escaped; or `svg`, the product's own markup (the same trust as
 * the icons). `label` names it.
 */
function markHtml(mark) {
  if (!mark || (mark.text == null && mark.svg == null))
    return '<span class="den-mark" id="den-mark" aria-hidden="true"></span>';
  return (
    '<span class="den-mark" id="den-mark" role="img" aria-label="' +
    esc(mark.label ?? "") +
    '">' +
    (mark.svg != null ? String(mark.svg) : esc(mark.text)) +
    "</span>"
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
    markHtml(product.mark) +
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

// ── 0.7.0: the scope crumbs, the search field, the bell, the account ────
// Pieces of the top bar and the rail a host gave as its own HTML before.
// The host gives the words and the values; the kit draws them, and
// shell-client.js wires them (hydrateScope, hydrateSearch, hydrateBell,
// hydrateAccount). A piece left out draws nothing.

/** Crumb ids: "den-scope-<key>" unless the host names its own. */
const crumbId = (c) => c.id || "den-scope-" + (c.key || "x");

/**
 * Whether a menu of `n` entries gets the filter field: `filter` false
 * never, a number past that many, true always, else past 6.
 */
export function menuHasFilter(filter, n) {
  if (filter === false) return false;
  if (filter === true) return true;
  return n > (typeof filter === "number" ? filter : 6);
}

/**
 * A menu's type-to-filter field (first in it) and its "No match" line
 * (last): [field, none]. `label`: the menu's name ("Filter <label>").
 */
export function menuFilterParts(menuId, label, lang) {
  return [
    '<input type="search" class="den-mfilter" id="' +
      esc(menuId) +
      '-filter" aria-label="' +
      esc(kitT(lang, "kit.menu.filter", { label: label ?? "" })) +
      '" placeholder="' +
      esc(kitT(lang, "kit.menu.filter.ph")) +
      '" autocomplete="off" spellcheck="false">',
    '<p class="den-mnote den-mnone" role="status" hidden>' +
      esc(kitT(lang, "kit.menu.none")) +
      "</p>",
  ];
}

/** A crumb's menu, drawn by the kit: links ({ label, href, current }) or HTML. */
function crumbMenuHtml(c, lang) {
  const m = c.menu;
  if (!m || m === true) return "";
  const menuId = crumbId(c) + "-menu";
  // A long list: a type-to-filter field first, "No match" last.
  const filter =
    Array.isArray(m) && menuHasFilter(c.filter, m.length)
      ? menuFilterParts(menuId, c.label, lang)
      : ["", ""];
  const body = Array.isArray(m)
    ? m
        .map(
          (l) =>
            '<a class="den-mi" role="menuitem" href="' +
            esc(l.href) +
            '"' +
            (l.current ? ' aria-current="true"' : "") +
            '><span class="den-mi-l">' +
            esc(l.label) +
            "</span></a>",
        )
        .join("")
    : String(m);
  return (
    '<div class="den-pop den-scope-menu" id="' +
    esc(menuId) +
    '" role="menu" aria-label="' +
    esc(c.label) +
    '" hidden>' +
    filter[0] +
    body +
    filter[1] +
    "</div>"
  );
}

/**
 * One scope crumb: its small-caps key and its value. With a menu, a
 * button with ▾ (aria-haspopup="menu"); without, a plain label.
 *   { key, label, value, menu?, id?, title?, hidden?, optional?, cls?,
 *     valueCls? }
 * `menu`: links [{ label, href, current? }] or HTML (the kit draws and
 * opens it), or true (the host opens its own: hydrateScope's onOpen).
 * `filter`: a type-to-filter field at the top of a list of links: by
 * default past 6 of them; a number sets that threshold; false, never.
 * `optional`: the first to give way on a narrow bar. `cls`: more classes;
 * `valueCls`: more classes on the value.
 */
export function scopeCrumbHtml(c, lang) {
  if (!c) return "";
  const id = crumbId(c);
  const title = c.title != null ? ' title="' + esc(c.title) + '"' : "";
  const hidden = c.hidden ? " hidden" : "";
  const more = (c.cls ? " " + esc(c.cls) : "") + (c.optional ? " den-opt" : "");
  const key = '<span class="den-k">' + esc(c.label) + "</span> ";
  if (!c.menu)
    return (
      '<span id="' +
      esc(id) +
      '" class="den-ib' +
      more +
      '"' +
      hidden +
      title +
      ">" +
      key +
      '<span class="' +
      esc(c.valueCls || "den-vn") +
      '">' +
      esc(c.value ?? "") +
      "</span></span>"
    );
  const own = c.menu !== true;
  return (
    '<button type="button" id="' +
    esc(id) +
    '" class="den-ib den-scope-btn' +
    more +
    '" data-scope="' +
    esc(c.key || "") +
    '" aria-haspopup="menu" aria-expanded="false"' +
    (own ? ' aria-controls="' + esc(id) + '-menu"' : "") +
    hidden +
    title +
    ">" +
    key +
    '<span class="den-v"><span class="den-vn' +
    (c.valueCls ? " " + esc(c.valueCls) : "") +
    '">' +
    esc(c.value ?? "") +
    '</span> <span aria-hidden="true">▾</span></span></button>' +
    crumbMenuHtml(c, lang)
  );
}

/**
 * The scope crumbs: / KEY value ▾ / KEY value ▾ …, a group named "Scope".
 *   scopeHtml({ crumbs, label?, lang, after? })
 * A crumb left out (null, or not in the list) draws nothing, and no
 * separator. Each separator after a crumb is "den-sep den-<key>-sep",
 * hidden with it. `after`: the host's HTML at the group's end (a hidden
 * <select> its pages read, say). No crumbs: nothing at all.
 */
export function scopeHtml({ crumbs, label, lang, after } = {}) {
  const list = (crumbs || []).filter(Boolean);
  if (!list.length) return "";
  let html =
    '<div class="den-scope" role="group" aria-label="' +
    esc(label ?? kitT(lang, "kit.scope")) +
    '"><span class="den-sep" aria-hidden="true">/</span>';
  list.forEach((c, i) => {
    html += scopeCrumbHtml(c, lang);
    if (i < list.length - 1)
      html +=
        '<span class="den-sep den-' +
        esc(c.key || "x") +
        '-sep" aria-hidden="true"' +
        (c.hidden ? " hidden" : "") +
        ">/</span>";
  });
  return html + (after || "") + "</div>";
}

/**
 * The search field: the placeholder, then ⌘K inside it, as a button (the
 * host's palette or page opens on it: hydrateSearch).
 *   searchHtml({ placeholder?, label?, id?, shortcut?, lang })
 * `label`: its name (default the placeholder); `shortcut: false`: no ⌘K.
 */
export function searchHtml({ placeholder, label, id, shortcut, lang } = {}) {
  const ph = placeholder ?? kitT(lang, "kit.search.ph");
  const keys = shortcut !== false;
  return (
    '<button type="button" class="den-search" id="' +
    esc(id || "den-search") +
    '" aria-haspopup="dialog"' +
    (keys ? ' aria-keyshortcuts="Meta+K Control+K"' : "") +
    ' aria-label="' +
    esc(label ?? ph) +
    '"><span class="den-search-ph">' +
    esc(ph) +
    "</span>" +
    (keys ? '<kbd aria-hidden="true">⌘K</kbd>' : "") +
    '<span class="den-search-ic" aria-hidden="true">⌕</span></button>'
  );
}

/** The bell's count on its badge: "" for none, 99+ past 99. */
export function bellCount(n) {
  const c = Number(n) || 0;
  return c <= 0 ? "" : c > 99 ? "99+" : String(c);
}

/**
 * The bell: a button that opens the notifications panel, with its count.
 *   bellButtonHtml({ count?, label?, id?, lang })
 * Its name says the count ("Notifications: 3 unread").
 */
export function bellButtonHtml({ count, label, id, lang } = {}) {
  const n = Number(count) || 0;
  const word = label ?? kitT(lang, "kit.bell");
  const name = n > 0 ? kitT(lang, "kit.bell.n", { n }) : word;
  return (
    '<button type="button" class="den-ib den-bell" id="' +
    esc(id || "den-bell") +
    '" aria-haspopup="dialog" aria-expanded="false" aria-label="' +
    esc(name) +
    '" title="' +
    esc(word) +
    '"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>' +
    '<span class="den-bell-n"' +
    (n > 0 ? "" : " hidden") +
    ">" +
    esc(bellCount(n)) +
    "</span></button>"
  );
}

/** One row of the bell's panel. */
function bellRowHtml(it) {
  const text = esc(it.text ?? "");
  return (
    '<div class="den-bell-row' +
    (it.read ? " read" : "") +
    '"' +
    (it.id != null ? ' data-id="' + esc(it.id) + '"' : "") +
    ">" +
    (it.href != null
      ? '<a href="' + esc(it.href) + '">' + text + "</a>"
      : '<span class="den-bell-t">' + text + "</span>") +
    (it.time
      ? "<time" +
        (it.datetime ? ' datetime="' + esc(it.datetime) + '"' : "") +
        ">" +
        esc(it.time) +
        "</time>"
      : "") +
    "</div>"
  );
}

/**
 * The bell's panel content: its heading, then rows or the empty state.
 *   bellPanelHtml({ title?, titleId?, actions?, lead?, items?, body?,
 *                   empty?, after?, foot?, lang })
 * `items`: [{ text, href?, time?, datetime?, read?, id? }], drawn as rows;
 * or `body`, the host's own HTML for them. Neither (or no items): the
 * empty state, `empty` { text?, more? } (more: HTML under the words).
 * `actions`: buttons beside the heading (Mark all read); `lead`: HTML
 * under the heading; `after`: HTML after the rows; `foot`: the footer (a
 * Report button). Every HTML part is the host's own.
 */
export function bellPanelHtml({
  title,
  titleId,
  actions,
  lead,
  items,
  body,
  empty,
  after,
  foot,
  lang,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const e = empty || {};
  const rows =
    body != null && body !== ""
      ? body
      : list.length
        ? list.map(bellRowHtml).join("")
        : '<div class="den-bell-empty"><p>' +
          esc(e.text ?? kitT(lang, "kit.bell.empty")) +
          "</p>" +
          (e.more || "") +
          "</div>";
  return (
    '<div class="den-bell-hd"><h2 id="' +
    esc(titleId || "den-bell-h") +
    '">' +
    esc(title ?? kitT(lang, "kit.bell")) +
    "</h2>" +
    (actions || "") +
    "</div>" +
    (lead || "") +
    rows +
    (after || "") +
    (foot || "")
  );
}

/**
 * The account entry, in the rail's foot: who is signed in, here.
 *   accountHtml({ label, detail?, href?, action?, icon?, id?, navId?,
 *                 attrs?, current? })
 * `href`: a link; else `menu` true: a button opening the account menu
 * (accountMenuHtml, hydrateAccount's menu; id "den-account" unless
 * given); else `action` true: a button (hydrateAccount's onAction). The
 * name and tooltip read "label · detail". It is a rail entry (.den-ni)
 * marked data-den-account. No label: nothing.
 */
export function accountHtml(a) {
  if (!a || !a.label) return "";
  const full = a.detail ? a.label + " · " + a.detail : a.label;
  const more = { ...(a.attrs || {}) };
  if (a.id) more.id = a.id;
  const words =
    '<span class="den-lbl">' +
    esc(a.label) +
    (a.detail
      ? '<span class="den-acct-d"> · ' + esc(a.detail) + "</span>"
      : "") +
    "</span>";
  if (a.href == null && a.menu && !a.id) more.id = "den-account";
  const open =
    a.href != null
      ? '<a class="den-ni" data-den-account href="' + esc(a.href) + '"'
      : a.menu
        ? '<button type="button" class="den-ni" data-den-account aria-haspopup="menu" aria-expanded="false"'
        : '<button type="button" class="den-ni" data-den-account data-act="account"';
  return (
    open +
    ' data-nav="' +
    esc(a.navId || "account") +
    '"' +
    (a.current ? ' aria-current="page"' : "") +
    attrs(more) +
    ' title="' +
    esc(full) +
    '">' +
    icon(a.icon || "person") +
    words +
    (a.href != null ? "</a>" : "</button>")
  );
}

/**
 * The Settings entry, in the rail's foot after the host's entries.
 *   settingsHtml({ href, label?, current?, id? }, lang)
 * No href: nothing.
 */
export function settingsHtml(o, lang) {
  if (!o || !o.href) return "";
  return navItemHtml({
    id: o.id || "settings",
    href: o.href,
    label: o.label ?? kitT(lang, "kit.settings"),
    icon: "settings",
    current: !!o.current,
  });
}

/**
 * The appearance button, ◐ ▾, last in the bar (the `account` slot): its
 * menu (hydrateAppearance) holds the mode, the theme and the language.
 *   appearanceButtonHtml({ id?, label?, title?, lang })
 */
export function appearanceButtonHtml({ id, label, title, lang } = {}) {
  return (
    '<button id="' +
    esc(id || "appearance-btn") +
    '" type="button" class="den-ib appearance-btn" title="' +
    esc(title ?? kitT(lang, "kit.appearance.title")) +
    '" aria-label="' +
    esc(label ?? kitT(lang, "kit.appearance")) +
    '" aria-haspopup="menu" aria-expanded="false"><span aria-hidden="true">◐ ▾</span></button>'
  );
}

/** One row of a kit menu: a radio (checked set), a link or a button. */
function menuRowHtml(r) {
  const radio = r.checked != null;
  const tag = r.href != null ? "a" : "button";
  return (
    "<" +
    tag +
    ' class="den-mi" tabindex="-1" role="' +
    (radio ? "menuitemradio" : "menuitem") +
    '"' +
    (radio ? ' aria-checked="' + (r.checked ? "true" : "false") + '"' : "") +
    (r.href != null ? ' href="' + esc(r.href) + '"' : ' type="button"') +
    (r.kind ? ' data-kind="' + esc(r.kind) + '"' : "") +
    (r.value != null ? ' data-value="' + esc(r.value) + '"' : "") +
    '><span class="den-mi-l">' +
    esc(r.label) +
    "</span></" +
    tag +
    ">"
  );
}

/**
 * The appearance menu's content.
 *   appearanceMenuHtml({ mode, modes?, themes?, notice?, languages?,
 *                        items?, lang })
 * mode: "system", "dark" or "light" (checked); modes: [{ value, label }]
 * (default the kit's System, Dark, Light); themes: [{ value, label,
 * selected? }]; notice: a line under the themes; languages: [{ id, name,
 * current? }], each named in itself; items: [{ label, href? | id }] after
 * a rule (Settings, say). A part with nothing in it draws nothing.
 */
export function appearanceMenuHtml({
  mode,
  modes,
  themes,
  notice,
  languages,
  items,
  lang,
} = {}) {
  const head = (w) =>
    '<div class="den-ml" aria-hidden="true">' + esc(w) + "</div>";
  const hr = '<div class="den-hr" role="separator"></div>';
  const ms = modes || [
    { value: "system", label: kitT(lang, "kit.mode.system") },
    { value: "dark", label: kitT(lang, "kit.mode.dark") },
    { value: "light", label: kitT(lang, "kit.mode.light") },
  ];
  const parts = [];
  parts.push(
    head(kitT(lang, "kit.appearance")) +
      ms
        .map((m) =>
          menuRowHtml({
            label: m.label,
            checked: m.value === mode,
            kind: "mode",
            value: m.value,
          }),
        )
        .join(""),
  );
  if ((themes && themes.length) || notice)
    parts.push(
      head(kitT(lang, "kit.theme")) +
        (themes || [])
          .map((t) =>
            menuRowHtml({
              label: t.label,
              checked: !!t.selected,
              kind: "theme",
              value: t.value ?? "",
            }),
          )
          .join("") +
        (notice
          ? '<p class="den-mnote" role="status">' + esc(notice) + "</p>"
          : ""),
    );
  if (languages && languages.length)
    parts.push(
      head(kitT(lang, "kit.language")) +
        languages
          .map((l) =>
            menuRowHtml({
              label: l.name,
              checked: !!l.current,
              kind: "language",
              value: l.id,
            }),
          )
          .join(""),
    );
  if (items && items.length)
    parts.push(
      items
        .map((it) =>
          menuRowHtml({
            label: it.label,
            href: it.href,
            kind: "item",
            value: it.id,
          }),
        )
        .join(""),
    );
  return parts.join(hr);
}

/**
 * The account entry's menu: who is signed in (name), where (detail), a
 * rule, then the entries.
 *   accountMenuHtml({ name, detail?, items, lang })
 * items: [{ label, href }] links, [{ label, id }] buttons (onPick "item"),
 * or [{ label, action: { method?, url, csrf?, field? } }]: a form that
 * posts to url on its own, with no script (csrf, if any, in a hidden
 * field named `field`, "csrf" by default).
 */
export function accountMenuHtml({ name, detail, items } = {}) {
  const parts = [];
  const who =
    (name ? '<div class="den-ml">' + esc(name) + "</div>" : "") +
    (detail ? '<p class="den-mnote">' + esc(detail) + "</p>" : "");
  if (who) parts.push(who);
  const rows = (items || [])
    .map((it) => {
      if (!it || !it.label) return "";
      const a = it.action;
      if (a && a.url)
        return (
          '<form class="den-mform" method="' +
          esc(a.method || "post") +
          '" action="' +
          esc(a.url) +
          '">' +
          (a.csrf != null
            ? '<input type="hidden" name="' +
              esc(a.field || "csrf") +
              '" value="' +
              esc(a.csrf) +
              '">'
            : "") +
          '<button type="submit" class="den-mi" tabindex="-1" role="menuitem"><span class="den-mi-l">' +
          esc(it.label) +
          "</span></button></form>"
        );
      return menuRowHtml({
        label: it.label,
        href: it.href,
        kind: "item",
        value: it.id,
      });
    })
    .join("");
  if (rows) parts.push(rows);
  return parts.join('<div class="den-hr" role="separator"></div>');
}

/**
 * The update-waiting pill beside the version chip: ⚠ and its words, a
 * button (setWaiting in version.js shows and wires it).
 *   waitingHtml({ label, action, title?, name?, id? })
 * Reads "⚠ label · action"; below 720px only ⚠.
 */
export function waitingHtml({ label, action, title, name, id } = {}) {
  return (
    '<button id="' +
    esc(id || "stale-pill") +
    '" class="stale-pill"' +
    (title != null ? ' title="' + esc(title) + '"' : "") +
    (name != null ? ' aria-label="' + esc(name) + '"' : "") +
    '><span aria-hidden="true">⚠</span><span class="stale-lbl"> ' +
    esc(label ?? "") +
    (action != null ? " · <b>" + esc(action) + "</b>" : "") +
    "</span></button>"
  );
}
