/**
 * SRV-P6 (0.4.48): the update check's state file and doctor's line, shared
 * by the web server (src/ui/server/update-check.ts writes the file after
 * each pass) and the CLI (doctor reads it).
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";
import { readStateJson } from "./state-backup.js";

/** What one update-check pass did. */
export type UpdateTick =
  | { did: "current" }
  | { did: "skipped"; version?: string; why: string }
  | {
      did: "asked" | "updating";
      version: string;
      /** Issue 562: a security release, updated past an open question. */
      security?: boolean;
    }
  /** #251: why it waits, in words (doctor and Settings say it). */
  | {
      did: "waiting";
      version: string;
      why?: string;
      /** #251: the reason's code (UpdateWait), for the page's words. */
      wait?: string;
    }
  | { did: "failed"; version: string; why: string };

/**
 * SRV-P6 (0.4.48): the update check's last pass and next one, written by
 * the running Den after each pass so doctor (its own process) and
 * Settings can say them.
 */
export interface CheckState {
  /** server_agent.update_check_minutes as the running Den read it. */
  everyMinutes: number;
  /** When the next pass is due (ISO), or null when checks are off. */
  next: string | null;
  /** The last pass, absent before the first. */
  last?: { at: string } & UpdateTick;
}

export const updateCheckFile = (stateDir: string): string =>
  path.join(stateDir, "server-agent", "update", "check.json");

export function writeCheckState(stateDir: string, s: CheckState): void {
  const p = updateCheckFile(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  writeFileAtomic(p, JSON.stringify(s) + "\n", { mode: 0o600 });
}

export function readCheckState(stateDir: string): CheckState | null {
  try {
    // Issue 786: a file that can't be parsed is kept in backup, not reset.
    const r = readStateJson(stateDir, updateCheckFile(stateDir));
    if (!r.ok) return null;
    const s = (r.value ?? {}) as Partial<CheckState>;
    if (typeof s.everyMinutes !== "number") return null;
    return {
      everyMinutes: s.everyMinutes,
      next: typeof s.next === "string" ? s.next : null,
      ...(s.last && typeof s.last.at === "string" ? { last: s.last } : {}),
    };
  } catch {
    return null;
  }
}

export function firstCheckDelay(
  prev: CheckState | null,
  everyMs: number,
  now: number,
): number | null {
  if (!everyMs) return null;
  const next = prev?.next ? Date.parse(prev.next) : NaN;
  const last = prev?.last ? Date.parse(prev.last.at) : NaN;
  const due = Number.isFinite(next)
    ? next
    : Number.isFinite(last)
      ? last + everyMs
      : NaN;
  if (!Number.isFinite(due)) return everyMs;
  return Math.min(Math.max(due - now, 0), everyMs);
}

export function tickBegun(
  prev: CheckState | null,
  everyMinutes: number,
  everyMs: number,
  now: number,
): CheckState {
  return {
    everyMinutes,
    next: new Date(now + everyMs).toISOString(),
    ...(prev?.last ? { last: prev.last } : {}),
  };
}

export interface CheckTimers {
  once: (fn: () => void, ms: number) => void;
  every: (fn: () => void, ms: number) => void;
}

export function scheduleUpdateChecks(o: {
  every: number;
  prev: CheckState | null;
  now: number;
  tick: () => void;
  timers: CheckTimers;
}): { next: string | null } {
  const first = firstCheckDelay(o.prev, o.every, o.now);
  if (first === null) return { next: null };
  o.timers.once(() => {
    o.tick();
    o.timers.every(o.tick, o.every);
  }, first);
  return { next: new Date(o.now + first).toISOString() };
}

/** A local date and time, minutes only: 2026-11-14 18:34. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

/** What a pass did, in a few words. */
export function tickText(t: UpdateTick): string {
  switch (t.did) {
    case "current":
      return "on the newest version";
    case "skipped":
      return `skipped: ${t.why}`;
    case "asked":
      return `${t.version} is out, waiting for the person's Allow`;
    case "waiting":
      return t.why
        ? `${t.version} is out, waiting: ${t.why}`
        : `${t.version} is out, waiting for a quiet moment`;
    case "updating":
      return `updating to ${t.version}`;
    case "failed":
      return `couldn't update to ${t.version}: ${t.why}`;
  }
}

/**
 * Doctor's line (SRV-P6): self_update, where it came from, and the
 * checks' last and next pass. `warn` when a pass is well overdue (Den
 * isn't running, or its check stopped).
 */
export function selfUpdateSummary(
  cfg: {
    selfUpdate: "ask" | "auto";
    selfUpdateFrom: "user" | "org" | "default";
    updateCheckMs: number;
  },
  check: CheckState | null,
  orgFile: string,
  now: number = Date.now(),
): { status: "ok" | "warn"; detail: string } {
  const from =
    cfg.selfUpdateFrom === "user"
      ? "set in config/local/user.yml"
      : cfg.selfUpdateFrom === "org"
        ? `from ${orgFile}, copied to config/local/user.yml at the next start`
        : "the default (nothing set in config/local/user.yml)";
  const head = `self_update: ${cfg.selfUpdate}, ${from}`;
  if (!cfg.updateCheckMs)
    return {
      status: "ok",
      detail: `${head}; new-version checks are off (server_agent.update_check_minutes: 0)`,
    };
  const mins = Math.round(cfg.updateCheckMs / 60_000);
  if (!check)
    return {
      status: "ok",
      detail: `${head}; no check yet: Den looks for a new version every ${mins} min while it runs`,
    };
  const last = check.last
    ? `last check ${when(check.last.at)}: ${tickText(check.last)}`
    : "no check yet";
  if (!check.next) return { status: "ok", detail: `${head}; ${last}` };
  const due = Date.parse(check.next);
  const late =
    Number.isFinite(due) && now - due > 2 * check.everyMinutes * 60_000;
  return late
    ? {
        status: "warn",
        detail: `${head}; ${last}; the next check was due ${when(check.next)} and hasn't run: is Den running?`,
      }
    : {
        status: "ok",
        detail: `${head}; ${last}; next check ${when(check.next)}`,
      };
}
