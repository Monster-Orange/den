/**
 * A searchable picker (D30): a text field (role=combobox) over a listbox.
 * Type to filter (the command palette's ranking, rankCommands), ↑/↓ to
 * move, Enter (or a click) picks, Esc closes. What is picked is an id; what
 * is shown is its name. One shared control, so a form never asks a person
 * to type an id.
 *
 *   comboHtml({ id, label, placeholder, bare })  the markup (bare: no <label>)
 *   wireCombo(root, id, { items, onPick, onType, load, free, words })
 *     items() is read each time it opens. load(q) → { items, more } asks a
 *     server as you type instead (more: a last "words.more" row). free: the
 *     typed text is the value (a name not in the list stays). Returns
 *     { value(), set(id), clear() }.
 *
 * An item: { id, label, sub?, keywords?, off? } (off: shown, not pickable).
 */
import { rankCommands } from "./topbar.js";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export function comboHtml({
  id,
  label,
  placeholder = "",
  bare = false,
  cls = "",
}) {
  return (
    `<span class="den-combo" data-combo="${esc(id)}">` +
    (bare ? "" : `<label for="${esc(id)}">${esc(label)}</label>`) +
    `<span class="den-combo-box">` +
    `<input type="text" id="${esc(id)}"${cls ? ` class="${esc(cls)}"` : ""} role="combobox" aria-expanded="false" aria-controls="${esc(id)}-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}">` +
    `<ul id="${esc(id)}-list" role="listbox" aria-label="${esc(label)}" class="den-combo-list" hidden></ul>` +
    `</span></span>`
  );
}

export const pageLoad =
  (base, limit = 50) =>
  async (q) => {
    const u = typeof base === "function" ? base() : base;
    if (!u) return { items: [], more: false };
    const p = new URLSearchParams({ limit: String(limit) });
    if (q) p.set("q", q);
    const r = await fetch(`${u}${u.includes("?") ? "&" : "?"}${p}`)
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
    const names = Array.isArray(r?.items) ? r.items : [];
    return {
      items: names.map((n) => ({ id: String(n), label: String(n) })),
      more: !!r?.next,
    };
  };

/** Rows ranked for `q` (every item when it is empty). */
export function comboMatches(items, q) {
  const list = items.map((x) => ({
    ...x,
    keywords: [x.id, x.sub ?? "", ...(x.keywords ?? [])],
  }));
  return rankCommands(list, q, { limit: 50, emptyLimit: 50 });
}

export function wireCombo(
  root,
  id,
  { items = () => [], onPick, onType, load, free = false, words = {} },
) {
  const input = root.querySelector(`#${CSS.escape(id)}`);
  const ul = root.querySelector(`#${CSS.escape(id)}-list`);
  if (!input || !ul) return null;
  const pop = typeof ul.showPopover === "function";
  if (pop) ul.popover = "manual";
  const show = (on) => {
    ul.hidden = !on;
    if (pop && on !== ul.matches(":popover-open"))
      on ? ul.showPopover() : ul.hidePopover();
  };
  let picked = "";
  let shown = [];
  let sel = 0;
  let found = { items: [], more: false };
  let seq = 0;
  let timer = 0;
  const fetchFor = (q) => {
    const n = ++seq;
    Promise.resolve(load(q))
      .catch(() => ({ items: [], more: false }))
      .then((r) => {
        if (n !== seq) return;
        found = { items: r?.items ?? [], more: !!r?.more };
        if (document.activeElement === input) draw();
      });
  };
  const close = () => {
    show(false);
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const draw = () => {
    shown = load
      ? found.items
      : comboMatches(
          items(),
          input.value === labelOf(picked) ? "" : input.value,
        );
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    ul.innerHTML = shown.length
      ? shown
          .map(
            (x, i) =>
              `<li role="option" id="${esc(id)}-o-${i}" data-i="${i}" aria-selected="${i === sel}"${x.off ? ' aria-disabled="true"' : ""}>` +
              `<span class="den-combo-l">${esc(x.label)}</span>` +
              (x.sub ? `<span class="den-combo-s">${esc(x.sub)}</span>` : "") +
              `</li>`,
          )
          .join("") +
        (load && found.more
          ? `<li class="den-combo-more" aria-disabled="true">${esc(words.more ?? "")}</li>`
          : "")
      : `<li class="den-combo-none" aria-disabled="true">${esc(words.none ?? "No match")}</li>`;
    show(true);
    place();
    input.setAttribute("aria-expanded", "true");
    if (shown.length)
      input.setAttribute("aria-activedescendant", `${id}-o-${sel}`);
    ul.querySelector(`[data-i="${sel}"]`)?.scrollIntoView?.({
      block: "nearest",
    });
  };
  const place = () => {
    const r = input.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    const up = room < 160 && r.top > room;
    ul.style.left = `${r.left}px`;
    ul.style.width = `${r.width}px`;
    ul.style.maxHeight = `${Math.max(120, Math.min(240, (up ? r.top : room) - 8))}px`;
    ul.style.top = up ? "" : `${r.bottom + 2}px`;
    ul.style.bottom = up ? `${window.innerHeight - r.top + 2}px` : "";
  };
  const labelOf = (v) =>
    (load ? found.items : items()).find((x) => x.id === v)?.label ??
    (free ? v : "");
  const pick = (x) => {
    if (!x || x.off) return;
    picked = x.id;
    input.value = x.label;
    input.dataset.value = x.id;
    close();
    onPick?.(x);
    onType?.(x.id);
  };
  document.addEventListener(
    "scroll",
    () => {
      if (!ul.hidden) place();
    },
    true,
  );
  input.addEventListener("focus", () => {
    sel = 0;
    if (load) fetchFor(input.value.trim());
    else draw();
  });
  input.addEventListener("input", () => {
    picked = free ? input.value.trim() : "";
    delete input.dataset.value;
    sel = 0;
    onType?.(picked);
    if (!load) return draw();
    clearTimeout(timer);
    timer = setTimeout(() => fetchFor(input.value.trim()), 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (ul.hidden) return draw();
      const n = shown.length;
      if (!n) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      draw();
    } else if (e.key === "Enter") {
      if (ul.hidden) return;
      e.preventDefault();
      pick(shown[sel]);
    } else if (e.key === "Escape") {
      if (!ul.hidden) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
  });
  // mousedown, not click: the field keeps its focus (no blur close first).
  ul.addEventListener("mousedown", (e) => {
    const li = e.target.closest?.("[data-i]");
    if (!li) return;
    e.preventDefault();
    pick(shown[Number(li.dataset.i)]);
  });
  input.addEventListener("blur", () => {
    close();
    // Leaving with a half-typed name: back to what was picked.
    if (!free && input.value !== labelOf(picked)) input.value = labelOf(picked);
  });
  return {
    value: () => picked,
    set: (v) => {
      picked = v;
      input.value = free ? v : labelOf(v);
      if (v) input.dataset.value = v;
      else delete input.dataset.value;
    },
    clear: () => {
      picked = "";
      input.value = "";
      delete input.dataset.value;
    },
  };
}
