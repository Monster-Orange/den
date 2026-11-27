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
import type { HeldOpCheck } from "../cli/agent-ops.js";
import type { HeldOp } from "./held-actions.js";

export interface HostRestartOpDeps {
  /** A refresh runs now (the web start's, or an earlier Allow's). */
  refreshing: () => boolean;
  /** sessions.host_restart_wait_seconds. */
  waitSeconds: () => number;
  /**
   * Starts the refresh; resolves when it ends (null: one already ran).
   * idleOnly (issue 1403): restart only with no agent mid-turn, else held.
   */
  start: (o?: { idleOnly: true }) => Promise<RefreshResult | null>;
  log?: (line: string) => void;
  /** Issue 1403: the install is personal. Unknown: strict. */
  personal?: () => boolean;
  /** Issue 1403: an agent is mid-turn now (a restart could cut it). */
  turnsRunning?: () => Promise<boolean>;
  /**
   * Issue 1403: hold a host_restart for the person's Allow (pending in the
   * bell, `card` its check), for `agent`, the agent that asked.
   */
  hold?: (card: HeldOpCheck<object>, agent?: string) => void;
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
  const op: HeldOp = {
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
    async run(_a, asked) {
      if (d.refreshing())
        return {
          ok: true,
          already: true,
          note: "Den is already restarting the terminal host when agents are idle",
        };
      // Issue 1403 (Den Builder): routine only because no turn ran at the
      // ask. Look again now; a turn started since holds it for the person.
      const routine = !!asked?.decidedBy?.startsWith("auto:");
      const holdIt = async (): Promise<boolean> => {
        const c = await op.check({});
        if (!c.ok || !d.hold) return false;
        d.hold({ ...c, personOnly: true }, asked?.agent);
        return true;
      };
      if (routine && (await hostRestartPersonOnly(d))) {
        const held = await holdIt();
        return {
          ok: true,
          held,
          note: "An agent turn started since the ask: Den didn't restart the terminal host. It waits for the person's Allow in the bell.",
        };
      }
      // The wait can be minutes: the Allow answers now.
      (routine ? d.start({ idleOnly: true }) : d.start())
        .then(async (r) => {
          if (r?.did === "held") await holdIt();
        })
        .catch((e: unknown) =>
          d.log?.(`  ⚠ terminal host restart: ${(e as Error).message}`),
        );
      return {
        ok: true,
        started: true,
        note: routine
          ? "Den restarts the terminal host now if no agent is mid-turn; a turn running then holds it for the person's Allow"
          : "Den restarts the terminal host once no agent is mid-turn; the activity trail (terminal-host) and doctor say how it went",
      };
    },
  };
  return op;
}
