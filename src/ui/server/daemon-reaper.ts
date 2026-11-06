/**
 * Daemon-registry recovery sweep (Web-UI server startup).
 *
 * After a den restart, previously registered daemons are reloaded from
 * disk and health-checked. Entries whose service is explicitly unhealthy
 * (was stopped outside of den) are removed so the shutdown prompt
 * doesn't list them.
 *
 * Removal requires STRONG evidence (review finding 11): a single
 * transient timeout/5xx must never unregister a possibly-running daemon,
 * so an "error" health result is only acted on after a SECOND
 * consecutive "error" check separated by a retry delay. "unknown"
 * results and thrown checks always keep the entry (err on the side of
 * keeping). A daemon this root registered whose address no longer resolves
 * to any workspace/catalog service is process-death-equivalent evidence and
 * is removed directly. Records another root registered (all roots of a
 * product share the file) are never touched, and an unstamped legacy record
 * is not removed for being unresolvable. A record whose checkout is gone, or
 * whose service moved to another checkout with nothing of it running
 * (`staleReason`), is removed whatever the address's health says.
 */

import type { ServiceHealthResult } from "../../shared/environment-manager/health.js";
import type { DaemonRecord } from "../../shared/environment-manager/service-runner.js";
import type { ResolvedService } from "../../shared/types/index.js";

export interface DaemonReaperDeps {
  listDaemons: () => DaemonRecord[];
  /**
   * Resolve an address, optionally against a named workspace. Omitting the
   * workspace resolves against the focused one only, which is not enough with
   * several workspaces active — see `resolveForDaemon`.
   */
  resolveService: (
    address: string,
    workspace?: string,
  ) => ResolvedService | null;
  /** Names of the currently active workspaces — see `resolveForDaemon`. */
  getActiveWorkspaces: () => string[];
  checkServiceHealth: (
    service: ResolvedService,
  ) => Promise<ServiceHealthResult>;
  unregisterDaemon: (address: string) => void;
  /** Injectable sleep between the two confirmation checks. */
  delay: (ms: number) => Promise<void>;
  /** Gap between the first "error" result and the confirming re-check. */
  retryDelayMs: number;
  /**
   * Which root wrote the record (`daemonRootOf`). Every root of a product
   * shares one daemons file: another root's records are never swept here,
   * and an unstamped (pre-0.2.7) one is not dropped for being unresolvable.
   */
  rootOf: (daemon: DaemonRecord) => "here" | "other" | "unstamped";
  /**
   * Why a record describes nothing that can be running whatever its health
   * (service-runner's daemonStaleReason: its checkout is gone, or the
   * service moved to another checkout and none of its containers run), or
   * null. Injected; omitted, no record is dropped for it. `running` is the
   * container listing, taken once per sweep by `runningContainers`.
   */
  staleReason?: (
    daemon: DaemonRecord,
    running: Set<string> | null,
  ) => string | null;
  /** The running container base names (null: unverifiable), once a sweep. */
  runningContainers?: () => Promise<Set<string> | null>;
}

export interface DaemonReapResult {
  /** Addresses removed from the registry. */
  removed: string[];
  /** Addresses kept (healthy, unknown, transient failure, or check threw). */
  kept: string[];
}

/**
 * Resolve a daemon's service, trying the focus, then each workspace that owns
 * it, then every other active workspace, before concluding the service is gone.
 * The focused workspace alone would drop every daemon belonging to another
 * active workspace the moment focus moves — and its containers keep running, so
 * the record is exactly what's needed to stop them.
 *
 * The active set is the last resort because a legacy record carries no owners
 * at all: without it, a running service defined only in a non-focused active
 * workspace looks unresolvable and gets reaped. This mirrors
 * `canResolveDaemonAddress`, which `pruneDeadDaemons` uses for the same call.
 */
function resolveForDaemon(
  deps: DaemonReaperDeps,
  daemon: DaemonRecord,
): ResolvedService | null {
  const direct = deps.resolveService(daemon.address);
  if (direct) return direct;
  const candidates = [
    ...new Set([...(daemon.workspaces ?? []), ...deps.getActiveWorkspaces()]),
  ];
  for (const workspace of candidates) {
    const owned = deps.resolveService(daemon.address, workspace);
    if (owned) return owned;
  }
  return null;
}

/**
 * Sweep the daemon registry once. Unregisters an entry only when its
 * service is gone from every owning workspace/catalog, or when TWO
 * consecutive health checks report "error".
 */
export async function reapDeadDaemons(
  deps: DaemonReaperDeps,
): Promise<DaemonReapResult> {
  const removed: string[] = [];
  const kept: string[] = [];
  const running = deps.staleReason
    ? await (deps.runningContainers?.() ?? Promise.resolve(null)).catch(
        () => null,
      )
    : null;

  await Promise.allSettled(
    deps.listDaemons().map(async (daemon) => {
      try {
        const root = deps.rootOf(daemon);
        if (root === "other") {
          kept.push(daemon.address);
          return;
        }
        // Its checkout is gone, or the service has moved and nothing of
        // the record's runs: whatever the address's health says (it is
        // another checkout's), the record is stale.
        if (deps.staleReason?.(daemon, running)) {
          deps.unregisterDaemon(daemon.address);
          removed.push(daemon.address);
          return;
        }
        const service = resolveForDaemon(deps, daemon);
        if (!service) {
          // No longer in any owning workspace/catalog — nothing could restart
          // it. An unstamped record may be another root's, so it stays.
          if (root === "unstamped") {
            kept.push(daemon.address);
            return;
          }
          deps.unregisterDaemon(daemon.address);
          removed.push(daemon.address);
          return;
        }

        const first = await deps.checkServiceHealth(service);
        if (first.health !== "error") {
          // "ok" and "unknown" both keep the entry.
          kept.push(daemon.address);
          return;
        }

        // One "error" may be a transient timeout/5xx — confirm before
        // unregistering a possibly-running daemon.
        await deps.delay(deps.retryDelayMs);
        const second = await deps.checkServiceHealth(service);
        if (second.health === "error") {
          deps.unregisterDaemon(daemon.address);
          removed.push(daemon.address);
        } else {
          kept.push(daemon.address);
        }
      } catch {
        // Err on the side of keeping the entry rather than wrongly
        // removing it.
        kept.push(daemon.address);
      }
    }),
  );

  return { removed, kept };
}
