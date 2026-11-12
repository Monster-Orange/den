/**
 * D55: a run (a service's or a workspace's up, down, restart) is a job on
 * the server, not a property of the page that started it.
 *
 * The run endpoints stream over SSE, and the first cut tied the work to the
 * stream: a closed stream (the tab closed, a reload, another page) killed
 * the command. A workspace restart cut off between its down and its up left
 * the services down. Now:
 *
 *   - the route starts a job and attaches its own stream to it; the job's
 *     first event is `{ type: "job", id }`;
 *   - a stream that closes only detaches. The job runs to its `done`;
 *   - Stop is its own request (`cancel`), which runs the route's stop
 *     hooks (kill the running command) and ends the job with a `done`
 *     that says it was stopped;
 *   - a page that comes back lists the jobs and attaches again: the events
 *     so far, then the rest live, or the whole run when it ended.
 *
 * As release-deploy-session.ts does for a deploy. The buffer and the
 * finished jobs kept are capped; a running job is never dropped.
 */
import type { ServerResponse } from "http";

export interface ExecJobInfo {
  id: string;
  /** The route that started it ("/api/workspace/exec"). */
  path: string;
  /** Its query, so a page can label it as it labels a live run. */
  params: Record<string, string>;
  status: "running" | "done";
  exitCode: number | null;
  stopped: boolean;
  startedAt: number;
  endedAt: number | null;
}

type Event = Record<string, unknown>;

interface Job extends ExecJobInfo {
  events: Event[];
  subs: Set<ServerResponse>;
  stopHooks: Array<() => void>;
  unwatchedHooks: Array<() => void>;
}

/** Events kept per job for a page that attaches late. */
export const MAX_JOB_EVENTS = 5000;
/** Finished jobs kept, newest first, for a page that comes back. */
export const MAX_FINISHED_JOBS = 20;
/**
 * How long a started service's log tail outlives the last page watching
 * it: a reload attaches again within it and keeps the live log.
 */
export const TAIL_GRACE_MS = 15_000;
/** The exit code of a job someone stopped (as a shell's for SIGINT). */
export const STOPPED_EXIT = 130;

const jobs = new Map<string, Job>();
let seq = 0;

function newId(): string {
  seq += 1;
  return `run_${Date.now().toString(36)}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function info(j: Job): ExecJobInfo {
  return {
    id: j.id,
    path: j.path,
    params: j.params,
    status: j.status,
    exitCode: j.exitCode,
    stopped: j.stopped,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
  };
}

function frame(ev: Event): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

function send(res: ServerResponse, ev: Event): void {
  try {
    if (!res.writableEnded && !res.destroyed) res.write(frame(ev));
  } catch {
    /* a dead stream detaches on its close */
  }
}

function prune(): void {
  const done = [...jobs.values()]
    .filter((j) => j.status === "done")
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const j of done.slice(MAX_FINISHED_JOBS)) jobs.delete(j.id);
}

/** The SSE response headers every run stream sends. */
export function sseHead(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/** What a route holds while it runs: in place of its `res`. */
export interface ExecJob {
  readonly id: string;
  /** One event to every stream attached, and to the replay buffer. */
  write(ev: Event): void;
  /** The run is over: streams end; later writes are dropped. */
  end(): void;
  /** True once the job ended (done or stopped). */
  readonly ended: boolean;
  /** Runs `fn` when someone stops the job (never on a stream closing). */
  onStop(fn: () => void): void;
  /** Streams attached now. */
  watchers(): number;
  /**
   * Runs `fn` each time the last stream detaches. For what only matters
   * while someone watches: a started service's log tail.
   */
  onUnwatched(fn: () => void): void;
}

/**
 * Start a job for a run route and attach `res` (its headers already sent)
 * to it. `params` is the route's query.
 */
export function startJob(
  path: string,
  params: URLSearchParams,
  res: ServerResponse,
): ExecJob {
  const j: Job = {
    id: newId(),
    path,
    params: Object.fromEntries(params),
    status: "running",
    exitCode: null,
    stopped: false,
    startedAt: Date.now(),
    endedAt: null,
    events: [],
    subs: new Set(),
    stopHooks: [],
    unwatchedHooks: [],
  };
  jobs.set(j.id, j);
  prune();
  const write = (ev: Event): void => {
    if (j.status === "done") return;
    j.events.push(ev);
    if (j.events.length > MAX_JOB_EVENTS)
      j.events.splice(0, j.events.length - MAX_JOB_EVENTS);
    if (ev.type === "done" && typeof ev.exitCode === "number")
      j.exitCode = ev.exitCode;
    for (const s of j.subs) send(s, ev);
  };
  attachStream(j, res, false);
  write({ type: "job", id: j.id });
  return {
    id: j.id,
    write,
    end: () => endJob(j),
    get ended() {
      return j.status === "done";
    },
    onStop: (fn) => {
      j.stopHooks.push(fn);
    },
    watchers: () => j.subs.size,
    onUnwatched: (fn) => {
      j.unwatchedHooks.push(fn);
    },
  };
}

function endJob(j: Job): void {
  if (j.status === "done") return;
  j.status = "done";
  j.endedAt = Date.now();
  for (const s of j.subs) {
    try {
      s.end();
    } catch {
      /* already closed */
    }
  }
  j.subs.clear();
  prune();
}

function attachStream(j: Job, res: ServerResponse, replay: boolean): void {
  if (replay) for (const ev of j.events) send(res, ev);
  if (j.status === "done") {
    try {
      res.end();
    } catch {
      /* already closed */
    }
    return;
  }
  j.subs.add(res);
  // A stream closing only stops it watching (D55).
  res.on("close", () => {
    if (!j.subs.delete(res) || j.subs.size || j.status === "done") return;
    for (const fn of j.unwatchedHooks) {
      try {
        fn();
      } catch {
        /* a hook that throws must not break the others */
      }
    }
  });
}

/** The jobs kept, newest first. */
export function listJobs(): ExecJobInfo[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(info);
}

export function getJob(id: string): ExecJobInfo | null {
  const j = jobs.get(id);
  return j ? info(j) : null;
}

/**
 * Attach a stream (its headers already sent) to job `id`: the events so
 * far, then the rest live. False when there is no such job.
 */
export function attachJob(id: string, res: ServerResponse): boolean {
  const j = jobs.get(id);
  if (!j) return false;
  attachStream(j, res, true);
  return true;
}

/**
 * Stop job `id`: its stop hooks run (the route kills what it runs), then a
 * line and a `done` with STOPPED_EXIT, and the job ends. "missing" when
 * there is no such job, "ended" when it is already over.
 */
export function stopJob(id: string): "stopped" | "ended" | "missing" {
  const j = jobs.get(id);
  if (!j) return "missing";
  if (j.status === "done") return "ended";
  j.stopped = true;
  for (const fn of j.stopHooks.splice(0)) {
    try {
      fn();
    } catch {
      /* a hook that throws must not keep the job running */
    }
  }
  const ev = (e: Event): void => {
    j.events.push(e);
    for (const s of j.subs) send(s, e);
  };
  ev({ type: "error", text: "Stopped" });
  ev({
    type: "done",
    exitCode: STOPPED_EXIT,
    stopped: true,
    duration: Date.now() - j.startedAt,
  });
  j.exitCode = STOPPED_EXIT;
  endJob(j);
  return "stopped";
}

/** Tests only: forget every job. */
export function resetJobsForTests(): void {
  jobs.clear();
}
