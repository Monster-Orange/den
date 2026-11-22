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
 *   /api/verify/runs/:id?project=       one run's record
 *   /api/verify/runs/:id/report?project=&module=
 *                                       a module's kept output, as text
 *
 * Issue 212 (GET):
 *   /api/verify/modules/:module/history?project=&env=&limit=
 *                                       its runs, first failing range, flaky
 *   /api/verify/runs/:id/modules/:module/findings?project=
 *                                       a scan's findings and threshold
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
  runPlan,
  spawnCmd,
  type RunDeps,
  type RunResult,
} from "../../shared/verify/run.js";
import { verifyOverview } from "../../shared/verify/overview.js";
import { moduleHistory } from "../../shared/verify/history.js";
import {
  DEFAULT_VERIFY_SETTINGS,
  type VerifySettings,
} from "../../shared/verify/settings.js";
import {
  listRunRecords,
  readRunRecord,
  type RunActor,
} from "../../shared/verify/records.js";
import type { DetailKey, HeldOpCheck } from "../cli/agent-ops.js";
import type { AskedBy } from "./approvals.js";
import { recordAction } from "./audit.js";
import { readBody, sendJson } from "./http-helpers.js";
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
  /** Issue 212: the org config's `verify:` settings (defaults when unset). */
  settings?: () => VerifySettings;
}

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

/** Runs the plan for these args (the held write's run, and local's). */
/**
 * Runs the plan for an ask. `asked`: a held run's request (the agent that
 * asked, the session that allowed it); without it, whoever called started
 * it (an agent, or a person). The run's record keeps both (issue 209).
 */
export async function runVerify(
  d: VerifyServerDeps,
  raw: Record<string, unknown>,
  who: Who = {},
  asked?: AskedBy,
): Promise<RunResult | { ok: false; error: string }> {
  const r = verifyPlanOf(d, raw, who);
  if (!r.ok) return r;
  const git = d.git ?? realGit;
  const agent = asked ? asked.agent : who.agent;
  const startedBy: RunActor = agent
    ? { kind: "agent", name: agent }
    : { kind: "person" };
  const allowedBy: RunActor | undefined = asked
    ? asked.decidedBy?.startsWith("auto:")
      ? { kind: "den" }
      : { kind: "person" }
    : undefined;
  return runPlan(r.plan, {
    stateDir: d.stateDir(),
    head: (p) => git.head(p),
    runCmd: d.runCmd ?? spawnCmd,
    probe: d.probe ?? httpProbe,
    by: { startedBy, ...(allowedBy ? { allowedBy } : {}) },
    retries: settingsOf(d).retries,
    failOn: settingsOf(d).failOn,
  });
}

const settingsOf = (d: VerifyServerDeps): VerifySettings =>
  d.settings?.() ?? { ...DEFAULT_VERIFY_SETTINGS };

/** Issue 212: a module's history, and one run's findings for a module. */
const HISTORY_PATH = /^\/api\/verify\/modules\/([^/]+)\/history$/;
const FINDINGS_PATH =
  /^\/api\/verify\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})\/modules\/([^/]+)\/findings$/;

const decoded = (v: string): string | null => {
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
};

const RUN_PATH =
  /^\/api\/verify\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(\/report)?$/;

/** Issue 209: the page's reads (GET); false when `pathname` is none of them. */
function handleVerifyReads(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: () => VerifyServerDeps,
): boolean {
  const run = RUN_PATH.exec(pathname);
  const hist = HISTORY_PATH.exec(pathname);
  const finds = FINDINGS_PATH.exec(pathname);
  if (pathname !== "/api/verify/overview" && !run && !hist && !finds)
    return false;
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
    const module = decoded(hist[1]);
    const env = q.get("env") ?? "local";
    if (!module || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(env)) {
      sendJson(
        res,
        { ok: false, error: "name a module and an environment" },
        400,
      );
      return true;
    }
    const s = settingsOf(deps);
    const raw = q.get("limit");
    const limit = raw === null ? s.historyLimit : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      sendJson(
        res,
        { ok: false, error: "limit is a whole number, 1 to 1000" },
        400,
      );
      return true;
    }
    sendJson(res, {
      ok: true,
      ...moduleHistory(
        listRunRecords(stateDir, p.project, Math.max(limit, s.flakyWindow) * 4),
        module,
        env,
        { ...s, historyLimit: limit },
      ),
    });
    return true;
  }
  if (finds) {
    const rec = readRunRecord(stateDir, p.project, finds[1]);
    const name = decoded(finds[2]);
    const m = rec?.modules.find((x) => x.name === name || x.id === name);
    if (!rec || !m) {
      sendJson(
        res,
        { ok: false, error: `there is no such run or module` },
        404,
      );
      return true;
    }
    if (!m.findings) {
      sendJson(
        res,
        { ok: false, error: `${m.name} wrote no findings in run ${rec.runId}` },
        404,
      );
      return true;
    }
    sendJson(res, {
      ok: true,
      runId: rec.runId,
      module: m.name,
      state: m.state,
      commit: rec.commit ?? null,
      failOn: m.findings.failOn,
      counts: m.findings.counts,
      findings: m.findings.list,
      report: !!m.tail?.length,
    });
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
    sendJson(res, { ok: true, ...rec });
    return true;
  }
  const name = q.get("module") ?? "";
  const tail = rec.modules.find((m) => m.name === name || m.id === name)?.tail;
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

/** The routes above; false when `pathname` is none of them. */
export async function handleVerifyRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: () => VerifyServerDeps,
): Promise<boolean> {
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
    else sendJson(res, { ok: true, ...r.plan });
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
