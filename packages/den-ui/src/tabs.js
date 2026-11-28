import { esc } from "./strings.js";

const HYSTERESIS_PX = 8;
const KINDS = ["page", "switch", "panel"];
const EDGE_W = 24;
const FADE_W = 16;
const EDGE_PAD = EDGE_W + FADE_W;

function itemsOf(o) {
  return (Array.isArray(o.items) ? o.items : [])
    .filter((it) => it && it.id != null && String(it.text ?? "").trim())
    .map((it) => ({
      id: String(it.id),
      text: String(it.text),
      href: it.href == null ? "" : String(it.href),
      count: it.count == null || it.count === "" ? "" : String(it.count),
      disabled: Boolean(it.disabled),
      alert: Boolean(it.alert),
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
  const id = ` data-id="${esc(it.id)}"` + (it.alert ? " data-alert" : "");
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
  const edge = (side, glyph) =>
    `<button type="button" class="den-tabs-edge" data-den-tabs-edge="${side}"` +
    ` tabindex="-1" aria-hidden="true" hidden>${glyph}` +
    `<i class="den-tabs-dot" hidden></i></button>`;
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
    `<div class="den-tabs" data-den-tabs="${kind}" data-size="${size}"` +
    ' data-den-tabs-over="none">' +
    edge("start", "«") +
    rowOpen(kind, label) +
    items.map((it) => segment(kind, it, it.id === chosen)).join("") +
    (kind === "page" ? "</nav>" : "</div>") +
    edge("end", "»") +
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

const HANDLES = new WeakMap();

export function hydrateTabs(el, opts = {}) {
  const root = el?.matches?.("[data-den-tabs]")
    ? el
    : (el?.closest?.("[data-den-tabs]") ??
      el?.querySelector?.("[data-den-tabs]"));
  const none = { set() {}, chosen: () => "", destroy() {} };
  if (!root) return none;
  if (root.hasAttribute("data-den-tabs-ready"))
    return HANDLES.get(root) ?? none;
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
    keep();
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
    const mod =
      e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
    if (kind === "panel" && mod) return;
    if (kind === "panel") e.preventDefault();
    choose(idOf(b));
  };

  const onKey = (e) => {
    if (kind === "page" || e.isComposing) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const b = e.target.closest?.(".den-tab");
    if (kind === "panel" && e.key === " " && b && usable(b)) {
      e.preventDefault();
      choose(idOf(b));
      return;
    }
    const all = segs().filter(usable);
    const at = all.indexOf(b);
    if (at < 0) return;
    const rtl = globalThis.getComputedStyle(row).direction === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    let to = -1;
    if (step) to = (at + step + all.length) % all.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = all.length - 1;
    if (to < 0) return;
    e.preventDefault();
    all[to].focus({ preventScroll: scroller });
    choose(idOf(all[to]));
    keep(all[to]);
  };

  const onSelect = () => {
    const went = choose(select.value);
    if (kind !== "page" || went === false) return;
    const href = select.selectedOptions[0]?.dataset.href;
    if (href) globalThis.location.assign(href);
  };

  const scroller = true;
  const edges = Array.from(root.querySelectorAll("[data-den-tabs-edge]"));
  const sideOf = (b) => {
    const rr = row.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return br.left + br.width / 2 < rr.left + rr.width / 2 ? "left" : "right";
  };
  function dirNow() {
    const rtl = globalThis.getComputedStyle(root).direction === "rtl";
    root.dataset.denTabsDir = rtl ? "rtl" : "ltr";
    for (const b of edges) {
      const start = b.dataset.denTabsEdge === "start";
      if (b.firstChild) b.firstChild.textContent = start !== rtl ? "«" : "»";
    }
  }
  function edgesNow() {
    if (folded) {
      for (const b of edges) b.hidden = true;
      root.dataset.denTabsOver = "none";
      return;
    }
    const at = Math.abs(row.scrollLeft);
    const start = at > 1;
    const end = at + row.clientWidth < row.scrollWidth - 1;
    const rr = row.getBoundingClientRect();
    for (const b of edges) {
      b.hidden = b.dataset.denTabsEdge === "start" ? !start : !end;
      if (b.hidden) continue;
      const left = sideOf(b) === "left";
      const hiddenAlert = segs().some((s) => {
        if (!s.hasAttribute("data-alert")) return false;
        const r = s.getBoundingClientRect();
        return left ? r.left < rr.left + EDGE_W : r.right > rr.right - EDGE_W;
      });
      const dot = b.querySelector(".den-tabs-dot");
      if (dot) dot.hidden = !hiddenAlert;
    }
    root.dataset.denTabsOver =
      start && end ? "both" : start ? "start" : end ? "end" : "none";
  }
  function keep(b = segs().find((s) => idOf(s) === current)) {
    if (folded || !b) return;
    const rr = row.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const pad = row.scrollWidth > row.clientWidth ? EDGE_PAD : 0;
    if (br.left < rr.left + pad) row.scrollLeft -= rr.left + pad - br.left;
    else if (br.right > rr.right - pad)
      row.scrollLeft += br.right - (rr.right - pad);
    edgesNow();
  }
  const onEdge = (e) => {
    const rr = row.getBoundingClientRect();
    const all = segs().map((s) => s.getBoundingClientRect());
    let delta;
    if (sideOf(e.currentTarget) === "right") {
      const r = all.find((x) => x.right > rr.right - EDGE_PAD + 1);
      delta = r ? r.left - (rr.left + EDGE_PAD) : row.clientWidth;
    } else {
      const r = all.findLast((x) => x.left < rr.left + EDGE_PAD - 1);
      delta = r ? r.right - (rr.right - EDGE_PAD) : -row.clientWidth;
    }
    const calm = globalThis.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    row.scrollBy({ left: delta, behavior: calm ? "auto" : "smooth" });
  };
  const onFocus = (e) => {
    const b = e.target.closest?.(".den-tab");
    if (b) keep(b);
  };

  let need = 0;
  let folded = false;
  function measure() {
    dirNow();
    if (!fold || !select) return edgesNow();
    if (!folded)
      need =
        Math.ceil(
          Math.max(0, ...segs().map((s) => s.getBoundingClientRect().width)),
        ) +
        2 * EDGE_PAD;
    const room = Math.floor(root.clientWidth);
    const next = folded ? room < need + HYSTERESIS_PX : room < need;
    if (next === folded) return keep();
    const hadFocus = root.contains(root.ownerDocument.activeElement);
    folded = next;
    row.hidden = folded;
    fold.hidden = !folded;
    root.toggleAttribute("data-folded", folded);
    keep();
    edgesNow();
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
  row?.addEventListener("scroll", edgesNow, { passive: true });
  row?.addEventListener("focusin", onFocus);
  root.setAttribute("data-den-tabs-ready", "");
  for (const b of edges) b.addEventListener("click", onEdge);
  const ro =
    typeof globalThis.ResizeObserver === "function"
      ? new globalThis.ResizeObserver(measure)
      : null;
  ro?.observe(root);
  if (root.parentElement) ro?.observe(root.parentElement);
  measure();
  keep();

  const handle = {
    set(id) {
      const b = segs().find((s) => idOf(s) === String(id));
      if (b && usable(b)) show(String(id));
    },
    chosen: () => current ?? "",
    destroy() {
      ro?.disconnect();
      row?.removeEventListener("click", onClick);
      row?.removeEventListener("keydown", onKey);
      row?.removeEventListener("scroll", edgesNow);
      row?.removeEventListener("focusin", onFocus);
      for (const b of edges) b.removeEventListener("click", onEdge);
      select?.removeEventListener("change", onSelect);
      HANDLES.delete(root);
      root.removeAttribute("data-den-tabs-ready");
    },
  };
  HANDLES.set(root, handle);
  return handle;
}
