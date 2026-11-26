/**
 * Issue 172: alerts outside the bell. When an agent starts to need its
 * person (a permission prompt, a question, a held write waiting for the
 * Allow), the person is told on the desktop (an open Den tab shows a
 * browser notification) and on a phone or a closed tab (Web Push).
 *
 * - A new need alerts; a finished turn only with alerts.finished on. A
 *   held write only when the approval policy held it. A mute never alerts.
 * - The words are the bell's own and never the details: who, and what it
 *   waits on. Never the tool line, the question's text or the write's
 *   summary (any of them can hold a secret or a code).
 * - The person's switches (user.yml `alerts:`) and quiet hours decide
 *   before anything goes out.
 *
 *   alerts:
 *     desktop: true          # an open tab shows them (default on)
 *     phone: true            # push to subscribed devices (default on)
 *     quiet: { from: "22:00", to: "07:00" }   # none by default
 *     finished: false        # a finished turn alerts too
 *     sound: false           # a short sound from an open tab
 *     tab_count: true        # the count in the tab title and icon
 *     push_timeout_seconds: 30     # how long one push may take (1..3600)
 *     push_ttl_seconds: 86400      # how long a push service keeps it
 *                                  # (0..2419200); both Settings rows (#367)
 *     tab_first_seconds: 3   # a tab's time before the push (1..10)
 *     max_streams: 20        # open-tab streams a person keeps (1..200)
 */
import type { UserConfig } from "./den-config.js";
import type { UiLanguage } from "./ui-language.js";

/** What the agent waits on. */
export type AlertWhy = "permission" | "asked" | "allow" | "finished";

export const ALERT_KINDS: Readonly<
  Record<
    AlertWhy,
    { alert: true | "opt-in"; sound: "needs" | "finished"; count: boolean }
  >
> = {
  permission: { alert: true, sound: "needs", count: true },
  asked: { alert: true, sound: "needs", count: true },
  allow: { alert: true, sound: "needs", count: true },
  finished: { alert: "opt-in", sound: "finished", count: false },
};

/** The words, in each language the UI ships (a test keeps them even). */
export const ALERT_WORDS: Readonly<
  Record<UiLanguage, Readonly<Record<AlertWhy, string>>>
> = {
  en: {
    permission: "{name} needs your permission",
    asked: "{name} asked you",
    allow: "{name} needs your Allow",
    finished: "{name} finished",
  },
  es: {
    permission: "{name} necesita tu permiso",
    asked: "{name} te preguntó",
    allow: "{name} necesita tu Permitir",
    finished: "{name} terminó",
  },
  ja: {
    permission: "{name} があなたの許可を待っています",
    asked: "{name} から質問があります",
    allow: "{name} が「許可」を待っています",
    finished: "{name} が終わりました",
  },
};

/**
 * A test alert's words (Settings › Notifications › Devices that get push:
 * Send a test alert), in each language the UI ships. No agent in it.
 */
export const ALERT_TEST_WORDS: Readonly<Record<UiLanguage, string>> = {
  en: "Test alert: this device gets alerts when an agent needs you.",
  es: "Aviso de prueba: este dispositivo recibe avisos cuando un agente te necesita.",
  ja: "テスト通知: エージェントがあなたを必要とするとき、このデバイスに通知が届きます。",
};

/** An agent's name as an alert says it: plain, one line, short. */
export function alertName(name: string): string {
  const s = String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (s || "An agent").slice(0, 64);
}

/** The alert's line in `lang`. */
export function alertBody(
  lang: UiLanguage,
  why: AlertWhy,
  name: string,
): string {
  const words = (ALERT_WORDS[lang] ?? ALERT_WORDS.en)[why];
  return words.replace("{name}", alertName(name));
}

/** The agent's page, as the bell's row links it. */
export function agentLink(workspace: string, agent: string): string {
  return workspace
    ? `/agents?project=${encodeURIComponent(workspace)}&agent=${encodeURIComponent(agent)}`
    : "/agents";
}

export interface AlertPrefs {
  desktop: boolean;
  phone: boolean;
  /** "HH:MM" each, or null (no quiet hours). */
  quiet: { from: string; to: string } | null;
  pushTimeoutSeconds: number;
  /** How long a push service keeps an alert for a device that is off. */
  pushTtlSeconds: number;
  finished: boolean;
  sound: boolean;
  tabCount: boolean;
  tabFirstSeconds: number;
  maxStreams: number;
}

export const ALERT_DEFAULTS: AlertPrefs = {
  desktop: true,
  phone: true,
  quiet: null,
  pushTimeoutSeconds: 30,
  pushTtlSeconds: 86_400,
  finished: false,
  sound: false,
  tabCount: true,
  tabFirstSeconds: 3,
  maxStreams: 20,
};

const SWITCHES = {
  desktop: "desktop",
  phone: "phone",
  finished: "finished",
  sound: "sound",
  tab_count: "tabCount",
} as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The person's alert prefs from user.yml; a hand-broken value is its default. */
export function alertPrefs(user: unknown): AlertPrefs {
  const a = ((user as { alerts?: Record<string, unknown> } | null)?.alerts ??
    {}) as Record<string, unknown>;
  const q = a.quiet as { from?: unknown; to?: unknown } | undefined;
  const t = a.push_timeout_seconds;
  const ttl = a.push_ttl_seconds;
  const on = (k: keyof typeof SWITCHES): boolean =>
    typeof a[k] === "boolean"
      ? (a[k] as boolean)
      : (ALERT_DEFAULTS[SWITCHES[k]] as boolean);
  return {
    desktop: on("desktop"),
    phone: on("phone"),
    finished: on("finished"),
    sound: on("sound"),
    tabCount: on("tab_count"),
    quiet:
      q &&
      typeof q.from === "string" &&
      typeof q.to === "string" &&
      HHMM.test(q.from) &&
      HHMM.test(q.to) &&
      q.from !== q.to
        ? { from: q.from, to: q.to }
        : null,
    pushTimeoutSeconds:
      typeof t === "number" && Number.isFinite(t) && t >= 1 && t <= 3600
        ? t
        : ALERT_DEFAULTS.pushTimeoutSeconds,
    pushTtlSeconds:
      typeof ttl === "number" &&
      Number.isInteger(ttl) &&
      ttl >= 0 &&
      ttl <= 2_419_200
        ? ttl
        : ALERT_DEFAULTS.pushTtlSeconds,
    tabFirstSeconds: within(
      a.tab_first_seconds,
      "tab_first_seconds",
      ALERT_DEFAULTS.tabFirstSeconds,
    ),
    maxStreams: within(a.max_streams, "max_streams", ALERT_DEFAULTS.maxStreams),
  };
}

const PUSH_LIMITS = {
  push_timeout_seconds: { min: 1, max: 3600 },
  push_ttl_seconds: { min: 0, max: 2_419_200 },
  tab_first_seconds: { min: 1, max: 10 },
  max_streams: { min: 1, max: 200 },
} as const;

function within(
  v: unknown,
  k: keyof typeof PUSH_LIMITS,
  fallback: number,
): number {
  const { min, max } = PUSH_LIMITS[k];
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max
    ? (v as number)
    : fallback;
}

/** What /api/settings serves as `alerts`. */
export function alertSettings(user: UserConfig): Record<string, unknown> {
  const p = alertPrefs(user);
  // Each side as stored (a start alone shows, and the page says it needs
  // an end); quiet hours count only with both.
  const q = ((user as { alerts?: { quiet?: Record<string, unknown> } }).alerts
    ?.quiet ?? {}) as Record<string, unknown>;
  const side = (v: unknown) => (typeof v === "string" && HHMM.test(v) ? v : "");
  return {
    desktop: p.desktop,
    phone: p.phone,
    quiet_from: side(q.from),
    quiet_to: side(q.to),
    // Issue 367: the push limits, their defaults when unset.
    push_timeout_seconds: p.pushTimeoutSeconds,
    push_ttl_seconds: p.pushTtlSeconds,
    finished: p.finished,
    sound: p.sound,
    tab_count: p.tabCount,
    tab_first_seconds: p.tabFirstSeconds,
    max_streams: p.maxStreams,
  };
}

/**
 * A POSTed `alerts`: {desktop?, phone?, finished?, sound?, tab_count?: boolean; quiet_from?, quiet_to?:
 * "HH:MM" or "" (none); push_timeout_seconds? (1..3600),
 * push_ttl_seconds? (0..2419200), tab_first_seconds? (1..10),
 * max_streams? (1..200): whole numbers}; null clears one (back
 * to its default).
 */
export function patchAlerts(
  user: UserConfig,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { ok: false, error: "alerts must be an object" };
  const body = v as Record<string, unknown>;
  const u = user as { alerts?: Record<string, unknown> };
  const a: Record<string, unknown> = { ...(u.alerts ?? {}) };
  for (const [k, x] of Object.entries(body)) {
    if (Object.hasOwn(SWITCHES, k)) {
      if (x === null) delete a[k];
      else if (typeof x === "boolean") a[k] = x;
      else return { ok: false, error: `alerts.${k} must be true or false` };
    } else if (k === "quiet_from" || k === "quiet_to") {
      const side = k === "quiet_from" ? "from" : "to";
      const q = { ...((a.quiet as Record<string, unknown>) ?? {}) };
      if (x === null || x === "") delete q[side];
      else if (typeof x === "string" && HHMM.test(x)) q[side] = x;
      else return { ok: false, error: `alerts.${k} must be HH:MM, or empty` };
      if (Object.keys(q).length) a.quiet = q;
      else delete a.quiet;
    } else if (Object.hasOwn(PUSH_LIMITS, k)) {
      const { min, max } = PUSH_LIMITS[k as keyof typeof PUSH_LIMITS];
      if (x === null) delete a[k];
      else if (
        Number.isInteger(x) &&
        (x as number) >= min &&
        (x as number) <= max
      )
        a[k] = x;
      else
        return {
          ok: false,
          error: `alerts.${k} must be a whole number from ${min} to ${max}`,
        };
    } else return { ok: false, error: `alerts has no ${k}` };
  }
  if (Object.keys(a).length) u.alerts = a;
  else delete u.alerts;
  return { ok: true };
}

/** "HH:MM" now in `zone` (the person's), else this machine's. */
function clockOf(at: Date, zone: string | null): string {
  try {
    const f = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(zone ? { timeZone: zone } : {}),
    });
    return f.format(at);
  } catch {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(at.getHours())}:${p(at.getMinutes())}`;
  }
}

/** Whether `at` is inside the person's quiet hours (from inclusive, to not). */
export function inQuietHours(
  prefs: Pick<AlertPrefs, "quiet">,
  at: Date,
  zone: string | null = null,
): boolean {
  const q = prefs.quiet;
  if (!q) return false;
  const now = clockOf(at, zone);
  return q.from < q.to
    ? now >= q.from && now < q.to
    : now >= q.from || now < q.to;
}
