import { pagerHtml, hydratePager } from "/kit/pager.js";

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
];
const attr = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const pagerWords = () =>
  Object.fromEntries(WORDS.map((k) => [k, tr(`pager.${k}`)]));

export function listPagerHtml(name, p, shown, per) {
  if (!p || typeof p.offset !== "number" || !shown) return "";
  const on = {
    first: !!p.prev,
    prev: !!p.prev,
    next: !!p.next,
    last: !!p.next && !!p.pages,
  };
  const html = pagerHtml({
    from: p.offset + 1,
    to: p.offset + shown,
    total: typeof p.total === "number" ? p.total : null,
    hasNext: !!p.next,
    ...(p.pages ? { page: p.page, pages: p.pages } : {}),
    per,
    href: (t) => (typeof t === "string" && !on[t] ? null : `#${name}`),
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

export function watchPagers(root, onNav) {
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
      hydratePager(el, {
        shortcuts: false,
        onNavigate: (ask) =>
          onNav(el.closest("[data-list-pager]").dataset.listPager, ask),
      });
    }
  };
  hydrate();
  const mo = new root.ownerDocument.defaultView.MutationObserver(hydrate);
  mo.observe(root, { childList: true, subtree: true });
  return () => mo.disconnect();
}
