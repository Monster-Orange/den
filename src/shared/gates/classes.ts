/**
 * Issue 803: priority classes per project, and their windows.
 *
 * Three settings, each a line of text a person types (Settings › Server,
 * or `gate settings`); empty is off:
 *   class_order    the classes, highest first: "release, lane, other"
 *   class_map      which class each project, or label pattern, is in:
 *                  "den=lane, label:release*=release, *=other". The first
 *                  label pattern that matches wins, then the project's
 *                  rule, then `*`, else the last class.
 *   class_windows  a class's window for its long runs:
 *                  "other=22:00-06:00/30" (local time; runs estimated 30
 *                  min or more; without /N, every run of the class).
 *
 * The class comes from these settings and the entry's project and label,
 * never from the asker. Pure: rules.ts orders the queue with it.
 */

export interface GateWindow {
  /** Minutes past local midnight it opens and closes (may wrap). */
  from: number;
  to: number;
  /** Runs estimated at least this long are windowed. */
  longMinutes: number;
  /** As typed: "22:00-06:00". */
  text: string;
}

export interface GateClasses {
  /** Highest first. */
  order: string[];
  projects: Record<string, string>;
  labels: { pattern: string; class: string }[];
  fallback: string;
  windows: Record<string, GateWindow>;
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export const items = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** "release, lane, other" → the names; or what is wrong. */
export function parseClassOrder(s: string): string[] | string {
  const names = items(s);
  if (names.length > 8) return "at most 8 classes";
  for (const n of names)
    if (!NAME.test(n))
      return `"${n}" is not a class name (lower-case letters, digits, - or _)`;
  if (new Set(names).size !== names.length) return "a class is named twice";
  return names;
}

export const glob = (p: string) =>
  new RegExp(
    "^" +
      p
        .split("*")
        .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
    "i",
  );

type MapRule = { project?: string; label?: string; class: string };

/** "den=lane, label:release*=release, *=other" → rules; or what is wrong. */
export function parseClassMap(s: string): MapRule[] | string {
  const out: MapRule[] = [];
  for (const it of items(s)) {
    const at = it.lastIndexOf("=");
    const key = it.slice(0, at).trim();
    const cls = it.slice(at + 1).trim();
    if (at < 1 || !NAME.test(cls))
      return `"${it}" is not <project>=<class>, label:<pattern>=<class> or *=<class>`;
    if (key.startsWith("label:")) {
      const pattern = key.slice(6).trim();
      if (!pattern || pattern.length > 120)
        return `"${it}" needs a label pattern`;
      out.push({ label: pattern, class: cls });
    } else if (key.length > 120) return `"${it}": the project name is long`;
    else out.push({ project: key, class: cls });
  }
  return out;
}

const hhmm = (s: string): number | undefined => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

/**
 * "22:00-06:00" → a window (local time; it may wrap past midnight), or
 * undefined. Issue 625 reads a test box's window with it.
 */
export function parseWindow(s: string): GateWindow | undefined {
  const m = /^\s*([0-9:]+)\s*-\s*([0-9:]+)\s*$/.exec(s);
  const from = m ? hhmm(m[1]!) : undefined;
  const to = m ? hhmm(m[2]!) : undefined;
  if (from === undefined || to === undefined) return undefined;
  return { from, to, longMinutes: 0, text: `${m![1]}-${m![2]}` };
}

/** Minutes past midnight as HH:MM. */
export const clockText = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** "other=22:00-06:00/30" → windows by class; or what is wrong. */
export function parseClassWindows(
  s: string,
): Record<string, GateWindow> | string {
  const out: Record<string, GateWindow> = {};
  for (const it of items(s)) {
    const m = /^([^=]+)=\s*([0-9:]+)\s*-\s*([0-9:]+)\s*(?:\/\s*(\d+))?$/.exec(
      it,
    );
    const cls = m?.[1]?.trim() ?? "";
    const from = m ? hhmm(m[2]!) : undefined;
    const to = m ? hhmm(m[3]!) : undefined;
    if (!m || !NAME.test(cls) || from === undefined || to === undefined)
      return `"${it}" is not <class>=HH:MM-HH:MM[/minutes]`;
    out[cls] = {
      from,
      to,
      longMinutes: m[4] ? Number(m[4]) : 0,
      text: `${m[2]!.trim()}-${m[3]!.trim()}`,
    };
  }
  return out;
}

/** The three settings, read; null when no classes are set (today's queue). */
export function readClasses(
  order: string | undefined,
  map: string | undefined,
  windows: string | undefined,
): GateClasses | null {
  const o = parseClassOrder(order ?? "");
  if (typeof o === "string" || o.length === 0) return null;
  const known = new Set(o);
  const rules = parseClassMap(map ?? "");
  const wins = parseClassWindows(windows ?? "");
  const c: GateClasses = {
    order: o,
    projects: {},
    labels: [],
    fallback: o[o.length - 1]!,
    windows: {},
  };
  if (typeof rules !== "string")
    for (const r of rules) {
      if (!known.has(r.class)) continue;
      if (r.label) c.labels.push({ pattern: r.label, class: r.class });
      else if (r.project === "*") c.fallback = r.class;
      else if (r.project && !(r.project in c.projects))
        c.projects[r.project] = r.class;
    }
  if (typeof wins !== "string")
    for (const [k, w] of Object.entries(wins))
      if (known.has(k)) c.windows[k] = w;
  return c;
}

/** An entry's class: by label pattern, then project, then the default. */
export function classOf(
  e: { project?: string; label: string },
  c: GateClasses | null | undefined,
): string | undefined {
  if (!c) return undefined;
  const l = c.labels.find((x) => glob(x.pattern).test(e.label));
  if (l) return l.class;
  if (e.project && Object.prototype.hasOwnProperty.call(c.projects, e.project))
    return c.projects[e.project];
  return c.fallback;
}

/** 0 is the highest class. */
export function classRank(
  e: { project?: string; label: string },
  c: GateClasses | null | undefined,
): number {
  if (!c) return 0;
  return c.order.indexOf(classOf(e, c)!);
}

const minuteOfDay = (now: number) => {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
};

/** Whether `now` (local time) is inside the window. */
export function inWindow(w: GateWindow, now: number): boolean {
  const m = minuteOfDay(now);
  return w.from <= w.to ? m >= w.from && m < w.to : m >= w.from || m < w.to;
}

/** When the window next opens (ms, local time), from `now`. */
export function windowOpens(w: GateWindow, now: number): number {
  const d = new Date(now);
  d.setHours(Math.floor(w.from / 60), w.from % 60, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

interface Classed {
  id: string;
  label: string;
  project?: string;
  estimateMin: number;
  grantedAt?: string;
}

/**
 * The waiters a window holds back now: a long run of a windowed class,
 * outside its window, while a run of a higher class holds or waits.
 */
export function windowHeld(
  entries: Classed[],
  c: GateClasses | null | undefined,
  now: number,
): Map<string, GateWindow> {
  const out = new Map<string, GateWindow>();
  if (!c || !Object.keys(c.windows).length) return out;
  const best = Math.min(...entries.map((e) => classRank(e, c)));
  for (const e of entries) {
    if (e.grantedAt) continue;
    const w = c.windows[classOf(e, c)!];
    if (!w || e.estimateMin < w.longMinutes || inWindow(w, now)) continue;
    if (best < classRank(e, c)) out.set(e.id, w);
  }
  return out;
}
