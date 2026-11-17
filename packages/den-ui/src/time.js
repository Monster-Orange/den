/**
 * Date-times for people: in the person's own time zone, never UTC.
 *
 * The data keeps ISO-8601 UTC; what a person reads is local. Framework-free
 * and pure: formatTime runs in Node as well as in a page (it touches
 * document or navigator only when they exist).
 *
 *   formatTime(iso, opts?) → the text ("Nov 15, 4:32 PM"); "" for a
 *     missing or invalid stamp.
 *   timeHtml(iso, opts?) → '<time datetime="ISO-UTC" title="full local
 *     date-time with zone name" data-den-time="style">text</time>'.
 *   upgradeTimes(root = document) → every time[datetime][data-den-time]
 *     under root drawn again (after the zone changes).
 *   setTimeZone(zone | null) → the zone pick; null is the browser's.
 *
 *   opts.style   "datetime" (the default), "date", "time" or "relative"
 *                ("3 min ago"; its title is the local absolute time).
 *   opts.seconds true: the seconds too.
 *   opts.zone    an IANA zone. Else <html data-den-tz> (a page), else
 *                setTimeZone's value, else the browser's (or process's).
 *   opts.locale  else <html lang> (in the browser's variant of it), else
 *                the browser's. upgradeTimes uses the nearest [lang] around
 *                each <time> first.
 *   opts.now     ms or ISO: "now" for relative and the year rule (tests,
 *                server use).
 *
 * The year shows only when it isn't the current year in that zone.
 */

const STYLES = ["datetime", "date", "time", "relative"];

let picked = null;

const hasDoc = () =>
  typeof document !== "undefined" && !!document.documentElement;

/** The browser's (or process's) own zone. */
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every IANA zone this runtime knows, or [] when it can't list them. */
export function timeZones() {
  try {
    return typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  } catch {
    return [];
  }
}

/** True when `zone` is a zone this runtime can format in. */
export function isTimeZone(zone) {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone pick: an IANA zone, or null for the browser's. On a page it is
 * also <html data-den-tz>, so the attribute is the one source there.
 */
export function setTimeZone(zone) {
  picked = isTimeZone(zone) ? zone : null;
  if (hasDoc()) {
    const ds = document.documentElement.dataset;
    if (picked) ds.denTz = picked;
    else delete ds.denTz;
  }
}

/** The zone a stamp is drawn in. */
export function currentTimeZone(zone) {
  if (isTimeZone(zone)) return zone;
  if (hasDoc()) {
    const z = document.documentElement.dataset?.denTz;
    if (isTimeZone(z)) return z;
  }
  return picked ?? browserTimeZone();
}

/**
 * The page's language, in the browser's own variant of it when they share
 * a language ("en" with an en-GB browser reads en-GB: its 24-hour clock).
 */
function currentLocale(locale) {
  if (locale) return locale;
  return localeOf(hasDoc() ? document.documentElement.lang : "");
}

/** A lang attribute's value as a locale, in the browser's variant of it. */
function localeOf(lang) {
  const nav =
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language
      : undefined;
  if (!lang) return nav;
  if (nav && !lang.includes("-") && nav.split("-")[0] === lang) return nav;
  return lang;
}

/** A Date for an ISO string, ms or Date; null when it isn't one. */
function toDate(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmt(locale, o) {
  try {
    return new Intl.DateTimeFormat(locale, o);
  } catch {
    return new Intl.DateTimeFormat("en", o);
  }
}

function yearIn(d, zone) {
  return fmt("en", { timeZone: zone, year: "numeric" }).format(d);
}

function absolute(d, style, o) {
  const f = { timeZone: o.zone };
  const withYear = yearIn(d, o.zone) !== yearIn(o.now, o.zone);
  if (style !== "time") {
    f.month = "short";
    f.day = "numeric";
    if (withYear) f.year = "numeric";
  }
  if (style !== "date") {
    f.hour = "numeric";
    f.minute = "2-digit";
    if (o.seconds) f.second = "2-digit";
  }
  return fmt(o.locale, f).format(d);
}

/** The full local date-time with the zone's name: a title. */
function full(d, o) {
  return fmt(o.locale, {
    timeZone: o.zone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "long",
  }).format(d);
}

const UNITS = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

function relative(d, o) {
  const s = Math.round((d.getTime() - o.now.getTime()) / 1000);
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(o.locale, { numeric: "auto" });
  } catch {
    rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(0, "second");
  for (const [unit, size] of UNITS)
    if (abs >= size || unit === "minute")
      return rtf.format(Math.round(s / size), unit);
  return "";
}

function resolve(opts) {
  const o = opts || {};
  return {
    style: STYLES.includes(o.style) ? o.style : "datetime",
    seconds: !!o.seconds,
    zone: currentTimeZone(o.zone),
    locale: currentLocale(o.locale),
    now: toDate(o.now) ?? new Date(),
  };
}

/** The text a person reads for `iso`; "" when it isn't a date-time. */
export function formatTime(iso, opts) {
  const d = toDate(iso);
  if (!d) return "";
  const o = resolve(opts);
  return o.style === "relative" ? relative(d, o) : absolute(d, o.style, o);
}

/** The full local date-time with its zone's name, for a title. */
export function formatTitle(iso, opts) {
  const d = toDate(iso);
  return d ? full(d, resolve(opts)) : "";
}

const ESC = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** A <time> element's HTML for `iso`; "" when it isn't a date-time. */
export function timeHtml(iso, opts) {
  const d = toDate(iso);
  if (!d) return "";
  const o = resolve(opts);
  const text = formatTime(d, opts);
  return (
    `<time datetime="${esc(d.toISOString())}" title="${esc(full(d, o))}"` +
    ` data-den-time="${esc(o.style)}"${o.seconds ? ' data-den-seconds=""' : ""}>` +
    `${esc(text)}</time>`
  );
}

/** Draws every time[datetime][data-den-time] under `root` again. */
export function upgradeTimes(root) {
  const r = root || (hasDoc() ? document : null);
  if (!r || typeof r.querySelectorAll !== "function") return;
  for (const el of r.querySelectorAll("time[datetime][data-den-time]")) {
    const iso = el.getAttribute("datetime");
    const opts = {
      style: el.getAttribute("data-den-time"),
      seconds: el.hasAttribute("data-den-seconds"),
    };
    // The language of the part the time sits in (a row still in English
    // on a translated page reads in English), then the page's, then the
    // browser's.
    const near = typeof el.closest === "function" ? el.closest("[lang]") : null;
    const page = hasDoc() ? document.documentElement : null;
    if (near && near !== page)
      opts.locale = localeOf(near.getAttribute("lang"));
    const text = formatTime(iso, opts);
    if (!text) continue;
    el.textContent = text;
    el.title = formatTitle(iso, opts);
  }
}
