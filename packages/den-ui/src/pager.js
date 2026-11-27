import { esc } from "./strings.js";
import { holdDots } from "./busy.js";

const MODES = ["pages", "more"];
const PER = [25, 50, 100, 200];
const SELECT_MAX = 500;
const TRAIL_MAX = 20;
let popSeq = 0;

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

function hrefOf(o) {
  const own = {
    first: o.firstHref,
    prev: o.prevHref,
    next: o.nextHref,
    last: o.lastHref,
  };
  return (t) => {
    let v;
    try {
      v = typeof o.href === "function" ? o.href(t) : own[t];
    } catch {
      v = "";
    }
    return v == null ? "" : String(v);
  };
}

function modelOf(o) {
  const known = o.total != null && o.total !== "";
  const total = known ? num(o.total) : null;
  const from = Math.max(1, num(o.from) || 1);
  const to0 = Math.max(from, num(o.to));
  const to = known ? Math.min(total, to0) : to0;
  const per = num(o.per) || num(o.step) || Math.max(1, to - from + 1);
  const pages =
    total == null ? null : num(o.pages) || Math.max(1, Math.ceil(total / per));
  const page =
    total == null
      ? num(o.page) || Math.ceil(from / per)
      : Math.min(pages, Math.max(1, num(o.page) || Math.ceil(from / per)));
  const hasNext =
    total == null
      ? o.hasNext == null
        ? o.nextHref != null && o.nextHref !== ""
        : !!o.hasNext
      : page < pages;
  const href = hrefOf(o);
  const opts = Array.isArray(o.perOptions) ? o.perOptions.map(num) : PER;
  return {
    mode: MODES.includes(o.mode) ? o.mode : "pages",
    from,
    to,
    total,
    step: num(o.step) || per,
    per,
    perOptions: [...new Set([...opts, per])]
      .filter((n) => n > 0)
      .sort((a, b) => a - b),
    page,
    pages,
    hasNext,
    href,
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
  const w = m.words;
  const more = w.moreN ?? w.more;
  if (m.total == null) return fill(more, m.lang, { n: m.step });
  const left = m.total - m.to;
  return left <= m.step
    ? fill(w.lastN ?? w.last, m.lang, { n: left })
    : fill(more, m.lang, { n: m.step });
}

function pageLink(m, dir, on) {
  const w = m.words;
  const glyph = { first: "«", prev: "‹", next: "›", last: "»" }[dir];
  const before = dir === "first" || dir === "prev";
  const a = `<span class="den-pager-arr" aria-hidden="true">${glyph}</span>`;
  const t = `<span class="den-pager-word">${esc(String(w[dir] ?? ""))}</span>`;
  const inner = before ? a + t : t + a;
  const sr = w[`${dir}Sr`] ?? w[dir] ?? "";
  const attrs =
    `class="den-pager-btn den-pager-${dir}" data-den-pager-go="${dir}"` +
    ` aria-label="${esc(String(sr))}"`;
  const href = on ? m.href(dir) : "";
  if (!href) return `<a ${attrs} role="link" aria-disabled="true">${inner}</a>`;
  const rel = dir === "prev" || dir === "next" ? ` rel="${dir}"` : "";
  return `<a ${attrs} href="${esc(href)}"${rel}>${inner}</a>`;
}

function formFor(a, b, fallback) {
  let ua;
  let ub;
  try {
    ua = new URL(a, "http://h/");
    ub = new URL(b, "http://h/");
  } catch {
    return { action: "", name: fallback, keep: [] };
  }
  const keys = new Set([...ua.searchParams.keys(), ...ub.searchParams.keys()]);
  const name =
    [...keys].find((k) => ua.searchParams.get(k) !== ub.searchParams.get(k)) ??
    fallback;
  const keep = [...ua.searchParams].filter(([k]) => k !== name);
  return { action: ua.pathname, name, keep, hash: ua.hash };
}

function hidden(keep) {
  return keep
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
}

function inSentence(tpl, lang, vars, select) {
  const parts = String(tpl ?? "{select}").split("{select}");
  const words = (s) =>
    s.trim() ? `<span>${esc(fill(s, lang, vars).trim())}</span>` : "";
  return words(parts[0]) + select + words(parts.slice(1).join(""));
}

function pagePicker(m, phone) {
  const w = m.words;
  const target = (p) => m.href({ page: p });
  const f = formFor(target(1), target(Math.min(2, m.pages)), "page");
  const sr = fill(w.pageSr ?? "", m.lang, { p: m.page, n: m.pages });
  const go = `<button class="den-pager-btn den-pager-submit" type="submit">${esc(String(w.go ?? ""))}</button>`;
  const open = (cls) =>
    `<form class="den-pager-form ${cls}" method="get" novalidate action="${esc(f.action)}" data-den-pager-form="page">${hidden(f.keep)}`;
  if (m.pages > SELECT_MAX) {
    const field =
      `<input class="den-pager-sel den-pager-num" type="number" inputmode="numeric" name="${esc(f.name)}"` +
      ` min="1" max="${m.pages}" value="${m.page}" aria-label="${esc(sr)}">`;
    if (phone)
      return `${open("den-pager-phone")}${field}<button class="den-pager-btn den-pager-go-num" type="submit">${esc(String(w.go ?? ""))}</button></form>`;
    return `${open("den-pager-wide")}${inSentence(w.pageOf, m.lang, { n: m.pages }, field)}<button class="den-pager-btn den-pager-go-num" type="submit">${esc(String(w.go ?? ""))}</button></form>`;
  }
  const options = Array.from({ length: m.pages }, (_, i) => i + 1)
    .map((p) => {
      const text = phone
        ? fill(w.pageShort ?? "{p} / {n}", m.lang, { p, n: m.pages })
        : fmt(m.lang, p);
      return `<option value="${p}" data-href="${esc(target(p))}"${p === m.page ? " selected" : ""}>${esc(text)}</option>`;
    })
    .join("");
  const select = `<select class="den-pager-sel" name="${esc(f.name)}" data-den-pager-pick="page" aria-label="${esc(sr)}">${options}</select>`;
  if (phone) return `${open("den-pager-phone")}${select}${go}</form>`;
  return `${open("den-pager-wide")}${inSentence(w.pageOf, m.lang, { n: m.pages }, select)}${go}</form>`;
}

function perPicker(m, cls) {
  const w = m.words;
  const target = (n) => m.href({ per: n });
  const list = m.perOptions;
  const f = formFor(target(list[0]), target(list[1] ?? list[0]), "per");
  const options = list
    .map(
      (n) =>
        `<option value="${n}" data-href="${esc(target(n))}"${n === m.per ? " selected" : ""}>${esc(fmt(m.lang, n))}</option>`,
    )
    .join("");
  const sr = fill(w.perPage ?? "", m.lang, { select: m.per });
  const select = `<select class="den-pager-sel" name="${esc(f.name)}" data-den-pager-pick="per" aria-label="${esc(sr.replace(/\s+/g, " ").trim())}">${options}</select>`;
  return (
    `<form class="den-pager-form den-pager-per${cls ? ` ${cls}` : ""}" method="get" novalidate action="${esc(f.action)}" data-den-pager-form="per">${hidden(f.keep)}` +
    inSentence(w.perPage, m.lang, {}, select) +
    `<button class="den-pager-btn den-pager-submit" type="submit">${esc(String(w.go ?? ""))}</button></form>`
  );
}

function pagesHtml(m, open) {
  const w = m.words;
  const range = esc(rangeText(m));
  const counted = m.total != null;
  const past = m.page > 1 || m.from > 1;
  const ctl = [];
  if (counted || past) ctl.push(pageLink(m, "first", past));
  ctl.push(pageLink(m, "prev", past));
  if (counted) ctl.push(pagePicker(m, false), pagePicker(m, true));
  else
    ctl.push(`<span class="den-pager-mid" aria-hidden="true">${range}</span>`);
  ctl.push(pageLink(m, "next", m.hasNext));
  if (counted) ctl.push(pageLink(m, "last", m.hasNext));
  const per = m.perOptions.length > 1;
  const pop = `den-pager-pop-${++popSeq}`;
  return (
    `${open} data-den-pager-count="${counted ? "yes" : "no"}">` +
    `<div class="den-pager-row">` +
    `<p class="den-pager-range">${range}</p>` +
    `<div class="den-pager-ctl">${ctl.join("")}</div>` +
    (per ? perPicker(m, "den-pager-side") : "") +
    `<button class="den-pager-btn den-pager-opts" type="button" popovertarget="${pop}" aria-label="${esc(String(w.more ?? ""))}"><span aria-hidden="true">⋯</span></button>` +
    `</div>` +
    `<div class="den-pager-menu" id="${pop}" popover="auto"><p class="den-pager-menu-range">${range}</p>` +
    (per ? perPicker(m, "") : "") +
    `</div></nav>`
  );
}

export function pagerHtml(o = {}) {
  const m = modelOf(o);
  const onePage =
    m.total == null
      ? m.from <= 1 && !(m.mode === "more" ? m.moreHref : m.hasNext)
      : m.from <= 1 && m.to >= m.total;
  if (m.total === 0 || onePage) return "";
  const w = m.words;
  const open =
    `<nav class="den-pager" data-den-pager="${m.mode}"` +
    ` aria-label="${esc(String(w.label ?? ""))}"`;
  if (m.mode === "pages") return pagesHtml(m, open);
  const { href, ...keep } = m;
  void href;
  return (
    `${open} data-den-pager-model="${esc(JSON.stringify(keep))}">` +
    `<div class="den-pager-row">` +
    `<p class="den-pager-range" aria-live="polite">${esc(rangeText(m))}</p>` +
    `<div class="den-pager-ctl">` +
    `<p class="den-pager-err" hidden>${esc(String(w.moreErr ?? ""))}</p>` +
    `<a class="den-pager-btn den-pager-more" href="${esc(m.moreHref || "#")}">${esc(moreText(m))}</a>` +
    "</div></div></nav>"
  );
}

const FOCUSABLE = "a[href],button,input,select,textarea,[tabindex]";

export function hydratePager(el, opts = {}) {
  const root = el?.matches?.("[data-den-pager]")
    ? el
    : (el?.closest?.("[data-den-pager]") ??
      el?.querySelector?.("[data-den-pager]"));
  const none = { destroy() {} };
  if (root?.dataset.denPager === "pages") return hydratePages(root, opts);
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

const NOT_KEYS =
  'input,select,textarea,[contenteditable]:not([contenteditable="false"]),' +
  'dialog,[role="dialog"],[role="application"],[data-den-no-keys]';

function hydratePages(root, opts) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const list =
    typeof opts.list === "string" ? doc.getElementById(opts.list) : opts.list;
  root.dataset.denPagerLive = "";
  const keysOn = () =>
    typeof opts.shortcuts === "function"
      ? !!opts.shortcuts()
      : opts.shortcuts !== false;

  function go(ask) {
    const ev = new win.CustomEvent("den-pager-nav", {
      bubbles: true,
      cancelable: true,
      detail: ask,
    });
    const own = typeof opts.onNavigate === "function";
    if (own) opts.onNavigate(ask);
    if (!root.dispatchEvent(ev) || own || !ask.href) return;
    win.location.assign(ask.href);
  }
  function follow(dir) {
    const a = root.querySelector(
      `.den-pager-ctl a[data-den-pager-go="${dir}"]`,
    );
    if (!a || !a.hasAttribute("href")) return false;
    go({ kind: "page", target: dir, href: a.getAttribute("href") });
    return true;
  }
  const formHref = (form) => {
    const q = new URLSearchParams(new win.FormData(form)).toString();
    return `${form.getAttribute("action") || ""}${q ? `?${q}` : ""}`;
  };

  const onChange = (e) => {
    const sel = e.target.closest?.("select[data-den-pager-pick]");
    if (!sel || !root.contains(sel)) return;
    const kind = sel.dataset.denPagerPick;
    const opt = sel.selectedOptions[0];
    const v = num(sel.value);
    go({
      kind,
      target: kind === "per" ? { per: v } : { page: v },
      href: opt?.dataset.href || formHref(sel.form),
    });
  };
  const onSubmit = (e) => {
    const form = e.target;
    if (!root.contains(form)) return;
    e.preventDefault();
    const field = form.querySelector("input[type=number]");
    const kind = form.dataset.denPagerForm;
    if (field) {
      const max = num(field.max) || 1;
      field.value = String(Math.min(max, Math.max(1, num(field.value))));
    }
    const v = num((field ?? form.querySelector("select"))?.value);
    go({
      kind,
      target: kind === "per" ? { per: v } : { page: v },
      href: formHref(form),
    });
  };
  const onClick = (e) => {
    const a = e.target.closest?.("a[data-den-pager-go]");
    if (!a || !root.contains(a)) return;
    if (!a.hasAttribute("href")) {
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0)
      return;
    e.preventDefault();
    go({
      kind: "page",
      target: a.dataset.denPagerGo,
      href: a.getAttribute("href"),
    });
  };
  const onRootKey = (e) => {
    if (e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.target.closest?.(NOT_KEYS)) return;
    const dir = { Home: "first", End: "last" }[e.key];
    if (dir && follow(dir)) e.preventDefault();
  };
  const onDocKey = (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const dir = { ArrowLeft: "prev", ArrowRight: "next" }[e.key];
    if (!dir || !keysOn()) return;
    const t = e.target;
    const inScope =
      t === doc.body ||
      t === doc.documentElement ||
      root.contains(t) ||
      (list && list.contains(t));
    if (!inScope || t.closest?.(NOT_KEYS)) return;
    if (follow(dir)) e.preventDefault();
  };
  const menu = root.querySelector(".den-pager-menu[popover]");
  const opener = root.querySelector(".den-pager-opts");
  const onToggle = (e) => {
    if (e.newState !== "open") return;
    const narrow = root.getBoundingClientRect().width <= 600;
    menu.classList.toggle("den-pager-sheet", narrow);
    if (!narrow && opener) {
      const r = opener.getBoundingClientRect();
      menu.style.setProperty(
        "--den-pager-pop-x",
        `${Math.max(8, r.right - menu.offsetWidth)}px`,
      );
      menu.style.setProperty(
        "--den-pager-pop-y",
        `${Math.max(8, r.top - menu.offsetHeight - 4)}px`,
      );
    }
    menu.querySelector("select,a[href],button")?.focus();
  };
  root.addEventListener("change", onChange);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onRootKey);
  menu?.addEventListener("toggle", onToggle);
  doc.addEventListener("keydown", onDocKey);
  return {
    destroy() {
      root.removeEventListener("change", onChange);
      root.removeEventListener("submit", onSubmit);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onRootKey);
      menu?.removeEventListener("toggle", onToggle);
      doc.removeEventListener("keydown", onDocKey);
      delete root.dataset.denPagerLive;
    },
  };
}

export function cursorHref(url, target, next, o = {}) {
  const at = o.after ?? "after";
  const bk = o.back ?? "back";
  let u;
  try {
    u = new URL(String(url), "http://h/");
  } catch {
    return "";
  }
  const q = u.searchParams;
  const trail = q.get(bk) ? q.get(bk).split(".") : [];
  const here = q.get(at) ?? "";
  q.delete("page");
  if (target === "first") {
    q.delete(at);
    q.delete(bk);
  } else if (target === "next") {
    if (!next) return "";
    trail.push(here || "-");
    const keep = num(o.keep) || TRAIL_MAX;
    const real = trail.filter((c) => c !== "~");
    if (real.length > keep)
      trail.splice(0, trail.length, "~", ...real.slice(-keep));
    q.set(at, String(next));
    q.set(bk, trail.join("."));
  } else if (target === "prev") {
    if (!here || !trail.length || trail.at(-1) === "~") return "";
    const to = trail.pop();
    if (to && to !== "-") q.set(at, to);
    else q.delete(at);
    if (trail.length) q.set(bk, trail.join("."));
    else q.delete(bk);
  } else if (target && typeof target === "object" && "per" in target) {
    q.delete(at);
    q.delete(bk);
    q.set(o.per ?? "per", String(target.per));
  } else return "";
  const s = q.toString();
  return `${u.pathname}${s ? `?${s}` : ""}${u.hash}`;
}
