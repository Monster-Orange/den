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
  by: "need" | "project";
  limit: number;
  page: number | "last";
  seen: ReadonlyMap<string, string>;
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

export function viewPage(
  rows: readonly ListedSession[],
  ask: ViewAsk,
  projects: readonly string[],
): ViewPage {
  const seen = ask.seen;
  const bands = zero();
  for (const r of rows) bands[viewBand(r, seen)]++;
  let ordered: { band: ViewBand; r: ListedSession }[];
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
        ),
      ),
      ...inBandOrder(
        rows.filter((r) => viewBand(r, seen) === "stopped"),
        seen,
      ),
    ];
  } else ordered = inBandOrder(rows, seen);
  const pinned = ordered.filter((x) => x.band === "needs").map((x) => x.r);
  const restAt = ordered.filter((x) => x.band !== "needs");
  const rest = restAt.map((x) => x.r);
  const groupOf = (x: { band: ViewBand; r: ListedSession }) =>
    ask.by === "project" && x.band !== "stopped"
      ? `p:${x.r.workspace}`
      : `b:${x.band}`;
  const pages = Math.max(1, Math.ceil(rest.length / ask.limit));
  const page = ask.page === "last" ? pages : Math.min(ask.page, pages);
  const offset = (page - 1) * ask.limit;
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
      groupOf(restAt[offset - 1]) === groupOf(restAt[offset]),
    ...(perProject ? { projects: perProject } : {}),
  };
}
