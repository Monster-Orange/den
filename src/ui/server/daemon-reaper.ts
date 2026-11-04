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
 * keeping). A daemon whose address no longer resolves to any
 * workspace/catalog service is process-death-equivalent evidence and is
 * removed directly.
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

  await Promise.allSettled(
    deps.listDaemons().map(async (daemon) => {
      try {
        const service = resolveForDaemon(deps, daemon);
        if (!service) {
          // No longer in any owning workspace/catalog — nothing could restart it.
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
