/**
 * Security scan planning (security pillar) — PURE policy + command building.
 *
 * Nothing here touches the network or docker: it decides WHAT a ZAP run may
 * be (modes per env, target hosts, exclusions) and renders the `docker run`
 * argv for it. The runner (run.ts) is the only thing that executes the
 * result, which keeps every safety rule unit-testable. The one input read
 * from disk is the owned-host allowlist (config/den.yml), and every
 * function that uses it takes it as an injectable parameter.
 *
 * Safety posture, in order of precedence:
 * 1. MODE_CEILING is code, not config: a manifest can narrow what an env
 *    allows but never widen it (production = passive `baseline` only;
 *    local, dev, sandbox & staging = full).
 * 2. Targets must be http(s), https-only outside dev/sandbox/local, and the
 *    host must be on the owned-host allowlist in EVERY env, local included
 *    (config/den.yml `security.owned_hosts`, default: none) — a manifest typo or hostile `hosts:` entry can't point
 *    ZAP at a system we don't own.
 * 3. Credentials never ride argv: the Authorization header value is passed
 *    through the child env (`-e NAME` with no value) so it can't leak via
 *    the process list.
 */

import * as path from "path";
import { readSecurityOwnedHosts } from "../../shared/den-config.js";
import type {
  Environment,
  SecurityMode,
  SecurityServiceConfig,
} from "../../shared/types/index.js";

import { envKey, product } from "../../shared/product.js";
// ── Mode policy ──────────────────────────────────────────────────────────────

const ALL_MODES: readonly SecurityMode[] = ["baseline", "api", "full"];

/** Hard per-env ceiling — see module header (1). */
export const MODE_CEILING: Readonly<
  Record<Environment, readonly SecurityMode[]>
> = {
  local: ALL_MODES,
  dev: ALL_MODES,
  sandbox: ALL_MODES,
  staging: ALL_MODES,
  // beta is passive only; prod is never scanned.
  beta: ["baseline"],
  prod: [],
  production: ["baseline"],
};

/** Defaults when a service declares no `modes:` for the env. */
export const DEFAULT_MODES: Readonly<
  Record<Environment, readonly SecurityMode[]>
> = MODE_CEILING;

/** Modes this service may run in `env`: manifest (or default) ∩ ceiling. */
export function allowedModes(
  config: SecurityServiceConfig,
  env: Environment,
): SecurityMode[] {
  const requested = config.modes?.[env] ?? DEFAULT_MODES[env];
  return requested.filter((mode) => MODE_CEILING[env].includes(mode));
}

// ── Target resolution ────────────────────────────────────────────────────────

/** Subset of EnvironmentConfig the resolver reads (keeps tests light). */
export interface SecurityEnvConfigLike {
  baseUrls: { web: string; api: string; services?: Record<string, string> };
}

/** Env var that extends the owned-host allowlist for one shell (comma-separated). */
export const EXTRA_HOSTS_ENV = `${envKey("SECURITY_EXTRA_HOSTS")}`;

/**
 * The owned-host allowlist: config/den.yml `security.owned_hosts` plus
 * DEN_SECURITY_EXTRA_HOSTS. An entry matches that exact host or any
 * subdomain of it (a leading "." is ignored).
 */
export function ownedHostSuffixes(
  configured: readonly string[] = readSecurityOwnedHosts(),
  extra: string | undefined = process.env[EXTRA_HOSTS_ENV],
): string[] {
  const added = (extra ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  return [...new Set([...configured, ...added])];
}

export function isOwnedHost(
  hostname: string,
  suffixes: readonly string[] = ownedHostSuffixes(),
): boolean {
  const host = hostname.toLowerCase();
  return suffixes.some((s) => {
    const bare = s.replace(/^\./, "");
    return bare.length > 0 && (host === bare || host.endsWith(`.${bare}`));
  });
}

/** Normalize to an origin+path with no trailing slash; throws on bad input. */
function normalizeTarget(
  raw: string,
  env: Environment,
  suffixes: readonly string[],
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Security target "${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Security target "${raw}" must be http(s).`);
  }
  if (
    url.protocol === "http:" &&
    env !== "dev" &&
    env !== "sandbox" &&
    env !== "local"
  ) {
    throw new Error(
      `Security target "${raw}" must be https outside dev/sandbox/local (env=${env}).`,
    );
  }
  if (!isOwnedHost(url.hostname, suffixes)) {
    throw new Error(
      `Refusing to scan "${url.hostname}": not an owned host (add it to ` +
        `security.owned_hosts in ${product().configFile}). Allowed: ` +
        `${suffixes.length > 0 ? suffixes.join(", ") : "(none)"}.`,
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Resolve the base URLs to scan for `env`. Explicit `hosts[env]` wins over
 * `baseUrlKey`, which reads `baseUrls.api` / `baseUrls.web` from the
 * den environment config (config/environments/<env>.json). No URL is
 * ever invented.
 */
export function resolveTargets(
  config: SecurityServiceConfig,
  env: Environment,
  envConfig: SecurityEnvConfigLike,
  suffixes: readonly string[] = ownedHostSuffixes(),
): string[] {
  const explicit = config.hosts?.[env];
  let raw: string[];
  if (explicit !== undefined && explicit.length > 0) {
    raw = explicit;
  } else if (config.baseUrlKey === "api") {
    raw = [envConfig.baseUrls.api];
  } else if (config.baseUrlKey === "web") {
    raw = [envConfig.baseUrls.web];
  } else {
    throw new Error(`No security target resolvable for env "${env}".`);
  }
  return [...new Set(raw.map((r) => normalizeTarget(r, env, suffixes)))];
}

// ── ZAP command ──────────────────────────────────────────────────────────────

/** Pinned ZAP image; override with DEN_ZAP_IMAGE for a vetted digest. */
export const ZAP_IMAGE = "ghcr.io/zaproxy/zaproxy:stable";

/** Always excluded: spidering an authenticated session must not log it out. */
export const DEFAULT_EXCLUDES: readonly string[] = ["(?i).*/(log|sign)out.*"];

/** Wall-clock cap per scan; the runner kills the container past this. */
export const SCAN_TIMEOUT_MS: Readonly<Record<SecurityMode, number>> = {
  baseline: 10 * 60_000,
  api: 30 * 60_000,
  full: 60 * 60_000,
};

const SCAN_SCRIPT: Readonly<Record<SecurityMode, string>> = {
  baseline: "zap-baseline.py",
  api: "zap-api-scan.py",
  full: "zap-full-scan.py",
};

export const AUTH_HEADER_ENV = "ZAP_AUTH_HEADER_VALUE";

export interface ZapPlanInput {
  mode: SecurityMode;
  target: string;
  /** Absolute dir mounted rw at /zap/wrk; ZAP writes report.json/html here. */
  reportDir: string;
  /** Absolute path of a local OpenAPI file (mounted ro), if the spec is a file. */
  openapiFile?: string;
  /** Resolved OpenAPI URL (already template-expanded), if the spec is a URL. */
  openapiUrl?: string;
  exclude?: readonly string[];
  /** True when the run injects an Authorization header via AUTH_HEADER_ENV. */
  authenticated: boolean;
}

export interface ZapPlan {
  command: "docker";
  args: string[];
  /** Env var NAMES that must be present in the child env (values never in argv). */
  envPassthrough: string[];
  timeoutMs: number;
}

/**
 * Resolve the manifest `openapi` value: a URL template (`{baseUrl}` expands
 * to the target) or a repo-relative file path (resolved under `repoPath`).
 */
export function resolveOpenapi(
  openapi: string | undefined,
  target: string,
  repoPath: string,
): { file?: string; url?: string } {
  if (openapi === undefined) return {};
  if (/^(https?:\/\/|\{baseUrl\})/.test(openapi)) {
    return { url: openapi.replace(/\{baseUrl\}/g, target) };
  }
  const file = path.resolve(repoPath, openapi);
  if (!file.startsWith(path.resolve(repoPath) + path.sep)) {
    throw new Error(`openapi path "${openapi}" escapes the repo checkout.`);
  }
  return { file };
}

/**
 * `*.localhost` names resolve to loopback on the engineer's machine, but
 * inside the ZAP container they would resolve to the container itself (or
 * not at all). Map each one onto the docker host so ZAP reaches the local
 * edge. ZAP does not verify upstream TLS, so the edge's own CA is not needed.
 */
function hostGatewayArgs(urls: readonly (string | undefined)[]): string[] {
  const hosts = new Set<string>();
  for (const raw of urls) {
    if (raw === undefined) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host === "localhost" || host.endsWith(".localhost")) hosts.add(host);
    } catch {
      /* not a URL (e.g. a mounted spec path) */
    }
  }
  return [...hosts].sort().flatMap((h) => ["--add-host", `${h}:host-gateway`]);
}

/** Build the `docker run` argv for one scan. Throws on an unrunnable plan. */
export function buildZapPlan(input: ZapPlanInput): ZapPlan {
  const { mode, target } = input;
  const args: string[] = [
    "run",
    "--rm",
    "-v",
    `${input.reportDir}:/zap/wrk:rw`,
  ];
  const envPassthrough: string[] = [];

  args.push(
    ...hostGatewayArgs([target, mode === "api" ? input.openapiUrl : undefined]),
  );

  if (input.authenticated) {
    args.push("-e", "ZAP_AUTH_HEADER=Authorization", "-e", AUTH_HEADER_ENV);
    envPassthrough.push(AUTH_HEADER_ENV);
  }

  let scanTarget = target;
  if (mode === "api") {
    if (input.openapiFile !== undefined) {
      const mounted = `/zap/spec/${path.basename(input.openapiFile)}`;
      args.push("-v", `${input.openapiFile}:${mounted}:ro`);
      scanTarget = mounted;
    } else if (input.openapiUrl !== undefined) {
      scanTarget = input.openapiUrl;
    } else {
      throw new Error('mode "api" requires an openapi spec for the service.');
    }
  }

  args.push(process.env.DEN_ZAP_IMAGE ?? ZAP_IMAGE, SCAN_SCRIPT[mode]);
  args.push("-t", scanTarget);
  if (mode === "api") {
    // -O overrides the host in the spec so requests hit the resolved target.
    args.push("-f", "openapi", "-O", target);
  }
  // -I: ZAP's own warn/fail exit codes are ignored; the verdict is computed
  // from report.json by the runner. -m bounds spidering (minutes).
  args.push("-J", "report.json", "-r", "report.html", "-I");
  if (mode !== "api") args.push("-m", mode === "full" ? "10" : "3");

  const excludes = [...DEFAULT_EXCLUDES, ...(input.exclude ?? [])];
  const zapOpts = excludes
    .map(
      (re, i) =>
        `-config globalexcludeurl.url_list.url(${i}).regex=${re} ` +
        `-config globalexcludeurl.url_list.url(${i}).enabled=true`,
    )
    .join(" ");
  args.push("-z", zapOpts);

  return {
    command: "docker",
    args,
    envPassthrough,
    timeoutMs: SCAN_TIMEOUT_MS[mode],
  };
}

// ── Report summary ───────────────────────────────────────────────────────────

export interface AlertCounts {
  high: number;
  medium: number;
  low: number;
  informational: number;
}

/**
 * Count alerts by risk from a ZAP traditional-JSON report. Throws on a
 * report that isn't ZAP's shape — a malformed report must read as an infra
 * error, never as "zero findings".
 */
export function summarizeZapReport(report: unknown): AlertCounts {
  const sites = (report as { site?: unknown })?.site;
  if (!Array.isArray(sites)) {
    throw new Error("ZAP report has no `site` array — not a ZAP JSON report.");
  }
  const counts: AlertCounts = { high: 0, medium: 0, low: 0, informational: 0 };
  for (const site of sites) {
    const alerts = (site as { alerts?: unknown }).alerts;
    if (!Array.isArray(alerts)) continue;
    for (const alert of alerts) {
      switch (String((alert as { riskcode?: unknown }).riskcode)) {
        case "3":
          counts.high += 1;
          break;
        case "2":
          counts.medium += 1;
          break;
        case "1":
          counts.low += 1;
          break;
        default:
          counts.informational += 1;
      }
    }
  }
  return counts;
}

/** A scan FAILS on any High alert; lower risks are reported, not gated. */
export function scanFailed(counts: AlertCounts): boolean {
  return counts.high > 0;
}
