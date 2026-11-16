/**
 * issue 206: the person's time zone for date-times, a user pref like
 * `language:`: `time_zone:` in config/local/user.yml, an IANA zone. Absent
 * means the browser's own. Pages get it as <html data-den-tz>, so the
 * first paint already draws in it (the kit's time.js reads it).
 */

/** True when `v` is a zone this runtime can format in. */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || !v || v.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** The stored value, normalised: unknown or missing is null (the browser's). */
export function timeZonePref(stored: unknown): string | null {
  return isTimeZone(stored) ? stored : null;
}

/** A page with <html data-den-tz> when a zone is picked; else unchanged. */
export function zonePage(html: string, zone: string | null): string {
  if (!zone || !isTimeZone(zone)) return html;
  const attr = zone.replace(/[&<>"']/g, "");
  return html.replace(/<html\b/, () => `<html data-den-tz="${attr}"`);
}
