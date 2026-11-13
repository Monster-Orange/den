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
import {
  AskLimit,
  NotificationStore,
  readNotificationConfig,
} from "../../shared/notifications.js";
import { getStateDir } from "../../shared/paths.js";
import { Attention } from "./attention.js";

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
} {
  store ??= new NotificationStore(getStateDir());
  attention ??= new Attention({
    store,
    outputMark,
    nameOf: (id) => {
      const r = readRecord(getStateDir(), id);
      return r?.displayName || r?.persona || id;
    },
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
  };
}

/** NT-3b: the agents the hooks say wait for their person, and why. */
export function attentionWaiting(): Map<string, string> {
  return attention ? attention.waitingNow() : new Map();
}
