/**
 * issue 206: a date-time for a person reading the CLI, in this machine's
 * own zone (the process's Intl zone; TZ when set): "2026-11-15 16:32 PST".
 * Never for --json, logs, or anything an agent reads: those keep ISO UTC.
 */

function parts(d: Date, zone?: string): Record<string, string> {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(d)) out[p.type] = p.value;
  return out;
}

function toDate(v: string | number | Date | undefined | null): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2026-11-15 16:32 PST" in the machine's zone; a bad stamp as given. */
export function localDateTime(
  v: string | number | Date | undefined | null,
  zone?: string,
): string {
  const d = toDate(v);
  if (!d) return v == null ? "" : String(v);
  const p = parts(d, zone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** "2026-11-15", the day in the machine's zone; a bad stamp as given. */
export function localDate(
  v: string | number | Date | undefined | null,
  zone?: string,
): string {
  const d = toDate(v);
  if (!d) return v == null ? "" : String(v);
  const p = parts(d, zone);
  return `${p.year}-${p.month}-${p.day}`;
}
