import {
  cursorHref,
  cursorStart,
  hydratePager,
  pagerHtml,
} from "/kit/pager.js";

const tr = (k, v) => globalThis.denShell?.t?.(k, v) ?? k;
const WORDS = [
  "range",
  "rangeOpen",
  "label",
  "first",
  "firstSr",
  "prev",
  "prevSr",
  "next",
  "nextSr",
  "last",
  "lastSr",
  "pageOf",
  "pageShort",
  "pageSr",
  "go",
  "perPage",
  "more",
  "moreN",
  "lastN",
  "all",
  "moreErr",
];
const attr = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const pagerWords = () =>
  Object.fromEntries(WORDS.map((k) => [k, tr(`pager.${k}`)]));

const here = () => globalThis.location?.href ?? "http://localhost/";
const keys = (k) => ({
  c: `${k}c`,
  b: `${k}b`,
  p: `${k}p`,
  at: `${k}at`,
  n: `${k}n`,
  o: `${k}o`,
});

export function pageHref(name, reply, target, per, url = here()) {
  const k = keys(name);
  if (!reply || !("prev" in reply))
    return (
      cursorHref(url, target, reply?.next, {
        after: k.c,
        back: k.b,
        per: k.n,
        offset: k.o,
        size: per,
      }) || null
    );
  const u = new URL(url, "http://localhost/");
  const q = u.searchParams;
  for (const x of [k.c, k.b, k.p, k.at, k.o]) q.delete(x);
  if (target === "next") {
    if (!reply.next) return null;
    q.set(k.c, reply.next);
  } else if (target === "prev") {
    if (!reply.prev) return null;
    q.set(k.c, reply.prev);
  } else if (target === "first") {
    if (!reply.prev) return null;
  } else if (target === "last") {
    if (!reply.next || !reply.pages) return null;
    q.set(k.at, "last");
  } else if (target && typeof target === "object" && "page" in target)
    q.set(k.p, String(target.page));
  else if (target && typeof target === "object" && "per" in target)
    q.set(k.n, String(target.per));
  else return null;
  const str = q.toString();
  return `${u.pathname}${str ? `?${str}` : ""}${u.hash}`;
}

export function perFromUrl(name, per, url = here()) {
  const n = Number(
    new URL(url, "http://localhost/").searchParams.get(keys(name).n),
  );
  return Number.isInteger(n) && n > 0 ? n : per;
}

export function askFromUrl(name, per, url = here()) {
  const k = keys(name);
  const q = new URL(url, "http://localhost/").searchParams;
  const ask = new URLSearchParams({
    limit: String(perFromUrl(name, per, url)),
  });
  if (q.get(k.c)) ask.set("cursor", q.get(k.c));
  else if (q.get(k.p)) ask.set("page", q.get(k.p));
  else if (q.get(k.at)) ask.set("at", q.get(k.at));
  return ask;
}

export function listPagerHtml(name, p, shown, per, { url = true } = {}) {
  if (!p || !shown) return "";
  const offset =
    typeof p.offset === "number"
      ? p.offset
      : cursorStart(url ? here() : "", { offset: keys(name).o });
  const on = {
    first: !!p.prev,
    prev: !!p.prev,
    next: !!p.next,
    last: !!p.next && !!p.pages,
  };
  const html = pagerHtml({
    from: offset + 1,
    to: offset + shown,
    total: typeof p.total === "number" ? p.total : null,
    hasNext: !!p.next,
    ...(p.pages ? { page: p.page, pages: p.pages } : {}),
    per,
    href: url
      ? (t) => pageHref(name, p, t, per)
      : (t) => (typeof t === "string" && !on[t] ? null : `#${name}`),
    lang: globalThis.denShell?.lang?.() ?? "en",
    words: pagerWords(),
  });
  return html ? `<div data-list-pager="${attr(name)}">${html}</div>` : "";
}

export function listMoreHtml(name, p, shown, step) {
  if (!p || !shown) return "";
  const html = pagerHtml({
    mode: "more",
    from: 1,
    to: shown,
    loaded: shown > step,
    total: typeof p.total === "number" ? p.total : null,
    hasNext: !!p.next,
    step,
    per: step,
    moreHref: p.next ? `#${name}` : null,
    lang: globalThis.denShell?.lang?.() ?? "en",
    words: pagerWords(),
  });
  return html ? `<div data-list-pager="${attr(name)}">${html}</div>` : "";
}

export function pageQuery(p, target, per) {
  const q = new URLSearchParams({ limit: String(per) });
  if (target === "first") q.set("at", "first");
  else if (target === "last") q.set("at", "last");
  else if (target === "next" && p?.next) q.set("cursor", p.next);
  else if (target === "prev" && p?.prev) q.set("cursor", p.prev);
  else if (target && typeof target === "object" && "page" in target)
    q.set("page", String(target.page));
  else if (target && typeof target === "object" && "per" in target)
    q.set("limit", String(target.per));
  return q;
}

export function watchPagers(root, onNav, { url = true, more = null } = {}) {
  const win = root.ownerDocument.defaultView;
  const seen = new WeakSet();
  const hydrate = () => {
    for (const el of root.querySelectorAll(
      "[data-list-pager] [data-den-pager]",
    )) {
      if (seen.has(el)) {
        el.dataset.denPagerLive = "";
        continue;
      }
      seen.add(el);
      const name = el.closest("[data-list-pager]").dataset.listPager;
      if (el.dataset.denPager === "more") {
        hydratePager(el, {
          list: root.ownerDocument.createElement("div"),
          load: async () => ({ html: "", ...(await more(name)) }),
        });
        continue;
      }
      hydratePager(el, {
        shortcuts: false,
        onNavigate: (ask) => {
          if (url && ask.href) win.history.pushState(null, "", ask.href);
          onNav(el.closest("[data-list-pager]").dataset.listPager, ask);
        },
      });
    }
  };
  hydrate();
  const mo = new win.MutationObserver(hydrate);
  mo.observe(root, { childList: true, subtree: true });
  const onPop = () => onNav(null, { kind: "pop" });
  if (url) win.addEventListener("popstate", onPop);
  return () => {
    mo.disconnect();
    if (url) win.removeEventListener("popstate", onPop);
  };
}
