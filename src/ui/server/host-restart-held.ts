/**
 * Issue 731: the held write host_restart, "Restart the terminal
 * host when agents are idle". Doctor's fix when Den's own refresh of the
 * terminal host failed, or none is known (a host that outlived a server
 * restart). Never `sessions host --stop`, which stops every agent at once.
 *
 * On the person's one Allow it runs the refresh the web server's start
 * runs (agent-routes.ts refreshTerminalHost: refreshSessionHost's wait for
 * agents mid-turn, up to sessions.host_restart_wait_seconds, the restart,
 * the resumes, the `terminal-host` audit row and the bell). The wait can
 * take minutes, so the Allow answers at once and the refresh goes on; the
 * activity trail and doctor say how it ended.
 */
import { line, reviewLines } from "../../shared/review-lines.js";
import type { RefreshResult } from "../../shared/sessions/host-refresh.js";
import { HOST_RESTART_TITLE } from "../../shared/sessions/host-refresh-state.js";
import { isPersonal } from "../../shared/agents/sandbox-rollout.js";
import type { HeldOp } from "./held-actions.js";

export interface HostRestartOpDeps {
  /** A refresh runs now (the web start's, or an earlier Allow's). */
  refreshing: () => boolean;
  /** sessions.host_restart_wait_seconds. */
  waitSeconds: () => number;
  /** Starts the refresh; resolves when it ends (null: one already ran). */
  start: () => Promise<RefreshResult | null>;
  log?: (line: string) => void;
  /** Issue 1403: the install is personal. Unknown: strict. */
  personal?: () => boolean;
  /** Issue 1403: an agent is mid-turn now (a restart could cut it). */
  turnsRunning?: () => Promise<boolean>;
}

/**
 * Issue 1403 (Den Builder): on a personal install an agent's ask is
 * routine while no agent turn is running. A turn it could cut (the
 * person's own agents' work counts), turns that can't be read, or a
 * strict install keep it the person's.
 */
async function hostRestartPersonOnly(d: HostRestartOpDeps): Promise<boolean> {
  if (!isPersonal(d.personal) || !d.turnsRunning) return true;
  try {
    return await d.turnsRunning();
  } catch {
    return true;
  }
}

export function hostRestartOp(d: HostRestartOpDeps): HeldOp {
  return {
    async check() {
      if (d.refreshing())
        return {
          ok: false,
          error:
            "Den is already restarting the terminal host when agents are idle: doctor's terminal host row says since when",
        };
      const min = String(Math.max(1, Math.ceil(d.waitSeconds() / 60)));
      return {
        ok: true,
        // It can cut an agent's turn when the wait runs out: the person's.
        ...((await hostRestartPersonOnly(d))
          ? { personOnly: true as const }
          : {}),
        args: {},
        summary: HOST_RESTART_TITLE.replace(/^R/, "r"),
        params: { min },
        ...reviewLines([
          line(
            `Waits until no agent is mid-turn (at most ${min} min), then restarts the terminal host on the installed Den.`,
            "ap.det.host_restart.wait",
            { min },
          ),
          line(
            "The agents it ran resume where they were; open terminals end. The activity trail says how it went.",
            "ap.det.host_restart.resume",
          ),
        ]),
      };
    },
    run() {
      if (d.refreshing())
        return Promise.resolve({
          ok: true,
          already: true,
          note: "Den is already restarting the terminal host when agents are idle",
        });
      // The wait can be minutes: the Allow answers now.
      d.start().catch((e: unknown) =>
        d.log?.(`  ⚠ terminal host restart: ${(e as Error).message}`),
      );
      return Promise.resolve({
        ok: true,
        started: true,
        note: "Den restarts the terminal host once no agent is mid-turn; the activity trail (terminal-host) and doctor say how it went",
      });
    },
  };
}
