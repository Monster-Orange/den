/**
 * Issue 214: Verify's schedules on the server (VERIFY-SPEC section 5,
 * decision 10; handoff screen S11).
 *
 * - The loop: every minute, each project's schedules. A due run starts in
 *   its window under its standing Allow, one at a time; otherwise it is
 *   skipped and named. A scheduled production run is read-only.
 * - The bell: every scheduled run's result (a failure is an alert), and one
 *   warning when an Allow is verify.schedule.expiry_warning from expiring.
 * - The routes: GET /api/verify/schedules (the page and agents read it);
 *   POST /api/verify/schedules/allow and /run, a signed-in person's only.
 */
import type * as http from "http";
import {
  describeCron,
  nextRun,
  type CronWords,
} from "../../shared/verify/cron.js";
import { methodRules } from "../../shared/verify/guard.js";
import { runPlan } from "../../shared/verify/run.js";
import { httpProbe, spawnCmd } from "../../shared/verify/run.js";
import { realGit } from "../../shared/verify/changes.js";
import {
  listSchedules,
  mayRun,
  readAllows,
  readScheduleSettings,
  scheduleState,
  writeAllow,
  type Schedule,
  type ScheduleAllow,
  type ScheduleSettings,
  type ScheduleState,
} from "../../shared/verify/schedules.js";
import {
  decide,
  noteScheduleRun,
  readScheduleRuns,
  type ScheduleRunState,
} from "../../shared/verify/schedule-tick.js";
import type { RunActor } from "../../shared/verify/records.js";
import type { NotificationKind, NoteMsg } from "../../shared/notifications.js";
import { approverAllowed } from "./approvals.js";
import { sendJson } from "./http-helpers.js";
import { agentPrincipalOf, type GuardResult } from "./request-guard.js";
import {
  bodyOf,
  modulesOf,
  projectOf,
  verifyPlanOf,
  type VerifyServerDeps,
  type Who,
} from "./verify-routes.js";

export interface BellNote {
  kind: NotificationKind;
  subject: string;
  scope: string;
  text: string;
  msg: NoteMsg;
  link: string;
}

export interface ScheduleServerDeps extends VerifyServerDeps {
  /** Every project with a schedule to look at. */
  projects: () => string[];
  bell?: (n: BellNote) => void;
  now?: () => Date;
  log?: (line: string) => void;
}

const settingsOf = (d: VerifyServerDeps): ScheduleSettings =>
  readScheduleSettings(d.verifyConfig?.());

function schedulesOf(
  d: VerifyServerDeps,
  project: string,
): { ok: true; schedules: Schedule[] } | { ok: false; error: string } {
  const m = modulesOf(d, project);
  if (!m.ok) return m;
  return { ok: true, schedules: listSchedules(project, m.modules) };
}

/** What changed since the Allow: modules in or out, a command, a write. */
export interface PlanChange {
  added: string[];
  removed: string[];
  changed: string[];
  writes: string[];
  window?: { from?: string; to?: string };
  cron?: { from: string; to: string };
}

function changeOf(s: Schedule, a: ScheduleAllow): PlanChange {
  const was = new Map(a.modules.map((m) => [m.id, m]));
  const now = new Map(s.modules.map((m) => [m.id, m]));
  const c: PlanChange = {
    added: [...now.keys()].filter((id) => !was.has(id)),
    removed: [...was.keys()].filter((id) => !now.has(id)),
    changed: [...now.values()]
      .filter(
        (m) =>
          was.has(m.id) && (was.get(m.id)!.cmd ?? null) !== (m.cmd ?? null),
      )
      .map((m) => m.id),
    writes: [...now.values()]
      .filter((m) => m.writes && !(was.get(m.id)?.writes ?? false))
      .map((m) => m.id),
  };
  if ((a.window ?? null) !== (s.window ?? null))
    c.window = {
      ...(a.window ? { from: a.window } : {}),
      ...(s.window ? { to: s.window } : {}),
    };
  if (a.cron !== s.cron) c.cron = { from: a.cron, to: s.cron };
  return c;
}

export interface ScheduleRow {
  id: string;
  name?: string;
  env: string;
  cron: string;
  words: CronWords;
  window?: string;
  modules: { id: string; name: string; mark: string; cost?: string }[];
  shared: boolean;
  codeOnly: boolean;
  needsAllow: boolean;
  readOnly: boolean;
  state: ScheduleState;
  runs: boolean;
  allow: { by: RunActor; at: string; expiresAt: string } | null;
  /** The next due time; null when none comes. */
  next: string | null;
  last: ScheduleRunState["last"] | null;
  skipped: NonNullable<ScheduleRunState["skipped"]>;
  change?: PlanChange;
}

function rowOf(
  s: Schedule,
  a: ScheduleAllow | undefined,
  r: ScheduleRunState,
  now: Date,
  set: ScheduleSettings,
): ScheduleRow {
  const state = scheduleState(s, a, now, set);
  return {
    id: s.id,
    ...(s.name ? { name: s.name } : {}),
    env: s.env,
    cron: s.cron,
    words: describeCron(s.cron),
    ...(s.window !== undefined ? { window: s.window } : {}),
    modules: s.modules.map((m) => ({
      id: m.id,
      name: m.name,
      mark: m.mark,
      ...(m.cost ? { cost: m.cost } : {}),
    })),
    shared: s.shared,
    codeOnly: s.codeOnly,
    needsAllow: s.needsAllow,
    readOnly: s.env === "production",
    state,
    runs: mayRun(s, a, now, set),
    allow: a ? { by: a.by, at: a.at, expiresAt: a.expiresAt } : null,
    next: nextRun(s.cron, now)?.toISOString() ?? null,
    last: r.last ?? null,
    skipped: (r.skipped ?? []).slice(-3),
    ...(state === "plan-changed" && a ? { change: changeOf(s, a) } : {}),
  };
}

/** The page's list for a project. */
export function scheduleRows(
  d: VerifyServerDeps,
  project: string,
  now: Date,
): { ok: true; schedules: ScheduleRow[] } | { ok: false; error: string } {
  const got = schedulesOf(d, project);
  if (!got.ok) return got;
  const set = settingsOf(d);
  const allows = readAllows(d.stateDir(), project);
  const runs = readScheduleRuns(d.stateDir(), project);
  return {
    ok: true,
    schedules: got.schedules.map((s) =>
      rowOf(s, allows[s.id], runs[s.id] ?? {}, now, set),
    ),
  };
}

const label = (s: Schedule) =>
  s.name ?? s.modules.map((m) => m.name).join(", ");

function bellResult(
  d: ScheduleServerDeps,
  s: Schedule,
  verdict: string,
  runId: string,
  passed: number,
  failed: number,
): void {
  const ok = verdict === "passed";
  const env = s.env;
  d.bell?.({
    kind: "service",
    subject: `record:vsched-${s.project}-${s.id}`,
    scope: `workspace/${s.project}`,
    text: ok
      ? `Scheduled run on ${env}: ${passed} checks passed.`
      : `Scheduled run on ${env}: ${failed} of ${passed + failed} checks failed.`,
    msg: ok
      ? { key: "bell.m.vschedPass", vars: { env, n: passed } }
      : {
          key: "bell.m.vschedFail",
          vars: { env, n: failed, total: passed + failed },
        },
    link: `/verify?why=${encodeURIComponent(env)}&run=${encodeURIComponent(runId)}`,
  });
}

function bellExpiry(
  d: ScheduleServerDeps,
  s: Schedule,
  a: ScheduleAllow,
): void {
  d.bell?.({
    kind: "decision",
    subject: `record:vsched-expire-${s.project}-${s.id}`,
    scope: `workspace/${s.project}`,
    text: `The Allow for the schedule "${label(s)}" expires ${a.expiresAt.slice(0, 10)}.`,
    msg: {
      key: "bell.m.vschedExpire",
      vars: { name: label(s), at: a.expiresAt },
    },
    link: `/verify?schedules=1#sch-${s.id}`,
  });
}

let busy = false;

/** Runs one schedule now (the loop's due run, or a person's Run now). */
async function runSchedule(
  d: ScheduleServerDeps,
  s: Schedule,
  a: ScheduleAllow | undefined,
  due: string,
  runId?: string,
): Promise<
  { ok: true; runId: string; verdict: string } | { ok: false; error: string }
> {
  const plan = verifyPlanOf(
    d,
    { project: s.project, env: s.env, modules: s.modules.map((m) => m.id) },
    {},
    { trigger: "schedule" },
  );
  if (!plan.ok) return plan;
  const git = d.git ?? realGit;
  const now = d.now ?? (() => new Date());
  const r = await runPlan(plan.plan, {
    stateDir: d.stateDir(),
    head: (p) => git.head(p),
    runCmd: d.runCmd ?? spawnCmd,
    probe: d.probe ?? httpProbe,
    now,
    ...(runId ? { runId: () => runId } : {}),
    ...(plan.plan.readOnly
      ? { methods: methodRules(d.verifyConfig?.(), s.env) }
      : {}),
    by: {
      startedBy: { kind: "den", name: "schedule" },
      ...(a ? { allowedBy: a.by } : {}),
    },
    schedule: s.id,
  });
  noteScheduleRun(d.stateDir(), s.project, s.id, {
    lastDue: due,
    last: { runId: r.runId, verdict: r.verdict, at: now().toISOString() },
  });
  const passed = r.modules.filter((m) => m.state === "passed").length;
  bellResult(d, s, r.verdict, r.runId, passed, r.modules.length - passed);
  return { ok: true, runId: r.runId, verdict: r.verdict };
}

export interface TickNote {
  project: string;
  schedule: string;
  action: string;
  reason?: string;
}

/** One pass of the loop. Returns what it did, for tests and the log. */
export async function tickSchedules(
  d: ScheduleServerDeps,
): Promise<TickNote[]> {
  const out: TickNote[] = [];
  if (busy) return out;
  busy = true;
  try {
    const now = (d.now ?? (() => new Date()))();
    let set: ScheduleSettings;
    try {
      set = settingsOf(d);
    } catch (e) {
      d.log?.(`verify schedules: ${(e as Error).message}`);
      return out;
    }
    for (const project of d.projects()) {
      const got = schedulesOf(d, project);
      if (!got.ok) continue;
      const allows = readAllows(d.stateDir(), project);
      const runs = readScheduleRuns(d.stateDir(), project);
      for (const s of got.schedules) {
        const a = allows[s.id];
        const r = runs[s.id] ?? {};
        if (
          a &&
          scheduleState(s, a, now, set) === "expiring" &&
          r.warned !== a.expiresAt
        ) {
          bellExpiry(d, s, a);
          noteScheduleRun(d.stateDir(), project, s.id, { warned: a.expiresAt });
          out.push({ project, schedule: s.id, action: "warned" });
        }
        const c = decide(s, a, r, now, set);
        if (c.action === "wait") continue;
        if (c.action === "baseline") {
          noteScheduleRun(d.stateDir(), project, s.id, {
            lastDue: now.toISOString(),
          });
          out.push({ project, schedule: s.id, action: "baseline" });
          continue;
        }
        // Handled from here: a later due time comes after now, never a catch-up per miss.
        const handled = now.toISOString();
        if (c.action === "skip") {
          noteScheduleRun(d.stateDir(), project, s.id, {
            lastDue: handled,
            skip: { due: c.due, reason: c.reason },
          });
          out.push({
            project,
            schedule: s.id,
            action: "skip",
            reason: c.reason,
          });
          continue;
        }
        const ran = await runSchedule(d, s, a, handled);
        if (!ran.ok) {
          d.log?.(`verify schedules: ${project} ${s.id}: ${ran.error}`);
          noteScheduleRun(d.stateDir(), project, s.id, { lastDue: handled });
        }
        out.push({ project, schedule: s.id, action: ran.ok ? "run" : "error" });
      }
    }
    return out;
  } finally {
    busy = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** The loop: once a minute, until the server stops. */
export function startVerifySchedules(
  d: ScheduleServerDeps,
  everyMs = 60_000,
): void {
  if (timer) return;
  timer = setInterval(() => {
    tickSchedules(d).catch((e) =>
      d.log?.(
        `verify schedules: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      ),
    );
  }, everyMs);
  timer.unref();
}

export function stopVerifySchedules(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function isSchedulePath(pathname: string): boolean {
  return (
    pathname === "/api/verify/schedules" ||
    pathname === "/api/verify/schedules/allow" ||
    pathname === "/api/verify/schedules/run"
  );
}

/** The schedule routes; false when `pathname` is none of them. */
export async function handleScheduleRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  guard: Extract<GuardResult, { ok: true }>,
  deps: () => ScheduleServerDeps,
): Promise<boolean> {
  if (!isSchedulePath(pathname)) return false;
  const d = deps();
  const now = (d.now ?? (() => new Date()))();
  const method = (req.method ?? "GET").toUpperCase();
  const agent = agentPrincipalOf(req);
  const who: Who = agent
    ? { agent: agent.actor.slice("agent:".length), project: agent.workspace }
    : {};
  if (pathname === "/api/verify/schedules") {
    if (method !== "GET") {
      sendJson(res, { ok: false, error: "GET only" }, 405);
      return true;
    }
    const q = new URL(req.url ?? "/", "http://den").searchParams;
    const p = projectOf(d, q.get("project") ?? undefined, who);
    if (!p.ok) {
      sendJson(res, { ok: false, error: p.error }, 400);
      return true;
    }
    let rows;
    try {
      rows = scheduleRows(d, p.project, now);
    } catch (e) {
      rows = { ok: false as const, error: (e as Error).message };
    }
    if (!rows.ok) {
      sendJson(res, { ok: false, error: rows.error }, 422);
      return true;
    }
    sendJson(res, {
      ok: true,
      project: p.project,
      now: now.toISOString(),
      schedules: rows.schedules,
    });
    return true;
  }
  if (method !== "POST") {
    sendJson(res, { ok: false, error: "POST only" }, 405);
    return true;
  }
  // A person's, from a signed-in browser: never an agent's.
  const person = approverAllowed(req, guard, "decide");
  if (!person.ok) {
    sendJson(res, { ok: false, code: person.code, error: person.error }, 403);
    return true;
  }
  const body = await bodyOf(req);
  if (!body || typeof body.id !== "string") {
    sendJson(
      res,
      { ok: false, error: "The body is JSON: { project?, id }." },
      400,
    );
    return true;
  }
  const p = projectOf(d, body.project, {});
  if (!p.ok) {
    sendJson(res, { ok: false, error: p.error }, 400);
    return true;
  }
  const got = schedulesOf(d, p.project);
  const s = got.ok ? got.schedules.find((x) => x.id === body.id) : undefined;
  if (!s) {
    sendJson(
      res,
      { ok: false, error: `there is no schedule "${String(body.id)}"` },
      404,
    );
    return true;
  }
  let set: ScheduleSettings;
  try {
    set = settingsOf(d);
  } catch (e) {
    sendJson(res, { ok: false, error: (e as Error).message }, 422);
    return true;
  }
  const allows = readAllows(d.stateDir(), p.project);
  if (pathname === "/api/verify/schedules/allow") {
    if (!s.needsAllow) {
      sendJson(res, { ok: false, error: "This schedule needs no Allow." }, 409);
      return true;
    }
    const a = writeAllow(
      d.stateDir(),
      p.project,
      s,
      { kind: "person" },
      now,
      set,
    );
    const runs = readScheduleRuns(d.stateDir(), p.project);
    sendJson(res, {
      ok: true,
      schedule: rowOf(s, a, runs[s.id] ?? {}, now, set),
    });
    return true;
  }
  // Run now: under the schedule's own rule (its Allow, or none needed).
  const a = allows[s.id];
  if (!mayRun(s, a, now, set)) {
    sendJson(
      res,
      {
        ok: false,
        code: "needs_allow",
        error: "Allow this schedule first: it runs only under its Allow.",
      },
      409,
    );
    return true;
  }
  if (busy) {
    sendJson(
      res,
      {
        ok: false,
        code: "busy",
        error: "A scheduled run is going: try again when it ends.",
      },
      409,
    );
    return true;
  }
  const runId = `${now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  busy = true;
  runSchedule(d, s, a, now.toISOString(), runId)
    .catch((e) => d.log?.(`verify schedules: run now: ${(e as Error).message}`))
    .finally(() => {
      busy = false;
    });
  sendJson(res, { ok: true, runId }, 202);
  return true;
}
