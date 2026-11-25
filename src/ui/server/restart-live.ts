/**
 * The live status of a bulk restart ("Restart N agents
 * at their next idle"), per agent. Each starts in its plan's state (now,
 * turn, job, unknown) and moves as its restart ends: restarted (shown a
 * moment, then gone, so the status clears), or waiting on the person with
 * why (a job found when the turn ended, a wait that ran out, a failure).
 * Those also reach the bell, one row per agent, which goes once the agent
 * is restarted. In memory: a server restart ends the runs anyway.
 */
import type { NoteMsg, NotificationStore } from "../../shared/notifications.js";
import { jobCommandOf } from "../../shared/process/jobs.js";
import { redactSecrets } from "../../shared/redact.js";
import {
  restartMany,
  type AgentsResolved,
  type RestartOutcome,
  type RestartPlan,
  type RestartState,
} from "../cli/agent-ops.js";

export type LiveState = RestartState | "restarted" | "timedOut" | "failed";

export interface LiveRow {
  id: string;
  workspace: string;
  state: LiveState;
  job?: { command: string; minutes: number };
  /** timedOut: the minutes it waited. */
  minutes?: number;
  error?: string;
  /** When it last changed (ms). */
  at: number;
}

/** How long a restarted row stays before it clears (ms). */
export const KEEP_DONE_MS = 10_000;

/** The bell row's subject for agent `id` in `ws`. */
export function restartBellSubject(ws: string, id: string): string {
  return `record:restart-wait:${ws}/${id}`;
}

const key = (ws: string, id: string) => `${ws}\u0000${id}`;

/** The longest a failure's text is shown. */
export const ERROR_SHOWN_MAX = 200;

/**
 * A failure's text as a page and the bell may show it: secrets redacted,
 * its first line only, no control characters, at most ERROR_SHOWN_MAX.
 */
export function errorShown(text: string): string {
  const first =
    redactSecrets(String(text))
      .split(/\r?\n/)
      .find((l) => l.trim()) ?? "";
  const one = first
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > ERROR_SHOWN_MAX
    ? `${one.slice(0, ERROR_SHOWN_MAX - 1)}…`
    : one;
}

/** A job as shown: its command through jobCommandOf (redacted, short). */
const jobShown = (j: { command: string; minutes: number }) => ({
  command: jobCommandOf(String(j.command ?? "")),
  minutes: Number(j.minutes) || 0,
});

export class RestartLive {
  private readonly rows = new Map<string, LiveRow>();
  private readonly keepDoneMs: number;
  private readonly now: () => number;
  private readonly store: Pick<NotificationStore, "add" | "remove"> | null;

  constructor(
    o: {
      keepDoneMs?: number;
      now?: () => number;
      store?: Pick<NotificationStore, "add" | "remove"> | null;
    } = {},
  ) {
    this.keepDoneMs = o.keepDoneMs ?? KEEP_DONE_MS;
    this.now = o.now ?? Date.now;
    this.store = o.store ?? null;
  }

  /** A new run: each agent of `plan` in its state (replacing an older row). */
  begin(plan: readonly RestartPlan[]): void {
    for (const p of plan)
      this.rows.set(key(p.workspace, p.id), {
        id: p.id,
        workspace: p.workspace,
        state: p.state,
        ...(p.job ? { job: jobShown(p.job) } : {}),
        at: this.now(),
      });
  }

  /** How one agent's restart ended (restartMany's onDone, or Restart now). */
  done(o: RestartOutcome): void {
    const k = key(o.workspace, o.id);
    if (!this.rows.has(k)) return;
    const row: LiveRow = {
      id: o.id,
      workspace: o.workspace,
      state: o.outcome,
      ...(o.job ? { job: jobShown(o.job) } : {}),
      ...(o.minutes !== undefined ? { minutes: o.minutes } : {}),
      ...(o.error ? { error: errorShown(o.error) } : {}),
      at: this.now(),
    };
    this.rows.set(k, row);
    this.bell(row);
  }

  /** The rows now, oldest run first; restarted ones clear after a moment. */
  list(): LiveRow[] {
    const t = this.now();
    for (const [k, r] of this.rows)
      if (r.state === "restarted" && t - r.at > this.keepDoneMs)
        this.rows.delete(k);
    return [...this.rows.values()].map((r) => ({
      ...r,
      ...(r.job ? { job: { ...r.job } } : {}),
    }));
  }

  private bell(r: LiveRow): void {
    if (!this.store) return;
    const subject = restartBellSubject(r.workspace, r.id);
    try {
      if (r.state === "restarted") {
        this.store.remove((n) => n.subject === subject);
        return;
      }
      const say: { text: string; msg: NoteMsg } | null =
        r.state === "timedOut"
          ? {
              text: `${r.id} was not restarted: still working after ${r.minutes ?? 0} min`,
              msg: {
                key: "bell.m.rsTimedOut",
                vars: { id: r.id, min: r.minutes ?? 0 },
              },
            }
          : r.state === "job"
            ? {
                text: `${r.id} was not restarted: a background job is running (${r.job?.command ?? ""}, ${r.job?.minutes ?? 0} min)`,
                msg: {
                  key: "bell.m.rsJob",
                  vars: {
                    id: r.id,
                    cmd: r.job?.command ?? "",
                    min: r.job?.minutes ?? 0,
                  },
                },
              }
            : r.state === "failed"
              ? {
                  text: `${r.id} was not restarted`,
                  msg: { key: "bell.m.rsFailed", vars: { id: r.id } },
                }
              : null;
      if (!say) return;
      this.store.add({
        kind: "service",
        subject,
        scope: "workspace/den-server",
        link: "/agents",
        ...say,
      });
    } catch {
      /* the bell is best effort: the audit has it */
    }
  }
}

/** This server's live restart status (one per server; its bell rows). */
let SHARED: RestartLive | null = null;
export async function restartLive(): Promise<RestartLive> {
  if (SHARED) return SHARED;
  let store: Pick<NotificationStore, "add" | "remove"> | null = null;
  try {
    store = (await import("./notification-service.js")).notificationDeps()
      .store;
  } catch {
    /* no bell here: the page still has it */
  }
  SHARED ??= new RestartLive({ store });
  return SHARED;
}

/**
 * restartMany, followed live: each agent's plan goes into the live status,
 * and each outcome after it (one that comes before the plan is in, held
 * until it is). `o.onDone` hears each too (the audit). The
 * bell's grouped Allow restarts this way, as restart-stale does.
 */
export async function restartFollowed(
  d: AgentsResolved,
  agents: readonly { id: string; workspace: string }[],
  o: Parameters<typeof restartMany>[2] = {},
  live?: RestartLive,
): Promise<RestartPlan[]> {
  const l = live ?? (await restartLive());
  const early: RestartOutcome[] = [];
  let begun = false;
  const plan = await restartMany(d, agents, {
    ...o,
    onDone: (x) => {
      if (begun) l.done(x);
      else early.push(x);
      o?.onDone?.(x);
    },
  });
  l.begin(plan);
  begun = true;
  for (const x of early.splice(0)) l.done(x);
  return plan;
}
