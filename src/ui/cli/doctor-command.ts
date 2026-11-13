/**
 * `doctor`: every strategy kind in the registry (secrets, tls,
 * session-backend, runtime), the strategy this distribution selects for it, whether
 * nothing chose it (implicit), and its detect() result with the reason.
 *
 * Read-only: detect() is a PATH check (session-backend loads the optional
 * PTY module, which runs nothing; runtime reads a CLI's version from its
 * install, never by running it), so doctor never spawns a backend CLI,
 * never prompts, and never prints a secret value. Exit 1 when a strategy
 * that will be used is unavailable or its config is invalid. When agents
 * are configured, a note says to run `<cli> doctor --probe`.
 *
 * `--probe` (opt-in, AG spec §5a-env) is the one exception to never
 * spawning: it runs a short probe session through the session host for a
 * plain session and each available runtime's agent env (env-probe.ts), and
 * exits 1 when a runtime's scrubEnv name or a credential-shaped variable
 * reaches one. Without the PTY module the probe is unavailable, not failed.
 *
 * It also reads the tail of the local .dev-metrics/events.jsonl (bounded,
 * polling.ts) and warns when one command, run from one place, ran more than
 * 600 times in an hour: an agent polling it. A warning, never a failure;
 * nothing is sent.
 */
import { readWebUrl } from "../../shared/web-url.js";
import chalk from "chalk";
import {
  readDenConfig,
  readUserConfig,
  readMcpConfig,
  sectionConfigError,
  type DenConfig,
} from "../../shared/den-config.js";
import type { ConfigError } from "../../shared/config-error.js";
import { approvalsState } from "../mcp/tools.js";
import { getStateDir } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { listRecords } from "../../shared/agents/records.js";
import { eventsFile } from "../../shared/dev-metrics/emit.js";
import { pollingWarnings } from "../../shared/dev-metrics/polling.js";
import { readBrand } from "../../shared/brand.js";
import { hasEdgeBlock, readEdgeConfig } from "../../shared/edge/config.js";
import { edgeTlsWarnings, tlsStrategyFor } from "../../shared/edge/tls.js";
import {
  describeOpTokenSource,
  opTokenSourceProblem,
  parseOpTokenSource,
  readSecretsConfig,
  resolveProviderName,
  secretsStatus,
  type SecretsConfig,
} from "../../shared/secrets/index.js";
import {
  DEN_PTY_ID,
  SESSION_BACKEND_KIND,
} from "../../shared/sessions/den-pty.js";
import {
  getStrategy,
  strategyIds,
  strategyKinds,
} from "../../shared/strategies/registry.js";
import {
  DEFAULT_RUNTIME_ID,
  RUNTIME_KIND,
} from "../../shared/agents/runtimes.js";
import {
  defaultOnboardDeps,
  onboardingChecks,
  runnableCli,
  type OnboardCheck,
  type OnboardDeps,
} from "./doctor-onboard.js";
import { printJson } from "./json-out.js";
import { ownerCheck, ownerLine } from "./doctor-owner.js";
import {
  formatWhere,
  launchdJobPid,
  serviceJobState,
  whereRows,
  type WhereDeps,
  type WhereRow,
} from "./doctor-where.js";
import { hostLabel } from "./service-command.js";

export interface DoctorRow {
  kind: string;
  /** The selected strategy id ("" when the config could not be read). */
  selected: string;
  implicit: boolean;
  available: boolean;
  reason?: string;
  /** True when it will be used and cannot work: doctor exits 1. */
  problem: boolean;
  warnings: string[];
}

type Selector = (env: NodeJS.ProcessEnv) => DoctorRow;

const SELECTORS: Record<string, Selector> = {
  secrets(env) {
    let cfg: SecretsConfig;
    try {
      cfg = readSecretsConfig();
    } catch (err) {
      // A bad secrets.* key (naming the key): a problem, not a crash.
      return {
        kind: "secrets",
        selected: "",
        implicit: false,
        available: false,
        reason: (err as Error).message,
        problem: true,
        warnings: [],
      };
    }
    const st = secretsStatus(cfg, env);
    return {
      kind: "secrets",
      selected: st.backend,
      implicit: st.implicit,
      available: st.detect.available,
      reason: st.detect.reason,
      // The implicit default is used only when a secret is asked for.
      problem: !st.detect.available && !st.implicit,
      warnings: [],
    };
  },
  tls(env) {
    if (!hasEdgeBlock())
      return {
        kind: "tls",
        selected: "none",
        implicit: false,
        available: true,
        reason: "no edge: block",
        problem: false,
        warnings: [],
      };
    try {
      const cfg = readEdgeConfig();
      const d = tlsStrategyFor(cfg).detect(env);
      return {
        kind: "tls",
        selected: cfg.tls.strategy,
        implicit: cfg.tlsFrom === "implicit",
        available: d.available,
        reason: d.reason,
        problem: !d.available,
        warnings: edgeTlsWarnings(cfg),
      };
    } catch (err) {
      return {
        kind: "tls",
        selected: "",
        implicit: false,
        available: false,
        reason: (err as Error).message,
        problem: true,
        warnings: [],
      };
    }
  },
  // Agents' terminals (AG-3a). Only den-pty exists, so it is the implicit
  // choice; unavailable is never a problem (nothing needs a session until
  // one is started, and `sessions start` says why).
  [SESSION_BACKEND_KIND](env) {
    const d = getStrategy(SESSION_BACKEND_KIND, DEN_PTY_ID)?.detect(env) ?? {
      available: false,
      reason: "not registered",
    };
    return {
      kind: SESSION_BACKEND_KIND,
      selected: DEN_PTY_ID,
      implicit: true,
      available: d.available,
      reason: d.reason,
      problem: false,
      warnings: [],
    };
  },
  // Agents' CLIs (AG-2a): the default runtime, chosen per persona or agent,
  // so it is implicit and its absence is never a problem (`agents start`
  // says why it can't run).
  [RUNTIME_KIND](env) {
    const d = getStrategy(RUNTIME_KIND, DEFAULT_RUNTIME_ID)?.detect(env) ?? {
      available: false,
      reason: "not registered",
    };
    return {
      kind: RUNTIME_KIND,
      selected: DEFAULT_RUNTIME_ID,
      implicit: true,
      available: d.available,
      reason: d.reason,
      problem: false,
      warnings: [],
    };
  },
};

/**
 * One row per registered kind (secrets, then tls, then any other kind in
 * registration order). Never spawns, never throws.
 */
export function doctorRows(env: NodeJS.ProcessEnv = process.env): DoctorRow[] {
  const kinds = strategyKinds();
  const ordered = [
    ...Object.keys(SELECTORS).filter((k) => kinds.includes(k)),
    ...kinds.filter((k) => !(k in SELECTORS)),
  ];
  const rows = ordered.map(
    (kind) => SELECTORS[kind]?.(env) ?? everyStrategyRow(kind, env),
  );
  const op = onePasswordTokenRow(env);
  if (op) rows.splice(rows.findIndex((r) => r.kind === "secrets") + 1, 0, op);
  return rows;
}

/**
 * A kind no config selects one of (usage sources, D9): every registered
 * strategy is in use, so the row names them all (implicit) and is available
 * when any is. Never a problem: nothing was configured wrong. (It said
 * "(invalid config) ✗ no selector for this kind" on every fresh install.)
 */
function everyStrategyRow(kind: string, env: NodeJS.ProcessEnv): DoctorRow {
  const ids = strategyIds(kind);
  const found = ids.map((id) => {
    try {
      return getStrategy(kind, id)?.detect(env) ?? { available: false };
    } catch (e) {
      return { available: false, reason: (e as Error).message };
    }
  });
  const available = found.some((d) => d.available);
  return {
    kind,
    selected: ids.join(", "),
    implicit: true,
    available,
    reason: available
      ? undefined
      : found
          .map((d) => d.reason)
          .filter(Boolean)
          .join("; ") || undefined,
    problem: false,
    warnings: [],
  };
}

/**
 * The 1password row: shown only when 1Password is the configured provider
 * (secret_env refs and the engine's own secrets resolve through it) and the
 * configured token source yields no token. A warning, not a failure: a
 * signed-in desktop app needs none. Checks the source without reading a
 * keychain secret, so nothing prompts.
 */
function onePasswordTokenRow(env: NodeJS.ProcessEnv): DoctorRow | null {
  try {
    const cfg = readSecretsConfig();
    if (resolveProviderName(cfg, env) !== "1password") return null;
    const src = parseOpTokenSource(cfg.onepassword?.token);
    const why = opTokenSourceProblem(src, { env });
    if (!why) return null;
    return {
      kind: "1password",
      selected: describeOpTokenSource(src),
      implicit: false,
      available: false,
      reason:
        "this process has no service-account token. Set secrets.onepassword.token.",
      problem: false,
      warnings: [why],
    };
  } catch {
    return null;
  }
}

export function formatDoctor(rows: DoctorRow[], title: string): string[] {
  const lines = [chalk.bold(`${title} doctor: strategies`), ""];
  const width = Math.max(...rows.map((r) => r.kind.length));
  const selOf = (r: DoctorRow) =>
    r.selected
      ? `${r.selected}${r.implicit ? " (implicit)" : ""}`
      : "(invalid config)";
  // The state column lines up even past 20 ("den-claude (implicit)").
  const selWidth = Math.max(20, ...rows.map((r) => selOf(r).length));
  for (const r of rows) {
    const sel = selOf(r);
    const state = r.available
      ? chalk.green("✓ available")
      : (r.problem ? chalk.red : chalk.yellow)("✗ unavailable");
    lines.push(
      `  ${r.kind.padEnd(width)}  ${sel.padEnd(selWidth)} ${state}${r.reason ? `: ${r.reason}` : ""}`,
    );
    for (const w of r.warnings) lines.push(chalk.yellow(`    ⚠ ${w}`));
  }
  return lines;
}

/**
 * Whether agents are configured here: an `agents:` block with anything in
 * it (max_concurrent, persona_packs, an agent id), or an agent record.
 */
export function agentsConfigured(
  config: DenConfig | null,
  stateDir: string,
): boolean {
  const raw = config?.agents as unknown;
  if (raw && typeof raw === "object" && Object.keys(raw).length) return true;
  try {
    return listRecords(stateDir).length > 0;
  } catch {
    return false;
  }
}

/**
 * The held writes' state (mcp.approvals), as doctor prints it. A bad value
 * is a problem: the MCP server refuses to start on it.
 */
export function approvalsLines(read: () => boolean): {
  lines: string[];
  problem: boolean;
} {
  try {
    const state = approvalsState({ approvals: read() });
    return { lines: ["", `  ℹ MCP ${state}`], problem: false };
  } catch (err) {
    return {
      lines: ["", chalk.red(`  ✗ MCP ${(err as Error).message}`)],
      problem: true,
    };
  }
}

/** Informational lines after the rows: never a failure. */
export function doctorNotes(cli: string, configured: boolean): string[] {
  return configured
    ? [
        "",
        `  ℹ agents are configured or have run here: run \`${cli} doctor --probe\` to verify agent env isolation`,
      ]
    : [];
}

/** The polling-loop warnings for this events file, as doctor prints them. */
export function pollingLines(file: string, title: string): string[] {
  const warnings = pollingWarnings(file);
  if (!warnings.length) return [];
  return [
    "",
    chalk.bold(`${title} doctor: dev-metrics (local, never sent)`),
    "",
    ...warnings.map((w) => chalk.yellow(`  ⚠ ${w}`)),
  ];
}

function readConfigOrNull(): DenConfig | null {
  try {
    return readDenConfig();
  } catch {
    return null;
  }
}

/** A strategy row as a `doctor --json` check. */
export function strategyCheck(r: DoctorRow): OnboardCheck {
  const sel = r.selected
    ? `${r.selected}${r.implicit ? " (implicit)" : ""}`
    : "(invalid config)";
  const why = r.reason ? `: ${r.reason}` : "";
  return {
    id: `strategy:${r.kind}`,
    status: r.problem
      ? "fail"
      : !r.available || r.warnings.length
        ? "warn"
        : "ok",
    detail: `${sel} ${r.available ? "available" : "unavailable"}${why}${r.warnings.length ? ` (${r.warnings.join("; ")})` : ""}`,
  };
}

/**
 * `doctor --json` (ON-2): one JSON object, `{ ok, checks }`. The
 * onboarding checks first (doctor-onboard.ts), then every strategy row;
 * ok is false when any check fails. Exit 1 then, as for the human doctor.
 */
export async function doctorJson(
  deps: OnboardDeps,
  rows: DoctorRow[] = doctorRows(),
  owner: () => Promise<OnboardCheck> = () => ownerCheck(),
): Promise<{ ok: boolean; checks: OnboardCheck[] }> {
  const checks = [
    ...(await onboardingChecks(deps)),
    ...rows.map(strategyCheck),
    // D17: who can connect GitHub to this instance from the browser.
    await owner(),
  ];
  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

/** D18/D20: the real probes for doctor's "where it runs" rows. */
export async function defaultWhereDeps(): Promise<WhereDeps> {
  const os = await import("os");
  const { readDenConfig: cfg, readWebServiceConfig } =
    await import("../../shared/den-config.js");
  const { readWebPort } = await import("../../shared/edge/config.js");
  const { getDistRoot } = await import("../../shared/paths.js");
  const { connectHost } = await import("../../shared/sessions/client.js");
  const { sessionPaths } = await import("../../shared/sessions/paths.js");
  return {
    cli: product().cli,
    platform: process.platform,
    server: async () => {
      const port = readWebPort(getDistRoot());
      const res = await fetch(`http://localhost:${port}/api/server-info`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { launchd?: string | null };
      return { launchd: body.launchd ?? null };
    },
    host: async () => {
      const c = await connectHost(sessionPaths(getStateDir()).socket);
      try {
        return {
          launchd: c.hostLaunchd,
          pid: c.hostPid,
          startedAt: c.hostStartedAt || undefined,
          access: await c.access().catch(() => null),
        };
      } finally {
        c.close();
      }
    },
    service: () => {
      try {
        const { label } = readWebServiceConfig(
          cfg(),
          getDistRoot(),
          os.homedir(),
        );
        return serviceJobState(label, os.homedir(), process.getuid?.() ?? 0);
      } catch {
        return null;
      }
    },
    hostJob: () => {
      try {
        const { label } = readWebServiceConfig(
          cfg(),
          getDistRoot(),
          os.homedir(),
        );
        const host = hostLabel(label);
        const job = serviceJobState(
          host,
          os.homedir(),
          process.getuid?.() ?? 0,
        );
        return job?.state === "loaded" ? launchdJobPid(job.domain, host) : null;
      } catch {
        return null;
      }
    },
  };
}

/** A "where it runs" row as a `doctor --json` check. */
export function whereCheck(r: WhereRow): OnboardCheck {
  return {
    id: `where:${r.what.replace(" ", "-")}`,
    // info is as chosen: not a problem.
    status: r.status === "info" ? "ok" : r.status,
    detail: `${r.session}${r.detail ? `: ${r.detail}` : ""}`,
  };
}

/**
 * HUB-1.5: doctor's Hub row, or none when hub.url isn't set. Never the
 * token: hubStatus doesn't have it to give.
 */
export function hubLines(
  st: import("../../shared/hub.js").HubStatus,
  title: string,
): { lines: string[]; problem: boolean; check?: OnboardCheck } {
  if (!st.configured) return { lines: [], problem: false };
  const who = [
    st.team && `company ${st.team}`,
    st.label && `install ${st.label}`,
    st.role && `role ${st.role}`,
  ]
    .filter(Boolean)
    .join(", ");
  // HUB-1.7: what to do about it is in Settings (Connect, Reconnect).
  const fix =
    st.state === "no_token" || st.state === "rejected"
      ? ` (Settings › Agents › Hub: ${st.state === "rejected" ? "Reconnect" : "Connect"})`
      : "";
  const detail = st.connected
    ? `${st.url}: connected${who ? ` (${who})` : ""}`
    : `${st.url || "hub.url"}: not connected: ${st.problem ?? "no answer"}${fix}`;
  return {
    lines: [
      "",
      `${title} doctor: Hub`,
      "",
      `  hub  ${st.connected ? "✓" : "⚠"}  ${detail}`,
    ],
    problem: false, // a Hub that is down never fails doctor: agents still run
    check: { id: "hub", status: st.connected ? "ok" : "warn", detail },
  };
}

/**
 * H5: with Hub connected, each project's Hub project. Linked is ok; not
 * linked warns (Hub files that project's agents' work in Unfiled), with
 * the command that shows Hub's suggestions and links one; with two or
 * more unlinked, one more line names `hub link --suggested`. Doctor doesn't
 * ask Hub for the suggestions itself: one call per project is too slow.
 */
export function hubProjectLines(
  connected: boolean,
  projects: { ws: string; link: { slug: string; name: string } | null }[],
  cli: string,
): { lines: string[]; checks: OnboardCheck[] } {
  if (!connected || !projects.length) return { lines: [], checks: [] };
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  for (const { ws, link } of projects) {
    const name = link
      ? link.name === link.slug
        ? link.slug
        : `${link.name} (${link.slug})`
      : "";
    const detail = link
      ? `${ws}: linked to Hub project ${name}`
      : `${ws}: not linked to a Hub project, so Hub files its agents' work in Unfiled`;
    const fix = link ? undefined : `${cli} hub link -p ${ws}`;
    lines.push(
      `  hub project  ${link ? "✓" : "⚠"}  ${detail}${fix ? `. See Hub's suggestions: \`${fix}\`` : ""}`,
    );
    checks.push({
      id: `hub:project:${ws}`,
      status: link ? "ok" : "warn",
      detail,
      ...(fix ? { fix } : {}),
    });
  }
  // #68: two or more unlinked: one place links every suggestion at once.
  const unlinked = projects.filter((p) => !p.link).length;
  if (unlinked > 1)
    lines.push(
      `  hub project  ⚠  ${unlinked} projects aren't linked. See what Hub suggests for each, and link them in one go: \`${cli} hub link --suggested\``,
    );
  return { lines, checks };
}

/**
 * H5: Den Hub's GitHub access per org, live from Hub: all repos is fine;
 * some or none warns, with GitHub's link to change or give it.
 */
export function hubGithubLines(
  cov:
    | { orgs: import("../../shared/hub-project-sync.js").OrgCoverage[] }
    | { error: string }
    | null,
): { lines: string[]; checks: OnboardCheck[] } {
  if (!cov) return { lines: [], checks: [] };
  if ("error" in cov)
    return {
      lines: [
        `  hub github   ⚠  Den couldn't ask Hub about GitHub access: ${cov.error}`,
      ],
      checks: [
        {
          id: "hub:github",
          status: "warn",
          detail: `Den couldn't ask Hub about GitHub access: ${cov.error}`,
        },
      ],
    };
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  for (const o of cov.orgs) {
    const what =
      o.access === "all"
        ? "all repos"
        : o.access === "some"
          ? `${o.covered} of ${o.total} repos`
          : "no repos (no access)";
    const url =
      o.access === "all"
        ? undefined
        : ((o.access === "some" ? o.manageUrl : undefined) ?? o.installUrl);
    const detail = `${o.org}: Den Hub can read ${what}`;
    const ok = o.access === "all";
    lines.push(
      `  hub github   ${ok ? "✓" : "⚠"}  ${detail}${url ? `. ${o.access === "none" ? "Give Den Hub access" : "Change repos"}: ${url}` : ""}`,
    );
    checks.push({
      id: `hub:github:${o.org}`,
      status: ok ? "ok" : "warn",
      detail,
      ...(url ? { fix: url } : {}),
    });
  }
  return { lines, checks };
}

/** H5: every project here, with its Hub project (or null). */
async function projectsWithHubProject(): Promise<
  { ws: string; link: { slug: string; name: string } | null }[]
> {
  const { readWorkspacesFile } =
    await import("../../shared/environment-manager/workspaces.js");
  const { parseHubProjectLink } =
    await import("../../shared/hub-project-link.js");
  try {
    return Object.entries(readWorkspacesFile().workspaces).map(([ws, c]) => ({
      ws,
      link: parseHubProjectLink(c?.hub_project),
    }));
  } catch {
    return [];
  }
}

/**
 * D80: doctor's Address row. The install's address (web.url) is the one
 * people are given; unset fails doctor with its one-line fix. One a
 * migration took from what the install had is shown for the person to
 * confirm.
 */
export function addressLines(
  w: import("../../shared/web-url.js").WebUrl | null,
  title: string,
  cli: string,
): { lines: string[]; problem: boolean; check: OnboardCheck } {
  if (!w) {
    const detail = `not set: run \`${cli} web url <address>\` (for example https://${cli}.local.example.com)`;
    return {
      lines: ["", `${title} doctor: Address`, "", `  address  ✗  ${detail}`],
      problem: true,
      check: {
        id: "address",
        status: "fail",
        detail,
        // A person sets it (an agent's session can't): ask them.
        ask: `What address do people open this ${title} at (for example https://${cli}.local.example.com)? Then run \`${cli} web url <address>\`.`,
      },
    };
  }
  const detail = w.confirmed
    ? w.url
    : `${w.url}, taken from ${w.from ?? "what this install had"}: confirm it with \`${cli} web url ${w.url}\``;
  return {
    lines: [
      "",
      `${title} doctor: Address`,
      "",
      `  address  ${w.confirmed ? "✓" : "⚠"}  ${detail}`,
    ],
    problem: false,
    check: { id: "address", status: w.confirmed ? "ok" : "warn", detail },
  };
}

/**
 * `agents:` and `sessions:` (0.4.29): a bad key there stops only the agent
 * and session commands, so doctor names it, with its file and key path,
 * and carries on with every other row. Nothing is shown when both are fine.
 */
export function configLines(
  title: string,
  errorOf: (
    s: "agents" | "sessions",
  ) => ConfigError | null = sectionConfigError,
  deprecated: () => string[] = () => deprecatedKeys(),
): { lines: string[]; problem: boolean; checks: OnboardCheck[] } {
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  // Keys still accepted that no longer do anything: a note, not a problem.
  for (const l of deprecated()) lines.push(`  agents  ℹ  ${l}`);
  for (const section of ["agents", "sessions"] as const) {
    const e = errorOf(section);
    const issues = e
      ? e.issues.length
        ? e.issues.map((i) => `${i.file}: ${i.text}`)
        : [e.message]
      : [];
    checks.push({
      id: `config:${section}`,
      status: issues.length ? "fail" : "ok",
      detail: issues.length ? issues.join("; ") : `${section}: valid`,
    });
    for (const l of issues) lines.push(`  ${section}  ✗  ${l}`);
  }
  const problem = checks.some((c) => c.status === "fail");
  if (lines.length) lines.unshift("", `${title} doctor: config`, "");
  return { lines, problem, checks };
}

/**
 * Keys set where they do nothing: agents.helpers.collapse_done_minutes
 * (0.4.29), and den#3's org-only keys in a person's user.yml.
 */
export function deprecatedKeys(
  readUser: () => { agents?: unknown } = readUserConfig,
): string[] {
  return [...userYmlOrgKeys(readUser), ...collapseDoneKey()];
}

/**
 * den#3: agents.subagents and agents.claude_ai_connectors are the org's
 * (its config); set in user.yml they do nothing, which nobody would guess.
 */
export function userYmlOrgKeys(
  read: () => { agents?: unknown } = readUserConfig,
): string[] {
  try {
    const a = read().agents;
    if (!a || typeof a !== "object") return [];
    return (["subagents", "claude_ai_connectors"] as const)
      .filter((k) => k in a)
      .map(
        (k) =>
          `config/local/user.yml: agents.${k} does nothing there; it is the org's, set in ${product().configFile}`,
      );
  } catch {
    return [];
  }
}

function collapseDoneKey(): string[] {
  try {
    const h = (readDenConfig().agents as { helpers?: unknown } | undefined)
      ?.helpers;
    return h && typeof h === "object" && "collapse_done_minutes" in h
      ? [
          "agents.helpers.collapse_done_minutes no longer does anything (0.4.29): remove it. Finished helpers stay until a person clears them (Clear done).",
        ]
      : [];
  } catch {
    return [];
  }
}

export async function cmdDoctor(args: string[]): Promise<number> {
  const probe = args.includes("--probe");
  const json = args.includes("--json");
  const unknown = args.filter((a) => a !== "--probe" && a !== "--json");
  if (unknown.length) {
    const msg = `unknown argument ${unknown[0]} (doctor [--probe] [--json])`;
    if (json)
      printJson({
        ok: false,
        error: msg,
        fix: `${runnableCli()} doctor --json`,
      });
    else console.error(`✗ doctor: ${msg}`);
    return 2;
  }
  if (json) {
    if (probe) {
      printJson({
        ok: false,
        error: "--probe and --json do not combine: the probe starts sessions",
        fix: `${runnableCli()} doctor --json`,
      });
      return 2;
    }
    const { probeWebServer } = await import("./mcp-connect.js");
    const r = await doctorJson(
      defaultOnboardDeps((url) => probeWebServer(url)),
    );
    r.checks.push(
      ...(await whereRows(await defaultWhereDeps())).map(whereCheck),
    );
    {
      const { hubStatus } = await import("../../shared/hub.js");
      const st = await hubStatus();
      const h = hubLines(st, readBrand().name);
      if (h.check) r.checks.push(h.check);
      r.checks.push(
        ...hubProjectLines(
          st.configured && st.connected,
          await projectsWithHubProject(),
          product().cli,
        ).checks,
      );
      if (st.configured && st.connected) {
        const { githubCoverage } = await import("../../shared/hub-github.js");
        r.checks.push(...hubGithubLines(await githubCoverage()).checks);
      }
    }
    const cfg = configLines(readBrand().name);
    r.checks.push(...cfg.checks);
    if (cfg.problem) r.ok = false;
    const addr = addressLines(readWebUrl(), readBrand().name, product().cli);
    r.checks.push(addr.check);
    if (addr.problem) r.ok = false;
    printJson(r);
    return r.ok ? 0 : 1;
  }
  const rows = doctorRows();
  for (const l of formatDoctor(rows, readBrand().name)) console.log(l);
  const held = approvalsLines(() => readMcpConfig().approvals);
  for (const l of held.lines) console.log(l);
  // D17: who can connect GitHub to this instance from the browser.
  const owner = await ownerCheck();
  console.log("");
  console.log(ownerLine(owner));
  const ownerProblem = owner.status === "fail";
  // D18/D20: where the server and the session host run (logout).
  for (const l of formatWhere(
    await whereRows(await defaultWhereDeps()),
    readBrand().name,
  ))
    console.log(l);
  {
    // HUB-1.5: only when hub.url is set.
    const { hubStatus } = await import("../../shared/hub.js");
    const st = await hubStatus();
    for (const l of hubLines(st, readBrand().name).lines) console.log(l);
    for (const l of hubProjectLines(
      st.configured && st.connected,
      await projectsWithHubProject(),
      product().cli,
    ).lines)
      console.log(l);
    if (st.configured && st.connected) {
      const { githubCoverage } = await import("../../shared/hub-github.js");
      for (const l of hubGithubLines(await githubCoverage()).lines)
        console.log(l);
    }
  }
  const cfg = configLines(readBrand().name);
  for (const l of cfg.lines) console.log(l);
  const addr = addressLines(readWebUrl(), readBrand().name, product().cli);
  for (const l of addr.lines) console.log(l);
  for (const l of pollingLines(eventsFile(), readBrand().name)) console.log(l);
  const cli = product().cli;
  if (!probe) {
    for (const l of doctorNotes(
      cli,
      agentsConfigured(readConfigOrNull(), getStateDir()),
    ))
      console.log(l);
    return rows.some((r) => r.problem) ||
      held.problem ||
      ownerProblem ||
      cfg.problem ||
      addr.problem
      ? 1
      : 0;
  }
  const { runEnvProbe, formatProbe } = await import("./env-probe.js");
  const { resolveDeps, plainSessionEnv } =
    await import("./sessions-command.js");
  const d = resolveDeps({});
  const results = await runEnvProbe({
    dist: d.dist,
    cli: d.cli,
    env: d.env,
    pty: d.pty,
    connect: d.connect,
    plainEnv: (caller) => plainSessionEnv(caller),
  });
  console.log("");
  console.log(chalk.bold(`${readBrand().name} doctor: session env probe`));
  console.log("");
  for (const l of formatProbe(results)) console.log(l);
  const found = results.some((r) => r.findings.length);
  return rows.some((r) => r.problem) ||
    held.problem ||
    ownerProblem ||
    cfg.problem ||
    found
    ? 1
    : 0;
}
