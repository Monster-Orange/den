import type { ListedSession } from "./session-routes.js";

export type ViewBand = "needs" | "done" | "working" | "idle" | "stopped";
export const VIEW_BANDS: readonly ViewBand[] = [
  "needs",
  "done",
  "working",
  "idle",
  "stopped",
];
const OLDEST_FIRST = new Set<ViewBand>(["needs", "done"]);
const SEEN_MAX = 500;
const SEEN_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;

export const VIEW_LIST = "sessions.view";

export interface ViewAsk {
  by: "need" | "project" | "group" | "used";
  limit: number;
  page: number | "last";
  seen: ReadonlyMap<string, string>;
  used?: ReadonlyMap<string, number>;
}

export interface ViewPage {
  pinned: ListedSession[];
  items: ListedSession[];
  total: number;
  offset: number;
  page: number;
  pages: number;
  bands: Record<ViewBand, number>;
  projects?: Record<string, Record<ViewBand, number>>;
  continues: boolean;
  groups?: {
    pinned: string[];
    items: string[];
    totals: Record<string, number>;
  };
}

export interface ViewGroup {
  slug: string;
  agents: readonly string[];
}

export function parseSeen(v: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (v ?? "").split(",")) {
    const cut = pair.indexOf("~");
    if (cut < 1) continue;
    const id = pair.slice(0, cut);
    const since = pair.slice(cut + 1);
    if (!SEEN_ID.test(id) || since.length > 40) continue;
    out.set(id, since);
    if (out.size >= SEEN_MAX) break;
  }
  return out;
}

export function parseUsed(v: string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const pair of (v ?? "").split(",")) {
    const cut = pair.indexOf("~");
    if (cut < 1) continue;
    const id = pair.slice(0, cut);
    const at = Number(pair.slice(cut + 1));
    if (!SEEN_ID.test(id) || !Number.isSafeInteger(at) || at < 0) continue;
    out.set(id, at);
    if (out.size >= SEEN_MAX) break;
  }
  return out;
}

function byUse(
  rows: readonly ListedSession[],
  used: ReadonlyMap<string, number>,
): Entry[] {
  const at = (r: ListedSession) =>
    Math.max(
      used.get(r.id) ?? 0,
      Date.parse((r as { inputAt?: string }).inputAt ?? "") || 0,
      Date.parse(r.startedAt ?? "") || 0,
    );
  const sorted = (xs: ListedSession[]) =>
    xs.sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : 1));
  return [
    ...sorted(rows.filter((r) => !r.exited)).map((r) => ({
      band: "working" as const,
      r,
      key: "t:running",
    })),
    ...sorted(rows.filter((r) => r.exited)).map((r) => ({
      band: "stopped" as const,
      r,
      key: "t:exited",
    })),
  ];
}

export function viewBand(
  r: ListedSession,
  seen: ReadonlyMap<string, string>,
): ViewBand {
  if (r.kind === "agent" && r.state !== "running" && r.state !== "stopping")
    return "stopped";
  if (r.kind === "session" && r.exited) return "stopped";
  if (r.waiting && r.waitingWhy !== "input") return "needs";
  const a = r.attn ?? "idle";
  if (a === "done" && seen.has(r.id) && seen.get(r.id) === (r.attnSince ?? ""))
    return "idle";
  return a;
}

const nameOf = (r: ListedSession) =>
  (r.kind === "agent" ? r.displayName || r.agent || r.label : r.label) || r.id;
const timeOf = (s?: string) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : Infinity;
};

function compareIn(band: ViewBand, a: ListedSession, b: ListedSession): number {
  if (OLDEST_FIRST.has(band)) {
    const d = timeOf(a.attnSince) - timeOf(b.attnSince);
    if (d) return d < 0 ? -1 : 1;
  } else if (a.workspace === b.workspace) {
    const pa = a.place ?? Infinity;
    const pb = b.place ?? Infinity;
    if (pa !== pb) return pa < pb ? -1 : 1;
  }
  return (
    nameOf(a).localeCompare(nameOf(b), "en", { sensitivity: "base" }) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function inBandOrder(
  rows: readonly ListedSession[],
  seen: ReadonlyMap<string, string>,
): { band: ViewBand; r: ListedSession }[] {
  return VIEW_BANDS.flatMap((band) =>
    rows
      .filter((r) => viewBand(r, seen) === band)
      .sort((a, b) => compareIn(band, a, b))
      .map((r) => ({ band, r })),
  );
}

const zero = (): Record<ViewBand, number> => ({
  needs: 0,
  done: 0,
  working: 0,
  idle: 0,
  stopped: 0,
});

type Entry = { band: ViewBand; r: ListedSession; key: string };

function byGroups(
  rows: readonly ListedSession[],
  groups: readonly ViewGroup[],
  seen: ReadonlyMap<string, string>,
): Entry[] {
  const inSome = new Set<ListedSession>();
  const out: Entry[] = [];
  for (const g of groups) {
    const mine: ListedSession[] = [];
    for (const id of g.agents) {
      const r = rows.find((x) => x.kind === "agent" && x.agent === id);
      if (r && !mine.includes(r)) mine.push(r);
    }
    for (const r of mine) inSome.add(r);
    out.push(
      ...inBandOrder(mine, seen).map((x) => ({ ...x, key: `g:${g.slug}` })),
    );
  }
  out.push(
    ...inBandOrder(
      rows.filter((r) => !inSome.has(r)),
      seen,
    ).map((x) => ({ ...x, key: "g:" })),
  );
  return out;
}

export function viewPage(
  rows: readonly ListedSession[],
  ask: ViewAsk,
  projects: readonly string[],
  groups: readonly ViewGroup[] = [],
): ViewPage {
  const seen = ask.seen;
  const bands = zero();
  for (const r of rows) bands[viewBand(r, seen)]++;
  let ordered: Entry[];
  let perProject: Record<string, Record<ViewBand, number>> | undefined;
  if (ask.by === "project") {
    perProject = {};
    for (const r of rows) {
      const c = (perProject[r.workspace] ??= zero());
      c[viewBand(r, seen)]++;
    }
    const running = rows.filter((r) => viewBand(r, seen) !== "stopped");
    const rank = new Map(projects.map((p, i) => [p, i]));
    const order = [...new Set(running.map((r) => r.workspace))].sort(
      (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity),
    );
    ordered = [
      ...order.flatMap((ws) =>
        inBandOrder(
          running.filter((r) => r.workspace === ws),
          seen,
        ).map((x) => ({ ...x, key: `p:${ws}` })),
      ),
      ...inBandOrder(
        rows.filter((r) => viewBand(r, seen) === "stopped"),
        seen,
      ).map((x) => ({ ...x, key: "b:stopped" })),
    ];
  } else if (ask.by === "group") ordered = byGroups(rows, groups, seen);
  else if (ask.by === "used") ordered = byUse(rows, ask.used ?? new Map());
  else
    ordered = inBandOrder(rows, seen).map((x) => ({
      ...x,
      key: `b:${x.band}`,
    }));
  const pinnedAt = ordered.filter((x) => x.band === "needs");
  const pinned = pinnedAt.map((x) => x.r);
  const restAt = ordered.filter((x) => x.band !== "needs");
  const rest = restAt.map((x) => x.r);
  const pages = Math.max(1, Math.ceil(rest.length / ask.limit));
  const page = ask.page === "last" ? pages : Math.min(ask.page, pages);
  const offset = (page - 1) * ask.limit;
  const totals: Record<string, number> = {};
  for (const x of ordered) totals[x.key] = (totals[x.key] ?? 0) + 1;
  return {
    pinned,
    items: rest.slice(offset, offset + ask.limit),
    total: rest.length,
    offset,
    page,
    pages,
    bands,
    continues:
      offset > 0 &&
      offset < restAt.length &&
      restAt[offset - 1].key === restAt[offset].key,
    ...(perProject ? { projects: perProject } : {}),
    ...(ask.by === "group" || ask.by === "used"
      ? {
          groups: {
            pinned: pinnedAt.map((x) => x.key),
            items: restAt.slice(offset, offset + ask.limit).map((x) => x.key),
            totals,
          },
        }
      : {}),
  };
}
