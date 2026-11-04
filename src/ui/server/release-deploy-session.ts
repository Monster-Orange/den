/**
 * Deploy session manager for the Release tab.
 *
 * A deploy is a long-running, server-side thing (dispatch → gate → monitor) that
 * MUST outlive any single browser page. Den's tabs are separate full-page
 * navigations, so if the deploy were tied to the SSE request (as the first cut
 * was), navigating away from Release would both lose the log AND abort den's
 * monitoring of a real, already-dispatched deploy.
 *
 * This decouples them: `start()` runs the deploy in the background against an
 * in-memory replay buffer; browser clients `attach()` to REPLAY the log so far
 * and then stream live events. Re-attaching after a reload restores the full
 * log. The deploy runs to completion regardless of who is (or isn't) attached;
 * only an explicit `dismiss()` (the user closing the log) stops it.
 *
 * Sessions run CONCURRENTLY. Deploys of different systems are independent —
 * they dispatch to different repos and GitHub scopes its own `concurrency:`
 * group per repo-and-environment — so a global lock only stopped the operator
 * from doing things that were never in conflict. The one real collision is
 * dispatching the SAME repo to the SAME environment twice while the first is
 * still in flight, which `conflicts()` rejects.
 */

import {
  releaseService,
  type DeployPlanEntry,
  type ReleaseEvent,
} from "./release-service.js";
import {
  recordInvocation,
  recordFailure,
} from "../../shared/dev-metrics/emit.js";

/** Public (serializable) view of a session — no subscribers/internal flags. */
export interface DeploySessionInfo {
  id: string;
  label: string;
  env: string;
  mode: string;
  status: "running" | "done";
  ok: boolean | null;
  startedAt: number;
  endedAt: number | null;
  /** Repos this session deploys — lets the UI disable just their buttons. */
  repos: string[];
}

type Subscriber = (ev: ReleaseEvent) => void;

interface Session extends DeploySessionInfo {
  events: ReleaseEvent[];
  subs: Set<Subscriber>;
  dismissed: boolean;
}

// A deploy log is modest (dispatch/gate/monitor lines); cap the replay buffer so
// a pathologically long-running deploy can't grow it without bound.
const MAX_EVENTS = 5000;

// Finished sessions are retained so a reload can restore their log. Cap how
// many, so a long session of many deploys can't grow the map without bound.
const MAX_FINISHED_SESSIONS = 20;

function newId(): string {
  return `dep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

class DeploySessionManager {
  private sessions = new Map<string, Session>();

  private info(s: Session): DeploySessionInfo {
    const { events: _e, subs: _s, dismissed: _d, ...info } = s;
    void _e;
    void _s;
    void _d;
    return info;
  }

  /** All restorable sessions (running or finished), newest first. */
  active(): DeploySessionInfo[] {
    return [...this.sessions.values()]
      .filter((s) => !s.dismissed)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((s) => this.info(s));
  }

  /** True while ANY deploy is live. Kept for callers that just need a flag. */
  busy(): boolean {
    return [...this.sessions.values()].some(
      (s) => !s.dismissed && s.status === "running",
    );
  }

  /**
   * Repos in `plan` that already have a live deploy to `env` — dispatching the
   * same repo+env twice would race two runs against one GitHub concurrency
   * group. Different repos, or the same repo to a different env, do not
   * conflict. Empty array means the deploy is safe to start.
   */
  conflicts(env: string, plan: DeployPlanEntry[]): string[] {
    const live = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.dismissed || s.status !== "running" || s.env !== env) continue;
      for (const r of s.repos) live.add(r);
    }
    return plan.map((p) => p.repo).filter((r) => live.has(r));
  }

  /**
   * Start a deploy in the background. `notices` are emitted into the log before
   * the deploy begins (e.g. the header line and a hotfix warning). Callers
   * should check `conflicts()` first — this does not re-check.
   */
  start(opts: {
    env: string;
    mode: string;
    label: string;
    plan: DeployPlanEntry[];
    notices?: ReleaseEvent[];
  }): DeploySessionInfo {
    const session: Session = {
      id: newId(),
      label: opts.label,
      env: opts.env,
      mode: opts.mode,
      status: "running",
      ok: null,
      startedAt: Date.now(),
      endedAt: null,
      repos: opts.plan.map((p) => p.repo),
      events: [],
      subs: new Set(),
      dismissed: false,
    };
    this.sessions.set(session.id, session);
    this.prune();

    const emit = (ev: ReleaseEvent): void => {
      session.events.push(ev);
      if (session.events.length > MAX_EVENTS) {
        session.events.splice(0, session.events.length - MAX_EVENTS);
      }
      for (const sub of session.subs) {
        try {
          sub(ev);
        } catch {
          /* a dead subscriber must not break the fan-out */
        }
      }
    };

    for (const n of opts.notices ?? []) emit(n);

    const startedAt = session.startedAt;
    // Decoupled from any client. aborted() fires only when the user dismisses
    // the log, giving an escape hatch for a stuck monitor; navigation does not.
    void releaseService
      .deploy(opts.env, opts.plan, emit, () => session.dismissed)
      .then((ok) => {
        session.ok = ok;
        recordInvocation({
          command: "release.deploy",
          surface: "ux",
          durationMs: Date.now() - startedAt,
          exit: ok ? 0 : 1,
          extra: { mode: opts.mode, env: opts.env, repos: opts.plan.length },
        });
      })
      .catch((e) => {
        session.ok = false;
        recordFailure({
          command: "release.deploy",
          surface: "ux",
          reason:
            (e as { constructor?: { name?: string } })?.constructor?.name ??
            "Error",
        });
        emit({
          type: "log",
          level: "error",
          text: `Deploy error: ${(e as Error).message}`,
        });
        emit({ type: "done", ok: false, summary: "Deploy error." });
      })
      .finally(() => {
        session.status = "done";
        session.endedAt = Date.now();
        // Dismissed mid-run: nothing can attach to it now, so drop it once the
        // deploy loop has actually exited.
        if (session.dismissed) this.sessions.delete(session.id);
      });

    return this.info(session);
  }

  /**
   * Bound the map. Finished sessions are kept so a reload can still restore the
   * log, but not forever — drop the oldest finished ones past the cap. Running
   * sessions are never pruned.
   */
  private prune(): void {
    const finished = [...this.sessions.values()]
      .filter((s) => s.status === "done")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    const excess = finished.length - MAX_FINISHED_SESSIONS;
    for (let i = 0; i < excess; i++) this.sessions.delete(finished[i].id);
  }

  /**
   * Attach a subscriber to session `id`: replays every buffered event (the full
   * log, terminal `done` included when finished) then streams live ones.
   * Returns an unsubscribe fn, or null if the session is gone/dismissed.
   */
  attach(id: string, sub: Subscriber): (() => void) | null {
    const s = this.sessions.get(id);
    if (!s || s.dismissed) return null;
    for (const ev of s.events) {
      try {
        sub(ev);
      } catch {
        /* ignore */
      }
    }
    s.subs.add(sub);
    return () => {
      s.subs.delete(sub);
    };
  }

  /**
   * Dismiss (close) session `id`: signals the deploy to stop monitoring and
   * removes it from restore. A finished session's slot is freed immediately; a
   * running one frees once its loop exits.
   */
  dismiss(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.dismissed = true;
    // A finished session can go now; a running one is dropped by its own
    // .finally() once the deploy loop notices the dismissal and exits.
    if (s.status === "done") this.sessions.delete(id);
    return true;
  }
}

export const deploySessions = new DeploySessionManager();
