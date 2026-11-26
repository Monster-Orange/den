import { type DetailKey, line, reviewLines } from "../review-lines.js";
import {
  allowedFor,
  holdOutcome,
  PERSON_CREDENTIAL_NAMES,
  type EnvHoldSettings,
} from "./env-hold.js";

export const ENV_HOLD_ON_ACTION = "den_env_hold_on";
export const ENV_ALLOW_KEEP_ACTION = "den_env_allow_keep";
export const ENV_HOLD_ACTOR = "den:env-hold";

export const LEGACY_ENV_HOLD_REASON =
  "it started before secret-looking variables were held back; Allow Keep these or Remove in the bell, or set agents.env_hold_existing: true in config/local/user.yml";

export interface WithEnvHold {
  id: string;
  workspace?: string;
  envHold?: { applied: boolean; legacy?: true };
}

export function isFromBeforeHold(rec: WithEnvHold): boolean {
  return rec.envHold === undefined || rec.envHold.legacy === true;
}

export function holdOnAtStart(
  prev: WithEnvHold | null | undefined,
  s: EnvHoldSettings,
): boolean {
  if (!prev) return true;
  if (prev.envHold?.applied === true) return true;
  return s.holdExisting;
}

export function envHoldMark(on: boolean): {
  applied: boolean;
  legacy?: true;
} {
  return on ? { applied: true } : { applied: false, legacy: true };
}

export function legacyHoldIds(
  recs: readonly WithEnvHold[],
  s: EnvHoldSettings,
): string[] {
  if (s.holdExisting) return [];
  return recs.filter(isFromBeforeHold).map((r) => r.id);
}

export function wouldHold(
  recs: readonly WithEnvHold[],
  s: EnvHoldSettings,
  present: readonly string[],
  projectAllow: (project: string) => readonly string[] = () => [],
): { id: string; names: string[] }[] {
  const ids = new Set(legacyHoldIds(recs, s));
  return recs
    .filter((r) => ids.has(r.id))
    .map((r) => ({
      id: r.id,
      names: holdOutcome(
        present,
        s.hold,
        allowedFor(s, r.id, r.workspace ? projectAllow(r.workspace) : []),
      ).held.filter((n) => !PERSON_CREDENTIAL_NAMES.includes(n)),
    }));
}

export function heldUnion(rows: readonly { names: string[] }[]): string[] {
  return [...new Set(rows.flatMap((r) => r.names))].sort();
}

export function agentsCount(n: number): string {
  return `${n} agent${n === 1 ? "" : "s"}`;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvHoldCheck =
  | {
      ok: true;
      args: { names?: string[] };
      summary: string;
      params: Record<string, string>;
      details: string[];
      detailKeys: DetailKey[];
      personOnly: true;
    }
  | { ok: false; error: string };

export interface EnvHoldOp {
  check(args: Record<string, unknown>): EnvHoldCheck;
  run(args: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

export interface EnvHoldOpDeps {
  rows: () => { id: string; names: string[] }[];
  turnOn: () => void;
  keep: (names: string[]) => void;
}

export function envHoldOnOp(d: EnvHoldOpDeps): EnvHoldOp {
  return {
    check: () => {
      const rows = d.rows();
      if (!rows.length)
        return {
          ok: false,
          error: "every agent here holds secret-looking variables back already",
        };
      const names = heldUnion(rows);
      const shown = names.length ? names.join(", ") : "none now";
      return {
        ok: true,
        args: {},
        summary: `hold secret-looking variables back from ${agentsCount(rows.length)} started before (each at its next start): ${shown}`,
        params: { count: String(rows.length), names: shown },
        ...reviewLines([
          line(
            "Sets agents.env_hold_existing: true in config/local/user.yml.",
            "ap.det.den_env_hold_on.sets",
          ),
          line(
            "Each agent loses them at its next start; one that runs now keeps them until then.",
            "ap.det.den_env_hold_on.next",
          ),
          line(
            "Names it keeps from agents.env_allow stay.",
            "ap.det.den_env_hold_on.allow",
          ),
        ]),
        personOnly: true,
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

export function envAllowKeepOp(d: EnvHoldOpDeps): EnvHoldOp {
  const checked = (
    args: Record<string, unknown>,
  ): { names: string[] } | { error: string } => {
    const raw = args.names;
    if (!Array.isArray(raw) || !raw.length)
      return { error: "names: the variables to keep, one or more" };
    const names: string[] = [];
    for (const n of raw) {
      if (typeof n !== "string" || !NAME_RE.test(n))
        return { error: `names: "${String(n)}" is not a variable name` };
      if (PERSON_CREDENTIAL_NAMES.includes(n))
        return {
          error: `names: ${n} is a person's credential; no agent keeps it`,
        };
      names.push(n);
    }
    const would = new Set(heldUnion(d.rows()));
    const other = names.filter((n) => !would.has(n));
    if (other.length)
      return {
        error: `names: ${other.join(", ")} would not be held back from any agent here`,
      };
    return { names: [...new Set(names)].sort() };
  };
  return {
    check: (args) => {
      const c = checked(args);
      if ("error" in c) return { ok: false, error: c.error };
      const rows = d.rows();
      const list = c.names.join(", ");
      return {
        ok: true,
        args: { names: c.names },
        summary: `keep ${list} for every agent, and hold the rest back from ${agentsCount(rows.length)} started before`,
        params: { names: list, count: String(rows.length) },
        ...reviewLines([
          line(
            "Adds {names} to agents.env_allow in config/local/user.yml: every agent here gets them.",
            "ap.det.den_env_allow_keep.adds",
            { names: list },
          ),
          line(
            "Sets agents.env_hold_existing: true: other secret-looking variables are held back from each agent at its next start.",
            "ap.det.den_env_allow_keep.on",
          ),
        ]),
        personOnly: true,
      };
    },
    run: async (args) => {
      const c = checked(args);
      if ("error" in c) return { ok: false, error: c.error };
      try {
        d.keep(c.names);
        d.turnOn();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}

export interface EnvHoldQueue {
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

export async function askEnvHold(
  queue: EnvHoldQueue,
  keep: EnvHoldOp,
  on: EnvHoldOp,
  rows: () => { id: string; names: string[] }[],
): Promise<boolean> {
  const waiting = queue
    .pending()
    .some(
      (a) =>
        a.action === ENV_HOLD_ON_ACTION || a.action === ENV_ALLOW_KEEP_ACTION,
    );
  if (waiting) return false;
  const names = heldUnion(rows());
  if (!names.length) return false;
  let asked = false;
  for (const [action, op, args] of [
    [ENV_ALLOW_KEEP_ACTION, keep, { names }],
    [ENV_HOLD_ON_ACTION, on, {}],
  ] as const) {
    const c = op.check(args);
    if (!c.ok) continue;
    try {
      queue.request({
        actor: ENV_HOLD_ACTOR,
        action,
        args: c.args,
        summary: c.summary,
        params: c.params,
        details: c.details,
        detailKeys: c.detailKeys,
      });
      asked = true;
    } catch {
      continue;
    }
  }
  return asked;
}
