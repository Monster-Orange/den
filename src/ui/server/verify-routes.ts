/**
 * Issue 208: Verify's plan and run, for a page, the CLI and agents.
 *
 *   POST /api/verify/plan   { project?, env?, scope?, modules? }: the plan
 *                           (shared/verify/plan.ts); runs nothing
 *   POST /api/verify/run    the same body, on local only: runs the plan
 *                           at once and answers the verdict and exit code
 *
 * A run on a shared environment (any but local) is the held write
 * `verify_run` (held-actions.ts): the person's Allow shows the plan, each
 * module with its mark, and what can't run and why. Nothing runs until
 * Allow; Decline runs nothing. The args it stores name the modules, so
 * the run is the plan that was allowed.
 *
 * An agent plans and runs in its own project only.
 *
 * Issue 209, what the Verify page reads (GET):
 *   /api/verify/overview?project=       the answer on each environment
 *   /api/verify/runs/:id?project=       one run's record (issue 210:
 *                                       `live` while it is "running")
 *   /api/verify/runs/:id/report?project=&module=
 *                                       a module's kept output, as text
 *
 * Issue 212:
 *   /api/verify/modules/:id/history?project=&env=
 *                                       one module's runs, oldest first, the
 *                                       flaky mark, the first failing range
 *                                       and the commits in between (S5)
 *   /api/verify/runs/:id/report?project=&module=&kind=sarif
 *                                       a scan's SARIF (S6); a run's record
 *                                       carries its findings
 * Settings (verify.run.retries, flaky, history, security.fail_on) come
 * from the org's `verify:` (shared/verify/settings.ts).
 *
 * Issue 210, runs that go on in the background (shared/verify/active.ts):
 *   POST /api/verify/run { background: true }   local: starts, answers
 *                                       202 { runId } at once
 *   POST /api/verify/runs/:id/cancel?project=   Cancel: the person, or
 *                                       the agent that started it
 * A held run starts when it is allowed and answers its run id at once
 * (startVerify), so Allow never waits for the whole run. One run at a
 * time per project and environment: a second is refused with the id of
 * the one going (409 run_going).
 */
import type * as http from "http";
import {
  moduleChanges,
  readLatest,
  realGit,
  type GitProbe,
} from "../../shared/verify/changes.js";
import {
  readVerifyModules,
  type ManifestLike,
  type VerifyModule,
} from "../../shared/verify/config.js";
import {
  MARK_WORDS,
  VERIFY_SCOPES,
  planVerify,
  type CantRunModule,
  type VerifyPlan,
  type VerifyScope,
} from "../../shared/verify/plan.js";
import {
  httpProbe,
  newRunId,
  runPlan,
  spawnCmd,
  type RunDeps,
  type RunResult,
} from "../../shared/verify/run.js";
import { ActiveRuns } from "../../shared/verify/active.js";
import { moduleHistory } from "../../shared/verify/history.js";
import { rangeIssue } from "../../shared/verify/range-issue.js";
import {
  fileIssueAsPerson,
  newIssueUrl,
  runGh,
  type FiledIssue,
  type ReportRouteDeps,
} from "./report-routes.js";
import {
  VERIFY_SETTINGS_DEFAULTS,
  type VerifySettings,
} from "../../shared/verify/settings.js";
import { verifyOverview } from "../../shared/verify/overview.js";
import {
  hasEnded,
  listRunRecords,
  readRunRecord,
  type RunActor,
} from "../../shared/verify/records.js";
import type { DetailKey, HeldOpCheck } from "../cli/agent-ops.js";
import type { AskedBy } from "./approvals.js";
import { recordAction } from "./audit.js";
import * as fs from "fs";
import * as path from "path";
import { readBody, sendJson, UNTRUSTED_FILE_HEADERS } from "./http-helpers.js";
import {
  agentPrincipalOf,
  auditActorOf,
  principalOf,
} from "./request-guard.js";

export interface VerifyServerDeps {
  stateDir: () => string;
  projectExists: (project: string) => boolean;
  /** The project a person's ask is about when it names none. */
  focusedProject: () => string | null;
  /** The project's repos, each with its manifest. */
  repos: (project: string) => {
    repo: string;
    repoPath: string;
    manifest: ManifestLike;
  }[];
  /** The org's environments (unchecked when absent). */
  environments?: () => readonly string[];
  git?: GitProbe;
  runCmd?: RunDeps["runCmd"];
  probe?: RunDeps["probe"];
  /** Issue 210: the runs going on (one per server when absent). */
  active?: ActiveRuns;
  /** Issue 212: the org's `verify:` settings (the defaults when absent). */
  settings?: () => VerifySettings;
  /** Issue 212: runs `gh` as the person (a test's fake; default: gh). */
  gh?: ReportRouteDeps["gh"];
}

const settingsOf = (d: VerifyServerDeps): VerifySettings =>
  d.settings?.() ?? VERIFY_SETTINGS_DEFAULTS;

const ACTIVE = new ActiveRuns();
const activeOf = (d: VerifyServerDeps) => d.active ?? ACTIVE;

export interface VerifyRunArgs {
  project: string;
  env: string;
  scope: VerifyScope;
  /** The module ids the person allowed. */
  modules: string[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type Who = { agent?: string; project?: string };
type PlanOf =
  | { ok: true; plan: VerifyPlan; modules: VerifyModule[] }
  | { ok: false; error: string };

type ProjectOf = { ok: true; project: string } | { ok: false; error: string };

/** The project an ask is about: the agent's own, the one named, or the focused one. */
function projectOf(d: VerifyServerDeps, raw: unknown, who: Who): ProjectOf {
  const no = (error: string): ProjectOf => ({ ok: false, error });
  if (raw !== undefined && typeof raw !== "string")
    return no("project must be text");
  const given = typeof raw === "string" ? raw.trim() : "";
  if (who.project && given && given !== who.project)
    return no(
      `${who.agent ?? "this agent"} works in project ${who.project}: it plans and runs Verify there only, not in project ${given}`,
    );
  const project = who.project ?? (given || d.focusedProject() || "");
  if (!project) return no("name the project");
  if (!NAME_RE.test(project) || !d.projectExists(project))
    return no(`there is no project "${project}"`);
  return { ok: true, project };
}

type ModulesOf =
  | { ok: true; modules: VerifyModule[]; layers: Record<string, string[]> }
  | { ok: false; error: string };

/** Every module the project's repos declare, and their layers. */
function modulesOf(d: VerifyServerDeps, project: string): ModulesOf {
  const envs = d.environments?.();
  const modules: VerifyModule[] = [];
  const layers: Record<string, string[]> = {};
  for (const r of d.repos(project)) {
    const got = readVerifyModules(r, envs);
    if (got.errors.length)
      return {
        ok: false,
        error: `${r.repo}'s verify: block has errors: ${got.errors
          .slice(0, 3)
          .map((e) => `${e.path}: ${e.message}`)
          .join("; ")}`,
      };
    modules.push(...got.modules);
    for (const [l, deps] of Object.entries(got.layers))
      layers[l] = [...new Set([...(layers[l] ?? []), ...deps])];
  }
  return { ok: true, modules, layers };
}

/** The plan for an ask ({ project?, env?, scope?, modules? }). */
export function verifyPlanOf(
  d: VerifyServerDeps,
  raw: Record<string, unknown>,
  who: Who = {},
): PlanOf {
  const no = (error: string): PlanOf => ({ ok: false, error });
  const p = projectOf(d, raw.project, who);
  if (!p.ok) return p;
  const project = p.project;
  const env = raw.env === undefined ? "local" : raw.env;
  if (typeof env !== "string" || !NAME_RE.test(env))
    return no("env is an environment's name, like local or staging");
  const envs = d.environments?.();
  if (envs && !envs.includes(env))
    return no(
      `there is no environment "${env}" (environments: ${envs.join(", ")})`,
    );
  const scope = raw.scope === undefined ? "changed" : raw.scope;
  if (!VERIFY_SCOPES.includes(scope as VerifyScope))
    return no(`scope is ${VERIFY_SCOPES.join(" or ")}`);
  let chosen: string[] | undefined;
  if (raw.modules !== undefined) {
    if (
      !Array.isArray(raw.modules) ||
      !raw.modules.length ||
      raw.modules.some((m) => typeof m !== "string")
    )
      return no("modules is a list of module names, like web/checkout");
    chosen = raw.modules as string[];
  }
  const mods = modulesOf(d, project);
  if (!mods.ok) return mods;
  const { modules, layers } = mods;
  const latest = readLatest(d.stateDir(), project)[env] ?? {};
  try {
    const plan = planVerify({
      project,
      env,
      scope: scope as VerifyScope,
      ...(chosen ? { chosen } : {}),
      modules,
      layers,
      changes: moduleChanges(modules, latest, d.git ?? realGit),
    });
    return { ok: true, plan, modules };
  } catch (e) {
    return no((e as Error).message);
  }
}

/** A can't-run line, in English and as its key. */
function cantLine(c: CantRunModule, env: string): [string, DetailKey] {
  const envs = c.environments === "all" ? "all" : c.environments.join(", ");
  switch (c.reason) {
    case "environment":
      return [
        `${c.name} can't run here: it runs on ${envs} only.`,
        { key: "ap.vr.cant.environment", vars: { module: c.name, envs } },
      ];
    case "production":
      return [
        `${c.name} can't run on production yet: opting in to production comes in a later Den.`,
        { key: "ap.vr.cant.production", vars: { module: c.name } },
      ];
    case "adapter-later":
      return [
        `${c.name} can't run yet: its adapter (${c.adapter}) comes in a later Den.`,
        {
          key: "ap.vr.cant.adapter-later",
          vars: { module: c.name, adapter: c.adapter },
        },
      ];
    case "no-health-url":
      return [
        `${c.name} can't run here: no health URL for ${env}.`,
        { key: "ap.vr.cant.no-health-url", vars: { module: c.name, env } },
      ];
  }
}

const SCOPE_LINES: Record<string, string> = {
  changed:
    "Scope: what changed (smoke, plus checks whose files changed since their last result).",
  all: "Scope: everything on this environment.",
  chosen: "Scope: the checks chosen by name.",
};

/**
 * The held write's check: a run on a shared environment, with the plan
 * in the Review. Local runs at once (POST /api/verify/run), never held.
 */
export function checkVerifyRun(
  d: VerifyServerDeps,
  raw: Record<string, unknown>,
  who: Who = {},
): HeldOpCheck<VerifyRunArgs> {
  const r = verifyPlanOf(d, raw, who);
  if (!r.ok) return r;
  const p = r.plan;
  if (!p.shared)
    return {
      ok: false,
      error:
        "local runs at once, with no Allow: use verify_run on local (POST /api/verify/run)",
    };
  if (p.nothingToRun)
    return {
      ok: false,
      error: `nothing to run on ${p.env}: ${
        p.reason === "unchanged"
          ? "nothing changed since the last results"
          : p.reason === "none-declared"
            ? `project ${p.project} declares no modules`
            : "no module can run here"
      }`,
    };
  const scope = p.chosen ? "chosen" : p.scope;
  const lines: [string, DetailKey][] = [
    [SCOPE_LINES[scope], { key: `ap.vr.scope.${scope}` }],
    ...p.modules.map((m): [string, DetailKey] => [
      `${m.name} (${m.kind}): ${MARK_WORDS[m.mark]}`,
      { key: `ap.vr.mod.${m.mark}`, vars: { module: m.name, kind: m.kind } },
    ]),
    ...p.cantRun.map((c) => cantLine(c, p.env)),
    [
      "This Allow covers this run only. Nothing runs until you Allow it.",
      { key: "ap.vr.once" },
    ],
  ];
  const list = p.modules.map((m) => m.name).join(", ");
  return {
    ok: true,
    // Always the person's own Allow: a shared environment is critical
    // (CRITICAL_HELD_ACTIONS in held-actions.ts).
    personOnly: true,
    summary: `run checks on ${p.env} in project ${p.project}: ${list}`,
    params: { env: p.env, project: p.project, list },
    details: lines.map((l) => l[0]),
    detailKeys: lines.map((l) => l[1]),
    args: {
      project: p.project,
      env: p.env,
      scope: p.scope,
      modules: p.modules.map((m) => m.id),
    },
  };
}

/** Who started a run and who allowed it (issue 209), for its record. */
function actorsOf(
  who: Who,
  asked?: AskedBy,
): { startedBy: RunActor; allowedBy?: RunActor } {
  const agent = asked ? asked.agent : who.agent;
  const startedBy: RunActor = agent
    ? { kind: "agent", name: agent }
    : { kind: "person" };
  const allowedBy: RunActor | undefined = asked
    ? asked.decidedBy?.startsWith("auto:")
      ? { kind: "den" }
      : { kind: "person" }
    : undefined;
  return { startedBy, ...(allowedBy ? { allowedBy } : {}) };
}

function runDeps(d: VerifyServerDeps, by: RunDeps["by"]): RunDeps {
  const git = d.git ?? realGit;
  return {
    stateDir: d.stateDir(),
    head: (p) => git.head(p),
    runCmd: d.runCmd ?? spawnCmd,
    probe: d.probe ?? httpProbe,
    ...(by ? { by } : {}),
    // Issue 212: retries, and the threshold a scan fails at.
    retries: settingsOf(d).retries,
    failOn: settingsOf(d).failOn,
  };
}

/**
 * Runs the plan for an ask and answers when it ends. `asked`: a held
 * run's request (the agent that asked, the session that allowed it);
 * without it, whoever called started it (an agent, or a person). The
 * run's record keeps both (issue 209).
 */
export async function runVerify(
  d: VerifyServerDeps,
  raw: Record<string, unknown>,
  who: Who = {},
  asked?: AskedBy,
): Promise<RunResult | { ok: false; error: string }> {
  const r = verifyPlanOf(d, raw, who);
  if (!r.ok) return r;
  return runPlan(r.plan, runDeps(d, actorsOf(who, asked)));
}

export type StartResult =
  | {
      ok: true;
      runId: string;
      project: string;
      env: string;
      /** False when the plan had nothing to run: it ended at once. */
      running: boolean;
    }
  | { ok: false; error: string; code?: "run_going"; runId?: string };

/**
 * Issue 210: starts the plan in the background and answers its run id at
 * once (a held run's Allow, and the page's Run). The record says
 * "running" and shows progress; Cancel stops it.
 */
export async function startVerify(
  d: VerifyServerDeps,
  raw: Record<string, unknown>,
  who: Who = {},
  asked?: AskedBy,
): Promise<StartResult> {
  const r = verifyPlanOf(d, raw, who);
  if (!r.ok) return r;
  const { project, env } = r.plan;
  const by = actorsOf(who, asked);
  const base = runDeps(d, by);
  if (r.plan.nothingToRun) {
    const done = await runPlan(r.plan, base);
    return { ok: true, runId: done.runId, project, env, running: false };
  }
  const active = activeOf(d);
  const going = active.going(project, env);
  const runId = newRunId();
  const started =
    !going &&
    active.start(
      { project, env, runId, startedBy: by.startedBy },
      (signal, cancelled) =>
        runPlan(r.plan, { ...base, runId: () => runId, signal, cancelled }),
    );
  if (!started)
    return {
      ok: false,
      code: "run_going",
      ...(going ? { runId: going } : {}),
      error: `a run is already going on ${env} in project ${project}: wait for it, or cancel it`,
    };
  return { ok: true, runId, project, env, running: true };
}

const RUN_PATH =
  /^\/api\/verify\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(\/report)?$/;
const CANCEL_PATH =
  /^\/api\/verify\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/cancel$/;
/** Issue 212: a module's id, URL-encoded (`<repo>:<layer>/<name>`). */
const HISTORY_PATH = /^\/api\/verify\/modules\/([^/]{1,300})\/history$/;
/** How many commits a failing range lists. */
const RANGE_COMMITS = 20;
/** Issue 212: "Open an issue with this range" (preview, or a person's send). */
const ISSUE_PATH = /^\/api\/verify\/modules\/([^/]{1,300})\/issue$/;

type RangeIssueOf =
  | { ok: true; repo: string; title: string; body: string }
  | { ok: false; status: number; code?: string; error: string };

/**
 * Issue 212: the issue for a failing module's range, on its own repo's
 * GitHub (from the repo's origin): never Den's. Sends nothing.
 */
function rangeIssueOf(
  deps: VerifyServerDeps,
  project: string,
  id: string,
  env: string,
): RangeIssueOf {
  const envs = deps.environments?.() ?? ["local"];
  if (!envs.includes(env))
    return {
      ok: false,
      status: 400,
      error: `"${env}" is not one of: ${envs.join(", ")}`,
    };
  const mods = modulesOf(deps, project);
  if (!mods.ok) return { ok: false, status: 400, error: mods.error };
  const m = mods.modules.find((x) => x.id === id);
  if (!m)
    return {
      ok: false,
      status: 404,
      error: `there is no module "${id}" in project ${project}`,
    };
  let s: VerifySettings;
  try {
    s = settingsOf(deps);
  } catch (e) {
    return {
      ok: false,
      status: 422,
      code: "config_invalid",
      error: (e as Error).message,
    };
  }
  const git = deps.git ?? realGit;
  const repo = git.origin?.(m.repoPath) ?? null;
  if (!repo)
    return {
      ok: false,
      status: 409,
      code: "no_github_repo",
      error: `repo ${m.repo} has no GitHub origin to file the issue on`,
    };
  const h = moduleHistory(listRunRecords(deps.stateDir(), project), id, env, s);
  const from = h.range?.lastPassed?.commit;
  const to = h.range?.firstFailed.commit;
  const commits =
    from && to
      ? (git.between?.(m.repoPath, from, to, RANGE_COMMITS) ?? undefined)
      : undefined;
  const issue = rangeIssue({
    project,
    module: { id, name: m.name, kind: m.kind },
    history: h,
    ...(commits ? { commits } : {}),
  });
  if (!issue)
    return {
      ok: false,
      status: 409,
      code: "no_range",
      error: `${m.name} is not failing on ${env}: there is no range to file`,
    };
  return { ok: true, repo, ...issue };
}

/** Issue 212: held write verify_issue's check (an agent's ask). */
export function checkVerifyIssue(
  d: VerifyServerDeps,
  raw: Record<string, unknown>,
  who: Who = {},
): HeldOpCheck<{ project: string; module: string; env: string }> {
  const p = projectOf(
    d,
    typeof raw.project === "string" ? raw.project : undefined,
    who,
  );
  if (!p.ok) return p;
  if (typeof raw.module !== "string" || !raw.module)
    return { ok: false, error: "module: the failing check's id" };
  const env = typeof raw.env === "string" ? raw.env : "local";
  const i = rangeIssueOf(d, p.project, raw.module, env);
  if (!i.ok) return { ok: false, error: i.error };
  const bodyLines = i.body.trimEnd().split("\n");
  return {
    ok: true,
    // Always the person's own Allow: it posts on GitHub as them.
    personOnly: true,
    summary: `open an issue on ${i.repo}: ${i.title}`,
    params: { repo: i.repo, title: i.title },
    details: [
      `On ${i.repo}, as you (your gh login).`,
      `Title: ${i.title}`,
      ...bodyLines,
    ],
    // The body stays as GitHub will show it: in the words it is filed in.
    detailKeys: [
      { key: "ap.vi.on", vars: { repo: i.repo } },
      { key: "ap.vi.title", vars: { title: i.title } },
      ...bodyLines.map(() => null),
    ],
    args: { project: p.project, module: raw.module, env },
  };
}

/** Issue 212: held write verify_issue, once the person allowed it. */
export async function runVerifyIssue(
  d: VerifyServerDeps,
  a: Record<string, unknown>,
): Promise<FiledIssue & { repo?: string }> {
  const i = rangeIssueOf(
    d,
    String(a.project ?? ""),
    String(a.module ?? ""),
    String(a.env ?? "local"),
  );
  if (!i.ok) return { ok: false, error: i.error };
  const f = await fileIssueAsPerson(d.gh ?? runGh, {
    repo: i.repo,
    title: i.title,
    body: i.body,
    label: "bug",
  });
  return { ...f, repo: i.repo };
}

/** Issue 212: POST /api/verify/modules/:id/issue. */
async function handleIssue(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawId: string,
  d: VerifyServerDeps,
): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, { ok: false, error: "POST only" }, 405);
    return;
  }
  const body = await bodyOf(req);
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    id = "";
  }
  if (!body || !id) {
    sendJson(
      res,
      { ok: false, error: "The body is JSON: { project?, env, send? }." },
      400,
    );
    return;
  }
  const agent = agentPrincipalOf(req);
  if (body.send === true && agent) {
    sendJson(
      res,
      {
        ok: false,
        error:
          'only a person sends it here: ask with POST /api/approvals { action: "verify_issue", args: { module, env } }',
      },
      403,
    );
    return;
  }
  const who: Who = agent
    ? { agent: agent.actor.slice("agent:".length), project: agent.workspace }
    : {};
  const p = projectOf(
    d,
    typeof body.project === "string" ? body.project : undefined,
    who,
  );
  if (!p.ok) {
    sendJson(res, { ok: false, error: p.error }, 400);
    return;
  }
  const env = typeof body.env === "string" ? body.env : "local";
  const i = rangeIssueOf(d, p.project, id, env);
  if (!i.ok) {
    sendJson(
      res,
      { ok: false, ...(i.code ? { code: i.code } : {}), error: i.error },
      i.status,
    );
    return;
  }
  if (body.send !== true) {
    sendJson(res, {
      ok: true,
      repo: i.repo,
      title: i.title,
      body: i.body,
      // The way without a gh sign-in: GitHub's page, the text filled in.
      newIssueUrl: newIssueUrl(i.repo, i.title, i.body),
    });
    return;
  }
  const f = await fileIssueAsPerson(d.gh ?? runGh, {
    repo: i.repo,
    title: i.title,
    body: i.body,
    label: "bug",
  });
  recordAction(
    auditActorOf(req),
    {
      verb: "verify-issue",
      detail: f.ok
        ? `${p.project} on ${env}: ${id} filed as ${f.url}`
        : `${p.project} on ${env}: ${id} not filed (${f.error})`,
    },
    principalOf(req),
  );
  if (f.ok) sendJson(res, { ok: true, url: f.url, repo: i.repo });
  else sendJson(res, { ...f, repo: i.repo }, "need" in f ? 409 : 502);
}

/** Issue 209: the page's reads (GET); false when `pathname` is none of them. */
function handleVerifyReads(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: () => VerifyServerDeps,
): boolean {
  const run = RUN_PATH.exec(pathname);
  const hist = HISTORY_PATH.exec(pathname);
  if (pathname !== "/api/verify/overview" && !run && !hist) return false;
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, { ok: false, error: "GET only" }, 405);
    return true;
  }
  const q = new URL(req.url ?? "/", "http://den").searchParams;
  const agent = agentPrincipalOf(req);
  const who: Who = agent
    ? { agent: agent.actor.slice("agent:".length), project: agent.workspace }
    : {};
  const deps = d();
  const p = projectOf(deps, q.get("project") ?? undefined, who);
  if (!p.ok) {
    sendJson(res, { ok: false, error: p.error }, 400);
    return true;
  }
  const stateDir = deps.stateDir();
  if (hist) {
    historyRead(res, deps, p.project, hist[1], q);
    return true;
  }
  if (!run) {
    const mods = modulesOf(deps, p.project);
    if (!mods.ok) {
      sendJson(res, { ok: false, error: mods.error }, 400);
      return true;
    }
    const envs = deps.environments?.() ?? ["local"];
    sendJson(res, {
      ok: true,
      ...verifyOverview({
        project: p.project,
        envs,
        modules: mods.modules,
        layers: mods.layers,
        latest: readLatest(stateDir, p.project),
        runs: listRunRecords(stateDir, p.project),
      }),
    });
    return true;
  }
  const rec = readRunRecord(stateDir, p.project, run[1]);
  if (!rec) {
    sendJson(res, { ok: false, error: `there is no run "${run[1]}"` }, 404);
    return true;
  }
  if (!run[2]) {
    sendJson(res, {
      ok: true,
      ...rec,
      // Issue 210: a record still "running" that no run in this Den is
      // behind (Den stopped during it) is not live.
      ...(rec.verdict === "running"
        ? { live: activeOf(deps).isLive(p.project, rec.runId) }
        : {}),
    });
    return true;
  }
  const name = q.get("module") ?? "";
  const mod = rec.modules.find((m) => m.name === name || m.id === name);
  if (q.get("kind") === "sarif") {
    // Issue 212: the scan's SARIF, by the name its record keeps, from the
    // module's own results folder; served as data that runs nothing.
    const file = mod?.findings?.report;
    const dir = mod
      ? path.join(
          stateDir,
          "verify",
          p.project,
          "runs",
          rec.runId,
          mod.id.replace(/[^A-Za-z0-9._-]+/g, "_"),
        )
      : "";
    let body: Buffer | null = null;
    if (file && path.basename(file) === file)
      try {
        body = fs.readFileSync(path.join(dir, file));
      } catch {
        body = null;
      }
    if (!body) {
      sendJson(
        res,
        {
          ok: false,
          error: `run ${rec.runId} kept no findings report for "${name}"`,
        },
        404,
      );
      return true;
    }
    res.writeHead(200, {
      ...UNTRUSTED_FILE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(body);
    return true;
  }
  const tail = mod?.tail;
  if (!tail?.length) {
    sendJson(
      res,
      { ok: false, error: `run ${rec.runId} kept no output for "${name}"` },
      404,
    );
    return true;
  }
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(tail.join("\n") + "\n");
  return true;
}

/** Issue 212: S5, one module's history on one environment. */
function historyRead(
  res: http.ServerResponse,
  deps: VerifyServerDeps,
  project: string,
  rawId: string,
  q: URLSearchParams,
): void {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    sendJson(res, { ok: false, error: "not a module's id" }, 400);
    return;
  }
  const env = q.get("env") ?? "local";
  const envs = deps.environments?.() ?? ["local"];
  if (!envs.includes(env)) {
    sendJson(
      res,
      { ok: false, error: `"${env}" is not one of: ${envs.join(", ")}` },
      400,
    );
    return;
  }
  const mods = modulesOf(deps, project);
  if (!mods.ok) {
    sendJson(res, { ok: false, error: mods.error }, 400);
    return;
  }
  const m = mods.modules.find((x) => x.id === id);
  if (!m) {
    sendJson(
      res,
      { ok: false, error: `there is no module "${id}" in project ${project}` },
      404,
    );
    return;
  }
  let s: VerifySettings;
  try {
    s = settingsOf(deps);
  } catch (e) {
    sendJson(
      res,
      { ok: false, code: "config_invalid", error: (e as Error).message },
      422,
    );
    return;
  }
  const h = moduleHistory(listRunRecords(deps.stateDir(), project), id, env, s);
  const from = h.range?.lastPassed?.commit;
  const to = h.range?.firstFailed.commit;
  const git = deps.git ?? realGit;
  const commits =
    from && to
      ? (git.between?.(m.repoPath, from, to, RANGE_COMMITS) ?? null)
      : null;
  sendJson(res, {
    ok: true,
    project,
    name: m.name,
    kind: m.kind,
    mark: m.mark,
    ...h,
    ...(commits ? { commits } : {}),
  });
}

async function bodyOf(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    if (raw.length > 32 * 1024) return null;
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** How many past runs an estimate averages. */
const ESTIMATE_RUNS = 5;

/**
 * Issue 210: each planned module's estimate, in ms: the average of its
 * last runs on this environment that finished (passed or failed). A
 * module with no such run has none.
 */
function estimatesOf(
  stateDir: string,
  plan: VerifyPlan,
): Record<string, number> {
  const want = new Set(plan.modules.map((m) => m.id));
  const seen = new Map<string, number[]>();
  for (const r of listRunRecords(stateDir, plan.project)) {
    if (r.env !== plan.env || !hasEnded(r)) continue;
    for (const m of r.modules) {
      if (!want.has(m.id) || m.ms <= 0) continue;
      if (m.state !== "passed" && m.state !== "failed") continue;
      const xs = seen.get(m.id) ?? [];
      if (xs.length < ESTIMATE_RUNS) seen.set(m.id, [...xs, m.ms]);
    }
  }
  return Object.fromEntries(
    [...seen].map(([id, xs]) => [
      id,
      Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
    ]),
  );
}

/** Issue 210: Cancel. The person, or the agent that started the run. */
function handleCancel(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  d: VerifyServerDeps,
): void {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, { ok: false, error: "POST only" }, 405);
    return;
  }
  const q = new URL(req.url ?? "/", "http://den").searchParams;
  const agent = agentPrincipalOf(req);
  const who: Who = agent
    ? { agent: agent.actor.slice("agent:".length), project: agent.workspace }
    : {};
  const p = projectOf(d, q.get("project") ?? undefined, who);
  if (!p.ok) {
    sendJson(res, { ok: false, error: p.error }, 400);
    return;
  }
  const rec = readRunRecord(d.stateDir(), p.project, runId);
  if (!rec) {
    sendJson(
      res,
      { ok: false, code: "not_found", error: `there is no run "${runId}"` },
      404,
    );
    return;
  }
  const active = activeOf(d);
  if (!active.isLive(p.project, runId)) {
    sendJson(
      res,
      {
        ok: false,
        code: "not_running",
        error:
          rec.verdict === "running"
            ? `run ${runId} stopped when Den restarted: there is nothing to cancel`
            : `run ${runId} has ended (${rec.verdict})`,
      },
      409,
    );
    return;
  }
  const started = active.startedBy(runId);
  if (who.agent && !(started?.kind === "agent" && started.name === who.agent)) {
    sendJson(
      res,
      {
        ok: false,
        code: "not_yours",
        error: `${who.agent} can cancel only a run it started`,
      },
      403,
    );
    return;
  }
  const by: RunActor = who.agent
    ? { kind: "agent", name: who.agent }
    : { kind: "person" };
  active.cancel(p.project, runId, by);
  recordAction(
    auditActorOf(req),
    {
      verb: "verify-cancel",
      detail: `${p.project} on ${rec.env}: run ${runId}`,
    },
    principalOf(req),
  );
  sendJson(res, { ok: true, runId, cancelling: true });
}

/** The routes above; false when `pathname` is none of them. */
export async function handleVerifyRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: () => VerifyServerDeps,
): Promise<boolean> {
  const cancel = CANCEL_PATH.exec(pathname);
  if (cancel) {
    handleCancel(req, res, cancel[1], deps());
    return true;
  }
  const issue = ISSUE_PATH.exec(pathname);
  if (issue) {
    await handleIssue(req, res, issue[1], deps());
    return true;
  }
  if (handleVerifyReads(req, res, pathname, deps)) return true;
  const plan = pathname === "/api/verify/plan";
  if (!plan && pathname !== "/api/verify/run") return false;
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    sendJson(res, { ok: false, error: "POST only" }, 405);
    return true;
  }
  const body = await bodyOf(req);
  if (!body) {
    sendJson(
      res,
      {
        ok: false,
        error: "The body is JSON: { project?, env?, scope?, modules? }.",
      },
      400,
    );
    return true;
  }
  const agent = agentPrincipalOf(req);
  const who: Who = agent
    ? { agent: agent.actor.slice("agent:".length), project: agent.workspace }
    : {};
  const d = deps();
  if (plan) {
    const r = verifyPlanOf(d, body, who);
    if (!r.ok) sendJson(res, { ok: false, error: r.error }, 400);
    else
      sendJson(res, {
        ok: true,
        ...r.plan,
        estimates: estimatesOf(d.stateDir(), r.plan),
      });
    return true;
  }
  const env = body.env === undefined ? "local" : body.env;
  if (env !== "local") {
    sendJson(
      res,
      {
        ok: false,
        code: "needs_allow",
        error: `A run on ${String(env)} waits for a person's Allow: ask with POST /api/approvals { action: "verify_run", args }.`,
      },
      409,
    );
    return true;
  }
  if (body.background !== undefined && typeof body.background !== "boolean") {
    sendJson(res, { ok: false, error: "background is true or false" }, 400);
    return true;
  }
  // Issue 210: the page's Run goes on in the background (202 { runId }).
  if (body.background === true) {
    const s = await startVerify(d, body, who);
    recordAction(
      auditActorOf(req),
      s.ok
        ? {
            verb: "verify-run",
            detail: `${s.project} on ${s.env}: started run ${s.runId}`,
          }
        : {
            verb: "verify-run",
            detail: "local",
            outcome: "refused",
            reason: s.error,
          },
      principalOf(req),
    );
    sendJson(res, s, s.ok ? 202 : s.code === "run_going" ? 409 : 400);
    return true;
  }
  const r = await runVerify(d, body, who);
  recordAction(
    auditActorOf(req),
    r.ok
      ? {
          verb: "verify-run",
          detail: `${r.project} on ${r.env}: ${r.verdict} (exit ${r.exitCode}, run ${r.runId})`,
        }
      : {
          verb: "verify-run",
          detail: "local",
          outcome: "refused",
          reason: r.error,
        },
    principalOf(req),
  );
  if (!r.ok) sendJson(res, r, 400);
  else sendJson(res, r);
  return true;
}
