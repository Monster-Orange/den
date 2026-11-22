/**
 * Issue 1129: the web server's one restart queue (restart-queue.ts). A
 * resume after a restart and Hub's new tools both go through it, with
 * agents.resume's batch size, gap and load ceiling, read before each
 * batch. While agents wait, the bell has one item that says how many
 * (it goes when none wait), and agents/restarts-waiting.json says the
 * same for doctor.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  RestartQueue,
  type RestartQueueConfig,
} from "../../shared/agents/restart-queue.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { agentsResume, type UserConfig } from "../../shared/den-config.js";
import type { NotificationStore } from "../../shared/notifications.js";
import { getStateDir } from "../../shared/paths.js";

export const RESTARTS_SUBJECT = "record:agents-restart-queue";

/** The bell's one item while `n` agents wait to restart; none at 0. */
export function noteRestartsWaiting(
  store: Pick<NotificationStore, "add" | "remove">,
  n: number,
): void {
  if (n <= 0) {
    store.remove((x) => x.subject === RESTARTS_SUBJECT && !x.read);
    return;
  }
  store.add({
    kind: "service",
    subject: RESTARTS_SUBJECT,
    scope: "workspace/den-server",
    text: `${n} agent${n === 1 ? "" : "s"} waiting to restart, a few at a time`,
    msg: { key: "bell.m.restartsWaiting", vars: { n } },
    link: "/agents",
  });
}

/** What doctor reads: how many wait, and since when. */
export interface RestartsWaiting {
  waiting: number;
  ids: string[];
  at: string;
}

export function restartsWaitingFile(stateDir: string): string {
  return path.join(stateDir, "agents", "restarts-waiting.json");
}

export function readRestartsWaiting(stateDir: string): RestartsWaiting | null {
  try {
    const o = JSON.parse(
      fs.readFileSync(restartsWaitingFile(stateDir), "utf8"),
    ) as Partial<RestartsWaiting>;
    return typeof o.waiting === "number" &&
      Array.isArray(o.ids) &&
      typeof o.at === "string"
      ? { waiting: o.waiting, ids: o.ids.map(String), at: o.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * A new server holds no queue: what an earlier one left waiting is gone,
 * so its file (and doctor's line) goes too.
 */
export function clearRestartsWaiting(stateDir: string): void {
  try {
    fs.rmSync(restartsWaitingFile(stateDir), { force: true });
  } catch {
    /* doctor's line is best effort */
  }
}

/** agents.resume as the queue reads it; the defaults when user.yml is wrong. */
export function queueConfig(
  read?: () => UserConfig,
  log?: (line: string) => void,
): RestartQueueConfig {
  let c;
  try {
    c = agentsResume(read);
  } catch (e) {
    log?.(`  ⚠ ${(e as Error).message}: the defaults apply`);
    c = agentsResume(() => ({}) as UserConfig);
  }
  return {
    batch: c.batch,
    gapMs: c.gapSeconds * 1000,
    loadCeiling: c.loadCeiling,
    maxWaitMs: c.maxWaitSeconds * 1000,
  };
}

let queue: RestartQueue | null = null;
/** The log and the bell, as the latest caller gave them. */
let logTo: ((line: string) => void) | undefined;
let storeOf: (() => Pick<NotificationStore, "add" | "remove">) | undefined;

/** The server's one restart queue. */
export function restartQueue(
  o: {
    log?: (line: string) => void;
    store?: () => Pick<NotificationStore, "add" | "remove">;
  } = {},
): RestartQueue {
  if (o.log) logTo = o.log;
  if (o.store) storeOf = o.store;
  if (queue) return queue;
  // A new process: nothing waits yet, whatever an earlier one wrote.
  clearRestartsWaiting(getStateDir());
  try {
    if (storeOf) noteRestartsWaiting(storeOf(), 0);
  } catch {
    /* the bell is best effort */
  }
  let told = 0;
  let saidBad = "";
  const q: RestartQueue = new RestartQueue({
    config: () =>
      queueConfig(undefined, (line) => {
        if (line !== saidBad) logTo?.(line);
        saidBad = line;
      }),
    load: () => os.loadavg()[0],
    sleep: (ms) =>
      new Promise<void>((go) => {
        const t = setTimeout(go, ms);
        t.unref?.();
      }),
    log: (line) => logTo?.(line),
    changed: (n) => {
      const ids = q.waiting().map((x) => x.id);
      try {
        const f = restartsWaitingFile(getStateDir());
        fs.mkdirSync(path.dirname(f), { recursive: true });
        writeFileAtomic(
          f,
          JSON.stringify({ waiting: n, ids, at: new Date().toISOString() }) +
            "\n",
        );
      } catch {
        /* doctor's line is best effort */
      }
      if (n === told) return;
      told = n;
      try {
        if (storeOf) noteRestartsWaiting(storeOf(), n);
      } catch {
        /* the bell is best effort */
      }
    },
  });
  queue = q;
  return q;
}
