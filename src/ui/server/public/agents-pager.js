import { hydratePager, pagerHtml } from "/kit/pager.js";

const PAGE_KEY = "agp";
const PER_KEY = "agn";
const PER_OPTIONS = [25, 50, 100, 200];
const SEEN_MAX = 100;
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

let live = null;

const params = () => new URLSearchParams(location.search);

export function agentsPer() {
  const n = Number(params().get(PER_KEY));
  return Number.isInteger(n) && n > 0 && n <= 200 ? n : 50;
}

export function agentsPageNo() {
  const n = Number(params().get(PAGE_KEY));
  return Number.isInteger(n) && n > 1 ? n : 1;
}

export function agentsViewQuery({ by, ws, seen, open }) {
  const q = new URLSearchParams({
    view: "agents",
    by: by === "project" ? "project" : "need",
    page: String(agentsPageNo()),
    limit: String(agentsPer()),
  });
  if (ws) q.set("ws", ws);
  const pairs = [...(seen ?? new Map())]
    .filter(([, since]) => typeof since === "string" && since)
    .slice(0, SEEN_MAX)
    .map(([id, since]) => `${id}~${since}`);
  if (pairs.length) q.set("seen", pairs.join(","));
  const ids = (open ?? []).slice(0, 20);
  if (ids.length) q.set("open", ids.join(","));
  return q;
}

function hrefFor(target, data) {
  const u = new URL(location.href);
  if (target && typeof target === "object" && target.per) {
    u.searchParams.set(PER_KEY, String(target.per));
    u.searchParams.delete(PAGE_KEY);
  } else {
    const at = data.page ?? 1;
    const n =
      target === "first"
        ? 1
        : target === "prev"
          ? at - 1
          : target === "next"
            ? at + 1
            : target === "last"
              ? data.pages
              : Number(target?.page) || 1;
    if (n > 1) u.searchParams.set(PAGE_KEY, String(n));
    else u.searchParams.delete(PAGE_KEY);
  }
  return `${u.pathname}${u.search}${u.hash}`;
}

export function agentsPagerHtml(data, t, lang) {
  if (!data || typeof data.total !== "number" || !Array.isArray(data.items))
    return "";
  return pagerHtml({
    mode: "pages",
    total: data.total,
    from: data.offset + 1,
    to: data.offset + data.items.length,
    page: data.page,
    pages: data.pages,
    per: agentsPer(),
    perOptions: PER_OPTIONS,
    href: (target) => hrefFor(target, data),
    lang,
    words: Object.fromEntries(WORDS.map((k) => [k, t(`pager.${k}`)])),
  });
}

export function hydrateAgentsPager(root, onMove) {
  live?.destroy();
  live = null;
  const el = root?.querySelector(".den-pager");
  if (!el) return;
  live = hydratePager(el, {
    list: root,
    onNavigate: (ask) => {
      if (ask.href) history.pushState(history.state, "", ask.href);
      onMove();
    },
  });
}

export function keepServedPage(data) {
  if (!data?.page || data.page === agentsPageNo()) return;
  const u = new URL(location.href);
  if (data.page > 1) u.searchParams.set(PAGE_KEY, String(data.page));
  else u.searchParams.delete(PAGE_KEY);
  history.replaceState(history.state, "", u);
}
