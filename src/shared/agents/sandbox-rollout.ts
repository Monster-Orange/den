/**
 * Issue 936, the rollout. The agent sandbox is on for agents started after
 * the update. An agent that existed before it (its record has no sandbox
 * yet, or says it is from before) keeps starting outside it until the
 * person turns it on: `agents.sandbox: on` in user.yml, which Den asks for
 * once as a held write (den_sandbox_on) and doctor names. A setting the
 * person made, for all agents or for one, always decides.
 */

import { type DetailKey, line, reviewLines } from "../review-lines.js";

/** Why an agent from before the sandbox starts outside it. */
export const LEGACY_SANDBOX_REASON =
  "it started before the agent sandbox; Allow Turn on in the bell, or set agents.sandbox: on in config/local/user.yml";

/** The held write Den asks for, and who asks (Den itself). */
export const SANDBOX_ON_ACTION = "den_sandbox_on";
export const SANDBOX_ON_ACTOR = "den:sandbox";

/** What a record says of its sandbox (records.ts). */
interface WithSandbox {
  id: string;
  sandbox?: { applied: boolean; legacy?: boolean };
}

/** The setting as den-config resolves it: undefined where none was set. */
interface SandboxSettings {
  sandbox?: boolean;
  agents?: Record<string, { sandbox?: boolean } | undefined>;
}

/** Whether a record is from before the sandbox (no sandbox recorded yet). */
export function isFromBefore(rec: WithSandbox): boolean {
  return rec.sandbox === undefined || rec.sandbox.legacy === true;
}

/** Whether the person set the sandbox, for all agents or for this one. */
export function sandboxSetByPerson(
  cfg: SandboxSettings,
  agentId: string,
): boolean {
  return (
    cfg.sandbox !== undefined || cfg.agents?.[agentId]?.sandbox !== undefined
  );
}

/** The agents that start outside it as from before, by id. */
export function legacyAgentIds(
  recs: readonly WithSandbox[],
  cfg: SandboxSettings,
): string[] {
  return recs
    .filter((r) => isFromBefore(r) && !sandboxSetByPerson(cfg, r.id))
    .map((r) => r.id);
}

/** Issue 1403: whether `personal` says so; a throw or none is strict. */
export function isPersonal(personal?: () => boolean): boolean {
  try {
    return personal?.() === true;
  } catch {
    return false;
  }
}

/** "1 agent" / "2 agents". */
export function agentsCount(n: number): string {
  return `${n} agent${n === 1 ? "" : "s"}`;
}

export type SandboxOnCheck =
  | {
      ok: true;
      args: Record<string, never>;
      summary: string;
      params: { count: string };
      details: string[];
      detailKeys: DetailKey[];
      /** Not on a personal install, where it is routine (issue 1403). */
      personOnly?: true;
    }
  | { ok: false; error: string };

export interface SandboxOnOp {
  check(args: Record<string, unknown>): SandboxOnCheck;
  run(args: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

/**
 * den_sandbox_on: sets agents.sandbox: on in user.yml. It only narrows
 * what agents may do; still the person's call on a strict install, since
 * it changes how each of those agents starts. On a personal one an
 * agent's ask is routine, the person told (issue 1403).
 */
export function sandboxOnHeldOp(d: {
  count: () => number;
  turnOn: () => void;
  /** Issue 1403: the install is personal. Unknown: strict. */
  personal?: () => boolean;
}): SandboxOnOp {
  return {
    check: () => {
      const n = d.count();
      if (n < 1)
        return {
          ok: false,
          error: "every agent here starts in the agent sandbox already",
        };
      return {
        ok: true,
        args: {},
        summary: `turn on the agent sandbox for ${agentsCount(n)} started before it (each at its next start)`,
        params: { count: String(n) },
        ...reviewLines([
          line(
            "Sets agents.sandbox: on in config/local/user.yml.",
            "ap.det.den_sandbox_on.sets",
          ),
          line(
            "Each agent goes into the sandbox at its next start; one that runs now keeps running.",
            "ap.det.den_sandbox_on.next",
          ),
          line(
            "An agent set to off in user.yml stays off.",
            "ap.det.den_sandbox_on.off",
          ),
        ]),
        // The person's own Allow on strict: never an auto-allow setting.
        ...(isPersonal(d.personal) ? {} : { personOnly: true as const }),
      };
    },
    run: async () => {
      try {
        d.turnOn();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}

/** The part of the approval queue Den asks through. */
export interface SandboxOnQueue {
  pending(): readonly { action: string }[];
  request(r: {
    actor: string;
    action: string;
    args: Record<string, unknown>;
    summary: string;
    params?: Record<string, string>;
    details?: string[];
    detailKeys?: { key: string }[];
  }): unknown;
}

/**
 * Den asks once: when an agent starts outside the sandbox as from before
 * and no Turn on waits. True when it asked now.
 */
export async function askSandboxOn(
  queue: SandboxOnQueue,
  op: SandboxOnOp,
): Promise<boolean> {
  if (queue.pending().some((a) => a.action === SANDBOX_ON_ACTION)) return false;
  const c = op.check({});
  if (!c.ok) return false;
  try {
    queue.request({
      actor: SANDBOX_ON_ACTOR,
      action: SANDBOX_ON_ACTION,
      args: c.args,
      summary: c.summary,
      params: c.params,
      details: c.details,
      detailKeys: c.detailKeys,
    });
    return true;
  } catch {
    return false;
  }
}
