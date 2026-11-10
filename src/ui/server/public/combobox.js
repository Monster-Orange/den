/**
 * A searchable picker (D30): a text field (role=combobox) over a listbox.
 * Type to filter (the command palette's ranking, rankCommands), ↑/↓ to
 * move, Enter (or a click) picks, Esc closes. What is picked is an id; what
 * is shown is its name. One shared control, so a form never asks a person
 * to type an id.
 *
 *   comboHtml({ id, label, placeholder })   the markup (a <label>, the
 *                                            field, its list)
 *   wireCombo(root, id, { items, onPick })  makes it work; items() is read
 *                                            each time it opens, so it
 *                                            follows live data. Returns
 *                                            { value(), set(id), clear() }.
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

export function comboHtml({ id, label, placeholder = "" }) {
  return (
    `<span class="den-combo" data-combo="${esc(id)}">` +
    `<label for="${esc(id)}">${esc(label)}</label>` +
    `<span class="den-combo-box">` +
    `<input type="text" id="${esc(id)}" role="combobox" aria-expanded="false" aria-controls="${esc(id)}-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}">` +
    `<ul id="${esc(id)}-list" role="listbox" aria-label="${esc(label)}" class="den-combo-list" hidden></ul>` +
    `</span></span>`
  );
}

/** Rows ranked for `q` (every item when it is empty). */
export function comboMatches(items, q) {
  const list = items.map((x) => ({
    ...x,
    keywords: [x.id, x.sub ?? "", ...(x.keywords ?? [])],
  }));
  return rankCommands(list, q, { limit: 50, emptyLimit: 50 });
}

export function wireCombo(root, id, { items, onPick }) {
  const input = root.querySelector(`#${CSS.escape(id)}`);
  const ul = root.querySelector(`#${CSS.escape(id)}-list`);
  if (!input || !ul) return null;
  let picked = "";
  let shown = [];
  let sel = 0;
  const close = () => {
    ul.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const draw = () => {
    shown = comboMatches(
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
          .join("")
      : `<li class="den-combo-none" aria-disabled="true">No match</li>`;
    ul.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (shown.length)
      input.setAttribute("aria-activedescendant", `${id}-o-${sel}`);
    ul.querySelector(`[data-i="${sel}"]`)?.scrollIntoView?.({
      block: "nearest",
    });
  };
  const labelOf = (v) => items().find((x) => x.id === v)?.label ?? "";
  const pick = (x) => {
    if (!x || x.off) return;
    picked = x.id;
    input.value = x.label;
    input.dataset.value = x.id;
    close();
    onPick?.(x);
  };
  input.addEventListener("focus", () => {
    sel = 0;
    draw();
  });
  input.addEventListener("input", () => {
    picked = "";
    delete input.dataset.value;
    sel = 0;
    draw();
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
    if (input.value !== labelOf(picked)) input.value = labelOf(picked);
  });
  return {
    value: () => picked,
    set: (v) => {
      picked = v;
      input.value = labelOf(v);
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
