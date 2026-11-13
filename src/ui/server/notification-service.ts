/**
 * NT: the server's one notification store and attention tracker. An
 * agent's output mark is a hash of its session's last 4 KB on the session
 * host (never starts one); a check every 2 s clears a waiting mark whose
 * agent's output moved.
 */
import crypto from "node:crypto";
import { readRecord } from "../../shared/agents/records.js";
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
      void attention!.check().finally(() => (busy = false));
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
