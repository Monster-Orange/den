/**
 * Placement (R13): where each service runs for the env being viewed.
 *
 *   services:
 *     core:
 *       runs: { local: remote, dev: remote }   # per env: local | remote
 *       target: { env: dev, account: AWS, url: https://…/health, expect: 401 }
 *
 * `runs` is "local" (on this machine), "remote" (deployed elsewhere: Den never
 * starts, stops, scans or execs it) or "none" (no runtime Den knows about).
 * When the manifest does not say, for the viewed env:
 *   - local  if the service has commands there (locally: or the repo is a
 *            compose stack);
 *   - remote if it has an HTTP health URL there and no commands;
 *   - none   otherwise.
 *
 * `target` is set only for a remote service. The manifest's target applies
 * when viewing locally or its own env; any other env stands for itself.
 *
 * Pure: callers pass the manifest, and the production test where it matters.
 */

import type {
  RawManifest,
  ServiceHealthConfig,
  ServiceManagementConfig,
  ValidationError,
} from "../types/index.js";

export type Runs = "local" | "remote" | "none";

/** What /api/services, /api/health and /api/applications serve. */
export interface PlacementTarget {
  env: string;
  account?: string;
  url?: string;
}

export interface Placement {
  runs: Runs;
  target: PlacementTarget | null;
}

/** Status codes that count as up for a target.url probe. */
export type Expect = readonly number[] | "2xx";

/** Is this env treated as production by the org? */
export type IsProduction = (env: string) => boolean;

const LOCAL = "local";

function isHttp(h: ServiceHealthConfig | undefined): h is { url: string } {
  return !!h && h.type !== "shell" && typeof h.url === "string";
}

function hasCommands(
  manifest: RawManifest,
  svc: ServiceManagementConfig,
  env: string,
): boolean {
  if (ownCommands(svc, env)) return true;
  if (env !== LOCAL) return false;
  // Every service of a compose repo runs in the local stack, and so does
  // every service of a repo whose own up runs here: one repo-level up starts
  // services that declare no commands of their own.
  return (
    !!manifest.compose ||
    Object.values(manifest.services ?? {}).some((s) => ownCommands(s, env))
  );
}

function ownCommands(svc: ServiceManagementConfig, env: string): boolean {
  const cmds = svc.commands?.[env as keyof typeof svc.commands];
  return !!cmds && Object.keys(cmds).length > 0;
}

function targetFor(svc: ServiceManagementConfig, env: string): PlacementTarget {
  const t = svc.target;
  const own = t && (env === LOCAL || t.env === env) ? t : undefined;
  const tEnv = own?.env ?? env;
  const health = svc.health?.[tEnv as keyof typeof svc.health];
  const url = own?.url ?? (isHttp(health) ? health.url : undefined);
  return {
    env: tEnv,
    ...(own?.account ? { account: own.account } : {}),
    ...(url ? { url } : {}),
  };
}

/** Where `service` of `manifest` runs when viewing `env`. */
export function servicePlacement(
  manifest: RawManifest | null | undefined,
  service: string,
  env: string,
): Placement {
  const svc = manifest?.services?.[service];
  if (!manifest || !svc) return { runs: "none", target: null };
  const explicit = svc.runs?.[env as keyof typeof svc.runs];
  if (explicit === "local") return { runs: "local", target: null };
  if (explicit === "remote")
    return { runs: "remote", target: targetFor(svc, env) };
  if (hasCommands(manifest, svc, env)) return { runs: "local", target: null };
  if (isHttp(svc.health?.[env as keyof typeof svc.health]))
    return { runs: "remote", target: targetFor(svc, env) };
  return { runs: "none", target: null };
}

/** "dev · AWS": where a remote service is, for labels. */
export function targetLabel(t: PlacementTarget): string {
  return t.account ? `${t.env} · ${t.account}` : t.env;
}

/** "☁ remote (dev)" for a remote service; "" otherwise. */
export function placementSuffix(p: Placement): string {
  return p.runs === "remote" && p.target ? `☁ remote (${p.target.env})` : "";
}

// ── Health ──────────────────────────────────────────────────────────────────

export interface HealthCheckPlan {
  placement: Placement;
  /** The check to run, or undefined for none. */
  check?: ServiceHealthConfig;
  /** Set when probing target.url: the codes that count as up. */
  expect?: Expect;
  /** A remote service's row label: its target ("dev · AWS"). */
  label?: string;
}

function expectOf(e: number | number[] | undefined): Expect {
  if (e === undefined) return "2xx";
  return Array.isArray(e) ? e : [e];
}

/**
 * The health check for `service` viewed in `env`. The one resolution path for
 * the web health row and `<cli> status`.
 *   - local / none: the env's declared check, else `composeShell` (locally);
 *   - remote: the check declared for target.env, else a GET of target.url
 *     (up when the status is in target.expect, default any 2xx).
 */
export function resolveHealthCheck(
  manifest: RawManifest | null | undefined,
  service: string,
  env: string,
  composeShell: string | null,
): HealthCheckPlan {
  const placement = servicePlacement(manifest, service, env);
  const svc = manifest?.services?.[service];
  if (placement.runs === "remote" && placement.target) {
    const t = placement.target;
    const label = targetLabel(t);
    const declared = svc?.health?.[t.env as keyof typeof svc.health];
    if (declared) return { placement, check: declared, label };
    if (svc?.target?.url && t.url === svc.target.url)
      return {
        placement,
        check: { type: "http", url: t.url },
        expect: expectOf(svc.target.expect),
        label,
      };
    return { placement, label };
  }
  const declared = svc?.health?.[env as keyof typeof svc.health];
  if (declared) return { placement, check: declared };
  if (composeShell)
    return { placement, check: { type: "shell", cmd: composeShell } };
  return { placement };
}

/** Whether `status` counts as up under `expect`. */
export function expectMatches(
  status: number | undefined,
  expect: Expect,
): boolean {
  if (status === undefined) return false;
  return expect === "2xx"
    ? status >= 200 && status < 300
    : expect.includes(status);
}

// ── Guards ──────────────────────────────────────────────────────────────────

/** A remote service whose target env counts as production. */
export function isProtectedRemote(p: Placement, isProduction: IsProduction) {
  return p.runs === "remote" && !!p.target && isProduction(p.target.env);
}

/**
 * Why Den must not run a command on `address`, or null. Every command on a
 * remote service is refused ("runs in dev (AWS); nothing to start here").
 */
export function placementRefusal(
  address: string,
  p: Placement,
  isProduction: IsProduction,
  verb: "start" | "stop" = "start",
): string | null {
  if (p.runs !== "remote") return null;
  const where = p.target
    ? `${p.target.env}${p.target.account ? ` (${p.target.account})` : ""}`
    : "a remote env";
  const prod = isProtectedRemote(p, isProduction)
    ? ", which counts as production: it is never acted on from here"
    : "";
  return `${address} runs in ${where}; nothing to ${verb} here${prod}`;
}

// ── Rollups ─────────────────────────────────────────────────────────────────

export type RollupPlacement = Runs | "hybrid";

export interface PlacementRow extends Placement {
  repo: string;
  service: string;
}

function rollup(runs: Runs[]): RollupPlacement {
  const set = new Set(runs.filter((r) => r !== "none"));
  if (set.size === 0) return "none";
  return set.size > 1 ? "hybrid" : [...set][0];
}

function envsOf(rows: Placement[]): string[] {
  return [
    ...new Set(
      rows.flatMap((r) =>
        r.runs === "remote" && r.target ? [r.target.env] : [],
      ),
    ),
  ].sort();
}

/**
 * An application's placement and a summary per repo, e.g.
 * "shop-frontend local · shop-core remote (dev)".
 */
export function rollupPlacement(rows: readonly PlacementRow[]): {
  placement: RollupPlacement;
  summary: string;
} {
  const byRepo = new Map<string, PlacementRow[]>();
  for (const r of rows) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo)!.push(r);
  }
  const parts: string[] = [];
  for (const [repo, list] of byRepo) {
    const p = rollup(list.map((r) => r.runs));
    if (p === "none") continue;
    if (p === "local") parts.push(`${repo} local`);
    else if (p === "remote")
      parts.push(`${repo} remote (${envsOf(list).join(", ")})`);
    else
      parts.push(
        `${repo} hybrid (${list
          .filter((r) => r.runs === "remote")
          .map((r) => `${r.service} remote (${r.target?.env ?? "?"})`)
          .join(", ")})`,
      );
  }
  return {
    placement: rollup(rows.map((r) => r.runs)),
    summary: parts.join(" · "),
  };
}

/** A repo's placement over its manifest's services, and its remote envs. */
export function repoPlacement(
  manifest: RawManifest | null | undefined,
  env: string,
): { placement: RollupPlacement; envs: string[] } {
  const list = Object.keys(manifest?.services ?? {}).map((s) =>
    servicePlacement(manifest, s, env),
  );
  return { placement: rollup(list.map((p) => p.runs)), envs: envsOf(list) };
}

// ── Validation ──────────────────────────────────────────────────────────────

function isMap(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Placement errors the schema cannot see: env names in `runs` and
 * `target.env` must be among `environments` (the org's), and a service run
 * remote locally must say where (`target`).
 */
export function placementErrors(
  manifest: unknown,
  environments: readonly string[],
): ValidationError[] {
  if (!isMap(manifest) || !isMap(manifest.services)) return [];
  const known = environments.join(", ");
  const unknownEnv = (path: string, env: string): ValidationError => ({
    path,
    message: `unknown environment "${env}" (known: ${known})`,
    suggestion: "Use one of the org's environments (config `environments:`).",
  });
  const errors: ValidationError[] = [];
  for (const [name, svc] of Object.entries(manifest.services)) {
    if (!isMap(svc)) continue;
    const at = `services.${name}`;
    const runs = isMap(svc.runs) ? svc.runs : {};
    for (const env of Object.keys(runs))
      if (!environments.includes(env))
        errors.push(unknownEnv(`${at}.runs.${env}`, env));
    const target = isMap(svc.target) ? svc.target : null;
    if (target && typeof target.env === "string")
      if (!environments.includes(target.env))
        errors.push(unknownEnv(`${at}.target.env`, target.env));
    if (runs[LOCAL] === "remote" && !target)
      errors.push({
        path: `${at}.target`,
        message: "runs.local is remote: say where it runs with target.env",
        suggestion: "e.g. target: { env: dev, url: https://…/health }",
      });
  }
  return errors;
}
