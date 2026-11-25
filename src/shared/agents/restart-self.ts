/**
 * Agent_restart_self, an agent's ask to be restarted, as a
 * held write rather than a free-text question. Being structured, the bell
 * groups two or more of them into one "Restart N agents when idle" card
 * with one Allow (held-bell.ts).
 *
 * An agent asks for itself only (its token says who it is). A person, or
 * Den itself (after an update changes Den's own tools), names the agent.
 * On Allow the agent restarts at its next idle moment, on the same
 * conversation (agent-ops restartAgent, after-turn): never mid-turn.
 *
 * It is routine (approval-policy.ts): a restart keeps the conversation and
 * widens nothing. It asks by default, so a strict install sees the card; a
 * personal install runs it at once.
 */
import { line, reviewLines, type DetailKey } from "../review-lines.js";
import { plainText } from "./sandbox-set.js";

export const AGENT_RESTART_SELF_ACTION = "agent_restart_self";
export const RESTART_REASONS = ["tools", "update", "other"] as const;
export type RestartReason = (typeof RESTART_REASONS)[number];
/** The longest `why` an "other" ask may give (one line). */
export const RESTART_WHY_MAX = 300;

export interface RestartSelfArgs {
  agent: string;
  project: string;
  reason: RestartReason;
  why?: string;
}

export interface RestartSelfAgent {
  id: string;
  workspace: string;
  displayName?: string;
  stoppedAt?: string;
}

export interface RestartSelfDeps {
  /** The agent's record; throws when there is none. */
  record: (id: string) => RestartSelfAgent;
  /** Restarts the agent at its next idle, same conversation. */
  restart: (id: string, project: string) => Promise<unknown>;
}

export type RestartSelfCheck =
  | {
      ok: true;
      personOnly?: boolean;
      summary: string;
      params: Record<string, string>;
      details: string[];
      detailKeys: DetailKey[];
      args: RestartSelfArgs;
    }
  | { ok: false; error: string };

const isReason = (v: unknown): v is RestartReason =>
  typeof v === "string" && (RESTART_REASONS as readonly string[]).includes(v);

export function checkAgentRestartSelf(
  d: RestartSelfDeps,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): RestartSelfCheck {
  const no = (error: string): RestartSelfCheck => ({ ok: false, error });
  try {
    const named = typeof raw.agent === "string" ? raw.agent.trim() : "";
    if (who.agent && named && named !== who.agent)
      return no(
        "an agent asks to be restarted only for itself: leave agent out",
      );
    const id = who.agent ?? named;
    if (!id) return no("agent is required (the agent's id)");
    const reason = raw.reason ?? "tools";
    if (!isReason(reason))
      return no(
        `reason is "tools", "update" or "other" (got ${JSON.stringify(reason)})`,
      );
    let why: string | undefined;
    if (raw.why !== undefined && raw.why !== null) {
      if (typeof raw.why !== "string") return no("why must be text");
      why = plainText(raw.why) || undefined;
      if (why && why.length > RESTART_WHY_MAX)
        return no(
          `why must be ${RESTART_WHY_MAX} characters or fewer (got ${why.length})`,
        );
    }
    if (reason === "other" && !why)
      return no('why is required when reason is "other": one line on why');
    const rec = d.record(id);
    if (who.project && rec.workspace !== who.project)
      return no(`${id} isn't in project ${who.project}`);
    if (rec.stoppedAt)
      return no(`${id} isn't running: start it from the Agents page`);
    const shown = rec.displayName ?? id;
    const lines = [
      line(
        `Restarts ${shown} at its next idle moment, on the same conversation. It never cuts a turn.`,
        "ap.det.agent_restart_self.when",
        { agent: shown },
      ),
      reason === "tools"
        ? line(
            "Why: to load new tools from its MCP servers.",
            "ap.det.agent_restart_self.tools",
          )
        : reason === "update"
          ? line(
              "Why: to run on the updated Den and its tools.",
              "ap.det.agent_restart_self.update",
            )
          : line(`Why: ${why}`, "ap.det.agent_restart_self.why", {
              why: why ?? "",
            }),
    ];
    const r = reviewLines(lines);
    return {
      ok: true,
      summary: `restart ${shown} when idle`,
      params: { agent: shown, reason },
      details: r.details,
      detailKeys: r.detailKeys,
      args: {
        agent: id,
        project: rec.workspace,
        reason,
        ...(why ? { why } : {}),
      },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/**
 * On Allow: checks again, then asks for the restart after the agent's turn
 * (not waited for: the turn may be the one that asked).
 */
export async function runAgentRestartSelf(
  d: RestartSelfDeps,
  raw: Record<string, unknown>,
): Promise<
  { ok: true; agent: string; project: string } | { ok: false; error: string }
> {
  const c = checkAgentRestartSelf(d, raw);
  if (!c.ok) return c;
  const { agent, project } = c.args;
  void d.restart(agent, project).catch(() => undefined);
  return Promise.resolve({ ok: true, agent, project });
}
