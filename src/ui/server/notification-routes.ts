/**
 * NT-1 / NT-2 / NT-3: the bell's routes.
 *   POST /api/agents/self/attention  an agent (its actor token only) says it
 *        waits for its person, went on, or finished its turn:
 *        {event: waiting|resumed|finished, why?, from?, text?, hooked?}.
 *        Which agent comes from the token, never the body.
 *   GET  /api/notifications          the bell: {unread, groups, older,
 *                                     off, foldDays, mutes}. Bell v6: only
 *                                     the person's kinds that are on;
 *                                     items older than foldDays in
 *                                     `older`; unread counts what is shown.
 *   POST /api/notifications/read     {id} | {subject} | {scope} | {all: true}
 *                                     (all: what is shown only)
 *   POST /api/notifications/clear    the read ones ({scope} or all).
 *   POST /api/notifications/mute     {target, minutes}; {target, minutes: 0}
 *                                     unmutes.
 *   POST /api/notifications/looking  NT-2: a page shows these agents now,
 *                                     visible and focused: {agents: [...]}.
 * An agent reads the bell (notifications_list) but changes nothing in it
 * but its own attention.
 */
import type * as http from "http";
import {
  type AskLimit,
  type BellPrefs,
  bellPrefs,
  bellView,
  groupNotifications,
  type NotificationStore,
  type Which,
} from "../../shared/notifications.js";
import type { Attention, WaitingWhy } from "./attention.js";
import { readBody, sendJson } from "./http-helpers.js";
import { agentPrincipalOf } from "./request-guard.js";

export const NOTIFICATION_PATHS = [
  "/api/agents/self/attention",
  "/api/notifications",
  "/api/notifications/read",
  "/api/notifications/clear",
  "/api/notifications/mute",
  "/api/notifications/looking",
] as const;

export const isNotificationPath = (p: string) =>
  (NOTIFICATION_PATHS as readonly string[]).includes(p);

export interface NotificationRouteDeps {
  store: NotificationStore;
  attention: Attention;
  /** ask_human's limit (notifications.asks_per_hour); absent, none. */
  asks?: { limit: AskLimit; perHour: () => number };
  /** Bell v6: the person's kinds and fold (absent: the defaults). */
  prefs?: () => BellPrefs;
}

async function jsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    if (raw.length > 16 * 1024) return null;
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const refuse = (
  res: http.ServerResponse,
  status: number,
  code: string,
  error: string,
) => sendJson(res, { ok: false, code, error }, status);

const str = (v: unknown, max = 300) =>
  typeof v === "string" && v ? v.slice(0, max) : undefined;

function whichOf(b: Record<string, unknown>): Which | null {
  if (b.all === true) return { all: true };
  if (str(b.id)) return { id: str(b.id)! };
  if (str(b.subject)) return { subject: str(b.subject)! };
  if (str(b.scope)) return { scope: str(b.scope)! };
  return null;
}

export async function handleNotificationRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: NotificationRouteDeps,
): Promise<boolean> {
  if (!isNotificationPath(pathname)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  const agent = agentPrincipalOf(req);

  if (pathname === "/api/agents/self/attention") {
    if (method !== "POST")
      return (refuse(res, 405, "method", "POST only."), true);
    if (!agent) {
      refuse(
        res,
        403,
        "agent_only",
        "Only an agent's own token says it waits.",
      );
      return true;
    }
    const b = await jsonBody(req);
    const ev = b?.event;
    const why = b?.why;
    if (ev !== "waiting" && ev !== "finished" && ev !== "resumed") {
      refuse(
        res,
        400,
        "bad_event",
        'event is "waiting", "resumed" or "finished".',
      );
      return true;
    }
    if (
      ev === "waiting" &&
      why !== "permission" &&
      why !== "input" &&
      why !== "asked"
    ) {
      refuse(res, 400, "bad_why", 'why is "permission", "input" or "asked".');
      return true;
    }
    const id = agent.actor.slice("agent:".length);
    if (ev === "waiting" && why === "asked" && deps.asks) {
      let perHour: number;
      try {
        perHour = deps.asks.perHour();
      } catch (err) {
        refuse(res, 500, "bad_config", (err as Error).message);
        return true;
      }
      if (!deps.asks.limit.take(id, perHour)) {
        refuse(
          res,
          429,
          "ask_limit",
          `You asked ${perHour} questions in the last hour (notifications.asks_per_hour). Put the rest in your reply and end your turn.`,
        );
        return true;
      }
    }
    await deps.attention.event(
      id,
      agent.workspace,
      ev === "waiting"
        ? {
            event: "waiting",
            why: why as WaitingWhy,
            text: str(b?.text),
            hooked: b?.hooked === true,
          }
        : ev === "resumed"
          ? { event: "resumed", from: b?.from === "prompt" ? "prompt" : "tool" }
          : { event: "finished", text: str(b?.text) },
    );
    sendJson(res, { ok: true });
    return true;
  }

  if (pathname === "/api/notifications") {
    if (method !== "GET" && method !== "HEAD")
      return (refuse(res, 405, "method", "GET only."), true);
    const v = bellView(deps.store.list(), (deps.prefs ?? bellPrefs)(null));
    sendJson(res, {
      ok: true,
      unread: v.unread,
      waiting: [...deps.attention.waitingNow()].map(([a, why]) => ({
        agent: a,
        why,
      })),
      groups: groupNotifications(v.recent),
      older: { count: v.older.length, groups: groupNotifications(v.older) },
      off: v.off,
      foldDays: v.foldDays,
      mutes: deps.store.mutes(),
    });
    return true;
  }

  if (method !== "POST")
    return (refuse(res, 405, "method", "POST only."), true);
  if (agent) {
    refuse(res, 403, "person_only", "The bell is the person's to change.");
    return true;
  }
  const b = (await jsonBody(req)) ?? {};
  if (pathname === "/api/notifications/looking") {
    const agents = Array.isArray(b.agents)
      ? b.agents.filter((x): x is string => typeof x === "string").slice(0, 16)
      : [];
    deps.attention.lookingAt(agents);
    sendJson(res, { ok: true });
    return true;
  }
  if (pathname === "/api/notifications/mute") {
    const target = str(b.target, 200);
    const minutes = typeof b.minutes === "number" ? b.minutes : NaN;
    if (
      !target ||
      !/^(agent:|workspace\/|hub\/)/.test(target) ||
      !Number.isFinite(minutes)
    ) {
      refuse(
        res,
        400,
        "bad_mute",
        "Say which agent or project to mute, and for how many minutes.",
      );
      return true;
    }
    if (minutes <= 0) deps.store.unmute(target);
    else deps.store.mute(target, Math.min(minutes, 7 * 24 * 60));
    sendJson(res, { ok: true, mutes: deps.store.mutes() });
    return true;
  }
  const which =
    pathname === "/api/notifications/clear" && !Object.keys(b).length
      ? ({ all: true } as Which)
      : whichOf(b);
  if (!which) {
    refuse(res, 400, "bad_which", "id, subject, scope, or all: true.");
    return true;
  }
  // Bell v6: Mark all read marks what is shown (kinds off stay unread).
  const shownAll =
    pathname === "/api/notifications/read" && "all" in which
      ? (() => {
          const v = bellView(
            deps.store.list(),
            (deps.prefs ?? bellPrefs)(null),
          );
          return [...v.recent, ...v.older].filter((x) => !x.read);
        })()
      : null;
  const n = shownAll
    ? shownAll.reduce((k, x) => k + deps.store.markRead({ id: x.id }), 0)
    : pathname === "/api/notifications/read"
      ? deps.store.markRead(which)
      : deps.store.clearRead(which);
  sendJson(res, {
    ok: true,
    changed: n,
    // The badge's number: what is shown.
    unread: bellView(deps.store.list(), (deps.prefs ?? bellPrefs)(null)).unread,
  });
  return true;
}
