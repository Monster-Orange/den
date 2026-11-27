import { esc } from "./strings.js";

const HYSTERESIS_PX = 8;
const KINDS = ["page", "switch", "panel"];

function itemsOf(o) {
  return (Array.isArray(o.items) ? o.items : [])
    .filter((it) => it && it.id != null && String(it.text ?? "").trim())
    .map((it) => ({
      id: String(it.id),
      text: String(it.text),
      href: it.href == null ? "" : String(it.href),
      count: it.count == null || it.count === "" ? "" : String(it.count),
      disabled: Boolean(it.disabled),
      panel: it.panel == null ? String(it.id) : String(it.panel),
    }));
}

function chosenOf(items, chosen) {
  const want = chosen == null ? "" : String(chosen);
  const hit = items.find((it) => it.id === want && !it.disabled);
  return (hit ?? items.find((it) => !it.disabled))?.id ?? "";
}

const tabIdOf = (it) => `den-tab-${it.panel}`;

function segment(kind, it, on) {
  const name = it.count
    ? ` aria-label="${esc(`${it.text}, ${it.count}`)}"`
    : "";
  const inner =
    `<span class="den-tab-t">${esc(it.text)}</span>` +
    (it.count
      ? `<span class="den-tab-n" aria-hidden="true">${esc(it.count)}</span>`
      : "");
  const id = ` data-id="${esc(it.id)}"`;
  const off = it.disabled ? ' aria-disabled="true"' : "";
  if (kind === "page") {
    if (it.disabled) return `<a class="den-tab"${id}${off}${name}>${inner}</a>`;
    return (
      `<a class="den-tab"${id} href="${esc(it.href || "#")}"` +
      (on ? ' aria-current="page"' : "") +
      `${name}>${inner}</a>`
    );
  }
  if (kind === "panel") {
    const href = it.href || `?tab=${encodeURIComponent(it.id)}`;
    return (
      `<a class="den-tab" role="tab" id="${esc(tabIdOf(it))}"${id}` +
      (it.disabled ? "" : ` href="${esc(href)}"`) +
      ` aria-selected="${on ? "true" : "false"}"` +
      ` aria-controls="${esc(it.panel)}"` +
      ` tabindex="${on ? "0" : "-1"}"` +
      `${off}${name}>${inner}</a>`
    );
  }
  return (
    `<button type="button" class="den-tab"${id}` +
    ` aria-pressed="${on ? "true" : "false"}"` +
    ` tabindex="${on ? "0" : "-1"}"` +
    `${off}${name}>${inner}</button>`
  );
}

function rowOpen(kind, label) {
  const name = ` aria-label="${esc(label)}"`;
  if (kind === "page") return `<nav class="den-tabs-row"${name}>`;
  const role = kind === "panel" ? "tablist" : "group";
  return `<div class="den-tabs-row" role="${role}"${name}>`;
}

export function tabsHtml(o = {}) {
  const kind = KINDS.includes(o.kind) ? o.kind : "switch";
  const label = o.label == null ? "" : String(o.label);
  const items = itemsOf(o);
  if (!label.trim() || items.length < 2) return "";
  const chosen = chosenOf(items, o.chosen);
  const size = o.size === "m" || o.size === "l" ? o.size : "auto";
  const options = items
    .map(
      (it) =>
        `<option value="${esc(it.id)}"` +
        (it.href ? ` data-href="${esc(it.href)}"` : "") +
        (it.id === chosen ? " selected" : "") +
        (it.disabled ? " disabled" : "") +
        `>${esc(it.count ? `${it.text} (${it.count})` : it.text)}</option>`,
    )
    .join("");
  return (
    `<div class="den-tabs" data-den-tabs="${kind}" data-size="${size}">` +
    rowOpen(kind, label) +
    items.map((it) => segment(kind, it, it.id === chosen)).join("") +
    (kind === "page" ? "</nav>" : "</div>") +
    `<label class="den-tabs-fold" hidden>` +
    `<span class="den-tabs-fold-l">${esc(label)}</span>` +
    `<select class="den-tabs-select">${options}</select></label></div>`
  );
}

const ON_ATTR = {
  page: "aria-current",
  switch: "aria-pressed",
  panel: "aria-selected",
};

export function hydrateTabs(el, opts = {}) {
  const root = el?.matches?.("[data-den-tabs]")
    ? el
    : (el?.closest?.("[data-den-tabs]") ??
      el?.querySelector?.("[data-den-tabs]"));
  const none = { set() {}, chosen: () => "", destroy() {} };
  if (!root) return none;
  const kind = KINDS.includes(root.dataset.denTabs)
    ? root.dataset.denTabs
    : "switch";
  const row = root.querySelector(".den-tabs-row");
  const fold = root.querySelector(".den-tabs-fold");
  const select = root.querySelector(".den-tabs-select");
  const segs = () => Array.from(row.querySelectorAll(".den-tab"));
  const usable = (b) => b.getAttribute("aria-disabled") !== "true";
  const idOf = (b) => b.dataset.id;
  const isOn = (b) =>
    kind === "page"
      ? b.getAttribute("aria-current") === "page"
      : b.getAttribute(ON_ATTR[kind]) === "true";
  const panelOf = (b) =>
    kind === "panel"
      ? b.ownerDocument.getElementById(b.getAttribute("aria-controls"))
      : null;
  let current = (segs().find(isOn) ?? segs().find(usable))?.dataset.id;

  function show(id) {
    current = id;
    for (const b of segs()) {
      const on = idOf(b) === id;
      if (kind === "page") {
        if (on) b.setAttribute("aria-current", "page");
        else b.removeAttribute("aria-current");
        continue;
      }
      b.setAttribute(ON_ATTR[kind], on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      const panel = panelOf(b);
      if (panel) panel.hidden = !on;
    }
    if (select) select.value = id;
  }

  function choose(id) {
    if (id === current) return true;
    show(id);
    return opts.onChange?.(id);
  }

  for (const b of segs()) {
    const panel = panelOf(b);
    if (!panel) continue;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", b.id);
    if (!panel.hasAttribute("tabindex")) panel.tabIndex = 0;
    panel.hidden = !isOn(b);
  }

  const onClick = (e) => {
    const b = e.target.closest?.(".den-tab");
    if (!b || !row.contains(b)) return;
    if (!usable(b)) {
      e.preventDefault();
      return;
    }
    if (kind === "page") return;
    if (kind === "panel") e.preventDefault();
    choose(idOf(b));
  };

  const onKey = (e) => {
    if (kind === "page" || e.isComposing) return;
    const b = e.target.closest?.(".den-tab");
    if (kind === "panel" && e.key === " " && b && usable(b)) {
      e.preventDefault();
      choose(idOf(b));
      return;
    }
    const all = segs().filter(usable);
    const at = all.indexOf(b);
    if (at < 0) return;
    const rtl = getComputedStyle(row).direction === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    let to = -1;
    if (step) to = (at + step + all.length) % all.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = all.length - 1;
    if (to < 0) return;
    e.preventDefault();
    all[to].focus();
    choose(idOf(all[to]));
  };

  const onSelect = () => {
    const went = choose(select.value);
    if (kind !== "page" || went === false) return;
    const href = select.selectedOptions[0]?.dataset.href;
    if (href) window.location.assign(href);
  };

  let need = 0;
  let folded = false;
  function measure() {
    if (!fold || !select) return;
    if (!folded) need = Math.ceil(row.scrollWidth);
    const room = Math.floor(root.clientWidth);
    const next = folded ? room < need + HYSTERESIS_PX : room < need;
    if (next === folded) return;
    const hadFocus = root.contains(document.activeElement);
    folded = next;
    row.hidden = folded;
    fold.hidden = !folded;
    root.toggleAttribute("data-folded", folded);
    if (!hadFocus) return;
    if (folded) select.focus();
    else
      segs()
        .find((b) => idOf(b) === current)
        ?.focus();
  }

  row?.addEventListener("click", onClick);
  row?.addEventListener("keydown", onKey);
  select?.addEventListener("change", onSelect);
  const ro =
    typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
  ro?.observe(root);
  if (root.parentElement) ro?.observe(root.parentElement);
  measure();

  return {
    set(id) {
      const b = segs().find((s) => idOf(s) === String(id));
      if (b && usable(b)) show(String(id));
    },
    chosen: () => current ?? "",
    destroy() {
      ro?.disconnect();
      row?.removeEventListener("click", onClick);
      row?.removeEventListener("keydown", onKey);
      select?.removeEventListener("change", onSelect);
    },
  };
}
