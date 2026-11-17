/**
 * NT: the server's one notification store and attention tracker. An
 * agent's output mark is a hash of its session's last 4 KB on the session
 * host (never starts one); a check every 2 s clears a waiting mark whose
 * agent's output moved.
 */
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
import { leadCandidates, pickLead, tellLead } from "./lead-routing.js";

let store: NotificationStore | null = null;
let attention: Attention | null = null;
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

export function notificationDeps(): {
  store: NotificationStore;
  attention: Attention;
  asks: { limit: AskLimit; perHour: () => number };
  prefs: () => BellPrefs;
} {
  store ??= new NotificationStore(getStateDir());
  attention ??= new Attention({
    store,
    outputMark,
    nameOf: (id) => {
      const r = readRecord(getStateDir(), id);
      return r?.displayName || r?.persona || id;
    },
    hooked: (id) =>
      HOOKED_RUNTIMES.has(readRecord(getStateDir(), id)?.runtime ?? ""),
    endedAsking,
    ended: endedAgents,
    // Issue 101: a question goes to the project's lead, when it has one.
    leadOf: async (id, ws) => pickLead(await leadCandidates(), ws, id),
    tellLead,
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
  };
}

/**
 * The person typed into session `sessionId` (its pane): its agent's wait
 * is answered. Never throws.
 */
export function personTyped(sessionId: string): void {
  if (!attention?.waitingNow().size) return;
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
