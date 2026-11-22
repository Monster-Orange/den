/**
 * Issue 214: schedules, checks that run on their own (VERIFY-SPEC section 5,
 * decision 10). A schedule is the modules that share an environment, a cron,
 * a window and a name. On a shared environment it runs only under a
 * standing Allow: a person allows its plan once, the Allow lapses when the
 * plan changes, and it expires after verify.schedule.allow_expiry. Local and
 * code-only schedules need no Allow.
 *
 * Allows live in <state>/verify/<project>/schedule-allows.json (0600).
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { VerifyModule } from "./config.js";
import type { RunActor } from "./records.js";

export interface Schedule {
  /** Stable across plan changes: from the project, environment, cron, window and name. */
  id: string;
  project: string;
  name?: string;
  env: string;
  cron: string;
  window?: string;
  modules: VerifyModule[];
  /** The environment isn't local. */
  shared: boolean;
  /** Every module only reads the code. */
  codeOnly: boolean;
  needsAllow: boolean;
  /** The plan's fingerprint: any change to it lapses the Allow. */
  hash: string;
}

export interface ScheduleAllow {
  schedule: string;
  hash: string;
  by: RunActor;
  at: string;
  expiresAt: string;
  /** What was allowed, so the page can say what changed. */
  modules: { id: string; cmd?: string; writes: boolean }[];
  env: string;
  cron: string;
  window?: string;
}

export interface ScheduleSettings {
  allowExpiryMs: number;
  expiryWarningMs: number;
}

const DAY = 86_400_000;
export const SCHEDULE_DEFAULTS: Readonly<ScheduleSettings> = Object.freeze({
  allowExpiryMs: 30 * DAY,
  expiryWarningMs: 3 * DAY,
});

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

function span(v: unknown, name: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  let ms = NaN;
  if (typeof v === "number") ms = v * DAY;
  else if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)\s*([dh])$/.exec(v.trim());
    if (m) ms = Number(m[1]) * (m[2] === "d" ? DAY : 3_600_000);
  }
  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error(
      `verify.schedule.${name}: days as a number (30), or "30d" or "12h", got ${JSON.stringify(v)}`,
    );
  return ms;
}

/** verify.schedule.allow_expiry and expiry_warning, from Den's `verify:` block. */
export function readScheduleSettings(raw: unknown): ScheduleSettings {
  const s = obj(obj(raw).schedule);
  return {
    allowExpiryMs: span(
      s.allow_expiry,
      "allow_expiry",
      SCHEDULE_DEFAULTS.allowExpiryMs,
    ),
    expiryWarningMs: span(
      s.expiry_warning,
      "expiry_warning",
      SCHEDULE_DEFAULTS.expiryWarningMs,
    ),
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The plan behind a schedule: what runs, how, where and when. */
export function planHash(p: {
  env: string;
  cron: string;
  window?: string;
  modules: VerifyModule[];
}): string {
  const mods = [...p.modules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({
      id: m.id,
      adapter: m.adapter,
      mark: m.mark,
      cmd: m.cmd ?? null,
      writes: m.writes,
      environments: m.environments,
    }));
  return sha(
    JSON.stringify({
      env: p.env,
      cron: p.cron,
      window: p.window ?? null,
      mods,
    }),
  ).slice(0, 16);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
}

function idOf(
  project: string,
  k: { env: string; cron: string; window?: string; name?: string },
) {
  const h = sha(
    JSON.stringify([project, k.env, k.cron, k.window ?? null, k.name ?? null]),
  ).slice(0, 8);
  const lead = slug(k.name ?? k.env);
  return lead ? `${lead}-${h}` : h;
}

/** Every schedule in a project's modules, sorted by environment then name. */
export function listSchedules(
  project: string,
  modules: VerifyModule[],
): Schedule[] {
  const groups = new Map<string, VerifyModule[]>();
  for (const m of modules) {
    if (!m.schedule) continue;
    const s = m.schedule;
    const key = JSON.stringify([
      s.env,
      s.cron,
      s.window ?? null,
      s.name ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const out: Schedule[] = [];
  for (const mods of groups.values()) {
    const s = mods[0].schedule!;
    const sorted = [...mods].sort((a, b) => a.name.localeCompare(b.name));
    const shared = s.env !== "local";
    const codeOnly = sorted.every((m) => m.mark === "reads-code-only");
    out.push({
      id: idOf(project, s),
      project,
      ...(s.name ? { name: s.name } : {}),
      env: s.env,
      cron: s.cron,
      ...(s.window !== undefined ? { window: s.window } : {}),
      modules: sorted,
      shared,
      codeOnly,
      needsAllow: shared && !codeOnly,
      hash: planHash({
        env: s.env,
        cron: s.cron,
        window: s.window,
        modules: sorted,
      }),
    });
  }
  return out.sort(
    (a, b) =>
      a.env.localeCompare(b.env) ||
      (a.name ?? "").localeCompare(b.name ?? "") ||
      a.id.localeCompare(b.id),
  );
}

const fileOf = (stateDir: string, project: string) =>
  path.join(stateDir, "verify", project, "schedule-allows.json");

export function readAllows(
  stateDir: string,
  project: string,
): Record<string, ScheduleAllow> {
  try {
    const v = JSON.parse(fs.readFileSync(fileOf(stateDir, project), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function save(
  stateDir: string,
  project: string,
  all: Record<string, ScheduleAllow>,
) {
  const file = fileOf(stateDir, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A person allows the schedule's plan as it is now. */
export function writeAllow(
  stateDir: string,
  project: string,
  s: Schedule,
  by: RunActor,
  now: Date,
  settings: ScheduleSettings,
): ScheduleAllow {
  const a: ScheduleAllow = {
    schedule: s.id,
    hash: s.hash,
    by,
    at: now.toISOString(),
    expiresAt: new Date(now.getTime() + settings.allowExpiryMs).toISOString(),
    modules: s.modules.map((m) => ({
      id: m.id,
      ...(m.cmd !== undefined ? { cmd: m.cmd } : {}),
      writes: m.writes,
    })),
    env: s.env,
    cron: s.cron,
    ...(s.window !== undefined ? { window: s.window } : {}),
  };
  save(stateDir, project, { ...readAllows(stateDir, project), [s.id]: a });
  return a;
}

export function removeAllow(
  stateDir: string,
  project: string,
  id: string,
): void {
  const all = readAllows(stateDir, project);
  if (!(id in all)) return;
  delete all[id];
  save(stateDir, project, all);
}

export type ScheduleState =
  | "no-allow-needed"
  | "needs-allow"
  | "allowed"
  | "expiring"
  | "expired"
  | "plan-changed";

export function scheduleState(
  s: Schedule,
  a: ScheduleAllow | undefined,
  now: Date,
  settings: ScheduleSettings,
): ScheduleState {
  if (!s.needsAllow) return "no-allow-needed";
  if (!a) return "needs-allow";
  if (a.hash !== s.hash) return "plan-changed";
  const left = Date.parse(a.expiresAt) - now.getTime();
  if (!(left > 0)) return "expired";
  return left <= settings.expiryWarningMs ? "expiring" : "allowed";
}

export function mayRun(
  s: Schedule,
  a: ScheduleAllow | undefined,
  now: Date,
  settings: ScheduleSettings,
): boolean {
  const st = scheduleState(s, a, now, settings);
  return st === "no-allow-needed" || st === "allowed" || st === "expiring";
}
