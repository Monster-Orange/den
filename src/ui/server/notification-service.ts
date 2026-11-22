/**
 * NT: the server's one notification store and attention tracker. An
 * agent's output mark is a hash of its session's last 4 KB on the session
 * host (never starts one); a check every 2 s clears a waiting mark whose
 * agent's output moved.
 */
import { projectDisplayName } from "../../shared/workspace-name.js";
import { readWorkspacesFile } from "../../shared/environment-manager/workspaces.js";
import crypto from "node:crypto";
import {
  listRecords,
  readRecord,
  type AgentRecord,
} from "../../shared/agents/records.js";
import type { SessionInfo } from "../../shared/sessions/types.js";
import { readDenConfig, readUserConfig } from "../../shared/den-config.js";
import { bellPrefs, type BellPrefs } from "../../shared/notifications.js";
import {
  AskLimit,
  NotificationStore,
  readNotificationConfig,
} from "../../shared/notifications.js";
import { getStateDir } from "../../shared/paths.js";
import { Attention } from "./attention.js";
import { AlertFeed } from "./alert-feed.js";
import { ALERT_TEST_WORDS, alertPrefs } from "./alerts.js";
import { uiLanguage } from "./ui-language.js";
import { timeZonePref } from "./time-zone-pref.js";
import { product } from "../../shared/product.js";
import { readWebUrl } from "../../shared/web-url.js";
import { pushContact } from "../../shared/push-contact.js";
import { PushSubscriptions, pushAll, pushEach, vapidKeys } from "./web-push.js";
import { leadCandidates, pickLead, tellLead } from "./lead-routing.js";
import { seenMarks } from "../../shared/seen-mark.js";
import {
  agentSubject,
  doneAgents,
  seenDoneAgents,
  type AgentStateDeps,
  type DoneAgent,
} from "./agent-state.js";

let store: NotificationStore | null = null;
let attention: Attention | null = null;
let alerts: AlertFeed | null = null;
let timer: NodeJS.Timeout | null = null;
const askLimit = new AskLimit();

async function outputMark(agent: string): Promise<string | null> {
  const rec = readRecord(getStateDir(), agent);
  if (!rec) return null;
  try {
    const { webDeps } = await import("./agent-routes.js");
    const c = await webDeps().connectExisting();
    if (!c) return null;
    try {
      const s = (await c.list()).find((x) => x.ref.id === rec.session.id);
      if (!s || s.exited) return null;
      const tail = await c.scrollback(rec.session.id, 4096);
      return crypto.createHash("sha256").update(tail).digest("hex");
    } finally {
      c.close();
    }
  } catch {
    return null;
  }
}

/**
 * #142: the question an agent's finished turn ended on (its transcript's
 * last answer), or null. Claude Code agents only: others have no
 * transcript Den reads.
 */
async function endedAsking(agent: string): Promise<string | null> {
  const rec = readRecord(getStateDir(), agent);
  if (!rec || !HOOKED_RUNTIMES.has(rec.runtime ?? "")) return null;
  const [{ transcriptFile }, { lastAnswerQuestion }] = await Promise.all([
    import("../../shared/agents/den-claude.js"),
    import("../../shared/agents/conversations.js"),
  ]);
  return lastAnswerQuestion(transcriptFile(rec.resumeToken));
}

/**
 * Issue 327: how agent `rec` ended, or null while it runs (or Den can't
 * tell). `live`: the sessions running now (id → startedAt), or null when
 * the session host didn't answer. Removed (no record), or stopped since
 * its session started (`agents stop`, even while it still ends):
 * "stopped". Its session gone, not stopped: "exited".
 */
export function agentEnded(
  rec: Pick<AgentRecord, "stoppedAt" | "session"> | null,
  live: ReadonlyMap<string, string> | null,
): "stopped" | "exited" | null {
  if (!rec) return "stopped";
  if (live === null) return rec.stoppedAt ? "stopped" : null;
  const started = live.get(rec.session.id);
  if (started === undefined) return rec.stoppedAt ? "stopped" : "exited";
  return rec.stoppedAt && rec.stoppedAt >= started ? "stopped" : null;
}

/** Issue 327: which of these waiting agents ended (see agentEnded). */
async function endedAgents(
  agents: readonly string[],
): Promise<Map<string, "stopped" | "exited">> {
  let live: Map<string, string> | null = null;
  try {
    const { webDeps } = await import("./agent-routes.js");
    const c = await webDeps().connectExisting();
    if (c)
      try {
        live = new Map(
          (await c.list())
            .filter((x) => !x.exited)
            .map((x) => [x.ref.id, x.startedAt]),
        );
      } finally {
        c.close();
      }
  } catch {
    live = null;
  }
  const out = new Map<string, "stopped" | "exited">();
  for (const a of agents) {
    let rec: AgentRecord | null;
    try {
      rec = readRecord(getStateDir(), a);
    } catch {
      continue; // unreadable now: the next tick looks again
    }
    const how = agentEnded(rec, live);
    if (how) out.set(a, how);
  }
  return out;
}

/**
 * Issue 369: whether agent `agent`'s screen ends with its runtime's
 * permission dialog (the last 16 KB of its session). No record, no
 * session, or exited: false. The session host not answering: null (look
 * again). A runtime whose dialogs Den can't see: true (its output going
 * on clears the wait).
 */
async function dialogOpen(agent: string): Promise<boolean | null> {
  const rec = readRecord(getStateDir(), agent);
  if (!rec) return false;
  const [{ getRuntime }, { promptOnScreen }] = await Promise.all([
    import("../../shared/agents/runtimes.js"),
    import("../../shared/agents/trust-prompt.js"),
  ]);
  const p = getRuntime(rec.runtime)?.permissionPrompt;
  if (!p) return true;
  try {
    const { webDeps } = await import("./agent-routes.js");
    const c = await webDeps().connectExisting();
    if (!c) return null;
    try {
      const s = (await c.list()).find((x) => x.ref.id === rec.session.id);
      if (!s || s.exited) return false;
      const out = (await c.scrollback(rec.session.id, 16 * 1024)).toString(
        "utf-8",
      );
      return promptOnScreen(out, p);
    } finally {
      c.close();
    }
  } catch {
    return null;
  }
}

/** The runtimes whose hooks say when they wait: their bells add nothing. */
const HOOKED_RUNTIMES = new Set(["den-claude"]);

/** NT-1 (3): which running agents' sessions rang, and when. */
export function bellsOf(
  sessions: readonly SessionInfo[],
  records: readonly AgentRecord[],
): { agent: string; workspace: string; bellAt: string }[] {
  const rang = new Map(
    sessions
      .filter((x) => x.bellAt && !x.exited)
      .map((x) => [x.ref.id, x.bellAt!]),
  );
  return records
    .filter(
      (r) =>
        !HOOKED_RUNTIMES.has(r.runtime) &&
        !r.stoppedAt &&
        rang.has(r.session.id),
    )
    .map((r) => ({
      agent: r.id,
      workspace: r.workspace,
      bellAt: rang.get(r.session.id)!,
    }));
}

/**
 * NT-1 (3): the agents whose session rang the terminal's bell. Claude
 * Code's agents are left out: their hooks say it, more exactly.
 */
async function sessionBells(): Promise<
  { agent: string; workspace: string; bellAt: string }[]
> {
  try {
    const { webDeps } = await import("./agent-routes.js");
    const c = await webDeps().connectExisting();
    if (!c) return [];
    try {
      const sessions = await c.list();
      if (!sessions.some((x) => x.bellAt)) return [];
      return bellsOf(sessions, listRecords(getStateDir()));
    } finally {
      c.close();
    }
  } catch {
    return [];
  }
}

/** An agent's name as the bell says it. */
function nameOf(id: string): string {
  const r = readRecord(getStateDir(), id);
  return r?.displayName || r?.persona || id;
}

/**
 * Issue 172: the alerts outside the bell (alert-feed.ts): the person's
 * prefs, language and zone read each time from user.yml.
 */
/**
 * Issue 172 S2: who the push services may contact about this install's
 * pushes (VAPID's subject): its https address, else the mailto fallback
 * (issue 367: shared/push-contact.ts; doctor warns about the fallback).
 */
function pushSubject(): string {
  return pushContact(readWebUrl()?.url).subject;
}

let pushSubs: PushSubscriptions | null = null;
/** Issue 172 S2: the person's devices that get alerts by push. */
export function pushDeps(): {
  subs: PushSubscriptions;
  publicKey: () => string;
  test: () => Promise<{ endpoint: string; status: number }[]>;
} {
  pushSubs ??= new PushSubscriptions(getStateDir());
  const subs = pushSubs;
  return {
    subs,
    publicKey: () => vapidKeys(getStateDir()).publicKey,
    // Issue 172: Settings' Send a test alert. It goes now, whatever the
    // switches and quiet hours say: the person asked for it.
    test: () => {
      const user = readUserConfig();
      const prefs = alertPrefs(user);
      return pushEach(
        {
          title: product().title,
          body: ALERT_TEST_WORDS[uiLanguage(user.language)],
          link: "/settings#notifications",
          tag: `test-${crypto.randomUUID()}`,
        },
        {
          subs,
          keys: () => vapidKeys(getStateDir()),
          subject: pushSubject(),
          timeoutMs: prefs.pushTimeoutSeconds * 1000,
          ttlSeconds: prefs.pushTtlSeconds,
        },
      );
    },
  };
}

export function alertFeed(): AlertFeed {
  alerts ??= new AlertFeed({
    prefs: () => alertPrefs(readUserConfig()),
    lang: () => uiLanguage(readUserConfig().language),
    zone: () => timeZonePref(readUserConfig().time_zone),
    title: () => product().title,
    nameOf,
    // Issue 774: an agent (or its project) the person muted never alerts.
    muted: (agent, workspace) =>
      (store ?? notificationDeps().store).muted(
        `agent:${agent}`,
        `workspace/${workspace}`,
      ),
    // Issue 774: the heading is the bell's words, the line under it the
    // project (as an open tab shows it).
    push: (a, prefs) =>
      pushAll(
        { title: a.body, body: a.project, link: a.link, tag: a.id },
        {
          subs: pushDeps().subs,
          keys: () => vapidKeys(getStateDir()),
          subject: pushSubject(),
          timeoutMs: prefs.pushTimeoutSeconds * 1000,
          ttlSeconds: prefs.pushTtlSeconds,
        },
      ),
  });
  return alerts;
}

export function notificationDeps(): {
  store: NotificationStore;
  attention: Attention;
  alerts: AlertFeed;
  push: ReturnType<typeof pushDeps>;
  asks: { limit: AskLimit; perHour: () => number };
  prefs: () => BellPrefs;
  seen: ReturnType<typeof seenMarks>;
  doneAgents: (person: string) => DoneAgent[];
  seenDone: (person: string) => DoneAgent[];
} {
  store ??= new NotificationStore(getStateDir());
  attention ??= new Attention({
    store,
    outputMark,
    nameOf,
    hooked: (id) =>
      HOOKED_RUNTIMES.has(readRecord(getStateDir(), id)?.runtime ?? ""),
    endedAsking,
    ended: endedAgents,
    alert: (n) => void alertFeed().needs(n),
    dialogOpen,
    // Issue 101: a question goes to the project's lead, when it has one.
    leadOf: async (id, ws) => pickLead(await leadCandidates(), ws, id),
    tellLead,
    // Issue 773: a turn's end is a new version of the agent's finished
    // work: Done for each person until they open it.
    turnEnded: (id, at) =>
      seenMarks(getStateDir()).noteVersion(
        agentSubject(id),
        String(at),
        new Date(at).toISOString(),
      ),
    // Issue 1008: an answer after a withdraw; the agent is told.
    tell: tellLead,
  });
  if (!timer) {
    let busy = false;
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void attention!
        .check()
        .then(async () => attention!.bells(await sessionBells()))
        .catch(() => undefined)
        .finally(() => (busy = false));
    }, 2000);
    timer.unref();
  }
  return {
    store,
    attention,
    alerts: alertFeed(),
    push: pushDeps(),
    asks: {
      limit: askLimit,
      // Read each time: a change to user.yml counts at once.
      perHour: () =>
        readNotificationConfig(readDenConfig(), readUserConfig()).asksPerHour,
    },
    // Bell v6: the person's kinds and fold, read each time.
    prefs: () => {
      try {
        return bellPrefs(readUserConfig());
      } catch {
        return bellPrefs(null);
      }
    },
    seen: seenMarks(getStateDir()),
    // Issue 773: the bell's Done, not seen (not one waiting again).
    doneAgents: (person) =>
      doneAgents(
        listRecords(getStateDir()),
        person,
        agentStateDeps(),
        busyNow(attention!),
        // Mock v3: each Done row names its project as the person sees it.
        doneProjectName(),
      ),
    // Mock v3's Earlier: the seen ones, newest first.
    seenDone: (person) =>
      seenDoneAgents(
        listRecords(getStateDir()),
        person,
        agentStateDeps(),
        busyNow(attention!),
        doneProjectName(),
      ),
  };
}

/** The agents waiting on their person now (not an idle notice). */
function busyNow(a: Attention): Set<string> {
  return new Set(
    [...a.waitingNow()]
      .filter(([, why]) => why !== "input")
      .map(([agent]) => agent),
  );
}

/** The project names a Done row shows (one read of workspaces.yml). */
function doneProjectName(): (ws: string) => string {
  const ws = readWorkspacesFile().workspaces ?? {};
  return (slug) => projectDisplayName(slug, ws[slug]);
}

/**
 * Issue 773: what each agent's state for a person is made of: the seen
 * marks, the agents in a turn, and since when each waits.
 */
export function agentStateDeps(): AgentStateDeps {
  const a = notificationDeps().attention;
  return {
    seen: seenMarks(getStateDir()),
    working: () => a.workingNow(),
    waitingSince: (agent) => a.waitingDetail(agent)?.since,
    waitingWhat: (agent) => a.waitingDetail(agent)?.what,
  };
}

/**
 * The person typed into session `sessionId` (its pane): its agent's wait
 * is answered. Never throws.
 */
export function personTyped(sessionId: string): void {
  // Issue 1008: a withdrawn question counts too (a late answer).
  if (!attention?.waitingNow().size && !attention?.hasSettled()) return;
  try {
    const rec = listRecords(getStateDir()).find(
      (r) => r.session.id === sessionId,
    );
    if (rec) attention.typed(rec.id);
  } catch {
    /* records unreadable: the hooks or the output clear it */
  }
}

/**
 * Issue 327: agent `id` was stopped or removed here: its wait and its
 * bell row go now, not on the next tick. Never throws.
 */
export function agentGone(id: string): void {
  try {
    attention?.gone(id);
  } catch {
    /* the bell is best effort: the tick clears it */
  }
}

/**
 * Issue 369: at server start, the waiting rows kept from before it are
 * decided against the agents now (the check every 2 s goes on with any
 * Den can't decide yet). Never throws.
 */
export async function reconcileKeptWaits(): Promise<void> {
  try {
    await notificationDeps().attention.reconcile();
  } catch {
    /* the bell is best effort: the tick looks again */
  }
}

/** NT-3b: the agents the hooks say wait for their person, and why. */
export function attentionWaiting(): Map<string, string> {
  return attention ? attention.waitingNow() : new Map();
}

/** Issue 327: what `agent` waits on and since when, or null. */
export function attentionDetail(
  agent: string,
): { what: string; since: string } | null {
  const w = attention?.waitingDetail(agent);
  return w ? { what: w.what, since: w.since } : null;
}
