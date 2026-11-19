/**
 * Issue 172: alerts outside the bell, their rules and words in one place.
 * One plain ES module, because the page (alerts.js, Settings) and the
 * server (src/shared/alerts.ts, alert-feed.ts) both run it: a change here
 * changes every alert, on every path.
 *
 *   - What counts (issue 160, the approval policy): every need, or only
 *     what the person watches or what is critical (the default).
 *   - When it stays quiet: quiet hours (the person's, in their time zone),
 *     and while this page is visible and focused (the bell says it).
 *   - One alert per item: a browser claims each id once (two tabs show one).
 *   - The title is the product's; the body is the bell's words: who, and
 *     what it waits on. Never the tool line, the question's text or the
 *     write's summary (any of them can hold a secret or a code).
 *
 * The Settings row's English is here too; its es and ja are in the
 * catalogs (i18n/es.js, i18n/ja.js), and shell.js's en matches this
 * (tests/unit/server/i18n.test.ts).
 */

// ── The words ──────────────────────────────────────────────────────────

/** An alert's line, per language and what the agent waits on. */
export const ALERT_WORDS = {
  en: {
    permission: "{name} needs your permission",
    asked: "{name} asked you",
    allow: "{name} needs your Allow",
  },
  es: {
    permission: "{name} necesita tu permiso",
    asked: "{name} te preguntó",
    allow: "{name} necesita tu Permitir",
  },
  ja: {
    permission: "{name} があなたの許可を待っています",
    asked: "{name} から質問があります",
    allow: "{name} が「許可」を待っています",
  },
};

/** An agent's name as an alert says it: plain, one line, short. */
export function alertName(name) {
  const s = String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (s || "An agent").slice(0, 64);
}

/** The alert's line in `lang`. */
export function alertBody(lang, why, name) {
  const words = (ALERT_WORDS[lang] ?? ALERT_WORDS.en)[why];
  return words.replace("{name}", alertName(name));
}

/** A notification's title and body: the product's title, the bell's words. */
export function alertText(lang, title, why, name) {
  return { title: String(title ?? ""), body: alertBody(lang, why, name) };
}

/** The agent's page, as the bell's row links it. */
export function agentLink(workspace, agent) {
  return workspace
    ? `/agents?project=${encodeURIComponent(workspace)}&agent=${encodeURIComponent(agent)}`
    : "/agents";
}

/** Only Den's own pages: an alert's link, as a click follows it. */
export const alertLink = (l) =>
  typeof l === "string" && /^\/(?!\/)/.test(l) ? l : "/agents";

// ── What counts ────────────────────────────────────────────────────────

/** The choices (user.yml alerts.counts). */
export const ALERT_COUNTS = Object.freeze(["needs_you", "watched_or_critical"]);

/** Issue 160: people are told about what they watch or what is critical. */
export const ALERT_COUNTS_DEFAULT = "watched_or_critical";

/** Settings › Notifications › What counts, in English. */
export const ALERT_COUNTS_ROW = Object.freeze({
  label: "What counts",
  description:
    "Which needs alert you outside the bell. What you watch or what's critical: an agent's question, its own ask for your Allow, a write that is critical, or anything on a project, agent, repo or service you watch or pinned. The bell still has everything.",
  options: Object.freeze([
    { value: "needs_you", label: "Everything that needs you" },
    { value: "watched_or_critical", label: "What I watch or what's critical" },
  ]),
});

/** A stored choice, or the default. */
export function countsOf(v) {
  return ALERT_COUNTS.includes(v) ? v : ALERT_COUNTS_DEFAULT;
}

/**
 * How much a need matters, by the approval policy:
 *   critical   a held write the policy calls critical (it widens what an
 *              agent may do, touches secrets, deletes or money, or the
 *              person's critical list names it)
 *   escalated  the agent chose to ask the person (a question, or its own
 *              ask for an Allow)
 *   watched    on something the person watches or pinned (its project,
 *              the agent, the write's repo or service)
 *   routine    anything else (a permission prompt nobody watches)
 */
export function alertLevel(n) {
  if (n?.critical) return "critical";
  if (n?.escalated || n?.why === "asked") return "escalated";
  if (n?.watched) return "watched";
  return "routine";
}

/** Whether a need at `level` alerts under the choice `counts`. */
export function alertCounts(counts, level) {
  return countsOf(counts) === "needs_you" || level !== "routine";
}

// ── When it stays quiet ────────────────────────────────────────────────

/** "HH:MM" now in `zone` (the person's), else this machine's. */
function clockOf(at, zone) {
  try {
    const f = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(zone ? { timeZone: zone } : {}),
    });
    return f.format(at);
  } catch {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(at.getHours())}:${p(at.getMinutes())}`;
  }
}

/** Whether `at` is inside the person's quiet hours (from inclusive, to not). */
export function inQuietHours(prefs, at, zone = null) {
  const q = prefs?.quiet;
  if (!q) return false;
  const now = clockOf(at, zone);
  return q.from < q.to
    ? now >= q.from && now < q.to
    : now >= q.from || now < q.to;
}

/** In front (visible and focused): the bell and the Allow dialog say it. */
export function quietInFront(doc) {
  try {
    return doc?.visibilityState === "visible" && doc.hasFocus?.() === true;
  } catch {
    return false;
  }
}

// ── One alert per item ─────────────────────────────────────────────────

/** Where a browser keeps the ids it showed. */
export const ALERT_CLAIM_KEY = "den-alerts-shown";
/** How many ids it keeps. */
export const ALERT_CLAIM_KEEP = 100;

/**
 * True the first time this browser claims alert `id` (two tabs: one shows
 * it). No storage, or a broken one: true (the notification's tag, the
 * id, still folds two into one).
 */
export function claimAlert(storage, id) {
  if (!storage) return true;
  try {
    const seen = JSON.parse(storage.getItem(ALERT_CLAIM_KEY) || "[]");
    const list = Array.isArray(seen) ? seen : [];
    if (list.includes(id)) return false;
    list.push(id);
    storage.setItem(
      ALERT_CLAIM_KEY,
      JSON.stringify(list.slice(-ALERT_CLAIM_KEEP)),
    );
  } catch {
    /* no storage: the tag still folds two into one */
  }
  return true;
}
