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
 * (STYLE_PROPS).
 *
 * The key names an element the same way on every run: `#id` when it has
 * an id; `[data-nav="x"]` for a rail entry; else its parent's key, " > ",
 * its tag and first class, and [n] when siblings share that.
 *
 * Theme tokens: the snapshot also maps each colour it saw to the :root
 * custom properties (--tokens) that compute to that same colour. The
 * method: every custom property declared in a rule whose selector names
 * :root or html (inside @media and @layer too) is read from
 * getComputedStyle(<html>); a value that is a colour (CSS.supports) is
 * set on a probe element's `color` and read back, so it is in the same
 * form as any computed colour ("rgb(…)", "rgba(…)", "color(…)"). A colour
 * equal to that is said to come from the token. Two tokens of one value
 * both match; the comparer asks only that one listed token match on both
 * sides.
 */

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

/** The snapshot's format; a reference with another one is refused. */
export const NAV_INVENTORY_VERSION = 1;

/**
 * The global nav of the page, in DOM order. Runs in the page: nothing is
 * read from outside it.
 */
export async function collectNav(page) {
  const snap = await page.evaluate(
    ({ props, colorProps }) => {
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
      const walk = (el, pathKey, boxParent, slot) => {
        if (el.hidden) return slot;
        const cs = getComputedStyle(el);
        if (cs.display === "none") return slot;
        const mySlot = el.classList.contains("den-rail-grow") ? "foot" : slot;
        let key = keyOf(el, pathKey);
        const n = (used.get(key) || 0) + 1;
        used.set(key, n);
        if (n > 1) key += `{${n}}`;
        const boxed = el.getClientRects().length > 0;
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
          });
        }
        if (el.tagName.toLowerCase() === "svg") return mySlot;
        let kidSlot = mySlot;
        for (const k of Array.from(el.children)) {
          // Everything after the rail's spacer is the rail's foot.
          kidSlot = walk(k, key, boxed ? key : boxParent, kidSlot);
        }
        return kidSlot === "foot" ? "foot" : mySlot;
      };
      const top = document.querySelector("header.den-top");
      const rail = document.querySelector("nav.den-rail, .den-rail");
      if (top) walk(top, null, null, "top");
      if (rail) walk(rail, null, null, "rail");

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
      const byColor = {};
      for (const name of [...names].sort()) {
        const v = rootCs.getPropertyValue(name).trim();
        if (!v || !CSS.supports("color", v)) continue;
        probe.style.color = "";
        probe.style.color = v;
        const c = getComputedStyle(probe).color;
        (byColor[c] = byColor[c] || []).push(name);
      }
      probe.remove();
      const seen = new Set();
      for (const e of out) for (const p of colorProps) seen.add(e.style[p]);
      const tokens = {};
      for (const c of [...seen].sort()) if (byColor[c]) tokens[c] = byColor[c];
      return {
        viewport: { w: innerWidth, h: innerHeight },
        userAgent: navigator.userAgent,
        elements: out,
        tokens,
      };
    },
    { props: STYLE_PROPS, colorProps: COLOR_PROPS },
  );
  return { version: NAV_INVENTORY_VERSION, ...snap };
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
function slotShifts(actual, reference, hostSlots) {
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
 * Every difference between `actual` and `reference`. Fails on: an element
 * missing, extra or out of order; a slot, role, tag, name or class list
 * that differs; a box edge moved more than `tolerance` px (default 2); a
 * computed style that differs. Not compared: anything inside `hostSlots`
 * (keys such as "#den-status", or one class such as ".den-scope": the
 * element and all under it, on both sides); a colour that differs where
 * both colours come from one token named in `themeTokens` ("--accent").
 * A host slot may be wider or narrower than in the reference (or there on
 * one side only): the other elements in its nav slot may then move or
 * stretch sideways by exactly that change (or a sum of such changes, with
 * the flex gap of a slot there on one side only), never by anything else.
 */
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
  const want = kept(reference, hostSlots);
  const got = kept(actual, hostSlots);
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
  const shifts = slotShifts(actual, reference, hostSlots);
  for (const w of want) {
    const g = gotBy.get(w.key);
    if (!g) continue;
    for (const p of ["slot", "role", "tag", "name"])
      if (w[p] !== g[p]) add(w, p, w[p], g[p]);
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
    const moves = shifts[w.slot] || [0];
    for (const edge of ["left", "top", "right", "bottom"]) {
      const d = ge[edge] - we[edge];
      const ok =
        edge === "left" || edge === "right"
          ? moves.some((m) => Math.abs(d - m) <= tol)
          : Math.abs(d) <= tol;
      if (!ok) add(w, `box.${edge}`, we[edge], ge[edge]);
    }
    for (const p of STYLE_PROPS) {
      const rv = w.style[p];
      const av = g.style[p];
      if (rv === av) continue;
      if (COLOR_PROPS.includes(p) && themeTokens.size) {
        const rt = tokenOf(reference, rv);
        const at = tokenOf(actual, av);
        if (rt.some((t) => themeTokens.has(t) && at.includes(t))) continue;
      }
      add(w, `style.${p}`, rv, av);
    }
  }
  return diffs;
}

/** The differences, one per line: "top #den-search style.font-weight: 500 → 700". */
export function formatNavDiffs(diffs) {
  return diffs
    .map(
      (d) => `${d.slot} ${d.key} ${d.property}: ${d.reference} → ${d.actual}`,
    )
    .join("\n");
}
