import { esc } from "./strings.js";
import { holdDots } from "./busy.js";

const MODES = ["pages", "more"];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function fmt(lang, n) {
  try {
    return new Intl.NumberFormat(lang || "en").format(n);
  } catch {
    return String(n);
  }
}

function fill(tpl, lang, vars) {
  return String(tpl ?? "").replace(/\{(\w+)\}/g, (all, k) =>
    k in vars ? fmt(lang, vars[k]) : all,
  );
}

function modelOf(o) {
  const known = o.total != null && o.total !== "";
  const total = known ? num(o.total) : null;
  const from = Math.max(1, num(o.from) || 1);
  const to = Math.max(from, num(o.to));
  return {
    mode: MODES.includes(o.mode) ? o.mode : "pages",
    from,
    to: known ? Math.min(total, to) : to,
    total,
    step: num(o.step) || Math.max(1, to - from + 1),
    prevHref: o.prevHref == null ? "" : String(o.prevHref),
    nextHref:
      o.nextHref == null || o.hasNext === false ? "" : String(o.nextHref),
    moreHref:
      o.moreHref == null || o.hasNext === false ? "" : String(o.moreHref),
    lang: o.lang == null ? "en" : String(o.lang),
    words: o.words && typeof o.words === "object" ? o.words : {},
  };
}

const done = (m) => m.total != null && m.to >= m.total;

function rangeText(m) {
  const w = m.words;
  if (m.mode === "more" && m.from === 1 && done(m))
    return fill(w.all, m.lang, { total: m.total });
  if (m.total == null)
    return fill(w.rangeOpen ?? "{from}–{to}", m.lang, {
      from: m.from,
      to: m.to,
    });
  return fill(w.range, m.lang, { from: m.from, to: m.to, total: m.total });
}

function moreText(m) {
  if (m.total == null) return fill(m.words.more, m.lang, { n: m.step });
  const left = m.total - m.to;
  return left <= m.step
    ? fill(m.words.last, m.lang, { n: left })
    : fill(m.words.more, m.lang, { n: m.step });
}

function pageLink(cls, href, arrow, word, before) {
  const a = `<span class="den-pager-arr" aria-hidden="true">${arrow}</span>`;
  const t = `<span>${esc(word)}</span>`;
  const inner = before ? a + t : t + a;
  const rel = cls === "prev" ? "prev" : "next";
  if (!href)
    return `<a class="den-pager-btn den-pager-${cls}" aria-disabled="true">${inner}</a>`;
  return `<a class="den-pager-btn den-pager-${cls}" href="${esc(href)}" rel="${rel}">${inner}</a>`;
}

export function pagerHtml(o = {}) {
  const m = modelOf(o);
  const onePage =
    m.total == null
      ? m.from <= 1 && !(m.mode === "more" ? m.moreHref : m.nextHref)
      : m.from <= 1 && m.to >= m.total;
  if (m.total === 0 || onePage) return "";
  const w = m.words;
  const open =
    `<nav class="den-pager" data-den-pager="${m.mode}"` +
    ` aria-label="${esc(String(w.label ?? ""))}"`;
  if (m.mode === "pages")
    return (
      `${open}>` +
      `<p class="den-pager-range">${esc(rangeText(m))}</p>` +
      `<div class="den-pager-ctl">` +
      pageLink("prev", m.prevHref, "←", w.prev, true) +
      pageLink("next", m.nextHref, "→", w.next, false) +
      "</div></nav>"
    );
  const keep = { ...m, words: m.words };
  return (
    `${open} data-den-pager-model="${esc(JSON.stringify(keep))}">` +
    `<p class="den-pager-range" aria-live="polite">${esc(rangeText(m))}</p>` +
    `<div class="den-pager-ctl">` +
    `<p class="den-pager-err" hidden>${esc(String(w.moreErr ?? ""))}</p>` +
    `<a class="den-pager-btn den-pager-more" href="${esc(m.moreHref || "#")}">${esc(moreText(m))}</a>` +
    "</div></nav>"
  );
}

const FOCUSABLE = "a[href],button,input,select,textarea,[tabindex]";

export function hydratePager(el, opts = {}) {
  const root = el?.matches?.("[data-den-pager]")
    ? el
    : (el?.closest?.("[data-den-pager]") ??
      el?.querySelector?.("[data-den-pager]"));
  const none = { destroy() {} };
  if (!root || root.dataset.denPager !== "more") return none;
  let m;
  try {
    m = modelOf(JSON.parse(root.dataset.denPagerModel || "{}"));
  } catch {
    return none;
  }
  const range = root.querySelector(".den-pager-range");
  const err = root.querySelector(".den-pager-err");
  const btn = root.querySelector(".den-pager-more");
  const list =
    (typeof opts.list === "string"
      ? root.ownerDocument.getElementById(opts.list)
      : opts.list) ?? root.previousElementSibling;
  if (!btn || !list) return none;
  btn.setAttribute("role", "button");
  let loading = false;

  function show() {
    range.textContent = rangeText(m);
    if (done(m)) {
      btn.remove();
      err?.remove();
      return;
    }
    btn.textContent = moreText(m);
  }

  async function more() {
    if (loading || typeof opts.load !== "function") return;
    loading = true;
    if (err) err.hidden = true;
    holdDots(btn, true);
    try {
      const res = await opts.load();
      holdDots(btn, false);
      const last = list.lastElementChild;
      list.insertAdjacentHTML("beforeend", String(res?.html ?? ""));
      const first = last ? last.nextElementSibling : list.firstElementChild;
      const to = Math.max(m.to, num(res?.to));
      m =
        m.total == null
          ? { ...m, to, total: res?.hasNext === false ? to : null }
          : { ...m, to: Math.min(m.total, to) };
      if (res?.moreHref) btn.setAttribute("href", String(res.moreHref));
      show();
      if (first) {
        if (!first.matches(FOCUSABLE)) first.tabIndex = -1;
        first.focus();
      }
    } catch {
      holdDots(btn, false);
      if (err) err.hidden = false;
    } finally {
      loading = false;
    }
  }

  const onClick = (e) => {
    e.preventDefault();
    more();
  };
  const onKey = (e) => {
    if (e.key !== " " || e.isComposing) return;
    e.preventDefault();
    more();
  };
  btn.addEventListener("click", onClick);
  btn.addEventListener("keydown", onKey);
  return {
    destroy() {
      btn.removeEventListener("click", onClick);
      btn.removeEventListener("keydown", onKey);
    },
  };
}
