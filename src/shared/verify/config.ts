/**
 * Issue 208: the `verify:` block in a repo's manifest (VERIFY-SPEC
 * section 3), and the modules it declares.
 *
 *   verify:
 *     layers:
 *       web: { depends_on: [api] }
 *       api: {}
 *     modules:
 *       web/smoke: { kind: smoke }                 # built in: health URLs
 *       api/orders:
 *         kind: integration
 *         cmd: make contract-test                  # or one adapter
 *         environments: [local, staging]           # default [local]
 *         cost: heavy                              # cheap | medium | heavy
 *         watch: [api/src/**]                      # default: the whole repo
 *
 * A module is `<layer>/<name>`. Its kind is one of five (the order runs
 * by kind). It runs through `cmd`, one of Den's adapters, or an outside
 * adapter (`adapter: { name }`); smoke with neither uses the repo's
 * health URLs. Each module carries a mark: what Den can promise about
 * what it sends (VERIFY-SPEC section 6).
 */
import { z } from "zod";
import type { ValidationError } from "../types/index.js";
import { parseCron, parseWindow } from "./cron.js";

export const VERIFY_KINDS = [
  "smoke",
  "integration",
  "synthetic",
  "security",
  "performance",
] as const;
export type VerifyKind = (typeof VERIFY_KINDS)[number];

/** Den's adapters that block other methods themselves: "enforced". */
export const ENFORCING_ADAPTERS = [
  "playwright",
  "k6",
  "zap",
  "nuclei",
  "journey",
] as const;
/** Scanners that read the code only (VERIFY-SPEC section 17). */
export const CODE_SCANNERS = [
  "trivy",
  "gitleaks",
  "osv",
  "semgrep",
  "checkov",
] as const;

export const VERIFY_COSTS = ["cheap", "medium", "heavy"] as const;
export type VerifyCost = (typeof VERIFY_COSTS)[number];

/**
 * What Den can promise about a module's requests (the Allow shows it):
 * enforced (Den's adapter blocks other methods), declared read-only (a
 * command: Den can't see inside), reads code only (never touches the
 * environment), declared by the service (an outside adapter's word).
 */
export const VERIFY_MARKS = [
  "enforced",
  "declared-read-only",
  "reads-code-only",
  "declared-by-service",
] as const;
export type VerifyMark = (typeof VERIFY_MARKS)[number];

const MODULE_NAME_RE =
  /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A watch glob: relative to the repo's root, never out of it. */
const watchPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/^[A-Za-z]:/.test(p) &&
      !p.split("/").includes(".."),
    {
      message:
        "a watch path is inside the repo: a glob from its root, like web/src/**",
    },
  );

const adapterConfig = z.record(z.string(), z.unknown());

const moduleSchema = z
  .object({
    kind: z.enum(VERIFY_KINDS),
    cmd: z.string().min(1).optional(),
    results: z.string().min(1).optional(),
    environments: z.array(z.string().min(1)).min(1).optional(),
    login: z.string().min(1).optional(),
    writes: z.boolean().optional(),
    cost: z.enum(VERIFY_COSTS).optional(),
    watch: z.array(watchPath).min(1).optional(),
    // Issue 214: when it runs on its own. `env` defaults to local for a scan
    // of the code, and to the module's one environment otherwise.
    schedule: z
      .object({
        cron: z.string().min(1),
        window: z.string().optional(),
        name: z.string().min(1).max(60).optional(),
        env: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    thresholds: z.record(z.string(), z.number()).optional(),
    fail_on: z.enum(["critical", "high", "medium", "low"]).optional(),
    target: z
      .object({ build: z.string().optional(), version: z.string().optional() })
      .strict()
      .optional(),
    playwright: adapterConfig.optional(),
    k6: adapterConfig.optional(),
    zap: adapterConfig.optional(),
    nuclei: adapterConfig.optional(),
    journey: z.string().min(1).optional(),
    trivy: adapterConfig.optional(),
    gitleaks: adapterConfig.optional(),
    osv: adapterConfig.optional(),
    semgrep: adapterConfig.optional(),
    checkov: adapterConfig.optional(),
    // An outside adapter (VERIFY-SPEC section 15): its name, its config.
    adapter: z
      .object({ name: z.string().regex(NAME_RE, "an adapter's name") })
      .passthrough()
      .optional(),
  })
  .strict();

export const verifySchema = z
  .object({
    layers: z
      .record(
        z.string(),
        z
          .object({ depends_on: z.array(z.string().min(1)).optional() })
          .strict(),
      )
      .optional(),
    modules: z.record(z.string(), moduleSchema).optional(),
  })
  .strict();

export type VerifyConfig = z.infer<typeof verifySchema>;
type ModuleConfig = z.infer<typeof moduleSchema>;

/** Every way a module can run, in the order an error names them. */
const RUNNERS = [
  "cmd",
  ...ENFORCING_ADAPTERS,
  ...CODE_SCANNERS,
  "adapter",
] as const;

function runnersOf(m: ModuleConfig): string[] {
  return RUNNERS.filter((k) => m[k] !== undefined);
}

const article = (kind: string) => (/^[aeiou]/.test(kind) ? "an" : "a");

/** Each layer and the layers it depends on, every named layer listed. */
function layerGraph(v: VerifyConfig): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [l, c] of Object.entries(v.layers ?? {}))
    out[l] = [...(c.depends_on ?? [])];
  for (const name of Object.keys(v.modules ?? {})) {
    const l = name.split("/")[0];
    if (MODULE_NAME_RE.test(name) && !out[l]) out[l] = [];
  }
  return out;
}

/** A circle in the layers' depends_on, as "a → b → a", or null. */
function circleOf(g: Record<string, string[]>): string | null {
  const state = new Map<string, "on" | "done">();
  const walk = (l: string, trail: string[]): string | null => {
    if (state.get(l) === "done") return null;
    if (state.get(l) === "on")
      return [...trail.slice(trail.indexOf(l)), l].join(" → ");
    state.set(l, "on");
    for (const d of g[l] ?? []) {
      const c = walk(d, [...trail, l]);
      if (c) return c;
    }
    state.set(l, "done");
    return null;
  };
  for (const l of Object.keys(g).sort()) {
    const c = walk(l, []);
    if (c) return c;
  }
  return null;
}

/**
 * What the schema can't say about a block it accepted: names, one way to
 * run each module, environments, depends_on. `environments` undefined:
 * not checked.
 */
export function verifyErrors(
  v: VerifyConfig,
  environments?: readonly string[],
): ValidationError[] {
  const out: ValidationError[] = [];
  const at = (p: string, message: string) =>
    out.push({ path: `verify.${p}`, message });
  for (const [name, m] of Object.entries(v.modules ?? {})) {
    const p = `modules.${name}`;
    if (!MODULE_NAME_RE.test(name)) {
      at(p, "a module's name is <layer>/<name>, like web/checkout");
      continue;
    }
    const runners = runnersOf(m);
    const scanner = CODE_SCANNERS.find((s) => m[s] !== undefined);
    if (runners.length > 1)
      at(
        p,
        `give one way to run it: cmd or one adapter, not several (found: ${runners.join(", ")})`,
      );
    else if (runners.length === 0 && m.kind !== "smoke")
      at(
        p,
        `${article(m.kind)} ${m.kind} module needs cmd or an adapter (${[...ENFORCING_ADAPTERS, ...CODE_SCANNERS].join(", ")}, or adapter: { name })`,
      );
    if (scanner && m.kind !== "security")
      at(p, `${scanner} scans the code: its kind is security`);
    if (m.results !== undefined && m.cmd === undefined)
      at(`${p}.results`, "results goes with cmd: the file the command writes");
    if (m.fail_on !== undefined && m.kind !== "security")
      at(`${p}.fail_on`, "fail_on is for security modules");
    if (m.schedule) scheduleErrors(m, `${p}.schedule`, at);
    if (environments)
      for (const e of m.environments ?? [])
        if (!environments.includes(e))
          at(
            `${p}.environments`,
            `there is no environment "${e}" (environments: ${environments.join(", ")})`,
          );
  }
  const g = layerGraph(v);
  for (const [l, c] of Object.entries(v.layers ?? {}))
    for (const d of c.depends_on ?? [])
      if (!g[d])
        at(
          `layers.${l}.depends_on`,
          `there is no layer "${d}" (layers: ${Object.keys(g).sort().join(", ")})`,
        );
  const circle = circleOf(g);
  if (circle) at("layers", `the layers depend in a circle: ${circle}`);
  return out;
}

/** Issue 214: a schedule's cron, window and environment, checked. */
function scheduleErrors(
  m: ModuleConfig,
  p: string,
  at: (p: string, message: string) => void,
): void {
  const s = m.schedule!;
  try {
    parseCron(s.cron);
  } catch (e) {
    at(`${p}.cron`, (e as Error).message);
  }
  try {
    parseWindow(s.window);
  } catch (e) {
    at(`${p}.window`, (e as Error).message);
  }
  const envs = m.environments;
  if (s.env !== undefined && envs && !envs.includes(s.env))
    at(`${p}.env`, `the module runs on ${envs.join(", ")}, not "${s.env}"`);
  if (s.env === undefined && envs && envs.length > 1)
    at(
      `${p}.env`,
      `the module runs on ${envs.join(", ")}: say which one the schedule uses`,
    );
}

/** The environment a module's schedule runs on. */
function scheduleEnv(
  s: NonNullable<ModuleConfig["schedule"]>,
  environments: string[] | "all",
): string {
  if (s.env) return s.env;
  return environments === "all" ? "local" : environments[0];
}

/** One module, as a plan and a run use it. */
export interface VerifyModule {
  /** `<repo>:<layer>/<name>`. */
  id: string;
  repo: string;
  repoPath: string;
  /** `<layer>/<name>`. */
  name: string;
  layer: string;
  kind: VerifyKind;
  /** cmd, smoke (built in), one of Den's adapters, or an outside one's name. */
  adapter: string;
  mark: VerifyMark;
  /** Where it may run; "all" for a scan of the code. */
  environments: string[] | "all";
  cost?: VerifyCost;
  /** Globs from the repo's root; none: any change in the repo. */
  watch?: string[];
  cmd?: string;
  results?: string;
  /** Issue 212: a scan's own threshold (it may only tighten the org's). */
  failOn?: "critical" | "high" | "medium" | "low";
  writes: boolean;
  /** Built-in smoke: the repo's HTTP health URLs, by environment. */
  healthUrls: Record<string, string[]>;
  /** Issue 214: when it runs on its own, and where. */
  schedule?: { cron: string; window?: string; name?: string; env: string };
}

function adapterOf(m: ModuleConfig): string {
  if (m.adapter) return m.adapter.name;
  return runnersOf(m)[0] ?? "smoke";
}

function markOf(m: ModuleConfig, layer: string): VerifyMark {
  if (m.adapter) return "declared-by-service";
  if (layer === "code" || CODE_SCANNERS.some((s) => m[s] !== undefined))
    return "reads-code-only";
  if (m.cmd !== undefined) return "declared-read-only";
  return "enforced";
}

/** What Verify reads of a manifest. */
export interface ManifestLike {
  services?: Record<
    string,
    { health?: Partial<Record<string, unknown>> } | undefined
  >;
  verify?: unknown;
}

function healthUrlsOf(manifest: ManifestLike): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const svc of Object.values(manifest.services ?? {}))
    for (const [env, h] of Object.entries(svc?.health ?? {})) {
      const url = (h as { url?: unknown } | undefined)?.url;
      if (typeof url === "string" && /^https?:\/\//.test(url))
        (out[env] ??= []).push(url);
    }
  return out;
}

/**
 * A repo's modules from its manifest's `verify:` block, with each layer's
 * depends_on. A bad block gives its errors and no modules.
 */
export function readVerifyModules(
  r: { repo: string; repoPath: string; manifest: ManifestLike },
  environments?: readonly string[],
): {
  modules: VerifyModule[];
  layers: Record<string, string[]>;
  errors: ValidationError[];
} {
  if (r.manifest.verify === undefined || r.manifest.verify === null)
    return { modules: [], layers: {}, errors: [] };
  const parsed = verifySchema.safeParse(r.manifest.verify);
  if (!parsed.success)
    return {
      modules: [],
      layers: {},
      errors: parsed.error.issues.map((i) => ({
        path: ["verify", ...i.path.map(String)].join("."),
        message: i.message,
      })),
    };
  const v = parsed.data;
  const errors = verifyErrors(v, environments);
  if (errors.length) return { modules: [], layers: {}, errors };
  const healthUrls = healthUrlsOf(r.manifest);
  const modules = Object.entries(v.modules ?? {}).map(
    ([name, m]): VerifyModule => {
      const layer = name.split("/")[0];
      const mark = markOf(m, layer);
      const environments: string[] | "all" =
        m.environments ?? (mark === "reads-code-only" ? "all" : ["local"]);
      return {
        id: `${r.repo}:${name}`,
        repo: r.repo,
        repoPath: r.repoPath,
        name,
        layer,
        kind: m.kind,
        adapter: adapterOf(m),
        mark,
        environments,
        ...(m.cost ? { cost: m.cost } : {}),
        ...(m.watch ? { watch: m.watch } : {}),
        ...(m.cmd !== undefined ? { cmd: m.cmd } : {}),
        ...(m.results !== undefined ? { results: m.results } : {}),
        ...(m.fail_on !== undefined ? { failOn: m.fail_on } : {}),
        writes: m.writes === true,
        healthUrls,
        ...(m.schedule
          ? {
              schedule: {
                cron: m.schedule.cron,
                ...(m.schedule.window !== undefined
                  ? { window: m.schedule.window }
                  : {}),
                ...(m.schedule.name ? { name: m.schedule.name } : {}),
                env: scheduleEnv(m.schedule, environments),
              },
            }
          : {}),
      };
    },
  );
  return { modules, layers: layerGraph(v), errors: [] };
}
