/**
 * den-init — interactive wizard to scaffold a new .den.yml.
 *
 * Exported pure functions (buildInitManifest, detectStackConfig,
 * formatManifestYaml) are unit-tested independently of the interactive flow.
 * The runInit() function drives the interactive CLI prompts.
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";
import * as yaml from "yaml";
import type { RawManifest, Environment } from "../../shared/types/index.js";
import { listMakeTargets } from "../../shared/environment-manager/make-targets.js";
import { readDenConfig } from "../../shared/den-config.js";
import { getInvokeCwd } from "../../shared/paths.js";
import { loadAwsProfiles } from "../../shared/environment/aws-profiles.js";

import { product } from "../../shared/product.js";
// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceInitConfig {
  name: string;
  healthUrl?: string;
  healthCmd?: string;
}

export interface InitOptions {
  name: string;
  services: ServiceInitConfig[];
  entrypoint?: string;
  /**
   * Standard make targets actually present in the repo root Makefile. When given,
   * `commands.local` reflects the real targets (adding `setup`, dropping absent
   * ones) instead of a blind up/down/restart default.
   */
  makeTargets?: string[];
  /**
   * Non-local health-URL templates (config `env_health_urls`), `{repo}`
   * substituted with `name`. Applied to the PRIMARY service only (the single
   * service, or the entrypoint of a multi-service repo) — deployed ALBs exist
   * per system, not per sidecar. These feed the TEST scope: smoke/perf resolve
   * each env's base URL from the manifest's `health.<env>.url`.
   */
  envHealthUrls?: Record<string, string>;
  /**
   * CloudWatch log groups detected per deployed env (aws describe-log-groups).
   * Applied to the PRIMARY service only; feeds the /logs page's env dropdown.
   */
  envLogGroups?: Record<string, string>;
}

/**
 * The manifest shape this wizard writes: a RawManifest plus the explicit
 * `version` header field (serialised first by formatManifestYaml). RawManifest
 * itself has no `version` — the parser treats absence as version 1.
 */
export type InitManifest = RawManifest & { version: number };

export interface StackDetectionResult {
  services: string[];
  ports?: Record<string, number>;
  /**
   * Repo-level local port from the stack v2 `config.local.PORT` (falling back to
   * `config.defaults.PORT`). This is the port the service listens on inside its
   * opctl container in local dev — the basis for the local health-check URL.
   */
  localPort?: number;
  /** Project language (e.g. "go", "python"). From stack.yml v2 `language` field. */
  language?: string;
}

// ── detectStackConfig ─────────────────────────────────────────────────────────

/**
 * Check if the target directory has an stack.yml (or .stack.yml) file and
 * extract service info + optional language field.
 * Checks: stack.yml → .stack.yml → .stack.yaml (first found wins).
 * Returns null when no usable file is found.
 */
export function detectStackConfig(
  repoPath: string,
): StackDetectionResult | null {
  const candidates = [
    path.join(repoPath, "stack.yml"),
    path.join(repoPath, ".stack.yml"),
    path.join(repoPath, ".stack.yaml"),
  ];

  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return null;

  try {
    const raw = fs.readFileSync(found, "utf-8") as string;
    const parsed = yaml.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;

    // stack v1 shape: a top-level `services:` map with per-service `port`.
    let serviceNames: string[] = [];
    let ports: Record<string, number> | undefined;
    if (parsed.services && typeof parsed.services === "object") {
      const servicesBlock = parsed.services as Record<
        string,
        Record<string, unknown>
      >;
      serviceNames = Object.keys(servicesBlock);
      const collected: Record<string, number> = {};
      for (const [svcName, svcConfig] of Object.entries(servicesBlock)) {
        if (typeof svcConfig?.port === "number") {
          collected[svcName] = svcConfig.port;
        }
      }
      if (Object.keys(collected).length > 0) ports = collected;
    }

    // stack v2 shape: the local port lives under `config.local.PORT` (a repo-level
    // env var), falling back to `config.defaults.PORT`. yaml.parse does NOT resolve
    // the `<<: *defaults` merge, so we read both explicitly.
    const localPort = extractLocalPort(parsed);

    const language =
      typeof parsed.language === "string" ? parsed.language : undefined;

    // Nothing usable found → behave as before (no detection).
    if (
      serviceNames.length === 0 &&
      localPort === undefined &&
      language === undefined
    ) {
      return null;
    }

    return {
      services: serviceNames,
      ports,
      localPort,
      language,
    };
  } catch {
    return null;
  }
}

/**
 * Extract the local listen port from an stack v2 config block. Reads
 * `config.local.PORT` first, then `config.defaults.PORT` (yaml.parse does not
 * resolve the `<<: *defaults` merge, so an env that inherits PORT from defaults
 * has no explicit `config.local.PORT`). PORT may be a number or a string.
 */
function extractLocalPort(parsed: Record<string, unknown>): number | undefined {
  const config = parsed.config as Record<string, unknown> | undefined;
  if (!config || typeof config !== "object") return undefined;
  const local = config.local as Record<string, unknown> | undefined;
  const defaults = config.defaults as Record<string, unknown> | undefined;
  const raw = local && local.PORT !== undefined ? local.PORT : defaults?.PORT;
  return coerceNumber(raw);
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Default local health-check URL following the opctl DNS convention: opctl
 * exposes each service on the host under a DNS name derived from stack.yml's
 * `name`, routed to port 80. So when the local port is 80 (the opctl default)
 * we use the bare-name form (`http://<name>/healthz`); a non-80 port is appended
 * explicitly (`http://<name>:<port>/healthz`). This is what den's host-side
 * health check actually reaches — NOT `http://localhost:<port>`, which only works
 * if the dev op publishes a host port (most do not).
 */
export function defaultLocalHealthUrl(
  repoName: string,
  localPort?: number,
): string {
  const port = localPort ?? 80;
  const host = port === 80 ? repoName : `${repoName}:${port}`;
  return `http://${host}/healthz`;
}

// ── Deployment evidence (pulumi) ──────────────────────────────────────────────

export interface PulumiEnvInfo {
  /** Public app subdomain (e.g. "app" → app.dev.example.dev). */
  appSubdomain?: string;
  /** Internal-ALB marker (e.g. "control-plane-dev"). */
  albSubdomain?: string;
  /** The repo's OWN declared health path (alb_health_check_path). */
  healthPath?: string;
}

/**
 * Read deployment evidence from the repo's pulumi stack configs instead of
 * assuming: `alb_health_check_path` is the repo's own declared health path;
 * `app_subdomain` marks a PUBLIC app (app.<env>.example.dev); `alb_subdomain`
 * without an app subdomain marks an internal-ALB service. Keys are namespaced
 * ("PlatformApp:app_subdomain"), so we match on suffix.
 */
export function detectPulumiDeployment(
  targetDir: string,
): Record<string, PulumiEnvInfo> {
  const files: Record<string, string> = {
    dev: "Pulumi.dev.yaml",
    sandbox: "Pulumi.sandbox.yaml",
    staging: "Pulumi.staging.yaml",
    production: "Pulumi.prod.yaml",
  };
  const envs: Record<string, PulumiEnvInfo> = {};
  for (const [env, file] of Object.entries(files)) {
    const p = path.join(targetDir, "pulumi", file);
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = yaml.parse(fs.readFileSync(p, "utf-8")) as Record<
        string,
        unknown
      > | null;
      const cfg = (
        parsed && typeof parsed.config === "object" ? parsed.config : parsed
      ) as Record<string, unknown> | null;
      if (!cfg) continue;
      const bySuffix = (suffix: string): string | undefined => {
        for (const [k, v] of Object.entries(cfg)) {
          if (k.endsWith(`:${suffix}`) && typeof v === "string") return v;
        }
        return undefined;
      };
      const info: PulumiEnvInfo = {
        appSubdomain: bySuffix("app_subdomain"),
        albSubdomain: bySuffix("alb_subdomain"),
        healthPath: bySuffix("alb_health_check_path"),
      };
      if (info.appSubdomain || info.albSubdomain || info.healthPath) {
        envs[env] = info;
      }
    } catch {
      /* unparseable stack file — no evidence for this env */
    }
  }
  return envs;
}

/** "https://{repo}.internal.dev.example.dev/healthz" → "dev.example.dev" (env domain). */
function envDomainFromTemplate(template: string): string | null {
  try {
    const host = new URL(template.replaceAll("{repo}", "x")).hostname;
    const i = host.indexOf(".internal.");
    return i >= 0 ? host.slice(i + ".internal.".length) : null;
  } catch {
    return null;
  }
}

/**
 * Build deployed-env health URLs from EVIDENCE only — envs with no pulumi
 * markers get nothing (no fabricated hosts). Public apps (`app_subdomain`) get
 * `https://<sub>.<env-domain><path>`; internal-ALB services get the config
 * template with the declared health path. The declared path wins; else the
 * locally detected path; else /healthz.
 */
export function buildEnvHealthUrls(
  name: string,
  pulumiEnvs: Record<string, PulumiEnvInfo>,
  templates: Record<string, string> | undefined,
  localPathHint?: string,
): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const [env, info] of Object.entries(pulumiEnvs)) {
    const template = templates?.[env];
    const healthPath = info.healthPath ?? localPathHint ?? "/healthz";
    if (info.appSubdomain) {
      const domain = template ? envDomainFromTemplate(template) : null;
      if (domain)
        urls[env] = `https://${info.appSubdomain}.${domain}${healthPath}`;
    } else if (info.albSubdomain && template) {
      const u = new URL(template.replaceAll("{repo}", name));
      u.pathname = healthPath;
      urls[env] = u.toString();
    }
  }
  return urls;
}

// ── CloudWatch log-group detection (deployed envs) ────────────────────────────

/**
 * Detect each deployed env's CloudWatch log group by ASKING AWS
 * (`aws logs describe-log-groups`) rather than assuming a naming convention —
 * observed conventions differ per repo (`/jobs_runtime/dev`,
 * `/aws/ecs/search-api/dev`, `/aws/ec2/platform__api_instance__dev`). Candidate
 * prefixes are derived from the repo name; a group only counts on an EXACT
 * match of `<candidate>` or `<candidate>/<envToken>` (so
 * `/jobs_runtime_coldstart_test/dev` never shadows `/jobs_runtime/dev`).
 * Envs without a working AWS session are skipped silently — these blocks only
 * feed the /logs page's env dropdown, so absence just means "add later".
 */
export function detectCloudwatchLogGroups(
  repoName: string,
  awsProfiles: Record<string, string>,
  opts: {
    region?: string;
    execImpl?: (cmd: string) => string;
  } = {},
): Record<string, string> {
  const region = opts.region ?? "us-east-1";
  const exec =
    opts.execImpl ??
    ((cmd: string): string =>
      execSync(cmd, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }));
  const snake = repoName.replaceAll("-", "_");
  const candidates = [
    `/${snake}`,
    `/${repoName}`,
    `/aws/ecs/${repoName}`,
    `/aws/ecs/${snake}`,
    `/aws/ec2/${snake}`,
  ];
  const found: Record<string, string> = {};
  for (const [env, profile] of Object.entries(awsProfiles)) {
    const envToken = env === "production" ? "prod" : env;
    for (const prefix of candidates) {
      try {
        const raw = exec(
          `aws logs describe-log-groups --log-group-name-prefix "${prefix}" ` +
            `--profile "${profile}" --region "${region}" ` +
            `--query 'logGroups[].logGroupName' --output json`,
        );
        const names = JSON.parse(raw) as string[];
        const hit = names.find(
          (n) => n === prefix || n === `${prefix}/${envToken}`,
        );
        if (hit) {
          found[env] = hit;
          break;
        }
      } catch {
        // No session / expired / no such groups — try next candidate; a hard
        // auth failure will fail every candidate and the env is skipped.
      }
    }
  }
  return found;
}

// ── Live local health detection ───────────────────────────────────────────────

/**
 * Detect the repo's real local health endpoint by probing it (opctl DNS),
 * instead of assuming /healthz: the pulumi-declared path first, then common
 * conventions. Only a 2xx counts. Returns null when the service isn't
 * reachable (first network error aborts — no point trying more paths) or
 * nothing responds 2xx.
 */
export async function detectLiveHealthPath(
  repoName: string,
  opts: {
    port?: number;
    declaredPath?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ path: string; status: number } | null> {
  const f = opts.fetchImpl ?? fetch;
  const host =
    opts.port && opts.port !== 80 ? `${repoName}:${opts.port}` : repoName;
  const candidates = [
    ...new Set(
      [
        opts.declaredPath,
        "/healthz",
        "/api/health",
        "/health",
        "/livez",
        "/readyz",
      ].filter((p): p is string => !!p),
    ),
  ];
  for (const p of candidates) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await f(`http://${host}${p}`, {
        signal: ctl.signal,
        redirect: "manual",
      });
      clearTimeout(t);
      if (res.status >= 200 && res.status < 300)
        return { path: p, status: res.status };
    } catch {
      return null; // host unreachable — service not running, stop probing
    }
  }
  return null;
}

// ── buildInitManifest ─────────────────────────────────────────────────────────

/**
 * Build a RawManifest from the user's init choices.
 * Pure function — no I/O, easily testable.
 */
export function buildInitManifest(opts: InitOptions): InitManifest {
  const manifest: InitManifest = {
    version: 1,
    name: opts.name,
  };

  // Only set entrypoint for multi-service repos with an explicit choice
  if (opts.services.length > 1 && opts.entrypoint) {
    manifest.entrypoint = opts.entrypoint;
  }

  // Prefer the real make targets when detected (adds `setup`, drops absent ones);
  // otherwise fall back to the conventional up/down/restart scaffold.
  const STANDARD = ["up", "down", "setup", "restart"];
  const detected = opts.makeTargets
    ? STANDARD.filter((t) => opts.makeTargets!.includes(t))
    : [];
  const cmdNames = detected.length > 0 ? detected : ["up", "down", "restart"];
  const localCommands: Record<string, string> = {};
  for (const t of cmdNames) localCommands[t] = `make ${t}`;

  if (opts.services.length > 0) {
    manifest.services = {};
    for (const svc of opts.services) {
      const serviceEntry: NonNullable<RawManifest["services"]>[string] = {
        commands: {
          local: { ...localCommands },
        },
      };

      if (svc.healthUrl) {
        serviceEntry.health = { local: { url: svc.healthUrl } };
      } else if (svc.healthCmd) {
        serviceEntry.health = {
          local: { type: "shell", cmd: svc.healthCmd },
        };
      }

      // Scaffold deployed-env health URLs on the primary service (single
      // service, or the multi-service entrypoint) from the config templates.
      const isPrimary =
        opts.services.length === 1 || svc.name === opts.entrypoint;
      if (isPrimary && opts.envHealthUrls) {
        serviceEntry.health = serviceEntry.health ?? {};
        for (const [env, template] of Object.entries(opts.envHealthUrls)) {
          if (env === "local") continue; // local comes from the user's answer
          serviceEntry.health[env as Environment] = {
            url: template.replaceAll("{repo}", opts.name),
          };
        }
      }

      if (isPrimary && opts.envLogGroups) {
        for (const [env, logGroup] of Object.entries(opts.envLogGroups)) {
          if (env === "local") continue;
          serviceEntry.logs = serviceEntry.logs ?? {};
          serviceEntry.logs[env as Environment] = {
            type: "cloudwatch",
            logGroup,
          };
        }
      }

      manifest.services![svc.name] = serviceEntry;
    }
  }

  return manifest;
}

// ── mergeManifestPreserving ───────────────────────────────────────────────────

/**
 * Merge a freshly generated init manifest over an existing one WITHOUT losing
 * hand-authored content. Init only OWNS what it generates; everything else in
 * the existing manifest survives regeneration:
 *  - top-level sections init doesn't produce (smoke, performance, synthetics,
 *    github, unknown future keys) carry over verbatim;
 *  - `commands`: per-env merge, existing entries win (extra targets like
 *    preflight/seed/migrate and hand-tuned cmds survive the make scaffold);
 *  - `health`: the generated `local` wins (the user just answered the prompt);
 *    for non-local envs, EXISTING entries win over generated defaults (e.g.
 *    shop's public api.dev.example.dev vs the internal-ALB template);
 *  - `logs`: per-env merge, existing entries win (cloudwatch groups etc.);
 *  - `depends_on`: preserved (init never generates it).
 * A single existing service matches a single generated service even when the
 * key was renamed by detection (services.shop-web → services.app).
 * Services only in the existing manifest are NOT resurrected — the new service
 * set is the user's explicit choice; runInit warns about the drop.
 * Pure function — easily testable.
 */
export function mergeManifestPreserving(
  existing: RawManifest | null,
  generated: RawManifest,
): RawManifest {
  if (!existing) return generated;

  // Top-level sections init doesn't generate (smoke, performance,
  // synthetics, github, and anything a future schema adds) are
  // hand-authored — carry them over verbatim.
  const OWNED_KEYS = new Set(["version", "name", "entrypoint", "services"]);
  const existingRec = existing as unknown as Record<string, unknown>;
  const generatedRec = generated as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(existingRec)) {
    if (OWNED_KEYS.has(key) || value === undefined) continue;
    if (generatedRec[key] === undefined) generatedRec[key] = value;
  }

  if (!existing.services || !generated.services) return generated;

  const oldKeys = Object.keys(existing.services);
  const newKeys = Object.keys(generated.services);

  for (const [name, genSvc] of Object.entries(generated.services)) {
    // Single-service repos: match across a detection-driven key rename
    // (e.g. services.shop-web regenerated as services.app) — otherwise the
    // rename silently discards every hand-authored block.
    const oldSvc =
      existing.services[name] ??
      (oldKeys.length === 1 && newKeys.length === 1
        ? existing.services[oldKeys[0]]
        : undefined);
    if (!oldSvc) continue;

    // commands: per-env merge — hand-authored commands win over the make
    // scaffold and extra targets (preflight, seed, migrate, …) survive.
    if (oldSvc.commands) {
      genSvc.commands = genSvc.commands ?? {};
      for (const [env, cmds] of Object.entries(oldSvc.commands)) {
        if (!cmds) continue;
        genSvc.commands[env as Environment] = {
          ...(genSvc.commands[env as Environment] ?? {}),
          ...cmds,
        };
      }
    }

    if (oldSvc.health) {
      const merged = { ...(genSvc.health ?? {}) };
      for (const [env, cfg] of Object.entries(oldSvc.health)) {
        if (env === "local" || !cfg) continue; // freshly answered — generated wins
        merged[env as Environment] = cfg; // hand-authored env URL wins over the template
      }
      if (Object.keys(merged).length > 0) genSvc.health = merged;
    }

    if (oldSvc.logs) {
      // Per-env merge, existing hand-authored entries win over detected ones.
      genSvc.logs = { ...(genSvc.logs ?? {}), ...oldSvc.logs };
    }

    // depends_on is never generated — preserve explicit wait-gates etc.
    if (oldSvc.depends_on && !genSvc.depends_on) {
      genSvc.depends_on = oldSvc.depends_on;
    }
  }
  return generated;
}

// ── formatManifestYaml ────────────────────────────────────────────────────────

/**
 * Serialise a manifest to a pretty YAML string with a header comment.
 * Ensures `version` appears first in the output.
 */
export function formatManifestYaml(manifest: Record<string, unknown>): string {
  const header = [
    `# ${product().manifestYml} — service manifest (format: see the Den README)`,
    "#",
    "# Dependency ORDER is derived automatically from real signals (SDK imports,",
    "# *_URL env vars, IaC refs, EventBridge rules) — you do NOT need depends_on.",
    "# Add depends_on only for an explicit `wait: true` readiness gate.",
    "",
  ].join("\n");

  // Hoist version and name to the top of the document
  const { version, name, ...rest } = manifest;
  const ordered: Record<string, unknown> = {};
  if (version !== undefined) ordered.version = version;
  if (name !== undefined) ordered.name = name;
  Object.assign(ordered, rest);

  return header + yaml.stringify(ordered, { lineWidth: 100 });
}

// ── Interactive wizard ────────────────────────────────────────────────────────
// The functions below are not unit-tested — they drive readline I/O.

/* istanbul ignore next */
function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Interactive den-init wizard. Writes a .den.yml to the target directory.
 */
/* istanbul ignore next */
export async function runInit(
  // cwd-appropriate BY DESIGN: init scaffolds .den.yml where the user is
  // standing — but honor the canonical invoke-cwd signal (bin/den exports
  // DEN_INVOKE_CWD) in case a spawned process repointed its own cwd.
  targetDir: string = getInvokeCwd(),
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const denYmlPath = path.join(targetDir, `${product().manifestYml}`);

    // Guard: don't silently overwrite
    if (fs.existsSync(denYmlPath)) {
      const answer = await prompt(
        rl,
        `${product().manifestYml} already exists. Overwrite? (y/N): `,
      );
      if (!answer.match(/^y$/i)) {
        console.log("Aborted.");
        return;
      }
    }

    // Read the existing manifest (if any) BEFORE overwriting — hand-authored
    // env-specific blocks (deployed health URLs, cloudwatch logs) are merged
    // back into the regenerated manifest so re-running init never loses them.
    let existingManifest: RawManifest | null = null;
    try {
      existingManifest = yaml.parse(
        fs.readFileSync(denYmlPath, "utf-8"),
      ) as RawManifest;
    } catch {
      /* no existing manifest / unparseable — nothing to preserve */
    }

    console.log(
      `\n  ${product().cli} init — scaffold a new ${product().manifestYml}\n`,
    );

    // Detect repo name from directory name
    const dirName = path.basename(targetDir);

    // Check for .stack.yml
    const stackDetection = detectStackConfig(targetDir);
    let serviceNames: string[] = [];

    if (stackDetection?.localPort !== undefined) {
      console.log(
        `  Detected local port ${stackDetection.localPort} (stack.yml config.local.PORT)`,
      );
    }
    if (stackDetection && stackDetection.services.length > 0) {
      console.log(
        `  Detected .stack.yml with services: ${stackDetection.services.join(", ")}`,
      );
      const useStack = await prompt(
        rl,
        "  Import service config from .stack.yml? (Y/n): ",
      );
      if (!useStack.match(/^n$/i)) {
        serviceNames = stackDetection.services;
      }
    }

    const name = await prompt(rl, `  Repo name [${dirName}]: `);
    const resolvedName = name.trim() || dirName;

    if (serviceNames.length === 0) {
      const svcsInput = await prompt(
        rl,
        "  Service names (comma-separated, e.g. api,worker) [api]: ",
      );
      serviceNames = svcsInput.trim()
        ? svcsInput
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : ["api"];
    }

    // Entrypoint for multi-service repos
    let entrypoint: string | undefined;
    if (serviceNames.length > 1) {
      const ep = await prompt(
        rl,
        `  Front-door service (entrypoint) [${serviceNames[0]}]: `,
      );
      entrypoint = ep.trim() || serviceNames[0];
    }

    // Health evidence — detect, don't assume:
    //  1. pulumi alb_health_check_path = the repo's OWN declared health path
    //  2. live probe of the running service via opctl DNS (2xx wins)
    //  3. /healthz convention only as the last resort
    const pulumiEnvs = detectPulumiDeployment(targetDir);
    const declaredPath = Object.values(pulumiEnvs).find(
      (e) => e.healthPath,
    )?.healthPath;
    const live = await detectLiveHealthPath(resolvedName, {
      port: stackDetection?.localPort,
      declaredPath,
    });
    if (live) {
      console.log(
        `  Detected live health endpoint: ${live.path} (HTTP ${live.status})`,
      );
    } else if (declaredPath) {
      console.log(
        `  Using pulumi-declared health path: ${declaredPath} (service not running — unverified)`,
      );
    }

    // Health check per service. The primary service (single, or the entrypoint)
    // defaults to the DETECTED path; sidecars fall back to the opctl DNS
    // convention (http://<name>/healthz, port 80) using the stack.yml port.
    const services: ServiceInitConfig[] = [];
    for (const svcName of serviceNames) {
      const svcPort =
        stackDetection?.ports?.[svcName] ?? stackDetection?.localPort;
      const isPrimary =
        serviceNames.length === 1 || svcName === (entrypoint ?? "");
      const detectedPath = live?.path ?? declaredPath;
      const port = svcPort ?? 80;
      const host = port === 80 ? resolvedName : `${resolvedName}:${port}`;
      const defaultUrl =
        isPrimary && detectedPath
          ? `http://${host}${detectedPath}`
          : defaultLocalHealthUrl(resolvedName, svcPort);
      const health = await prompt(
        rl,
        `  Health check for "${svcName}" — URL or shell cmd [${defaultUrl}]: `,
      );
      const resolved = health.trim() || defaultUrl;
      if (resolved.startsWith("http")) {
        services.push({ name: svcName, healthUrl: resolved });
      } else {
        services.push({ name: svcName, healthCmd: resolved });
      }
    }

    // Reflect the repo's actual make targets in commands.local (adds setup,
    // drops targets that don't exist) instead of a blind up/down/restart default.
    const makeTargets = listMakeTargets(targetDir).targets;
    if (makeTargets.length > 0) {
      const std = ["up", "down", "setup", "restart"].filter((t) =>
        makeTargets.includes(t),
      );
      if (std.length > 0) {
        console.log(`  Detected make targets: ${std.join(", ")}`);
      }
    }

    // Deployed-env health URLs from EVIDENCE (pulumi app_subdomain /
    // alb_subdomain / alb_health_check_path) — the TEST scope resolves per-env
    // base URLs from these manifest entries. Envs with no evidence get nothing
    // (no fabricated hosts); hand edits survive re-init via the merge below.
    const envHealthUrls = buildEnvHealthUrls(
      resolvedName,
      pulumiEnvs,
      readDenConfig().env_health_urls,
      live?.path ?? declaredPath,
    );
    if (Object.keys(envHealthUrls).length > 0) {
      const kind = Object.values(pulumiEnvs).some((e) => e.appSubdomain)
        ? "public app host"
        : "internal ALB";
      console.log(
        `  Deployed health URLs (${kind}, from pulumi): ${Object.keys(envHealthUrls).join(", ")}`,
      );
    } else {
      console.log(
        "  No deployed-host evidence in pulumi/ — skipping health.<env> URLs (add by hand; they survive re-init).",
      );
    }

    // CloudWatch log groups per deployed env — asked of AWS directly (exact
    // matches only), skipped silently for envs without a live session. These
    // feed the /logs page's env dropdown.
    const envLogGroups = detectCloudwatchLogGroups(
      resolvedName,
      loadAwsProfiles() as Record<string, string>,
    );
    if (Object.keys(envLogGroups).length > 0) {
      console.log(
        `  Detected CloudWatch log groups: ${Object.entries(envLogGroups)
          .map(([e, g]) => `${e}=${g}`)
          .join("  ")}`,
      );
    } else {
      console.log(
        "  No CloudWatch log groups detected (no live AWS session or no matching groups) — add logs.<env> by hand if needed.",
      );
    }

    const manifest = mergeManifestPreserving(
      existingManifest,
      buildInitManifest({
        name: resolvedName,
        services,
        entrypoint,
        makeTargets,
        envHealthUrls:
          Object.keys(envHealthUrls).length > 0 ? envHealthUrls : undefined,
        envLogGroups:
          Object.keys(envLogGroups).length > 0 ? envLogGroups : undefined,
      }),
    );
    const yamlContent = formatManifestYaml(
      manifest as unknown as Record<string, unknown>,
    );

    // Regeneration transparency: name every existing service that is not in
    // the new manifest (renamed = settings carried over; dropped = gone).
    if (existingManifest?.services && manifest.services) {
      const keptKeys = Object.keys(manifest.services);
      const missing = Object.keys(existingManifest.services).filter(
        (k) => !keptKeys.includes(k),
      );
      const renamed =
        missing.length === 1 &&
        Object.keys(existingManifest.services).length === 1 &&
        keptKeys.length === 1;
      if (renamed) {
        console.log(
          `  ⚠ service key renamed: ${missing[0]} → ${keptKeys[0]} (existing settings carried over)`,
        );
      } else if (missing.length > 0) {
        console.log(
          `  ⚠ services dropped from the manifest: ${missing.join(", ")} — restore from git if unintended`,
        );
      }
    }

    fs.writeFileSync(denYmlPath, yamlContent, "utf-8");
    console.log(`\n  ✓ Wrote ${denYmlPath}\n`);
    console.log("  Next steps:");
    console.log(
      `    make ${product().cli}-register   — add this repo to your service catalog`,
    );
    console.log(
      `    make ${product().cli}-validate   — validate the manifest\n`,
    );
  } finally {
    rl.close();
  }
}
