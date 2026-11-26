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
 *              lead?, mono?, cls?, attrs?, pin?, after?, kind?, off? }]   rail
 *              entries
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
 *   An entry: `badge` { n, bad?, what? } (what it counts: "open",
 *   "waiting", "down", "running", read with the name in the kit's words);
 *   `lead` HTML in place of the icon (a status dot); `attrs` more
 *   attributes { name: value } (escaped); `cls` more classes; `pin` the
 *   pinned id (the row is a pin row: Delete unpins it); `after` HTML after
 *   the link inside the pin row (a Visit link); `kind` (0.7.3) "project",
 *   "den", "service", "hub" or { artifact: word }: a small uppercase tag at
 *   the row's end; its tooltip and name are the kit's ("North · Project");
 *   `off` (0.7.4) "connect", "reconnect", "forbidden", "unreachable" or
 *   "config": the entry is greyed and the kit says why ("Acme Co · Hub,
 *   reconnect in Settings"); `icon`
 *   { initial } a project's initial in a disc in place of the icon.
 *
 * 0.7.0, for the slots: scopeHtml (the scope crumbs), searchHtml (the
 * search field with ⌘K inside), bellButtonHtml and bellPanelHtml (the
 * bell and its panel); and accountHtml (the rail's account entry).
 */
import { esc, kitT, safeId } from "./strings.js";
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

/** The fixed kinds a rail entry may name (issue 307). */
export const NAV_KINDS = ["project", "den", "service", "hub"];

/**
 * A rail entry's kind (issue 307), from its data: one of NAV_KINDS (any
 * case), or { artifact: "<word>" }, an artifact pin's own kind word (the
 * host's, already in its language). Anything else is no kind: the tag
 * never names a machine. → { id, word } or null.
 */
export function navKind(kind, lang) {
  if (kind == null) return null;
  if (typeof kind === "string") {
    const id = kind.trim().toLowerCase();
    return NAV_KINDS.includes(id)
      ? { id, word: kitT(lang, "kit.kind." + id) }
      : null;
  }
  if (typeof kind === "object" && kind.artifact != null) {
    const word = String(kind.artifact).trim();
    return word ? { id: "artifact", word } : null;
  }
  return null;
}

/**
 * Attributes that carry a host's words, not data: never in an entry of the rail
 * (issue 307). data-* attributes are data and stay allowed.
 */
export const HOST_TEXT_ATTRS = [
  "title",
  "aria-label",
  "aria-labelledby",
  "aria-description",
];

/** What a badge counts (issue 307): the kit words it. */
export const BADGE_WHATS = ["open", "waiting", "down", "running"];

/**
 * Why a rail entry is off (issue 326): the kit greys it (.den-off) and
 * words why. "connect" (not connected yet), "reconnect" (its sign-in is
 * no longer accepted), "forbidden" (not allowed; an admin decides),
 * "unreachable" (can't be reached right now), "config" (its settings have
 * a problem). Anything else is dropped.
 */
export const NAV_OFFS = [
  "connect",
  "reconnect",
  "forbidden",
  "unreachable",
  "config",
];

/** An entry's off reason, from its data, or null. */
export function navOff(off) {
  const id = typeof off === "string" ? off.trim().toLowerCase() : "";
  return NAV_OFFS.includes(id) ? id : null;
}

/**
 * A badge's words, from its data: "3 waiting". Without a `what` (a plain
 * total) the kit reads the bare number, so "Hub Docs, 4" still says the
 * count the visible badge (aria-hidden) shows. Nothing to count: none.
 */
function badgeWords(b, lang) {
  if (!b || b.n == null || b.n === "") return "";
  const n = typeof b.n === "number" ? b.n : String(b.n);
  if (BADGE_WHATS.includes(b.what))
    return kitT(lang, "kit.badge." + b.what, { n });
  if (typeof n !== "number") return n;
  try {
    return new Intl.NumberFormat(lang || undefined).format(n);
  } catch {
    return String(n);
  }
}

/** The icon, or (issue 307) a project's initial in a disc: { initial }. */
function leadIcon(ic) {
  if (ic && typeof ic === "object") {
    const ch = Array.from(String(ic.initial ?? "").trim())[0] || "";
    return (
      '<span class="den-ini" aria-hidden="true">' +
      esc(ch.toLocaleUpperCase()) +
      "</span>"
    );
  }
  return icon(ic);
}

/**
 * One rail entry (a link, .den-ni). `navRole`: the data-nav-role the nav
 * inventory reads ("page" for a rail group's entries: host content).
 * `lang`: the kit's words (the kind tag's).
 *
 * `kind` (issue 307): a small uppercase tag at the row's end, in the scope
 * labels' look (.den-k), for pins and links into another product. The
 * tooltip and the name are always the kit's: "<label> · <Kind>" (and a
 * badge's label after a comma), so a collapsed rail still says it. A
 * host's tip, title or aria-label on such an entry is not used: hosts pass
 * data, the kit owns the words.
 *
 * `badge.what` ("open", "waiting", "down", "running"): what the badge
 * counts; the kit words it ("North · Den, 3 waiting"). Without one, the
 * bare number reads ("Hub Docs, 4"). A label that is
 * its kind word reads once ("Hub", not "Hub · Hub"). A pin row gets
 * aria-keyshortcuts="Delete" from the kit.
 *
 * `off` (issue 326, NAV_OFFS): the entry is greyed (.den-off) and its
 * tooltip and name say why in the kit's words ("Acme Co · Hub, reconnect
 * in Settings"); an entry without a kind reads "<label>, <why>". An `off`
 * the kit doesn't know is dropped.
 *
 * Host text on any entry (HOST_TEXT_ATTRS in `attrs`, a badge's `label`)
 * is stamped data-nav-host-text, and the nav inventory fails on it.
 */
export function navItemHtml(n, navRole, lang) {
  const role =
    typeof navRole === "string" ? ' data-nav-role="' + esc(navRole) + '"' : "";
  const b = n.badge || null;
  const kind = navKind(n.kind, lang);
  const off = navOff(n.off);
  const waits =
    b && b.what === "waiting" && b.n != null && b.n !== ""
      ? ' title="' +
        esc(kitT(lang, "kit.badge.waiting.title", { n: b.n })) +
        '"'
      : "";
  const extra = b
    ? '<span class="den-bdg' +
      (b.bad ? " bad" : "") +
      '" aria-hidden="true"' +
      waits +
      ">" +
      esc(b.n) +
      "</span>"
    : "";
  const tag = kind
    ? '<span class="den-k den-ni-kind" data-nav-role="kind" aria-hidden="true">' +
      esc(kind.word) +
      "</span>"
    : "";
  const more = { ...(n.attrs || {}) };
  // Host text: words a host put on the entry itself. Never used on an
  // entry with a kind; stamped for the nav inventory, which fails on it.
  const hostText = HOST_TEXT_ATTRS.filter((k) => more[k] != null);
  if (b && b.label != null) hostText.push("badge.label");
  // A label that is its kind word (any case) reads once: "Hub", never
  // "Hub · Hub".
  const same =
    kind &&
    String(n.label).trim().toLocaleLowerCase() ===
      kind.word.trim().toLocaleLowerCase();
  const named = kind && !same ? n.label + " · " + kind.word : n.label;
  const counted = badgeWords(b, lang);
  // Issue 326: why it is off, in the kit's words, after the name.
  const why = off ? kitT(lang, "kit.off." + off) : "";
  const tip = why ? named + ", " + why : named;
  if (kind || off) {
    for (const k of HOST_TEXT_ATTRS) delete more[k];
    more["aria-label"] = [named, counted, why].filter(Boolean).join(", ");
    if (kind) more["data-nav-kind"] = kind.id;
    if (off) more["data-nav-off"] = off;
  } else if (more["aria-label"] == null && (counted || (b && b.label)))
    // Without a kind, as before: a badge's label still reads (flagged).
    more["aria-label"] = named + ", " + (counted || b.label);
  // A pin row's Delete (unpin) is the kit's own feature: its shortcut too.
  if (n.pin != null) more["aria-keyshortcuts"] = "Delete";
  if (hostText.length) more["data-nav-host-text"] = hostText.join(",");
  const link =
    '<a class="den-ni' +
    (n.cls ? " " + esc(n.cls) : "") +
    (off ? " den-off" : "") +
    '" href="' +
    esc(n.href) +
    '" data-nav="' +
    esc(n.id) +
    '"' +
    (n.pin != null ? "" : role) +
    (n.current ? ' aria-current="page"' : "") +
    attrs(more) +
    ' title="' +
    esc(kind || off ? tip : n.tip || n.label) +
    '">' +
    (n.lead || leadIcon(n.icon)) +
    '<span class="den-lbl' +
    (n.mono ? " den-mono" : "") +
    '">' +
    esc(n.label) +
    "</span>" +
    extra +
    tag +
    "</a>";
  return n.pin != null
    ? '<div class="den-pin-row"' +
        role +
        ">" +
        link +
        (n.after || "") +
        "</div>"
    : link;
}

/**
 * A rail group: its heading (and "from <d>" tag) and its entries, in
 * div.den-gb. Issue 1444: `folded` marks it data-folded; the heading stays
 * plain, and only hydrateRailFolds (shell-client.js) makes it the toggle,
 * so a page with no script shows every entry.
 */
export function railGroupHtml(g, body, lang, folded) {
  const id = esc(g.id);
  const from = g.from;
  return (
    '<div class="den-rail-group" data-nav-role="rail-group" role="group" aria-labelledby="den-gh-' +
    id +
    '"' +
    (from ? ' aria-describedby="den-gd-' + id + '"' : "") +
    (folded ? " data-folded" : "") +
    '><div class="den-gh" data-nav-role="group"><span id="den-gh-' +
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
    '<div class="den-gb" id="den-gb-' +
    id +
    '">' +
    body +
    "</div></div>"
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

/**
 * The rail's content: the groups, the spacer, then the foot (a host's
 * foot entries, Settings, the account entry, the toggle) in one
 * .den-rail-foot. The foot stays pinned at the rail's bottom while the
 * groups scroll above it (issue 1341).
 */
export function railHtml({
  nav = [],
  groups = [],
  foot = [],
  settings,
  account,
  lang,
  collapsed,
  folded = [],
} = {}) {
  let html = "";
  const fold = new Set(Array.isArray(folded) ? folded : []);
  for (const g of groups) {
    const items = nav.filter((n) => n.group === g.id);
    if (!items.length) continue;
    html += railGroupHtml(
      g,
      items.map((n) => navItemHtml(n, "page", lang)).join(""),
      lang,
      fold.has(g.id) && !items.some((n) => n.current),
    );
  }
  html += '<div class="den-rail-grow"></div>';
  html += '<div class="den-rail-foot">';
  html += foot
    .map((n) => (typeof n === "string" ? n : navItemHtml(n, undefined, lang)))
    .join("");
  html += settingsHtml(settings, lang);
  html += accountHtml(account);
  html += collapseHtml(!!collapsed, lang);
  html += "</div>";
  return html;
}

/** The version chip: "v<version>" (v… until known); a click opens What's new. */
export function versionChipHtml({ version, lang } = {}) {
  return (
    '<button class="den-ib v-pill" id="version-pill" title="' +
    esc(kitT(lang, "kit.version.title")) +
    '"><span class="v-txt"' +
    (version
      ? ' title="v' + esc(String(version).replace(/^v/, "")) + '"'
      : "") +
    ">" +
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
/**
 * The brand's mark (#den-mark).
 *   { src, label }: an image file (the default: the kit's marks/den.svg),
 *     drawn as Den's theme draws its own: span.den-mark.den-mark-svg,
 *     titled by label, holding an 18px <img alt="">. An image runs no
 *     script, so no markup of the host's is trusted.
 *   { text, label }: escaped text. { svg, label }: the host's own markup.
 *   none: the empty slot.
 */
export function markHtml(mark) {
  if (mark && mark.src != null)
    return (
      '<span class="den-mark den-mark-svg" id="den-mark" aria-hidden="true" title="' +
      esc(mark.label ?? "") +
      '"><img src="' +
      esc(mark.src) +
      '" alt="" width="18" height="18"></span>'
    );
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

/** Where the kit's search starts in a `start` slot (searchHtml's markup). */
const SEARCH_AT = '<button type="button" class="den-search"';

/**
 * The top bar (header.den-top), in three parts (issue 303): the left part
 * (☰, the brand, and what `start` holds before the search: the crumbs),
 * the search in a fixed slot, and the chips (the host's `end`, then
 * Report, the bell, the version and ◐ ▾, pinned to the right edge).
 * `rail: false` (issue 694): a page with no rail. No ☰ (it would open
 * nothing) and nothing that points at the rail; the header is stamped
 * data-nav-shape="no-rail" for the parity gate. The rest is the same bar.
 */
export function topBarHtml({
  product = {},
  lang,
  slots = {},
  report = true,
  rail = true,
} = {}) {
  const name = product.name ?? "";
  const start = slots.start || "";
  const at = start.indexOf(SEARCH_AT);
  const before = at < 0 ? start : start.slice(0, at);
  const search = at < 0 ? "" : start.slice(at);
  return (
    (rail === false
      ? '<header class="den-top" data-nav-shape="no-rail">'
      : '<header class="den-top">') +
    '<div class="den-left">' +
    (rail === false
      ? ""
      : '<button class="den-ib den-menu-btn" id="den-menu-btn" aria-label="' +
        esc(kitT(lang, "kit.menu")) +
        '" aria-expanded="false" aria-controls="den-rail">☰</button>') +
    '<a class="den-brand" href="' +
    esc(product.href || "/") +
    '" title="' +
    esc(product.title || name) +
    '">' +
    markHtml(product.mark) +
    // The brand is a name, not a heading: the page's own h1 is its one.
    '<span class="den-title" data-nav-role="brand-title">' +
    esc(name) +
    "</span></a>" +
    before +
    "</div>" +
    search +
    '<div class="den-chips">' +
    // The host's chips' group, always drawn (empty without chips): the
    // bar's structure is the same in any host.
    '<div class="den-end">' +
    (slots.end || "") +
    "</div>" +
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
 * dialog the rail sits in, so the rail stays a nav). `rail: false`
 * (issue 694): the skip link and the bar without ☰, and no rail.
 */
export function shellHtml(o = {}) {
  const lang = o.lang;
  return (
    '<a class="den-skip" href="#den-content">' +
    esc(kitT(lang, "kit.skip")) +
    "</a>" +
    topBarHtml(o) +
    (o.rail === false ? "" : railBoxHtml(o))
  );
}

function railBoxHtml(o) {
  const lang = o.lang;
  return (
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
      '-filter" aria-controls="' +
      esc(menuId) +
      '-list" aria-label="' +
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
  // With a filter, the pop-up holds the field, then the role="menu" list
  // (a menu owns only its items), then "No match".
  if (filter[0])
    return (
      '<div class="den-pop den-scope-menu" id="' +
      esc(menuId) +
      '" hidden>' +
      filter[0] +
      '<div class="den-mlist" role="menu" id="' +
      esc(menuId) +
      '-list" aria-label="' +
      esc(c.label) +
      '">' +
      body +
      "</div>" +
      filter[1] +
      "</div>"
    );
  return (
    '<div class="den-pop den-scope-menu" id="' +
    esc(menuId) +
    '" role="menu" aria-label="' +
    esc(c.label) +
    '" hidden>' +
    body +
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
      '" data-nav-role="crumb"' +
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
    '" data-nav-role="crumb" aria-haspopup="menu" aria-expanded="false"' +
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
  // Each separator after a crumb comes and goes with it: host content.
  list.forEach((c, i) => {
    // The last crumb is kept whole when the crumbs give way (issue 303).
    const last = i === list.length - 1;
    html += scopeCrumbHtml(
      last ? { ...c, cls: (c.cls ? c.cls + " " : "") + "den-last" } : c,
      lang,
    );
    if (i < list.length - 1)
      html +=
        '<span class="den-sep den-' +
        esc(c.key || "x") +
        '-sep" data-nav-role="crumb-sep" aria-hidden="true"' +
        (c.hidden ? " hidden" : "") +
        ">/</span>";
  });
  return html + (after || "") + "</div>";
}

/**
 * The search field: the kit's placeholder ("Search…"), then ⌘K inside it,
 * as a button (the host's palette or page opens on it: hydrateSearch).
 *   searchHtml({ id?, shortcut?, lang })
 * Its placeholder and its name ("Search") are the kit's words, in the
 * page's language: one search in every product, so a host can't set them.
 * `shortcut: false`: no ⌘K.
 */
export function searchHtml({ id, shortcut, lang } = {}) {
  const keys = shortcut !== false;
  return (
    '<button type="button" class="den-search" id="' +
    esc(id || "den-search") +
    '" aria-haspopup="dialog" data-nav-kit="search"' +
    (keys ? ' aria-keyshortcuts="Meta+K Control+K"' : "") +
    ' aria-label="' +
    esc(kitT(lang, "kit.search.label")) +
    '"><span class="den-search-ph">' +
    esc(kitT(lang, "kit.search.ph")) +
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
 * Issue 101: `sections` { needs, earlier? } in place of rows: the kit
 * heads them "Needs you" (first, always; its own line when `needs` is
 * empty) and "Earlier" (when given), in its words; the host gives only
 * each section's rows.
 */
export function bellPanelHtml({
  title,
  titleId,
  actions,
  lead,
  items,
  body,
  sections,
  empty,
  after,
  foot,
  lang,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const e = empty || {};
  const rows = sections
    ? bellSectionsHtml(sections, lang)
    : body != null && body !== ""
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

/** Issue 101: one titled section of the bell's panel. */
function bellSectionHtml(id, word, rows) {
  return (
    '<section class="den-bell-sec" data-sec="' +
    id +
    '" aria-labelledby="den-bell-' +
    id +
    '"><h3 class="den-bell-sech" id="den-bell-' +
    id +
    '">' +
    esc(word) +
    "</h3>" +
    rows +
    "</section>"
  );
}

/** Issue 101: Needs you, then Earlier (the host's rows in each). */
function bellSectionsHtml(s, lang) {
  const needs = s.needs || "";
  return (
    bellSectionHtml(
      "needs",
      kitT(lang, "kit.bell.needs"),
      needs ||
        '<p class="den-bell-none">' +
          esc(kitT(lang, "kit.bell.needsNone")) +
          "</p>",
    ) +
    (s.earlier
      ? bellSectionHtml("earlier", kitT(lang, "kit.bell.earlier"), s.earlier)
      : "")
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
/**
 * Who is signed in, as the kit draws it (0.7.1): the name on the first
 * line, @login on the second; @login alone when no name is known, or when
 * the name is just the login (sameAsLogin, issue 656). The
 * role is shown in the account menu's header only ({ menu: true }), on
 * its own line. From data: { name?, login?, role? }; with no
 * identity, { local: true } draws the kit's word for this computer. The old
 * { label, detail } (or the menu's { name, detail }) still work for one
 * release, as they were given, marked data-nav-legacy for the nav
 * inventory. Returns { lines: [first, second?], shape, legacy, full }.
 */
/**
 * Issue 656: whether a display name is just the login: the same once
 * trimmed, a leading "@" dropped and case ignored. Such a name is no name.
 */
export function sameAsLogin(name, login) {
  const norm = (v) =>
    String(v ?? "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
  return !!norm(login) && norm(name) === norm(login);
}

export function accountWho(a, { menu = false } = {}) {
  if (!a) return null;
  const legacy = a.label != null || a.detail != null;
  // Issue 656: a name that is just the login is no name (@login alone).
  const name =
    a.name != null && !a.label && a.login && sameAsLogin(a.name, a.login)
      ? ""
      : (a.name ?? a.label ?? "");
  const login = a.login
    ? String(a.login).startsWith("@")
      ? String(a.login)
      : "@" + a.login
    : (a.detail ?? "");
  // The role is shown in the account menu's header only, never in the
  // rail's entry (it isn't part of the entry's shape).
  const role = menu ? a.role || "" : "";
  let first = name || login;
  // No identity known at all: the kit's own word for this computer.
  const local = !first && !!a.local;
  if (local) first = kitT(a.lang, "kit.account.local");
  if (!first) return null;
  const second = name ? login : "";
  const shape = [
    name ? "name" : "",
    a.login || a.detail ? "login" : "",
    local ? "local" : "",
  ]
    .filter(Boolean)
    .join(",");
  const lines = [first, second].filter(Boolean);
  return {
    lines,
    role,
    shape,
    legacy,
    full: lines.join(" · "),
  };
}

function whoLinesHtml(who) {
  return (
    '<span class="den-acct-n">' +
    esc(who.lines[0]) +
    "</span>" +
    (who.lines[1]
      ? '<span class="den-acct-l">' + esc(who.lines[1]) + "</span>"
      : "") +
    (who.role ? '<span class="den-acct-r">' + esc(who.role) + "</span>" : "")
  );
}

export function accountHtml(a) {
  const who = accountWho(a);
  if (!who) return "";
  const full = who.full;
  const more = { ...(a.attrs || {}) };
  if (a.id) more.id = a.id;
  more["data-nav-shape"] = who.shape;
  if (who.legacy) more["data-nav-legacy"] = "account";
  // Who is signed in: the host's data (host content for the nav
  // inventory, which compares its shape: which fields, how many lines).
  const words =
    '<span class="den-lbl den-acct" data-nav-role="account-name">' +
    whoLinesHtml(who) +
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

/**
 * One row of a kit menu: a radio (checked set), a link or a button. The
 * kit's own menus (◐ ▾, the account menu) and the page action menu draw
 * their rows with it.
 *   menuRowHtml({ label, href?, checked?, kind?, value?, id?, cls?,
 *                 disabled?, describedBy? })
 * disabled: aria-disabled="true", and a link becomes a button (nothing to
 * follow); describedBy: the id of the line that says why.
 */
export function menuRowHtml(r) {
  const radio = r.checked != null;
  const link = r.href != null && !r.disabled;
  const tag = link ? "a" : "button";
  return (
    "<" +
    tag +
    ' class="den-mi' +
    (r.cls ? " " + esc(r.cls) : "") +
    '" tabindex="-1" role="' +
    (radio ? "menuitemradio" : "menuitem") +
    '"' +
    (radio ? ' aria-checked="' + (r.checked ? "true" : "false") + '"' : "") +
    (link ? ' href="' + esc(r.href) + '"' : ' type="button"') +
    (r.kind ? ' data-kind="' + esc(r.kind) + '"' : "") +
    (r.value != null ? ' data-value="' + esc(r.value) + '"' : "") +
    (r.id ? ' id="' + esc(r.id) + '"' : "") +
    (r.disabled ? ' aria-disabled="true"' : "") +
    (r.describedBy ? ' aria-describedby="' + esc(r.describedBy) + '"' : "") +
    '><span class="den-mi-l">' +
    esc(r.label) +
    "</span></" +
    tag +
    ">"
  );
}

/** A host's words: text, or { key, vars } in the kit's tables (addStrings). */
const words = (w, lang) =>
  w == null
    ? ""
    : typeof w === "object"
      ? w.key
        ? kitT(lang, w.key, w.vars)
        : ""
      : String(w);

/**
 * The page action menu's button (issue 555): "More ▾", the kit's button
 * (button.css), a menu button. hydratePageMenu (shell-client.js) opens
 * its menu.
 *   pageMenuButtonHtml({ id?, size?: "sm", lang })
 */
export function pageMenuButtonHtml({ id, size, lang } = {}) {
  return (
    '<button type="button" class="den-btn' +
    (size === "sm" ? " sm" : "") +
    ' den-pmenu-btn" id="' +
    esc(safeId(id || "den-pmenu")) +
    '" aria-haspopup="menu" aria-expanded="false">' +
    esc(kitT(lang, "kit.pmenu.more")) +
    ' <span aria-hidden="true">▾</span></button>'
  );
}

/**
 * The page action menu's rows (issue 555), from data.
 *   pageMenuHtml({ id, items, lang })
 * id: the menu button's (each row's id is "<id>-<item id>"). Each item:
 *   { id, label, href?, disabled?, note?, noteHref? }  or  { hr: true }
 * label and note: the host's words, or { key, vars } in the kit's tables
 * (a host adds its keys with addStrings). A disabled item has
 * aria-disabled and is described by its note, drawn right under it: a row
 * to follow when the note has an href (where to turn it on), else a line.
 * An item with no id or no label draws nothing.
 */
export function pageMenuHtml({ id, items, lang } = {}) {
  const base = safeId(id || "den-pmenu");
  return (items || [])
    .map((it) => {
      if (!it) return "";
      if (it.hr) return '<div class="den-hr" role="separator"></div>';
      const label = words(it.label, lang);
      if (it.id == null || it.id === "" || !label) return "";
      const rowId = base + "-" + safeId(it.id);
      const note = it.disabled ? words(it.note, lang) : "";
      const noteId = rowId + "-note";
      return (
        menuRowHtml({
          label,
          href: it.href,
          kind: "page",
          value: it.id,
          id: rowId,
          cls: "den-pmi",
          disabled: !!it.disabled,
          describedBy: note ? noteId : null,
        }) +
        (!note
          ? ""
          : it.noteHref != null
            ? menuRowHtml({
                label: note,
                href: it.noteHref,
                kind: "note",
                value: it.id,
                id: noteId,
                cls: "den-mwhy",
              })
            : '<p class="den-mnote den-mwhy" id="' +
              esc(noteId) +
              '">' +
              esc(note) +
              "</p>")
      );
    })
    .join("");
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
 * The account entry's menu: who is signed in (accountWho: the name, then
 * @login), a rule, then the entries.
 *   accountMenuHtml({ name?, login?, role?, items, lang })
 * ({ name, detail } is the old path, for one release.)
 * items: [{ label, href }] links, [{ label, id }] buttons (onPick "item"),
 * or [{ label, action: { method?, url, csrf?, field? } }]: a form that
 * posts to url on its own, with no script (csrf, if any, in a hidden
 * field named `field`, "csrf" by default).
 */
export function accountMenuHtml({ name, login, role, detail, items } = {}) {
  const parts = [];
  // The menu's { name, detail } were free text: the old path maps them
  // as the entry's label and detail.
  const w = accountWho(
    detail != null ? { label: name, detail } : { name, login, role },
    { menu: true },
  );
  if (w)
    parts.push(
      '<div class="den-ml den-acct" data-nav-shape="' +
        esc(w.shape) +
        '"' +
        (w.legacy ? ' data-nav-legacy="account"' : "") +
        ">" +
        whoLinesHtml(w) +
        "</div>",
    );
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
