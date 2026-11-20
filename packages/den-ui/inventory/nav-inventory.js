/**
 * den-ui nav inventory: the global nav (the top bar and the rail) as a
 * list of elements, and a comparer that names every difference. One spec
 * every product runs against the same reference, so two products' navs
 * never quietly differ.
 *
 *   collectNav(page)                → Promise<NavSnapshot>
 *   compareNav(actual, reference, { hostSlots, themeTokens, tolerance })
 *                                   → NavDiff[]   (empty: the same nav)
 *   formatNavDiffs(diffs)           → string, one line per difference
 *   pinNavFonts(context, { fontsDir }?) → Promise<void>: the same glyphs
 *                                   on every machine (see below)
 *
 * `page` is a Playwright Page (anything with `evaluate(fn, arg)` works),
 * already on a page that draws the kit's shell.
 *
 * What is collected, in DOM order: header.den-top and nav.den-rail and
 * every element under them that has a box (display: none, `hidden` and
 * what sits inside them are left out; an <svg> is one element, its shapes
 * are not). Each element's slot is "top", "rail" or "foot" (the rail's
 * entries after its spacer, .den-rail-grow: Settings, the collapse
 * toggle). For each: its key (below), its parent's key, slot, role, tag,
 * accessible name, classes, box { x, y, w, h } and computed styles
 * (STYLE_PROPS), and a rail entry's kind tag (0.7.3: `kind`, compared on
 * every entry both sides draw) and why it is off (0.7.4: `off`, compared
 * the same way).
 *
 * The key names an element the same way on every run: `#id` when it has
 * an id; `[data-nav="x"]` for a rail entry; else its parent's key, " > ",
 * its tag and first class, and [n] when siblings share that.
 *
 * Theme tokens: the snapshot also maps each colour and font-family it saw
 * to the :root custom properties (--tokens) that compute to the same
 * value. The method: every custom property declared in a rule whose
 * selector names :root or html (inside @media and @layer too) is read from
 * getComputedStyle(<html>); a value that is a colour (CSS.supports) is set
 * on a probe element's `color`, one that is a font-family list on its
 * `font-family`, and read back, so it is in the same form as any computed
 * value ("rgb(…)", "color(…)", a quoted family list). A value equal to
 * that is said to come from the token. Two tokens of one value both
 * match; the comparer asks only that one listed token match on both
 * sides.
 */

import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
// The kit's own src/fonts, found from the kit's files themselves: an ES
// module reads it from import.meta.url, CommonJS from __dirname (the
// package's "imports" picks the side).
import { FONTS_DIR } from "#den-ui-fonts-dir";

/** The computed styles kept for each element. */
export const STYLE_PROPS = [
  "display",
  "visibility",
  "height",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "background-color",
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "border-right-width",
  "border-right-style",
  "border-right-color",
  "border-bottom-width",
  "border-bottom-style",
  "border-bottom-color",
  "border-left-width",
  "border-left-style",
  "border-left-color",
  "font-size",
  "font-weight",
  "font-family",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "row-gap",
  "column-gap",
  "color",
  "opacity",
  "box-shadow",
];

/** The styles that hold one colour (a theme token may stand for it). */
export const COLOR_PROPS = STYLE_PROPS.filter((p) => /color$/.test(p));

/**
 * The styles a theme token may stand for: each colour, and font-family
 * (from --sans, --mono or --display, say).
 */
export const TOKEN_PROPS = [...COLOR_PROPS, "font-family"];

/** The snapshot's format; a reference with another one is refused. */
export const NAV_INVENTORY_VERSION = 2;

/**
 * The theme the reference was taken in: Den's "Den" theme, as Den draws
 * its pages today. Every product runs the inventory in this theme, so a
 * colour or font that differs is a real gap.
 */
export const NAV_THEME = { id: "den", version: "2.0.1" };

/**
 * The one browser build the nav is measured in: Playwright's image, by
 * version and the digest of its linux/amd64 build (its arm64 build ships
 * another Chromium, which lays text out apart; on an arm64 machine run
 * it with --platform linux/amd64). The references were taken there; a host runs its
 * check there too (its run-server, reached through DEN_PW_WS), so both
 * products are measured alike. Text lays out a few px apart on any other
 * build, so boxes from another one are never compared.
 */
export const NAV_BROWSER_IMAGE =
  "mcr.microsoft.com/playwright:v1.61.1-noble@sha256:cf0daee9b994042e011bc29f20cdff1a9f682a039b43fcd738f7d8a9d3bcd9d6";

/** The fixed line each face is measured with, for the fingerprint. */
export const FINGERPRINT_TEXT =
  "Search pages, services, actions… Report ⌘K ⌘⇧F v9.9.0 0123456789";

/**
 * The global nav of the page, in DOM order. Runs in the page: nothing is
 * read from outside it. `opts.image`: where the browser runs (say
 * NAV_BROWSER_IMAGE), kept in the snapshot's env for the messages.
 * `opts.theme`: { id, version } of the theme the page draws in (the
 * reference's is NAV_THEME); a snapshot on another theme never matches.
 */
export async function collectNav(page, opts = {}) {
  const snap = await page.evaluate(
    ({ props, colorProps, line }) => {
      const round = (n) => Math.round(n * 100) / 100;
      const ROLES = {
        a: "link",
        button: "button",
        nav: "navigation",
        header: "banner",
        input: "textbox",
        select: "combobox",
        img: "img",
        h1: "heading",
        h2: "heading",
        h3: "heading",
        ul: "list",
        li: "listitem",
        dialog: "dialog",
      };
      const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
      const nameOf = (el) => {
        const label = el.getAttribute("aria-label");
        if (label) return label.trim();
        const by = el.getAttribute("aria-labelledby");
        if (by) {
          const t = by
            .split(/\s+/)
            .map((id) => document.getElementById(id))
            .filter(Boolean)
            .map(textOf)
            .join(" ")
            .trim();
          if (t) return t;
        }
        const alt = el.getAttribute("alt");
        if (alt) return alt.trim();
        // Its text names it only when it is a control or a leaf: a
        // container's text is its children's, which are listed themselves.
        const tag = el.tagName.toLowerCase();
        const fromText =
          tag !== "svg" &&
          (/^(a|button|kbd|label|h[1-6])$/.test(tag) ||
            el.children.length === 0);
        const t = fromText ? textOf(el) : "";
        if (t) return t;
        return (el.getAttribute("title") || "").trim();
      };
      const roleOf = (el) => {
        const r = el.getAttribute("role");
        if (r) return r;
        const tag = el.tagName.toLowerCase();
        if (tag === "a" && !el.hasAttribute("href")) return "a";
        return ROLES[tag] || tag;
      };
      const step = (el) => {
        const tag = el.tagName.toLowerCase();
        const c = el.classList[0];
        return c ? `${tag}.${c}` : tag;
      };
      const keyOf = (el, parentKey) => {
        if (el.id) return `#${el.id}`;
        const nav = el.getAttribute("data-nav");
        if (nav) return `[data-nav="${nav}"]`;
        const s = step(el);
        const parent = el.parentElement;
        const same = parent
          ? Array.from(parent.children).filter(
              (k) => !k.id && !k.getAttribute("data-nav") && step(k) === s,
            )
          : [el];
        const n = same.indexOf(el);
        const here = same.length > 1 ? `${s}[${n + 1}]` : s;
        return parentKey ? `${parentKey} > ${here}` : here;
      };
      const out = [];
      const used = new Map();
      // `pathKey`: the DOM parent's key (an element with no box of its own,
      // display: contents, still names its children); `boxParent`: the
      // nearest ancestor with a box, the one the snapshot lists.
      // `host`: the nearest element (this one or an ancestor) with a
      // data-nav-role: host content ({ role, key }), else null.
      const walk = (el, pathKey, boxParent, slot, hostIn) => {
        if (el.hidden) return slot;
        const cs = getComputedStyle(el);
        if (cs.display === "none") return slot;
        const mySlot = el.classList.contains("den-rail-grow") ? "foot" : slot;
        let key = keyOf(el, pathKey);
        const n = (used.get(key) || 0) + 1;
        used.set(key, n);
        if (n > 1) key += `{${n}}`;
        const navRole = el.getAttribute("data-nav-role");
        const host = navRole
          ? { role: navRole, key }
          : hostIn
            ? { role: hostIn.role, key: hostIn.key }
            : null;
        const boxed = el.getClientRects().length > 0;
        // A host root's own width: its contents' plus its padding and
        // border (a field that fills the bar is wider than its words).
        if (navRole && boxed) {
          const rg = document.createRange();
          rg.selectNodeContents(el);
          const px = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
          const edge =
            px("padding-left") +
            px("padding-right") +
            px("border-left-width") +
            px("border-right-width");
          const w = el.getBoundingClientRect().width;
          host.fit = round(
            Math.min(w, rg.getBoundingClientRect().width + edge),
          );
        }
        if (boxed) {
          const r = el.getBoundingClientRect();
          const style = {};
          for (const p of props) style[p] = cs.getPropertyValue(p);
          out.push({
            key,
            parent: boxParent,
            slot: mySlot,
            role: roleOf(el),
            tag: el.tagName.toLowerCase(),
            name: nameOf(el),
            classes: Array.from(el.classList),
            box: {
              x: round(r.x),
              y: round(r.y),
              w: round(r.width),
              h: round(r.height),
            },
            style,
            ...(host ? { host } : {}),
            // Its name is the host's words (the search's label, say).
            ...(el.getAttribute("data-nav-name") === "host"
              ? { hostName: true }
              : {}),
            // 0.7.1: a kit-owned slot's content shape (which fields it
            // draws), the old free-text path, and the kit's own stamp.
            // A crumb showing its label with its value hidden (the
            // value must outlast the label).
            ...(el.getAttribute("data-nav-role") === "crumb" &&
            (() => {
              const k = el.querySelector(":scope > .den-k");
              const v = el.lastElementChild;
              if (!k || !v || v === k) return false;
              const kw = k.getClientRects().length
                ? k.getBoundingClientRect().width
                : 0;
              const vw = v.getClientRects().length
                ? v.getBoundingClientRect().width
                : 0;
              return kw > 1 && vw < 8;
            })()
              ? { labelOnly: true }
              : {}),
            ...(el.hasAttribute("data-nav-shape")
              ? { shape: el.getAttribute("data-nav-shape") }
              : {}),
            // Issue 694: on the top bar, whether the page holds ☰ or a
            // rail at all, drawn or hidden (a no-rail page has neither).
            ...(el.matches("header.den-top") &&
            document.querySelector(".den-menu-btn")
              ? { menu: true }
              : {}),
            ...(el.matches("header.den-top") &&
            document.querySelector("nav.den-rail, .den-rail")
              ? { rail: true }
              : {}),
            ...(el.hasAttribute("data-nav-legacy") ? { legacy: true } : {}),
            ...(el.hasAttribute("data-den-account")
              ? {
                  account: true,
                  lines: el.querySelectorAll(
                    ".den-acct-n, .den-acct-l, .den-acct-r",
                  ).length,
                }
              : {}),
            ...(el.hasAttribute("data-nav-kit")
              ? { kit: el.getAttribute("data-nav-kit") }
              : {}),
            // Issue 307: a rail entry's kind tag (project, den, service,
            // hub, artifact), compared across products.
            ...(el.hasAttribute("data-nav-kind")
              ? { kind: el.getAttribute("data-nav-kind") }
              : {}),
            // Issue 326: why an entry is off (greyed), compared across
            // products.
            ...(el.hasAttribute("data-nav-off")
              ? { off: el.getAttribute("data-nav-off") }
              : {}),
            // 0.7.3: host text in an entry of the rail (the kit stamps it).
            ...(el.hasAttribute("data-nav-host-text")
              ? { hostText: el.getAttribute("data-nav-host-text") }
              : {}),
          });
        }
        if (el.tagName.toLowerCase() === "svg") return mySlot;
        let kidSlot = mySlot;
        for (const k of Array.from(el.children)) {
          // Everything after the rail's spacer is the rail's foot.
          kidSlot = walk(k, key, boxed ? key : boxParent, kidSlot, host);
        }
        return kidSlot === "foot" ? "foot" : mySlot;
      };
      const top = document.querySelector("header.den-top");
      const rail = document.querySelector("nav.den-rail, .den-rail");
      if (top) walk(top, null, null, "top", null);
      if (rail) walk(rail, null, null, "rail", null);

      // The theme tokens: each colour seen → the --tokens that make it.
      const names = new Set();
      const scan = (rules) => {
        for (const r of Array.from(rules || [])) {
          if (r.cssRules && !r.selectorText) scan(r.cssRules);
          if (!r.selectorText || !r.style) continue;
          if (!/:root|\bhtml\b/.test(r.selectorText)) continue;
          for (const p of Array.from(r.style))
            if (p.startsWith("--")) names.add(p);
          if (r.cssRules) scan(r.cssRules);
        }
      };
      for (const sh of Array.from(document.styleSheets)) {
        try {
          scan(sh.cssRules);
        } catch {
          /* another origin's sheet: not readable */
        }
      }
      const rootCs = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      document.documentElement.appendChild(probe);
      // A token's value, set on the probe and read back: the form an
      // element's computed colour or font-family takes.
      const byValue = {};
      const note = (v, name) => (byValue[v] = byValue[v] || []).push(name);
      for (const name of [...names].sort()) {
        const v = rootCs.getPropertyValue(name).trim();
        if (!v) continue;
        if (CSS.supports("color", v)) {
          probe.style.color = "";
          probe.style.color = v;
          note(getComputedStyle(probe).color, name);
        } else if (CSS.supports("font-family", v)) {
          probe.style.fontFamily = "";
          probe.style.fontFamily = v;
          note(getComputedStyle(probe).fontFamily, name);
        }
      }
      probe.remove();
      const seen = new Set();
      for (const e of out) for (const p of colorProps) seen.add(e.style[p]);
      const tokens = {};
      for (const c of [...seen].sort()) if (byValue[c]) tokens[c] = byValue[c];
      // The fingerprint: the browser, and the width of one fixed line in
      // each face (weight, size, family) the nav's text uses, laid out in
      // the page as its text is. Boxes match only where it matches.
      const faces = {};
      const span = document.createElement("span");
      span.setAttribute("aria-hidden", "true");
      for (const [k, v] of Object.entries({
        position: "absolute",
        left: "-10000px",
        top: "0",
        "white-space": "pre",
        "letter-spacing": "normal",
        visibility: "hidden",
      }))
        span.style.setProperty(k, v);
      span.textContent = line;
      document.body.appendChild(span);
      // Fixed faces, never the page's own (a page that changes a font
      // must fail on that font, not on its fingerprint): the generic
      // families as this machine draws them, and the page's font tokens.
      const faceKeys = new Set();
      for (const fam of [
        "sans-serif",
        "serif",
        "monospace",
        // One line, single-spaced: a token written over lines (tokens.css
        // wraps long values) is the same family (navFamily, below).
        rootCs.getPropertyValue("--sans").replace(/\s+/g, " ").trim(),
        rootCs.getPropertyValue("--mono").replace(/\s+/g, " ").trim(),
      ])
        if (fam)
          for (const wt of ["400", "500"]) faceKeys.add(`${wt} 14px ${fam}`);
      for (const f of [...faceKeys].sort()) {
        const [weight, size, ...family] = f.split(" ");
        span.style.setProperty("font-weight", weight);
        span.style.setProperty("font-size", size);
        span.style.setProperty("font-family", family.join(" "));
        faces[f] = Math.round(span.getBoundingClientRect().width * 1000) / 1000;
      }
      span.remove();
      return {
        viewport: { w: innerWidth, h: innerHeight },
        env: { userAgent: navigator.userAgent, faces },
        elements: out,
        tokens,
      };
    },
    { props: STYLE_PROPS, colorProps: TOKEN_PROPS, line: FINGERPRINT_TEXT },
  );
  if (opts.image) snap.env.image = opts.image;
  if (opts.theme)
    snap.env.theme = { id: opts.theme.id, version: opts.theme.version };
  return { version: NAV_INVENTORY_VERSION, ...snap };
}

/**
 * A snapshot's fingerprint: its browser (user agent) and the widths of its
 * faces' fixed line. Boxes compare only between equal fingerprints: on
 * another browser build or font renderer text lays out a few px apart,
 * and the comparer says so instead of comparing boxes that can't match.
 */
export function fingerprint(snap) {
  const env = snap.env || {};
  const faces = env.faces || {};
  return JSON.stringify([
    env.userAgent || "",
    Object.keys(faces)
      .map((k) => [navFamily(k), faces[k]])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  ]);
}

/**
 * A font family (or a face key) as one line: every run of whitespace one
 * space, the ends trimmed. "a,\n    b" is "a, b": a token's value keeps
 * the line breaks it was written with, and must still name one face.
 */
export function navFamily(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Where a snapshot was taken, in words: its image (if named) and browser. */
function envWords(snap) {
  const env = snap.env || {};
  return `${env.image || "an unnamed browser"} (${env.userAgent || "?"})`;
}

/** Does host slot `s` cover element `e` (or one of its ancestors)? */
function slotMatches(s, e) {
  if (s.startsWith(".") && !s.includes(" "))
    return e.classes.includes(s.slice(1));
  return e.key === s;
}

/** The elements not inside a host slot, in order. */
function kept(snap, hostSlots) {
  const byKey = new Map(snap.elements.map((e) => [e.key, e]));
  const inSlot = (e) => {
    for (let x = e; x; x = x.parent ? byKey.get(x.parent) : undefined)
      if (hostSlots.some((s) => slotMatches(s, x))) return true;
    return false;
  };
  return snap.elements.filter((e) => !inSlot(e));
}

/**
 * The horizontal moves a host slot may cause in its own slot. A host slot
 * that is wider or narrower (or there on one side only, with its flex gap)
 * moves or stretches its neighbours by just that much: each host slot's
 * change in width, per nav slot, and every sum of them.
 */
function slotShifts(actual, reference, hostSlots, extra = {}) {
  const roots = (snap) => {
    const byKey = new Map(snap.elements.map((e) => [e.key, e]));
    const out = new Map();
    for (const e of snap.elements) {
      if (!hostSlots.some((s) => slotMatches(s, e))) continue;
      let inner = false;
      for (
        let x = e.parent && byKey.get(e.parent);
        x;
        x = x.parent && byKey.get(x.parent)
      )
        if (hostSlots.some((s) => slotMatches(s, x))) inner = true;
      if (inner) continue;
      const parent = e.parent && byKey.get(e.parent);
      const gap = parseFloat(parent ? parent.style["column-gap"] : "") || 0;
      out.set(e.key, { slot: e.slot, w: e.box.w, gap });
    }
    return out;
  };
  const a = roots(actual);
  const r = roots(reference);
  const deltas = {};
  for (const k of new Set([...a.keys(), ...r.keys()])) {
    const x = a.get(k);
    const y = r.get(k);
    const slot = (x || y).slot;
    const d = x && y ? x.w - y.w : x ? x.w + x.gap : -(y.w + y.gap);
    if (d) (deltas[slot] = deltas[slot] || []).push(d);
  }
  for (const [slot, ds] of Object.entries(extra))
    for (const d of ds) if (d) (deltas[slot] = deltas[slot] || []).push(d);
  const sums = {};
  for (const [slot, ds] of Object.entries(deltas)) {
    let set = [0];
    for (const d of ds.slice(0, 8)) set = [...set, ...set.map((v) => v + d)];
    sums[slot] = set.flatMap((v) => [v, -v]);
  }
  return sums;
}

/** The longest common subsequence of two key lists, as a Set of keys. */
function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i][j] =
        a[i] === b[j]
          ? t[i + 1][j + 1] + 1
          : Math.max(t[i + 1][j], t[i][j + 1]);
  const keep = new Set();
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      keep.add(a[i]);
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return keep;
}

/**
 * Every difference between `actual` and `reference`. Both must come from
 * the same browser build (equal `fingerprint`): else the one difference is
 * `env`, "reference taken on X, running on Y". Fails on: an element
 * missing, extra or out of order; a slot, role, tag, name or class list
 * that differs; a box edge moved more than `tolerance` px (default 2); a
 * computed style that differs. Not compared: anything inside `hostSlots`
 * (keys such as "#den-status", or one class such as ".den-scope": the
 * element and all under it, on both sides); a colour or font-family that
 * differs where both values come from one token named in `themeTokens`
 * ("--accent", "--sans"). `themeTokens` is empty by default and is never
 * for a parity run: both products run in NAV_THEME, where every colour
 * and font must match. It is only for comparing two runs on purpose in
 * different themes. Both snapshots must name the same theme (env.theme):
 * else the one difference is `theme`.
 * A host slot may be wider or narrower than in the reference (or there on
 * one side only): the other elements in its nav slot may then move or
 * stretch sideways by exactly that change (or a sum of such changes, with
 * the flex gap of a slot there on one side only), never by anything else.
 */
/** The rail's column: its slots stack top to bottom. */
const COLUMN = ["rail", "foot"];

/**
 * issue 303: the top bar's search and the kit's right-side items (Report,
 * the bell, the version chip, ◐ ▾) sit at the reference's x and width,
 * whatever the host's words: a host's crumbs, title or chips never excuse
 * moving them.
 */
/**
 * The search's slot for a viewport width (issue 303, "the search never
 * moves"): its x and width are a function of the viewport only, the same
 * in any host. Above 720px: the left part is 444px, less what the bar
 * needs for the search and the kit's right group (TOP_RIGHT_MIN);
 * 481–720px: 200px; up to 480px: 62px. The bar's padding is 12px and
 * its column gap 8px. Mirrors shell.css's .den-top columns (defaults).
 */
export const TOP_RIGHT_MIN = 380;
export function searchSlot(viewportW) {
  const pad = 12;
  const gap = 8;
  if (viewportW > 720) {
    const left = Math.max(
      0,
      Math.min(444, viewportW - 2 * pad - 304 - 2 * gap - TOP_RIGHT_MIN),
    );
    return { x: pad + left + gap, w: 304 };
  }
  return { x: pad + (viewportW < 480 ? 62 : 200) + gap, w: 54 };
}

/**
 * The search away from its slot (searchSlot for the snapshot's viewport):
 * a difference per edge, at any width, with no reference box needed.
 */
export function searchSlotDiffs(snap, tolerance = 2) {
  const out = [];
  const slot = searchSlot(snap.viewport.w);
  for (const e of snap.elements) {
    if (e.slot !== "top" || !e.classes.includes("den-search") || !e.box)
      continue;
    const near = (a, b) => Math.abs(a - b) <= tolerance;
    if (!near(e.box.x, slot.x))
      out.push({
        key: e.key,
        slot: e.slot,
        property: "slot.x",
        reference: String(slot.x),
        actual: String(e.box.x),
      });
    if (!near(e.box.w, slot.w))
      out.push({
        key: e.key,
        slot: e.slot,
        property: "slot.w",
        reference: String(slot.w),
        actual: String(e.box.w),
      });
  }
  return out;
}

/** The account entry's shapes the kit draws, and their line counts. */
export const ACCOUNT_SHAPES = { "name,login": 2, login: 1, local: 1 };

/**
 * Issue 694: the top bar's shapes the kit draws besides its default (no
 * data-nav-shape: ☰ and a rail). "no-rail": topBarHtml({ rail: false }).
 */
export const TOP_SHAPES = ["no-rail"];

/**
 * Issue 694: the top bar's shape, checked on what the page holds (no
 * reference needed). A shape the kit doesn't draw fails; a "no-rail" page
 * that holds ☰ or a rail (drawn or hidden) fails, once for each.
 */
export function railShapeDiffs(snap) {
  const out = [];
  const top = snap.elements.find(
    (e) => e.slot === "top" && e.tag === "header" && e.parent == null,
  );
  if (!top || top.shape == null) return out;
  const diff = (property, reference, actual) =>
    out.push({ key: top.key, slot: top.slot, property, reference, actual });
  if (!TOP_SHAPES.includes(top.shape)) {
    diff("shape", `(default) | ${TOP_SHAPES.join(" | ")}`, top.shape);
    return out;
  }
  if (top.menu || snap.elements.some((e) => e.classes.includes("den-menu-btn")))
    diff("menu", "absent (no-rail)", "☰ drawn");
  if (top.rail || snap.elements.some((e) => e.slot !== "top"))
    diff("rail", "absent (no-rail)", "rail drawn");
  return out;
}

/** The version's fixed slot for a viewport width (none on a phone). */
export function versionSlotW(viewportW) {
  return viewportW > 1100 ? 96 : viewportW > 720 ? 64 : 0;
}

/**
 * The top bar's kit slots at any width: the search (searchSlot), and the
 * right group anchored from the right edge: ◐ at the bar's padding, then
 * the version's fixed slot, the bell and Report, 4px apart. Widths that
 * depend on the engine (Report's words, ◐'s glyph) are taken as drawn;
 * their places follow, the same in any host.
 */
export function topSlotDiffs(snap, tolerance = 2) {
  const out = searchSlotDiffs(snap, tolerance);
  const vw = snap.viewport.w;
  if (vw <= 720) return out;
  const near = (a, b) => Math.abs(a - b) <= tolerance;
  const find = (pred) =>
    snap.elements.find((e) => e.slot === "top" && e.box && pred(e));
  const ap = find((e) => e.key === "#appearance-btn");
  const ver = find((e) => e.key === "#version-pill");
  const bell = find((e) => e.key === "#den-bell");
  const rb = find((e) => e.classes.includes("den-rb-top"));
  const push = (e, property, want, got) =>
    out.push({
      key: e.key,
      slot: e.slot,
      property,
      reference: String(Math.round(want * 100) / 100),
      actual: String(Math.round(got * 100) / 100),
    });
  let right = vw - 12;
  for (const e of [ap, ver, bell, rb]) {
    if (!e) continue;
    if (e === ver && !near(e.box.w, versionSlotW(vw)))
      push(e, "slot.w", versionSlotW(vw), e.box.w);
    const wantX = right - e.box.w;
    if (!near(e.box.x, wantX)) push(e, "slot.x", wantX, e.box.x);
    right = e.box.x - 4;
  }
  return out;
}

/**
 * 0.7.1: host HTML in the kit's account and search slots, listed (a
 * warning: 0.7.2 makes every slot data, and then it fails). The kit
 * stamps what it draws: the account entry's data-nav-shape, the search's
 * data-nav-kit.
 */
export function navWarnings(snap) {
  const out = [];
  for (const e of snap.elements) {
    if (e.account && e.shape == null)
      out.push(
        `account: ${e.key} is not the kit's (host HTML; draw it with accountHtml)`,
      );
    if (e.hostText)
      out.push(
        `rail entry: ${e.key} has the host's ${e.hostText} (pass data: the kit owns its words)`,
      );
    if (
      e.slot === "top" &&
      e.classes.includes("den-search") &&
      e.kit !== "search"
    )
      out.push(
        `search: ${e.key} is not the kit's (host HTML; draw it with searchHtml)`,
      );
  }
  return out;
}

export const PINNED_CLASSES = [
  "den-search",
  "den-rb-top",
  "den-bell",
  "v-pill",
  "appearance-btn",
];

/**
 * Host content's size, by role: for each role, the sum of its roots'
 * widths (in a row) or heights (in the rail's column), each with its
 * parent's gap. `row`: { slot: { role: n } }; `column`: { role: n }.
 */
function hostExtent(snap) {
  const byKey = new Map(snap.elements.map((e) => [e.key, e]));
  const row = {};
  const column = {};
  for (const e of snap.elements) {
    if (!e.host || e.host.key !== e.key) continue;
    const parent = e.parent && byKey.get(e.parent);
    const r = e.host.role;
    if (COLUMN.includes(e.slot)) {
      const gap = parseFloat(parent ? parent.style["row-gap"] : "") || 0;
      column[r] = (column[r] || 0) + e.box.h + gap;
    } else {
      const gap = parseFloat(parent ? parent.style["column-gap"] : "") || 0;
      row[e.slot] = row[e.slot] || {};
      const w = e.host.fit == null ? e.box.w : e.host.fit;
      row[e.slot][r] = (row[e.slot][r] || 0) + w + gap;
    }
  }
  return { row, column };
}

/** Every subset's sum of up to 8 deltas, with either sign. */
function subsetSums(ds) {
  let set = [0];
  for (const d of ds.filter(Boolean).slice(0, 8))
    set = [...set, ...set.map((v) => v + d)];
  return set.flatMap((v) => [v, -v]);
}

/**
 * Host content (an element with a data-nav-role, and what it holds): the
 * first of each role on each side, and what it holds by its key's tail,
 * as [role, tail, element] for each.
 */
function firstOfRoles(els) {
  const roots = new Map();
  for (const e of els)
    if (e.host && !roots.has(e.host.role)) roots.set(e.host.role, e.host.key);
  const out = new Map();
  for (const e of els) {
    if (!e.host || roots.get(e.host.role) !== e.host.key) continue;
    const root = e.host.key;
    const tail =
      e.key === root
        ? ""
        : e.key.startsWith(root)
          ? e.key.slice(root.length)
          : null;
    if (tail != null) out.set(`${e.host.role}|${tail}`, e);
  }
  return out;
}

export function compareNav(actual, reference, opts = {}) {
  const hostSlots = opts.hostSlots || [];
  const themeTokens = new Set(opts.themeTokens || []);
  const tol = opts.tolerance == null ? 2 : opts.tolerance;
  const diffs = [];
  const add = (e, property, ref, act) =>
    diffs.push({
      key: e.key,
      slot: e.slot,
      property,
      reference: ref,
      actual: act,
    });
  if (reference.version !== NAV_INVENTORY_VERSION)
    return [
      {
        key: "(snapshot)",
        slot: "",
        property: "version",
        reference: String(reference.version),
        actual: String(NAV_INVENTORY_VERSION),
      },
    ];
  // Another browser build: no box comparison, one clear difference.
  if (fingerprint(actual) !== fingerprint(reference))
    return [
      {
        key: "(snapshot)",
        slot: "",
        property: "env",
        reference: `reference taken on ${envWords(reference)}`,
        actual: `running on ${envWords(actual)}`,
      },
    ];
  // Another theme: its colours and fonts can't match.
  const themeWords = (snap) => {
    const t = (snap.env || {}).theme;
    return t ? `${t.id} ${t.version}` : "no named theme";
  };
  if (themeWords(actual) !== themeWords(reference))
    return [
      {
        key: "(snapshot)",
        slot: "",
        property: "theme",
        reference: `reference taken in theme ${themeWords(reference)}`,
        actual: `running in theme ${themeWords(actual)}`,
      },
    ];
  const allWant = kept(reference, hostSlots);
  const allGot = kept(actual, hostSlots);
  // Host content is never keyed: its count, keys, ids and text are the
  // host's. The kit's chrome around it is.
  const want = allWant.filter((e) => !e.host);
  const got = allGot.filter((e) => !e.host);
  // A kit element that holds host content: its name is the host's words.
  const holders = (snap) => {
    const byKey = new Map(snap.elements.map((e) => [e.key, e]));
    const out = new Set();
    for (const e of snap.elements)
      if (e.host)
        for (
          let x = e.parent && byKey.get(e.parent);
          x;
          x = x.parent && byKey.get(x.parent)
        )
          out.add(x.key);
    return out;
  };
  const holdsHost = new Set([...holders(reference), ...holders(actual)]);
  // issue 303: the kit's pinned elements, and all they hold, by the
  // reference's tree.
  const pinnedKeys = new Set();
  {
    const isRoot = (e) =>
      e.slot === "top" && e.classes.some((c) => PINNED_CLASSES.includes(c));
    const byKey = new Map(reference.elements.map((e) => [e.key, e]));
    for (const e of reference.elements)
      for (let x = e; x; x = x.parent && byKey.get(x.parent))
        if (isRoot(x)) {
          pinnedKeys.add(e.key);
          break;
        }
  }
  const wantBy = new Map(want.map((e) => [e.key, e]));
  const gotBy = new Map(got.map((e) => [e.key, e]));
  for (const e of want)
    if (!gotBy.has(e.key)) add(e, "element", "present", "missing");
  for (const e of got)
    if (!wantBy.has(e.key)) add(e, "element", "absent", "extra");
  const a = want.filter((e) => gotBy.has(e.key)).map((e) => e.key);
  const b = got.filter((e) => wantBy.has(e.key)).map((e) => e.key);
  const inOrder = lcs(a, b);
  for (const k of a)
    if (!inOrder.has(k))
      add(
        wantBy.get(k),
        "order",
        `#${a.indexOf(k) + 1} of ${a.length}`,
        `#${b.indexOf(k) + 1} of ${b.length}`,
      );
  const tokenOf = (snap, c) => (snap.tokens && snap.tokens[c]) || [];
  // Host content's size moves what follows it: in a row by its width's
  // change, in the rail's column by its height's.
  const ea = hostExtent(actual);
  const er = hostExtent(reference);
  const rowDeltas = {};
  for (const slot of new Set([
    ...Object.keys(ea.row),
    ...Object.keys(er.row),
  ])) {
    const a = ea.row[slot] || {};
    const r = er.row[slot] || {};
    rowDeltas[slot] = [...new Set([...Object.keys(a), ...Object.keys(r)])].map(
      (k) => (a[k] || 0) - (r[k] || 0),
    );
  }
  const shifts = slotShifts(actual, reference, hostSlots, rowDeltas);
  const drops = subsetSums(
    [...new Set([...Object.keys(ea.column), ...Object.keys(er.column)])].map(
      (k) => (ea.column[k] || 0) - (er.column[k] || 0),
    ),
  );
  // Issue 303: the search's slot, from the viewport alone.
  diffs.push(...topSlotDiffs(actual, tol));
  // Issue 694: the top bar's shape, from what the page holds alone.
  diffs.push(...railShapeDiffs(actual));
  // Issue 307: an entry both sides draw (host content too: its key is its
  // data-nav id) has the same kind tag, or none on both. The tag's look is
  // the "kind" role's, compared below with the first of each role.
  {
    const wantKind = new Map(allWant.map((e) => [e.key, e]));
    for (const g of allGot) {
      const w = wantKind.get(g.key);
      if (w && (w.kind ?? "") !== (g.kind ?? ""))
        add(w, "kind", w.kind ?? "(none)", g.kind ?? "(none)");
      // Issue 326: an entry off on one side is off, for the same reason,
      // on the other.
      if (w && (w.off ?? "") !== (g.off ?? ""))
        add(w, "off", w.off ?? "(none)", g.off ?? "(none)");
    }
  }
  // A crumb's value outlasts its label: one whose label shows while its
  // value is hidden fails, whatever the reference drew (crumbs are host
  // content, so this is checked on every element drawn).
  // 0.7.3: hosts pass data; the kit owns a rail entry's words. Host text
  // on an entry (a title, aria-label, aria-labelledby, aria-description,
  // a badge's label) fails, whatever the reference drew.
  for (const g of actual.elements)
    if (g.hostText)
      diffs.push({
        key: g.key,
        slot: g.slot,
        property: "hostText",
        reference: "none",
        actual: g.hostText,
      });
  for (const g of actual.elements)
    if (g.labelOnly)
      diffs.push({
        key: g.key,
        slot: g.slot,
        property: "crumb.value",
        reference: "shown",
        actual: "hidden while its label shows",
      });
  for (const w of want) {
    const g = gotBy.get(w.key);
    if (!g) continue;
    for (const p of ["slot", "role", "tag", "name"])
      if (
        w[p] !== g[p] &&
        !(p === "name" && (holdsHost.has(w.key) || w.hostName || g.hostName))
      )
        add(w, p, w[p], g[p]);
    // 0.7.1: what a kit-owned slot draws (its fields, its lines), and
    // the old free-text path, flagged.
    // The account entry's shape is the kit's: name over @login (two
    // lines), or @login alone, or the kit's local word; never a role
    // or other fields. Checked on what is drawn, not against the
    // reference's data.
    if (g.account && g.shape != null) {
      const want = ACCOUNT_SHAPES[g.shape];
      if (want == null || (g.lines != null && g.lines !== want))
        add(
          w,
          "shape",
          "name,login | login | local",
          `${g.shape} (${g.lines} lines)`,
        );
    } else if ((w.shape ?? "") !== (g.shape ?? ""))
      add(w, "shape", w.shape, g.shape);
    if (g.legacy && !w.legacy)
      add(w, "legacy", "data", "label/detail (deprecated)");
    const wc = w.classes.join(" ");
    const gc = g.classes.join(" ");
    if (wc !== gc) add(w, "classes", wc, gc);
    const edges = (x) => ({
      left: x.box.x,
      top: x.box.y,
      right: Math.round((x.box.x + x.box.w) * 100) / 100,
      bottom: Math.round((x.box.y + x.box.h) * 100) / 100,
    });
    const we = edges(w);
    const ge = edges(g);
    // The search and the kit's right-side items are pinned (issue 303):
    // nothing the host draws may move them.
    const moves = pinnedKeys.has(w.key) ? [0] : shifts[w.slot] || [0];
    for (const edge of ["left", "top", "right", "bottom"]) {
      const d = ge[edge] - we[edge];
      const ok =
        edge === "left" || edge === "right"
          ? moves.some((m) => Math.abs(d - m) <= tol)
          : COLUMN.includes(w.slot)
            ? drops.some((m) => Math.abs(d - m) <= tol)
            : Math.abs(d) <= tol;
      if (!ok) add(w, `box.${edge}`, we[edge], ge[edge]);
    }
    // The rail's spacer takes up what the rail's pages don't.
    const grows =
      w.classes.includes("den-rail-grow") &&
      drops.some(
        (m) =>
          Math.abs(
            parseFloat(g.style.height) - parseFloat(w.style.height) - m,
          ) <= tol,
      );
    styles(w, g, grows ? ["height"] : []);
  }
  // The first of each role on each side, and what it holds, compared on
  // every style and on height: never on text, width or where it sits.
  const fw = firstOfRoles(allWant);
  const fg = firstOfRoles(allGot);
  for (const [k, w] of fw) {
    const g = fg.get(k);
    if (!g) continue;
    if (Math.abs(g.box.h - w.box.h) > tol)
      add(w, "box.height", w.box.h, g.box.h);
    styles(w, g, []);
  }
  // Name over @login is taller than @login alone: an entry with another
  // line count than the reference's (both the kit's shapes) moves nothing
  // else's place; its own height and what it centres are its data.
  const tall = /^(box\.(height|top|bottom)|style\.height)$/;
  const acct = actual.elements.find((e) => e.account);
  const acctRef = acct && reference.elements.find((e) => e.key === acct.key);
  const acctOwn =
    acct && acctRef && (acct.lines ?? 0) !== (acctRef.lines ?? 0)
      ? (k) => k === acct.key || k.startsWith(acct.key + " >")
      : () => false;
  // Issue 313: a container empty on one side and holding something on
  // the other is as tall as what it holds; its top, bottom and height are
  // not compared (its x and width are). Children by the recorded parent.
  const kids = (snap) => {
    const n = new Map();
    for (const e of snap.elements)
      if (e.parent) n.set(e.parent, (n.get(e.parent) || 0) + 1);
    return n;
  };
  const ka = kids(actual);
  const kr = kids(reference);
  const emptyOneSide = (k) => !ka.get(k) !== !kr.get(k);
  return diffs.filter(
    (d) => !(tall.test(d.property) && (acctOwn(d.key) || emptyOneSide(d.key))),
  );
  function styles(w, g, skip) {
    for (const p of STYLE_PROPS) {
      if (skip.includes(p)) continue;
      const rv = w.style[p];
      const av = g.style[p];
      if (rv === av) continue;
      if (TOKEN_PROPS.includes(p) && themeTokens.size) {
        const rt = tokenOf(reference, rv);
        const at = tokenOf(actual, av);
        if (rt.some((t) => themeTokens.has(t) && at.includes(t))) continue;
      }
      add(w, `style.${p}`, rv, av);
    }
  }
}

/** The differences, one per line: "top #den-search style.font-weight: 500 → 700". */
export function formatNavDiffs(diffs) {
  return diffs
    .map(
      (d) => `${d.slot} ${d.key} ${d.property}: ${d.reference} → ${d.actual}`,
    )
    .join("\n");
}

// ── The font pin ─────────────────────────────────────────────────────────

/**
 * The system faces a nav names, pinned to the kit's own font files, so
 * text lays out alike on every machine: the sans faces to Rubik (400 up
 * to 449, 500 from 450), the mono ones to Space Mono. The reference was
 * taken with this pin.
 */
const PIN_SANS = [
  "-apple-system",
  "BlinkMacSystemFont",
  "Segoe UI",
  "Noto Sans",
  "Hiragino Sans",
  "Noto Sans JP",
  "Helvetica",
  "Arial",
  "Times New Roman",
];
const PIN_MONO = ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas"];
export const PIN_FONTS_CSS = [
  ...PIN_SANS.flatMap((f) => [
    `@font-face{font-family:"${f}";font-weight:100 449;src:url(/__pin-fonts/rubik-latin-400-normal.woff2) format("woff2")}`,
    `@font-face{font-family:"${f}";font-weight:450 900;src:url(/__pin-fonts/rubik-latin-500-normal.woff2) format("woff2")}`,
  ]),
  ...PIN_MONO.map(
    (f) =>
      `@font-face{font-family:"${f}";src:url(/__pin-fonts/space-mono-latin-400-normal.woff2) format("woff2")}`,
  ),
].join("\n");

/**
 * Pins a Playwright BrowserContext's fonts for the inventory (call it
 * before the context opens a page): every page gets the pin stylesheet
 * first in its <head>, and /__pin-fonts/* answers with the kit's own woff2
 * files. `opts.fontsDir`: where they are, if not this package's.
 */
export async function pinNavFonts(context, opts = {}) {
  const dir = opts.fontsDir || FONTS_DIR;
  await context.route("**/__pin-fonts/**", (route) => {
    const name = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").pop() || "",
    );
    if (name === "pin.css")
      return route.fulfill({ contentType: "text/css", body: PIN_FONTS_CSS });
    // Only a font file of the kit's: no path in the name.
    const file = path.join(dir, path.basename(name));
    if (!/^[\w.-]+\.woff2$/.test(name) || !existsSync(file))
      return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "font/woff2",
      body: readFileSync(file),
    });
  });
  await context.addInitScript(() => {
    const add = () => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "/__pin-fonts/pin.css";
      document.head.prepend(l);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add);
  });
}
