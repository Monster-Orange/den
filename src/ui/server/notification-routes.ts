/**
 * NT-1 / NT-2 / NT-3: the bell's routes.
 *   POST /api/agents/self/attention  an agent (its actor token only) says it
 *        waits for its person, went on, or finished its turn:
 *        {event: waiting|resumed|finished, why?, from?, text?, question?,
 *        hooked?}.
 *        Which agent comes from the token, never the body.
 *   GET  /api/notifications          the bell: {unread, groups, older,
 *                                     off, foldDays, mutes}. Bell v6: only
 *                                     the person's kinds that are on;
 *                                     items older than foldDays in
 *                                     `older`; unread counts what is shown.
 *                                     `done`, the agents that
 *                                     finished since this person looked.
 *   POST /api/notifications/read     {id} | {subject} | {scope} | {all: true}
 *                                     (all: what is shown only)
 *   POST /api/notifications/clear    the read ones ({scope} or all).
 *   POST /api/notifications/mute     {target, minutes}; {target, minutes: 0}
 *                                     unmutes.
 *   POST /api/notifications/looking  NT-2: a page shows these agents now,
 *                                     visible and focused: {agents: [...]}.
 *                                     The person has seen their
 *                                     finished work (the seen mark).
 *   GET  /api/alerts?after=<seq>     issue 172: the alerts after `after`
 *                                     for an open tab to show (alert-feed.ts),
 *                                     {seq, alerts}; the person's only.
 *   GET  /api/alerts/push-key        S2: this install's VAPID public key.
 *   POST /api/alerts/subscribe       S2: {subscription} (a device's
 *                                     PushSubscription.toJSON()).
 *   POST /api/alerts/unsubscribe     S2: {endpoint}.
 *   GET  /api/alerts/devices         the person's devices that get push:
 *                                     {devices: [{id, service, device, at}]};
 *                                     never an endpoint or its keys.
 *   POST /api/alerts/test            a test alert to each device: the
 *                                     devices, each with {status, reached,
 *                                     gone} (gone: dropped).
 *   POST /api/alerts/forget          {id}: stop push to that device.
 *   POST /api/notifications/withdraw issue 1008: {id, reason}: a question
 *                                     settled elsewhere leaves Needs you;
 *                                     the bell keeps it, saying why, who
 *                                     and when. The agent that asked (its
 *                                     token) or the person only; another
 *                                     agent's is refused and recorded.
 * An agent reads the bell (notifications_list) but changes nothing in it
 * but its own attention and its own questions.
 */
import type * as http from "http";
import {
  type AskLimit,
  type BellPrefs,
  bellPrefs,
  bellView,
  needsYou,
  groupNotifications,
  type Notification,
  type NotificationStore,
  type Which,
} from "../../shared/notifications.js";
import type { Approval } from "./approvals.js";
import { rowWhy, type Attention, type WaitingWhy } from "./attention.js";
import { recordAction } from "./audit.js";
import { heldWaiting } from "./held-bell.js";
import type { GateOverrunWaiting } from "./gate-overrun-bell.js";
import type { AlertFeed } from "./alert-feed.js";
import {
  deviceId,
  deviceOf,
  parseSubscription,
  pushService,
  type PushSubscription,
  type PushSubscriptions,
} from "./web-push.js";
import { readBody, sendJson } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";
import type { SeenMarks } from "../../shared/seen-mark.js";
import { agentSubject, personKey, type DoneAgent } from "./agent-state.js";

/** Issue 1008: a withdraw's reason, one line. */
export const WITHDRAW_REASON_MAX = 200;

export const NOTIFICATION_PATHS = [
  "/api/agents/self/attention",
  "/api/notifications",
  "/api/notifications/read",
  "/api/notifications/clear",
  "/api/notifications/mute",
  "/api/notifications/looking",
  "/api/notifications/withdraw",
  "/api/alerts",
  "/api/alerts/push-key",
  "/api/alerts/subscribe",
  "/api/alerts/unsubscribe",
  "/api/alerts/devices",
  "/api/alerts/test",
  "/api/alerts/forget",
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
  /** Issue 172: the alerts an open tab shows (absent: none). */
  alerts?: AlertFeed;
  /** Issue 172 S2: the person's devices, and this install's public key. */
  push?: {
    subs: PushSubscriptions;
    publicKey: () => string;
    /** A test alert to every device: each one's push service's answer. */
    test?: () => Promise<{ endpoint: string; status: number }[]>;
  };
  /**
   * Issue 746: the held writes waiting on the person (the approval
   * queue's pending()); they lead `waiting`, kind "allow".
   */
  held?: () => readonly Approval[];
  /**
   * Issue 993: the gate slots held past the overrun multiple of their
   * estimate; they follow the held writes in `waiting`, kind gate_overrun.
   */
  gateOverruns?: () => readonly GateOverrunWaiting[];
  /** The seen marks (opening an agent, or peeking at it, marks its work seen). */
  seen?: SeenMarks;
  /** The agents Done, not seen, for `person` (the bell). */
  doneAgents?: (person: string) => DoneAgent[];
  /** Mock v3's Earlier: the agents whose finished work `person` has seen. */
  seenDone?: (person: string) => DoneAgent[];
}

/** A device as a page sees it: no endpoint, no keys. */
const deviceView = (s: PushSubscription) => ({
  id: deviceId(s.endpoint),
  service: pushService(s.endpoint),
  device: s.device ?? "",
  at: s.at,
});

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
/** Issue 609: a tool input's hash (attention-hook.ts inputKey), or undefined. */
const inputKeyOf = (v: unknown) =>
  typeof v === "string" && /^[0-9a-f]{16}$/.test(v) ? v : undefined;

/** Issue 746: what waits on the person's Allow now; best effort. */
/** Issue 993: the overrun slots, or none when the store can't be read. */
function gateOverrunsNow(
  deps: NotificationRouteDeps,
): readonly GateOverrunWaiting[] {
  try {
    return deps.gateOverruns?.() ?? [];
  } catch {
    return [];
  }
}

function heldNow(deps: NotificationRouteDeps): readonly Approval[] {
  try {
    return deps.held?.() ?? [];
  } catch {
    return [];
  }
}

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
    // Issue 828: a question on the agent's screen (its hook says so). It
    // counts toward the ask limit like any question: the flag is the
    // agent's own word.
    const dialog = ev === "waiting" && why === "asked" && b?.dialog === true;
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
    const routed = await deps.attention.event(
      id,
      agent.workspace,
      ev === "waiting"
        ? {
            event: "waiting",
            why: why as WaitingWhy,
            text: str(b?.text),
            // Issue 327: what the wait saw (a tool, a notice), and the
            // idle notice that says no dialog is open.
            what: str(b?.what, 80),
            // Issue 609: which tool use a dialog is for (its input's hash).
            input: inputKeyOf(b?.input),
            idle: b?.idle === true,
            hooked: b?.hooked === true,
            ...(dialog ? { dialog: true } : {}),
          }
        : ev === "resumed"
          ? {
              event: "resumed",
              from:
                b?.from === "prompt" || b?.from === "session" ? b.from : "tool",
              // Issue 609: the tool that ran, so its own dialog clears.
              what: str(b?.what, 80),
              input: inputKeyOf(b?.input),
            }
          : {
              event: "finished",
              text: str(b?.text),
              // Issue 142: the question its turn ended on (the hook's).
              question: str(b?.question),
            },
    );
    // Issue 1008: the question's bell row, for a withdraw.
    const askId =
      ev === "waiting" && why === "asked" && !routed
        ? deps.store
            .list()
            .find(
              (n) =>
                n.subject === `agent:${id}` &&
                n.kind === "waiting" &&
                !n.settled &&
                rowWhy(n) === "asked",
            )?.id
        : undefined;
    // Issue 101: the question went to the project's lead (its name).
    sendJson(res, {
      ok: true,
      ...(routed ? { lead: deps.attention.nameOf(routed.lead) } : {}),
      ...(askId || routed?.askId ? { askId: askId ?? routed?.askId } : {}),
    });
    return true;
  }

  if (pathname === "/api/notifications/withdraw") {
    if (method !== "POST")
      return (refuse(res, 405, "method", "POST only."), true);
    const b = await jsonBody(req);
    const id = typeof b?.id === "string" ? b.id.trim().slice(0, 128) : "";
    const reason =
      typeof b?.reason === "string" ? b.reason.replace(/\s+/g, " ").trim() : "";
    if (!id || !reason || reason.length > WITHDRAW_REASON_MAX) {
      refuse(
        res,
        400,
        "bad_withdraw",
        `Give the question's id and a one-line reason (at most ${WITHDRAW_REASON_MAX} characters).`,
      );
      return true;
    }
    const row = deps.store
      .list()
      .find(
        (n) =>
          n.id === id &&
          n.source === "den" &&
          (n.kind === "waiting" || n.kind === "finished") &&
          n.subject.startsWith("agent:"),
      );
    // Issue 1058: a question routed to the lead is its "asked the lead" row.
    const isAsk = (n: NonNullable<typeof row>) =>
      n.kind === "waiting"
        ? rowWhy(n) === "asked"
        : n.msg?.key === "bell.m.toLead";
    if (!row || (!row.settled && !isAsk(row))) {
      refuse(res, 404, "not_found", "No question in the bell has that id.");
      return true;
    }
    const asker = row.subject.slice("agent:".length);
    const by = agent ? agent.actor : "person";
    const audit = (outcome: "refused" | undefined, detail: string) =>
      recordAction(
        auditActorOf(req),
        {
          verb: "ask_withdraw",
          detail,
          ...(outcome ? { outcome, reason: detail } : {}),
        },
        principalOf(req),
      );
    if (agent && agent.actor !== `agent:${asker}`) {
      audit(
        "refused",
        `withdraw of ${asker}'s question ${id} refused: only the agent that asked, or the person, may withdraw it`,
      );
      refuse(
        res,
        403,
        "not_yours",
        "Only the agent that asked, or the person, can withdraw a question.",
      );
      return true;
    }
    if (row.settled) {
      refuse(res, 409, "settled", "That question was withdrawn already.");
      return true;
    }
    const out = deps.attention.settle(asker, id, { reason, by });
    if (!out?.settled) {
      refuse(res, 409, "settled", "That question was withdrawn already.");
      return true;
    }
    audit(
      undefined,
      `${asker}'s question ${id} withdrawn by ${by}, settled: ${out.settled.reason}`,
    );
    sendJson(res, { ok: true, id, settled: out.settled });
    return true;
  }

  if (pathname === "/api/alerts") {
    if (method !== "GET")
      return (refuse(res, 405, "method", "GET only."), true);
    if (agent) {
      refuse(res, 403, "person_only", "Alerts are the person's.");
      return true;
    }
    const raw = new URL(req.url ?? "/", "http://x").searchParams.get("after");
    const after = raw !== null && /^\d{1,12}$/.test(raw) ? Number(raw) : null;
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, {
      ok: true,
      ...(deps.alerts?.after(after) ?? { seq: 0, alerts: [] }),
    });
    return true;
  }

  if (pathname === "/api/alerts/push-key") {
    if (method !== "GET")
      return (refuse(res, 405, "method", "GET only."), true);
    if (agent || !deps.push) {
      refuse(res, 403, "person_only", "Alerts are the person's.");
      return true;
    }
    let publicKey: string;
    try {
      publicKey = deps.push.publicKey();
    } catch {
      refuse(res, 500, "no_key", "This install has no push key.");
      return true;
    }
    sendJson(res, { ok: true, publicKey });
    return true;
  }

  if (pathname === "/api/alerts/devices") {
    if (method !== "GET")
      return (refuse(res, 405, "method", "GET only."), true);
    if (agent) {
      refuse(res, 403, "person_only", "Alerts are the person's.");
      return true;
    }
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, {
      ok: true,
      devices: (deps.push?.subs.list() ?? []).map(deviceView),
    });
    return true;
  }

  if (pathname === "/api/notifications") {
    if (method !== "GET" && method !== "HEAD")
      return (refuse(res, 405, "method", "GET only."), true);
    const prefs = (deps.prefs ?? bellPrefs)(null);
    const all = bellView(deps.store.list(), prefs);
    let done: DoneAgent[] = [];
    // Done follows the "finished" switch when the person turned
    // it off; its default (off for the updates) leaves Done on (mock v3).
    if (!prefs.finishedChosenOff)
      try {
        done = deps.doneAgents?.(personKey(req)) ?? [];
      } catch {
        /* the bell is best effort: no Done section this time */
      }
    let seenDone: DoneAgent[] = [];
    if (!prefs.finishedChosenOff)
      try {
        seenDone = deps.seenDone?.(personKey(req)) ?? [];
      } catch {
        /* best effort: no seen rows this time */
      }
    // An agent in Done (or its seen row in Earlier) shows once:
    // its "finished" item is left out of the updates and Older.
    const inDone = new Set(
      [...done, ...seenDone].map((d) => agentSubject(d.agent)),
    );
    const once = (ns: Notification[]) =>
      ns.filter((n) => !(n.kind === "finished" && inDone.has(n.subject)));
    const v = { ...all, updates: once(all.updates), older: once(all.older) };
    sendJson(res, {
      ok: true,
      unread: v.unread,
      // Done, not seen, for this person (its own section).
      done,
      // Mock v3: the ones seen, first in Earlier.
      seenDone,
      // Issue 746: a held write waiting for the person's Allow first,
      // then (issue 327) each agent waiting, what on, since when.
      waiting: [
        ...heldWaiting(heldNow(deps)),
        ...gateOverrunsNow(deps),
        ...[...deps.attention.waitingNow()].map(([a, why]) => {
          const w = deps.attention.waitingDetail(a);
          return {
            agent: a,
            why,
            ...(w?.what ? { what: w.what } : {}),
            ...(w ? { since: w.since } : {}),
          };
        }),
      ],
      groups: groupNotifications(v.recent),
      // ATTN-5 (den#142): updates, collapsed; never in the badge.
      updates: {
        count: v.updates.length,
        unread: v.updates.filter((n) => !n.read).length,
        groups: groupNotifications(v.updates),
      },
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
  if (pathname === "/api/alerts/subscribe") {
    const sub = parseSubscription(b.subscription);
    if (!sub || !deps.push) {
      refuse(
        res,
        400,
        "bad_subscription",
        "subscription is a device's push subscription: an https endpoint and its keys.",
      );
      return true;
    }
    deps.push.subs.add({ ...sub, device: deviceOf(req.headers["user-agent"]) });
    sendJson(res, { ok: true });
    return true;
  }
  if (pathname === "/api/alerts/unsubscribe") {
    const endpoint = str(b.endpoint, 2048);
    sendJson(res, {
      ok: true,
      removed: !!endpoint && !!deps.push?.subs.remove(endpoint),
    });
    return true;
  }
  if (pathname === "/api/alerts/test") {
    const before = deps.push?.subs.list() ?? [];
    const answers =
      before.length && deps.push?.test ? await deps.push.test() : [];
    const status = new Map(answers.map((a) => [a.endpoint, a.status]));
    sendJson(res, {
      ok: true,
      devices: before.map((s) => {
        const st = status.get(s.endpoint) ?? 0;
        return {
          ...deviceView(s),
          status: st,
          reached: st >= 200 && st < 300,
          gone: st === 404 || st === 410,
        };
      }),
    });
    return true;
  }
  if (pathname === "/api/alerts/forget") {
    const id = str(b.id, 64);
    const hit = id
      ? deps.push?.subs.list().find((s) => deviceId(s.endpoint) === id)
      : undefined;
    sendJson(res, {
      ok: true,
      removed: !!hit && !!deps.push?.subs.remove(hit.endpoint),
    });
    return true;
  }
  if (pathname === "/api/notifications/looking") {
    const agents = Array.isArray(b.agents)
      ? b.agents.filter((x): x is string => typeof x === "string").slice(0, 16)
      : [];
    deps.attention.lookingAt(agents);
    // Opening the agent (or its terminal) is seen, for this
    // person: Done turns into Idle.
    if (deps.seen) {
      const person = personKey(req);
      for (const a of agents)
        deps.seen.markSeen({ subject: agentSubject(a), person });
    }
    // ATTN-5 (den#142): opening an agent clears its updates (they leave
    // the list, and its count drops); what needs you stays until answered.
    const opened = new Set(agents.map((a) => `agent:${a}`));
    if (opened.size)
      deps.store.remove((n) => opened.has(n.subject) && !needsYou(n.kind));
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
  // A peek's read is a look at the agent (`seen: true`).
  const peek =
    pathname === "/api/notifications/read" &&
    b.seen === true &&
    "subject" in which &&
    /^agent:/.test(which.subject)
      ? which.subject
      : null;
  if (peek) deps.seen?.markSeen({ subject: peek, person: personKey(req) });
  // Issue 1339: one view build, one write for the whole set.
  const prefs = (deps.prefs ?? bellPrefs)(null);
  // Mark read for what the bell shows, kept by `keep`, in one write.
  const markShown = (keep: (x: { subject: string }) => boolean) => {
    const v = bellView(deps.store.list(), prefs);
    return deps.store.markReadMany(
      [...v.recent, ...v.updates, ...v.older]
        .filter((x) => !x.read && keep(x))
        .map((x) => x.id),
    );
  };
  const n = peek
    ? // A peek marks only what the bell showed for the agent.
      markShown((x) => x.subject === peek)
    : pathname === "/api/notifications/read" && "all" in which
      ? markShown(() => true)
      : pathname === "/api/notifications/read"
        ? deps.store.markRead(which)
        : deps.store.clearRead(which);
  sendJson(res, {
    ok: true,
    changed: n,
    // The badge's number: what is shown.
    unread: bellView(deps.store.list(), prefs).unread,
  });
  return true;
}
