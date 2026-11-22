/**
 * Issue 214: a schedule's cron (five fields) and its window, in the host's
 * local time. No dependency: Den reads the common cron forms only
 * (numbers, `*`, lists, ranges and steps; 0 or 7 for Sunday).
 */

export interface Cron {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** Day of the month and day of the week are both set: either one matches. */
  either: boolean;
  domAny: boolean;
  dowAny: boolean;
}

const FIELDS: [string, number, number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of the month", 1, 31],
  ["month", 1, 12],
  ["day of the week", 0, 7],
];

function field(text: string, [name, lo, hi]: [string, number, number]) {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron ${name}: can't read "${part}"`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    if (step < 1) throw new Error(`cron ${name}: a step is 1 or more`);
    let from = lo;
    let to = hi;
    if (m[1] !== "*") {
      from = Number(m[2]);
      to = m[3] === undefined ? (m[4] === undefined ? from : hi) : Number(m[3]);
    }
    if (from < lo || to > hi)
      throw new Error(`cron ${name}: ${lo} to ${hi}, got "${part}"`);
    if (from > to) throw new Error(`cron ${name}: a range runs low to high`);
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(text: string): Cron {
  const parts = String(text).trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(`cron: five fields (minute hour day month weekday), got "${text}"`);
  const f = parts.map((p, i) => field(p, FIELDS[i]));
  const dow = [...new Set(f[4].map((d) => d % 7))].sort((a, b) => a - b);
  const domAny = parts[2] === "*";
  const dowAny = parts[4] === "*";
  return {
    minute: f[0],
    hour: f[1],
    dom: f[2],
    month: f[3],
    dow,
    either: !domAny && !dowAny,
    domAny,
    dowAny,
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  if (!c.month.includes(d.getMonth() + 1)) return false;
  const dom = c.dom.includes(d.getDate());
  const dow = c.dow.includes(d.getDay());
  if (c.either) return dom || dow;
  return dom && dow;
}

/** The first time after `after` (a later minute, never the same one); null if none in 5 years. */
export function nextRun(cron: string | Cron, after: Date): Date | null {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < 366 * 5; i++) {
    if (dayMatches(c, day)) {
      for (const h of c.hour)
        for (const m of c.minute) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          // A local time skipped by a clock change lands on another hour: skip it.
          if (t.getHours() !== h) continue;
          if (t >= start) return t;
        }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

/** Minutes after midnight; `to` may be below `from` (a window across midnight). */
export interface Window {
  from: number;
  to: number;
}

const NAMED: Record<string, Window> = { night: { from: 22 * 60, to: 6 * 60 } };

export function parseWindow(text: string | undefined): Window | null {
  if (text === undefined || text === "any") return null;
  if (NAMED[text]) return { ...NAMED[text] };
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(text);
  const mins = (h: string, mi: string) => {
    const hh = Number(h);
    const mm = Number(mi);
    return hh > 23 || mm > 59 ? NaN : hh * 60 + mm;
  };
  const from = m ? mins(m[1], m[2]) : NaN;
  const to = m ? mins(m[3], m[4]) : NaN;
  if (Number.isNaN(from) || Number.isNaN(to) || from === to)
    throw new Error(
      `schedule window: "HH:MM-HH:MM", "night" or "any", got "${text}"`,
    );
  return { from, to };
}

const minuteOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

export function inWindow(w: Window | null, d: Date): boolean {
  if (!w) return true;
  const m = minuteOf(d);
  return w.from < w.to ? m >= w.from && m < w.to : m >= w.from || m < w.to;
}

/** When a run due at `due` must have started by: the end of the window it is in, or of the next one. */
export function windowEnd(w: Window | null, due: Date): Date | null {
  if (!w) return null;
  const at = (base: Date, mins: number, addDays = 0) =>
    new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() + addDays,
      Math.floor(mins / 60),
      mins % 60,
    );
  // Before today's end it is today's; after it (or late, across midnight) tomorrow's.
  return at(due, w.to, minuteOf(due) < w.to ? 0 : 1);
}

export type CronWords =
  | { kind: "hourly" }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; days: number[] }
  | { kind: "raw" };

/** The shapes the page says in words; anything else shows the cron itself. */
export function describeCron(text: string): CronWords {
  const p = String(text).trim().split(/\s+/);
  if (p.length !== 5) return { kind: "raw" };
  const [mi, h, dom, mon, dow] = p;
  const num = (s: string, hi: number) => /^\d+$/.test(s) && Number(s) <= hi;
  if (num(mi, 59) && h === "*" && dom === "*" && mon === "*" && dow === "*")
    return Number(mi) === 0 ? { kind: "hourly" } : { kind: "raw" };
  if (!num(mi, 59) || !num(h, 23) || dom !== "*" || mon !== "*")
    return { kind: "raw" };
  const time = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  if (dow === "*") return { kind: "daily", time };
  try {
    return { kind: "weekly", time, days: parseCron(text).dow };
  } catch {
    return { kind: "raw" };
  }
}
