/**
 * The filter bar (issue 552): one "Filters (n)" button that opens a panel
 * of facets, and what is chosen as chips under the row, each removable,
 * then Clear all. Framework-free and data-only: the host passes its facets,
 * their options with counts, what is chosen and a callback; the kit draws
 * the markup and owns every word (kit.filter.* in strings.js).
 *
 *   filterBarHtml({ id, facets, selected, open, lang }) → string   (pure)
 *   const bar = mountFilterBar(el, {
 *     id: "docs-filter",           ids: <id>-panel, <id>-f-<n>
 *     facets: [{ id, label, options: [{ value, label, count? }] }],
 *     selected: { [facetId]: [value, …] },
 *     onChange: (selected, change) => …,
 *              change: { facet, value, on } (an option or a chip),
 *                      { clear: facetId } (a facet's Clear),
 *                      { clear: null } (Clear all)
 *     start, end,                  the host's own nodes for the row (a find
 *                                  box before Filters, Sort and the page's
 *                                  buttons after it): moved in, kept
 *     open: false,                 the panel drawn open
 *     lang: "en" | () => "en",     default: <html lang>
 *   })
 *   bar.update({ facets?, selected? })   new counts or choices from the host;
 *                                         focus stays where it was
 *   bar.selected()  bar.open()  bar.close()  bar.destroy()
 *
 * A facet's label and an option's label are the host's own words (its
 * data, as a rail page's label is); everything else is the kit's. An
 * option with a count of 0 can't be chosen, unless it is chosen. A value
 * chosen that has no option shows as itself.
 *
 * Keys: Filters is a disclosure (aria-expanded, aria-controls); Esc in
 * the panel or on Filters closes it, focus on Filters. Removing a chip
 * focuses the next chip, else the one before, else Filters; Clear all
 * focuses Filters; a facet's Clear focuses its first option.
 *
 * Its look is filter-bar.css (link it after tokens.css). Under 720px the
 * start node takes its own line and the chips scroll in their own row;
 * there, and on a touch screen, every control is 44px tall.
 */
import { esc, kitT } from "./strings.js";

/** How many values are chosen, across every facet. */
export function chosenCount(selected) {
  let n = 0;
  for (const v of Object.values(selected || {}))
    if (Array.isArray(v)) n += v.length;
  return n;
}

const numberIn = (lang, n) => {
  try {
    return new Intl.NumberFormat(lang).format(n);
  } catch {
    return String(n);
  }
};

const chosenOf = (selected, facet) =>
  Array.isArray(selected?.[facet]) ? selected[facet] : [];

/** The chips: one per chosen value, in the facets' order, then Clear all. */
function chipsHtml(facets, selected, lang) {
  const items = [];
  for (const f of facets) {
    for (const value of chosenOf(selected, f.id)) {
      const opt = (f.options || []).find((o) => o.value === value);
      const label = opt ? opt.label : value;
      items.push(
        `<li><button type="button" class="den-fb-chip" data-facet="${esc(f.id)}" data-value="${esc(value)}"` +
          ` aria-label="${esc(kitT(lang, "kit.filter.remove", { facet: f.label, value: label }))}">` +
          `<span class="den-fb-chip-facet">${esc(kitT(lang, "kit.filter.chip", { facet: f.label }))}</span>` +
          ` <span class="den-fb-chip-value">${esc(label)}</span>` +
          ` <span class="den-fb-x" aria-hidden="true">×</span></button></li>`,
      );
    }
  }
  if (!items.length) return "";
  items.push(
    `<li><button type="button" class="den-fb-clear-all">${esc(kitT(lang, "kit.filter.clearAll"))}</button></li>`,
  );
  return `<ul class="den-fb-chips" aria-label="${esc(kitT(lang, "kit.filter.chosen"))}">${items.join("")}</ul>`;
}

/** The panel's insides: a named group per facet, its options toggles. */
function facetsHtml(id, facets, selected, lang) {
  return facets
    .map((f, i) => {
      const on = chosenOf(selected, f.id);
      const head = `${id}-f-${i}`;
      const clear = on.length
        ? `<button type="button" class="den-fb-facet-clear" data-facet="${esc(f.id)}"` +
          ` aria-label="${esc(kitT(lang, "kit.filter.clearFacet", { facet: f.label }))}">` +
          `${esc(kitT(lang, "kit.filter.clear"))}</button>`
        : "";
      const opts = (f.options || [])
        .map((o) => {
          const pressed = on.includes(o.value);
          const n = typeof o.count === "number" ? o.count : null;
          const off = !pressed && n === 0;
          const count =
            n == null
              ? ""
              : ` <span class="den-fb-n">${esc(numberIn(lang, n))}</span>`;
          return (
            `<button type="button" class="den-fb-opt" data-facet="${esc(f.id)}" data-value="${esc(o.value)}"` +
            ` aria-pressed="${pressed}"${off ? " disabled" : ""}>` +
            `<span class="den-fb-opt-label">${esc(o.label)}</span>${count}</button>`
          );
        })
        .join("");
      return (
        `<div class="den-fb-facet" role="group" aria-labelledby="${esc(head)}" data-facet="${esc(f.id)}">` +
        `<div class="den-fb-facet-head"><span class="den-fb-facet-name" id="${esc(head)}">${esc(f.label)}</span>${clear}</div>` +
        `<div class="den-fb-values">${opts}</div></div>`
      );
    })
    .join("");
}

const toggleWords = (selected, lang) => {
  const n = chosenCount(selected);
  return n > 0
    ? kitT(lang, "kit.filter.buttonN", { n })
    : kitT(lang, "kit.filter.button");
};

/** The whole bar as markup (see the top of this file). Pure: runs in Node. */
export function filterBarHtml({
  id = "den-fb",
  facets = [],
  selected = {},
  open = false,
  lang = "en",
} = {}) {
  const panel = `${id}-panel`;
  return (
    `<div class="den-fb" id="${esc(id)}">` +
    `<div class="den-fb-row"><button type="button" class="den-fb-toggle" aria-expanded="${!!open}"` +
    ` aria-controls="${esc(panel)}">${esc(toggleWords(selected, lang))}</button></div>` +
    chipsHtml(facets, selected, lang) +
    `<div class="den-fb-panel" id="${esc(panel)}" role="group"` +
    ` aria-label="${esc(kitT(lang, "kit.filter.button"))}"${open ? "" : " hidden"}>` +
    facetsHtml(id, facets, selected, lang) +
    `</div></div>`
  );
}

/** A copy of `selected` with only non-empty lists. */
function tidy(selected) {
  const out = {};
  for (const [k, v] of Object.entries(selected || {}))
    if (Array.isArray(v) && v.length) out[k] = [...v];
  return out;
}

/** The filter bar in `el` (see the top of this file). */
export function mountFilterBar(el, opts = {}) {
  let facets = opts.facets || [];
  let selected = tidy(opts.selected);
  let isOpen = !!opts.open;
  const id = opts.id || el.id || "den-fb";
  const lang = () => {
    const l = typeof opts.lang === "function" ? opts.lang() : opts.lang;
    return l || document.documentElement.lang?.slice(0, 2) || "en";
  };

  el.innerHTML = filterBarHtml({
    id,
    facets,
    selected,
    open: isOpen,
    lang: lang(),
  });
  const root = el.firstElementChild;
  const row = root.querySelector(".den-fb-row");
  const toggle = row.querySelector(".den-fb-toggle");
  const panel = root.querySelector(".den-fb-panel");
  const nodes = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  for (const n of nodes(opts.start)) {
    n.classList?.add("den-fb-start");
    row.insertBefore(n, toggle);
  }
  for (const n of nodes(opts.end)) {
    n.classList?.add("den-fb-end");
    row.append(n);
  }

  /** What has focus, as something that survives a redraw. */
  function focusKey() {
    const a = document.activeElement;
    if (!a || !root.contains(a)) return null;
    if (a.classList.contains("den-fb-opt"))
      return `.den-fb-opt[data-facet="${CSS.escape(a.dataset.facet)}"][data-value="${CSS.escape(a.dataset.value)}"]`;
    if (a.classList.contains("den-fb-chip"))
      return `.den-fb-chip[data-facet="${CSS.escape(a.dataset.facet)}"][data-value="${CSS.escape(a.dataset.value)}"]`;
    if (a.classList.contains("den-fb-clear-all")) return ".den-fb-clear-all";
    if (a.classList.contains("den-fb-facet-clear"))
      return `.den-fb-facet-clear[data-facet="${CSS.escape(a.dataset.facet)}"]`;
    return null;
  }

  function paint(focus) {
    const l = lang();
    const keep = focus === undefined ? focusKey() : null;
    toggle.textContent = toggleWords(selected, l);
    toggle.setAttribute("aria-expanded", String(isOpen));
    panel.hidden = !isOpen;
    const old = root.querySelector(".den-fb-chips");
    const chips = chipsHtml(facets, selected, l);
    if (old) old.remove();
    if (chips) panel.insertAdjacentHTML("beforebegin", chips);
    panel.innerHTML = facetsHtml(id, facets, selected, l);
    const target =
      typeof focus === "function"
        ? focus()
        : keep
          ? root.querySelector(keep)
          : null;
    if (target && !target.disabled) target.focus({ preventScroll: true });
    else if (focus) toggle.focus({ preventScroll: true });
  }

  function changed(change) {
    opts.onChange?.(tidy(selected), change);
  }

  function setOpen(on, focusToggle) {
    isOpen = on;
    toggle.setAttribute("aria-expanded", String(on));
    panel.hidden = !on;
    if (focusToggle) toggle.focus({ preventScroll: true });
  }

  const onClick = (e) => {
    const b = e.target.closest?.("button");
    if (!b || !root.contains(b) || b.disabled) return;
    if (b === toggle) return setOpen(!isOpen, false);
    if (b.classList.contains("den-fb-opt")) {
      const { facet, value } = b.dataset;
      const on = chosenOf(selected, facet);
      const now = !on.includes(value);
      selected = tidy({
        ...selected,
        [facet]: now ? [...on, value] : on.filter((v) => v !== value),
      });
      paint();
      return changed({ facet, value, on: now });
    }
    if (b.classList.contains("den-fb-chip")) {
      const { facet, value } = b.dataset;
      const all = [...root.querySelectorAll(".den-fb-chip")];
      const at = all.indexOf(b);
      selected = tidy({
        ...selected,
        [facet]: chosenOf(selected, facet).filter((v) => v !== value),
      });
      paint(() => {
        const left = root.querySelectorAll(".den-fb-chip");
        return left[at] || left[at - 1] || toggle;
      });
      return changed({ facet, value, on: false });
    }
    if (b.classList.contains("den-fb-clear-all")) {
      selected = {};
      paint(() => toggle);
      return changed({ clear: null });
    }
    if (b.classList.contains("den-fb-facet-clear")) {
      const { facet } = b.dataset;
      selected = tidy({ ...selected, [facet]: [] });
      paint(
        () =>
          [
            ...panel.querySelectorAll(
              `.den-fb-opt[data-facet="${CSS.escape(facet)}"]`,
            ),
          ].find((o) => !o.disabled) || toggle,
      );
      return changed({ clear: facet });
    }
  };
  const onKey = (e) => {
    if (e.key !== "Escape" || !isOpen) return;
    const t = e.target;
    if (t !== toggle && !panel.contains(t)) return;
    e.preventDefault();
    setOpen(false, true);
  };
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);

  return {
    update(data = {}) {
      if (data.facets) facets = data.facets;
      if (data.selected) selected = tidy(data.selected);
      paint();
    },
    selected: () => tidy(selected),
    open: () => setOpen(true, false),
    close: () => setOpen(false, false),
    destroy() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKey);
    },
  };
}
