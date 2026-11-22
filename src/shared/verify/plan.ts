/**
 * Issue 208: the plan (VERIFY-SPEC sections 5 to 7): exactly what a run
 * would do on one environment, in order, before anything starts. The
 * same plan answers the page, the CLI, an agent and the person's Allow.
 *
 * Scope:
 *   changed (the default)  smoke, plus the modules whose `watch` paths
 *                          changed since their latest result here (no
 *                          `watch`: any change in the repo), plus every
 *                          module of the layers that depend on theirs.
 *                          Nothing changed anywhere: nothing to run, not
 *                          even smoke ("nothing ran", exit 3)
 *   all                    every module of the project, by choice only
 *   chosen modules         exactly those (what a person allowed)
 *
 * Order: scans of the code first (they never touch the environment), then
 * by kind (smoke, integration, synthetic, security, performance), a layer
 * after the layers it depends on. A module that can't run here says why
 * before anything starts. Pure: the caller hands in what changed.
 */
import type { ChangeState } from "./changes.js";
import { VERIFY_KINDS, type VerifyMark, type VerifyModule } from "./config.js";

export type VerifyScope = "changed" | "all";
export const VERIFY_SCOPES: readonly VerifyScope[] = ["changed", "all"];

/** Why a module is in the plan. */
export type PlanWhy =
  | "smoke"
  | "changed"
  | "never-checked"
  | "depends"
  | "chosen"
  | "all";

/**
 * Why it can't run here: not listed for this environment; production
 * (its opt-in comes later; scans of the code are fine); an adapter Den
 * doesn't run yet; built-in smoke with no health URL here.
 */
export type CantReason =
  | "environment"
  | "production"
  /** Issue 214: a scheduled production run takes only checks Den keeps read-only. */
  | "production-declared"
  | "adapter-later"
  | "no-health-url";

export interface PlanModule extends VerifyModule {
  why: PlanWhy;
}

export interface CantRunModule extends PlanModule {
  reason: CantReason;
}

export interface VerifyPlan {
  project: string;
  env: string;
  /** Any environment but local: a run waits for a person's Allow. */
  shared: boolean;
  allow: "needed" | "none";
  scope: VerifyScope;
  /** The module ids asked for, when it was a choice of modules. */
  chosen?: string[];
  /** What runs, in order. */
  modules: PlanModule[];
  cantRun: CantRunModule[];
  /** Each layer and the layers it depends on (a run blocks by them). */
  layers: Record<string, string[]>;
  nothingToRun: boolean;
  /** Issue 214: production, under the read-only method rule. */
  readOnly: boolean;
  /** Issue 214: how the run started; by hand when absent. */
  trigger?: "schedule";
  /** Why nothing runs: nothing changed, none declared, none can run here. */
  reason?: "unchanged" | "none-declared" | "none-here";
}

export interface PlanInput {
  project: string;
  env: string;
  scope?: VerifyScope;
  /** Module ids (repo:layer/name) or names (layer/name): exactly these. */
  chosen?: string[];
  modules: readonly VerifyModule[];
  layers: Record<string, string[]>;
  /** By module id; a module not listed counts as never checked. */
  changes: Record<string, ChangeState>;
  /** Issue 214: a schedule's run. */
  trigger?: "schedule";
}

/** Den runs these itself today: a command, and built-in smoke. */
const RUNS_NOW = new Set(["cmd", "smoke"]);

export const PRODUCTION = "production";

function cantReason(
  m: VerifyModule,
  env: string,
  trigger?: "schedule",
): CantReason | null {
  if (m.environments !== "all" && !m.environments.includes(env))
    return "environment";
  if (env === PRODUCTION) {
    if (trigger === "schedule") {
      // Issue 214: on a schedule, production takes built-in smoke (GET and
      // HEAD, through the guard) and built-in code scans; any command, and
      // anything else Den can't see inside, is left out.
      if (m.cmd !== undefined) return "production-declared";
      if (
        m.mark !== "reads-code-only" &&
        !(m.mark === "enforced" && m.adapter === "smoke")
      )
        return "production-declared";
    } else if (m.mark !== "reads-code-only") return "production";
  }
  if (!RUNS_NOW.has(m.adapter)) return "adapter-later";
  if (m.adapter === "smoke" && !(m.healthUrls[env] ?? []).length)
    return "no-health-url";
  return null;
}

/** Layers in an order where each comes after those it depends on. */
function layerOrder(layers: Record<string, string[]>): Map<string, number> {
  const order = new Map<string, number>();
  const visit = (l: string, on: Set<string>) => {
    if (order.has(l) || on.has(l)) return;
    on.add(l);
    for (const d of [...(layers[l] ?? [])].sort()) visit(d, on);
    order.set(l, order.size);
  };
  for (const l of Object.keys(layers).sort()) visit(l, new Set());
  return order;
}

/** The layers that depend on `l`, directly or through others. */
function dependents(layers: Record<string, string[]>, l: string): string[] {
  const out = new Set<string>();
  const walk = (x: string) => {
    for (const [k, deps] of Object.entries(layers))
      if (deps.includes(x) && !out.has(k)) {
        out.add(k);
        walk(k);
      }
  };
  walk(l);
  return [...out];
}

function sortModules<T extends VerifyModule>(
  xs: T[],
  layers: Record<string, string[]>,
): T[] {
  const lo = layerOrder(layers);
  const rank = (m: VerifyModule) =>
    m.mark === "reads-code-only" ? 0 : 1 + VERIFY_KINDS.indexOf(m.kind);
  return [...xs].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (lo.get(a.layer) ?? lo.size) - (lo.get(b.layer) ?? lo.size) ||
      a.name.localeCompare(b.name) ||
      a.repo.localeCompare(b.repo),
  );
}

export function planVerify(input: PlanInput): VerifyPlan {
  const scope = input.scope ?? "changed";
  const { env, layers } = input;
  const all = input.modules;
  let picked: PlanModule[];
  let reason: VerifyPlan["reason"];
  if (input.chosen) {
    const ids = new Set<string>();
    for (const c of input.chosen) {
      const hits = all.filter((m) => m.id === c || m.name === c);
      if (!hits.length) throw new Error(`there is no module "${c}"`);
      for (const h of hits) ids.add(h.id);
    }
    picked = all
      .filter((m) => ids.has(m.id))
      .map((m) => ({ ...m, why: "chosen" as const }));
  } else if (scope === "all") {
    picked = all.map((m) => ({ ...m, why: "all" as const }));
  } else {
    const state = (m: VerifyModule) => input.changes[m.id] ?? "never";
    const touched = all.filter((m) => state(m) !== "unchanged");
    if (!touched.length) {
      picked = [];
      if (all.length) reason = "unchanged";
    } else {
      // The layers of what changed (smoke aside), and those depending on them.
      const affected = new Set<string>();
      for (const m of touched)
        if (m.kind !== "smoke")
          for (const l of dependents(layers, m.layer)) affected.add(l);
      picked = [];
      for (const m of all) {
        const s = state(m);
        const why: PlanWhy | null =
          m.kind === "smoke"
            ? "smoke"
            : s === "changed"
              ? "changed"
              : s === "never"
                ? "never-checked"
                : affected.has(m.layer)
                  ? "depends"
                  : null;
        if (why) picked.push({ ...m, why });
      }
    }
  }
  const modules: PlanModule[] = [];
  const cantRun: CantRunModule[] = [];
  for (const m of picked) {
    const r = cantReason(m, env, input.trigger);
    if (r) cantRun.push({ ...m, reason: r });
    else modules.push(m);
  }
  if (!all.length) reason = "none-declared";
  else if (!modules.length && !reason) reason = "none-here";
  const shared = env !== "local";
  return {
    project: input.project,
    env,
    shared,
    allow: shared ? "needed" : "none",
    scope,
    ...(input.chosen ? { chosen: picked.map((m) => m.id) } : {}),
    modules: sortModules(modules, layers),
    cantRun: sortModules(cantRun, layers),
    layers,
    nothingToRun: modules.length === 0,
    readOnly: env === PRODUCTION,
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(modules.length === 0 && reason ? { reason } : {}),
  };
}

/** A mark as the Allow says it in English. */
export const MARK_WORDS: Readonly<Record<VerifyMark, string>> = {
  enforced: "enforced",
  "declared-read-only": "declared read-only",
  "reads-code-only": "reads code only",
  "declared-by-service": "declared by the service",
};
