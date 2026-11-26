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
import { MEMORY_NOT_MEASURED_WORDS } from "../../shared/gates/rules.js";
import { fixturePersonPath } from "../../shared/fixture-person.js";
import { readFixtureMadeBy } from "../../shared/fixture-setup-secret.js";
import { parseProjectMcpServers } from "../../shared/agents/project-mcp.js";
import * as fs from "fs";
import * as path from "path";
import { rankFindings, readWebUrl } from "../../shared/web-url.js";
import { loopbackRefusal } from "../../shared/web-url-check.js";
import { pushContact } from "../../shared/push-contact.js";
import chalk from "chalk";
import {
  agentsKeepRunningAfterLogout,
  readAgentsConfig,
  readDenConfig,
  readUserConfig,
  readServerAgentConfig,
  type UserConfig,
  readMcpConfig,
  sectionConfigError,
  agentsUserDrift,
  type DenConfig,
} from "../../shared/den-config.js";
import type { ConfigError } from "../../shared/config-error.js";
import {
  pinNotes,
  pinProjectsOf,
  type PinProjects,
} from "../../shared/shell-pins.js";
import { readWorkspacesFile } from "../../shared/environment-manager/workspaces.js";
import {
  projectRepoDirs,
  projectRepoDirsOf,
} from "../../shared/project-repo-dirs.js";
import {
  PLAYWRIGHT_AUTH_DIR,
  REPO_SECRETS_FILE,
} from "../../shared/credential-paths.js";
import {
  checkAgentSigning,
  existingAgentSigningKey,
  resolveAgentSigning,
  signingKeyAddLine,
  signingReadFiles,
  type AgentGitSettings,
  type SigningCheck,
} from "../../shared/agents/git-signing.js";
import { approvalsState } from "../mcp/tools.js";
import { getDistRoot, getStateDir } from "../../shared/paths.js";
import {
  bothSpellings,
  readRulesCover,
  repoSecretDenyRules,
  stateDirDenyRules,
} from "../../shared/agents/den-claude.js";
import {
  isRegistered,
  listOtherInstalls,
  registryDir,
} from "../../shared/install-registry.js";
import { AUDIT_FILE } from "../../shared/audit-file.js";
import {
  AUDIT_INTAKE_DIR,
  AUDIT_PERSON_QUEUE_DIR,
  QUEUE_DROPPED_VERB,
  readAuditRows,
} from "../../shared/audit-queue.js";
import { DEN_PROCS_DIR, pidAlive } from "../../shared/den-procs.js";
import {
  SIGNIN_REQUEST_VERB,
  signinRequestCounts,
} from "../../shared/signin-request-count.js";
import {
  SESSION_SIGNING_DIR,
  sandboxFor,
  sandboxHidesFile,
  sandboxSetting,
} from "../../shared/agents/sandbox.js";
import { agentSandboxInput, agentsMayReadTrail } from "./agent-ops.js";
import { localDateTime } from "../../shared/local-time.js";
import {
  readRestartsWaiting,
  type RestartsWaiting,
} from "../../shared/agents/restarts-waiting.js";
import {
  readTestResolveState,
  testResolveDoctorLine,
} from "../../shared/test-resolve.js";
import { listDaemons } from "../../shared/environment-manager/service-runner.js";
import {
  containerRuntimeOnPath,
  readLastRestore,
  restoreDoctorLine,
  runtimeMissingDoctorLine,
  servicesRestoreOnBoot,
} from "../../shared/environment-manager/restore-on-boot.js";
import {
  deliveryAlert,
  readDeliveryHealth,
  TROUBLE_TEXT,
} from "../../shared/hub-delivery.js";
import {
  lostFiles,
  lostMarkLines,
} from "../../shared/agents/guardrails/lost-marks.js";
import {
  readCheckState,
  selfUpdateSummary,
  type CheckState,
} from "../../shared/update-check-state.js";
import { product } from "../../shared/product.js";
import { listRecords, type AgentRecord } from "../../shared/agents/records.js";
import { getRuntime } from "../../shared/agents/runtimes.js";
import {
  contextTokensFor,
  contextWatchSettings,
  instructionCheck,
  instructionWarning,
  sizeText,
  type ContextWatchSettings,
} from "../../shared/agents/context-watch.js";
import { eventsFile } from "../../shared/dev-metrics/emit.js";
import { pollingWarnings } from "../../shared/dev-metrics/polling.js";
import { readBrand } from "../../shared/brand.js";
import { hasEdgeBlock, readEdgeConfig } from "../../shared/edge/config.js";
import {
  cliLanguage,
  edgeUncheckedLine,
  isEdgeAddress,
  statedAddress,
} from "../../shared/edge/address-check.js";
import { readEdgeProof } from "../../shared/edge/proof.js";
import { getActiveWorkspaces } from "../../shared/environment-manager/workspaces.js";
import {
  edgeProofRotation,
  stacksWithGeneratedSecrets,
} from "../../shared/edge/runtime.js";
import { edgeDomains, edgeImageCheck } from "../../shared/edge/render.js";
import {
  bridgeLine,
  readBridgeState,
} from "../../shared/edge/bridge-listen.js";
import {
  edgeAccessHealthy,
  edgeAccessWarnings,
} from "../../shared/edge/access-sweep.js";
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
  ADDRESS_SETTINGS_LINK,
  defaultOnboardDeps,
  onboardingChecks,
  runnableCli,
  type OnboardCheck,
  type OnboardDeps,
} from "./doctor-onboard.js";
import { printJson } from "./json-out.js";
import {
  pinDoctorText,
  readPinRecord,
  type PinRecord,
} from "../../shared/pin-record.js";
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
import { denWebBase } from "../../shared/web-dial.js";

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
  /** #63: what's healthy and worth saying (a ✓ line each). */
  notes?: string[];
  /**
   * Issue 1334: nothing uses it yet (an implicit default no one chose,
   * no source found, no agents). Unavailable then is "not in use yet",
   * ok, never a ⚠ an agent would turn into a question.
   */
  idle?: true;
}

/** What a row may need beyond the env (issue 1334). */
export interface DoctorRowsOpts {
  /** How many agents this install has (records); default: read them. */
  agents?: () => number;
}

type Selector = (
  env: NodeJS.ProcessEnv,
  o: Required<DoctorRowsOpts>,
) => DoctorRow;

const idleIf = (b: boolean): { idle?: true } => (b ? { idle: true } : {});

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
      ...idleIf(st.implicit && !st.detect.available),
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
      const image = edgeImageCheck(cfg);
      return {
        kind: "tls",
        selected: cfg.tls.strategy,
        implicit: cfg.tlsFrom === "implicit",
        available: d.available,
        reason: d.reason,
        problem: !d.available,
        warnings: [
          ...edgeTlsWarnings(cfg),
          ...edgeAccessWarnings(cfg),
          ...(image.status === "warn" ? [image.detail] : []),
        ],
        notes: [
          image.status === "ok" ? image.detail : null,
          edgeAccessHealthy(cfg),
        ].filter((n): n is string => !!n),
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
  [SESSION_BACKEND_KIND](env, o) {
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
      // Issue 1334: no agents yet, so no terminal is needed yet.
      ...idleIf(!d.available && o.agents() === 0),
    };
  },
  // Agents' CLIs (AG-2a): the default runtime, chosen per persona or agent,
  // so it is implicit and its absence is never a problem (`agents start`
  // says why it can't run).
  [RUNTIME_KIND](env, o) {
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
      // Issue 1334: no agents yet, so no agent CLI is needed yet.
      ...idleIf(!d.available && o.agents() === 0),
    };
  },
};

/**
 * One row per registered kind (secrets, then tls, then any other kind in
 * registration order). Never spawns, never throws.
 */
export function doctorRows(
  env: NodeJS.ProcessEnv = process.env,
  opts: DoctorRowsOpts = {},
): DoctorRow[] {
  let counted: number | undefined;
  const o: Required<DoctorRowsOpts> = {
    agents:
      opts.agents ??
      (() => {
        if (counted === undefined)
          try {
            counted = listRecords(getStateDir()).length;
          } catch {
            // Can't tell: count one, so nothing hides behind an error.
            counted = 1;
          }
        return counted;
      }),
  };
  const kinds = strategyKinds();
  const ordered = [
    ...Object.keys(SELECTORS).filter((k) => kinds.includes(k)),
    ...kinds.filter((k) => !(k in SELECTORS)),
  ];
  const rows = ordered.map(
    (kind) => SELECTORS[kind]?.(env, o) ?? everyStrategyRow(kind, env),
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
  const found: { available: boolean; reason?: string; threw?: true }[] =
    ids.map((id) => {
      try {
        return getStrategy(kind, id)?.detect(env) ?? { available: false };
      } catch (e) {
        return {
          available: false,
          reason: (e as Error).message,
          threw: true as const,
        };
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
    // Issue 1334: no source found yet (no transcripts): nothing to fix.
    // A detect that threw is broken, not idle: it still warns.
    ...idleIf(!available && !found.some((d) => d.threw)),
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
      : r.idle
        ? chalk.dim("– not in use yet")
        : (r.problem ? chalk.red : chalk.yellow)("✗ unavailable");
    lines.push(
      `  ${r.kind.padEnd(width)}  ${sel.padEnd(selWidth)} ${state}${r.reason ? `: ${r.reason}` : ""}`,
    );
    for (const n of r.notes ?? []) lines.push(chalk.green(`    ✓ ${n}`));
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

/**
 * Issue 1129: agents waiting in the restart queue, as doctor prints them.
 * Informational: the queue starts them a few at a time on its own.
 */
export function restartsWaitingLines(
  read: () => RestartsWaiting | null,
): string[] {
  const w = read();
  if (!w || w.waiting <= 0) return [];
  const names = w.ids.slice(0, 5).join(", ");
  const more = w.ids.length > 5 ? ` and ${w.ids.length - 5} more` : "";
  return [
    "",
    `  ℹ ${w.waiting} agent${w.waiting === 1 ? "" : "s"} waiting to restart, a few at a time (as of ${localDateTime(w.at)}): ${names}${more}`,
  ];
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
      : (!r.available && !r.idle) || r.warnings.length
        ? "warn"
        : "ok",
    detail: `${sel} ${r.available ? "available" : r.idle ? "not in use yet, unavailable" : "unavailable"}${why}${r.warnings.length ? ` (${r.warnings.join("; ")})` : ""}`,
    ...(r.notes?.length ? { notes: [...r.notes] } : {}),
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

type CatalogEntry = import("../../shared/agents/catalog.js").CatalogEntry;

/** D18/D20: the real probes for doctor's "where it runs" rows. */
export async function defaultWhereDeps(): Promise<WhereDeps> {
  const os = await import("os");
  const {
    readDenConfig: cfg,
    readWebServiceConfig,
    readAgentsConfig,
    configuredRuntimeCatalog,
  } = await import("../../shared/den-config.js");
  const { BUILTIN_CATALOG } = await import("../../shared/agents/catalog.js");
  const { listRecords } = await import("../../shared/agents/records.js");
  const { agentsWithoutSignIn } =
    await import("../../shared/agents/signin-token.js");
  const { readWebPort } = await import("../../shared/edge/config.js");
  const { getDistRoot } = await import("../../shared/paths.js");
  const { connectHost } = await import("../../shared/sessions/client.js");
  const { sessionPaths } = await import("../../shared/sessions/paths.js");
  return {
    cli: product().cli,
    platform: process.platform,
    server: async () => {
      const port = readWebPort(getDistRoot());
      const res = await fetch(`${denWebBase(port)}/api/server-info`, {
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
    hostJobInstalled: () => {
      try {
        const { label } = readWebServiceConfig(
          cfg(),
          getDistRoot(),
          os.homedir(),
        );
        const job = serviceJobState(
          hostLabel(label),
          os.homedir(),
          process.getuid?.() ?? 0,
        );
        return !!job && job.state !== "not-loaded";
      } catch {
        // Can't tell: say nothing.
        return true;
      }
    },
    // Issue 163 (b): the agents' sign-in token, read from the store.
    signIn: async () => {
      const { agentTokenStatus } =
        await import("../../shared/agents/signin-token.js");
      return agentTokenStatus({
        // The daemon's view: doctor asks only under mode always.
        env: { DEN_AGENT_SIGNIN: "token" },
        stateDir: getStateDir(),
        probe: true,
      });
    },
    // Issue 340: each vendor's pick, read from the store as a start would.
    signInPicks: async () => {
      const [
        { signInPicks },
        { agentTokenRef, readAgentToken },
        { runtimeIds },
      ] = await Promise.all([
        import("../../shared/agents/signin-accounts.js"),
        import("../../shared/agents/signin-token.js"),
        import("../../shared/agents/runtimes.js"),
      ]);
      return signInPicks({
        stateDir: getStateDir(),
        runtimeIds: runtimeIds(),
        read: (name) =>
          readAgentToken({
            ref: () => agentTokenRef(undefined, undefined, name),
          }),
      });
    },
    // Issue 338: agents on a runtime with no sign-in data (built-in,
    // the distribution's or user.yml's catalog entries).
    noSignIn: () => {
      let extra: CatalogEntry[] = [];
      try {
        const dist = readAgentsConfig(cfg()).runtimeCatalog;
        extra = [
          ...dist,
          ...configuredRuntimeCatalog([
            ...BUILTIN_CATALOG.map((e) => e.id),
            ...dist.map((e) => e.id),
          ]),
        ];
      } catch {
        extra = []; // a bad entry is the catalog's own check to say
      }
      return agentsWithoutSignIn(listRecords(getStateDir()), [
        ...BUILTIN_CATALOG,
        ...extra,
      ]);
    },
    // Issue 163 (a): unset over a login install is offered.
    keepSetting: () => agentsKeepRunningAfterLogout(),
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
/** The stacks' project clashes; none when the stacks can't be read. */
async function safeStackClashes(): Promise<
  import("../../shared/stacks/status.js").ProjectClash[]
> {
  try {
    const { stackProjectClashes } =
      await import("../../shared/stacks/status.js");
    return stackProjectClashes();
  } catch {
    return [];
  }
}

/**
 * D53: Compose projects Den's stacks can't call their own: a name two
 * stacks render to, or one already running containers Den didn't start
 * (its up, down and restart are refused). A warning: nothing is broken
 * until one of them is acted on.
 */
export function stackClashLines(
  clashes: import("../../shared/stacks/status.js").ProjectClash[],
  title: string,
  cli: string,
): { lines: string[]; check?: OnboardCheck } {
  if (!clashes.length) return { lines: [] };
  const each = clashes.map((c) =>
    c.stacks.length > 1
      ? `Compose project "${c.project}" is the name of ${c.stacks.length} stacks: ${c.stacks.join(", ")}. Give each a compose.name of its own in its repo's .den.yml.`
      : `Compose project "${c.project}" (stack ${c.stacks[0]}) is running containers ${cli} didn't start: ${c.foreign.slice(0, 5).join(", ")}${c.foreign.length > 5 ? ` and ${c.foreign.length - 5} more` : ""}. Its up, down and restart are refused. Give the stack a compose.name of its own in its repo's .den.yml.`,
  );
  return {
    lines: [
      "",
      `${title} doctor: stacks`,
      "",
      ...each.map((l) => `  stacks  ⚠  ${l}`),
    ],
    check: { id: "stacks:projects", status: "warn", detail: each.join(" ") },
  };
}

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
      ? ` (Settings › Hub: ${st.state === "rejected" ? "Reconnect" : "Connect"})`
      : "";
  // #71: connected, on an older token Den can't replace itself.
  const legacy =
    st.connected && st.legacy
      ? "; on an older Hub token kept where Den can't replace it (Settings › Hub: Reconnect)"
      : "";
  const detail = st.connected
    ? `${st.url}: connected${who ? ` (${who})` : ""}${legacy}`
    : `${st.url || "hub.url"}: not connected: ${st.problem ?? "no answer"}${fix}`;
  const good = st.connected && !legacy;
  return {
    lines: [
      "",
      `${title} doctor: Hub`,
      "",
      `  hub  ${good ? "✓" : "⚠"}  ${detail}`,
      // Issue 158: a bad hub.delivery_loop is ignored, and said here.
      ...("deliveryLoopIgnored" in st && st.deliveryLoopIgnored
        ? [`  hub loop  ⚠  ${st.deliveryLoopIgnored}`]
        : []),
    ],
    problem: false, // a Hub that is down never fails doctor: agents still run
    check: { id: "hub", status: good ? "ok" : "warn", detail },
  };
}

/** Issue 702: "3 min ago", "2 h ago", "4 d ago". */
function agoText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 120) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * Issue 702: doctor's "Hub comments" row, from the server's
 * hub/deliveries-health.json: the URL it reads, whether the stream is
 * open, its last good read and the last comment. Warns, with the reason,
 * after hub.delivery_alert_minutes with no good read; a quiet Hub is ok.
 * None when the server hasn't written it.
 */
export function hubDeliveryLines(
  h: import("../../shared/hub-delivery.js").DeliveryHealth | null,
  now: number,
  minutes: number,
  /** P0-D4: the delivery log's last 24 h (journalSummary), when there is one. */
  journal:
    | import("../../shared/hub-delivery-journal.js").JournalSummary
    | null = null,
): { lines: string[]; problem: boolean; check?: OnboardCheck } {
  if (!h) return { lines: [], problem: false };
  const alert = deliveryAlert(h, now, minutes);
  const parts = [
    `${h.url ?? "Hub"}: ${h.streamOpen ? "stream open" : "stream not open"}`,
    h.lastOkAt === null
      ? "no good read yet"
      : `last good read ${agoText(now - h.lastOkAt)}`,
    h.lastDeliveryAt === null
      ? "no comment yet"
      : `last comment ${agoText(now - h.lastDeliveryAt)}`,
  ];
  // The cursor's age, the last list read, and a stall.
  if (h.cursorAt != null)
    parts.push(`cursor moved ${agoText(now - h.cursorAt)}`);
  if (h.lastPoll)
    parts.push(
      `last list read ${agoText(now - h.lastPoll.at)}: ${
        h.lastPoll.ok ? `${h.lastPoll.count ?? 0} waiting` : h.lastPoll.error
      }`,
    );
  if (h.stale) parts.push(`${h.stale.waiting} waiting in Hub`);
  if (journal) {
    const words: [keyof typeof journal.counts, string][] = [
      ["typed", "typed"],
      ["done", "done"],
      ["held", "held"],
      ["passed", "passed over"],
      ["refused", "refused"],
      ["failed", "failed"],
      ["no-answer", "no answer"],
    ];
    const said = words
      .filter(([k]) => journal.counts[k])
      .map(([k, w]) => `${journal.counts[k]} ${w}`);
    parts.push(
      `last 24 h: ${said.length ? said.join(", ") : "none"}` +
        (journal.lastTypedAt !== null
          ? `, last typed ${agoText(now - journal.lastTypedAt)}`
          : "") +
        ` (log: ${journal.file})`,
    );
  }
  const detail = alert
    ? `Hub comments aren't arriving: ${TROUBLE_TEXT[alert]} (${parts.join("; ")})`
    : parts.join("; ");
  return {
    lines: [`  hub comments  ${alert ? "⚠" : "✓"}  ${detail}`],
    problem: false, // like the Hub row: agents still run
    check: { id: "hub:comments", status: alert ? "warn" : "ok", detail },
  };
}

/**
 * The shared GitHub watcher's row (MCP github_watch): GitHub calls left,
 * the reset, the active watches and the interval, from the server's
 * github/watch-status.json. Warns while paused (never a failure: agents
 * still run). None before the server wrote it.
 */
async function githubWatchRow(): Promise<{
  lines: string[];
  check?: OnboardCheck;
}> {
  const { githubWatchLine, readWatchStatus } =
    await import("../../shared/github-watch/status-line.js");
  const l = githubWatchLine(readWatchStatus(getStateDir()));
  if (!l) return { lines: [] };
  return {
    lines: [`  github watch  ${l.ok ? "✓" : "⚠"}  ${l.text}`],
    check: { id: "github:watch", status: l.ok ? "ok" : "warn", detail: l.text },
  };
}

/** Issue 702: the row for this install (hub.delivery_alert_minutes). */
async function hubDeliveryDoctor(): Promise<
  ReturnType<typeof hubDeliveryLines>
> {
  const { readHubConfig } = await import("../../shared/hub.js");
  let minutes = 15;
  try {
    minutes = readHubConfig()?.deliveryAlertMinutes ?? 15;
  } catch {
    /* the Hub row says what's wrong with the hub block */
  }
  const { journalSummary } =
    await import("../../shared/hub-delivery-journal.js");
  return hubDeliveryLines(
    readDeliveryHealth(
      path.join(getStateDir(), "hub", "deliveries-health.json"),
    ),
    Date.now(),
    minutes,
    journalSummary(
      path.join(getStateDir(), "hub", "deliveries.jsonl"),
      Date.now(),
    ),
  );
}

export function hubAgentTokenLines(
  problems: readonly import("../../shared/hub-agent-tokens.js").AgentTokenProblem[],
): { lines: string[]; checks: OnboardCheck[] } {
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  for (const p of problems) {
    const when = Number.isFinite(Date.parse(p.at))
      ? new Date(p.at).toLocaleString()
      : p.at;
    const reconnect =
      p.code === "agents_not_covered" || p.code === "agents_manage_missing";
    const fix = reconnect
      ? "Settings › Hub: Reconnect"
      : p.what === "mint"
        ? "Den asks Hub again after hub.agent_token_retry_seconds; the agent uses the install's token meanwhile"
        : undefined;
    const detail = `agent ${p.agentId}: ${p.detail} (${when})`;
    lines.push(`  hub agent  ✗  ${detail}${fix ? `. ${fix}` : ""}`);
    checks.push({
      id: `hub:agent-token:${p.agentId}`,
      status: "fail",
      detail,
      ...(reconnect ? { ask: "Reconnect to Hub in Settings › Hub" } : {}),
    });
  }
  return { lines, checks };
}

/**
 * H5: with Hub connected, each project's Hub project. Linked is ok; not
 * linked warns (Hub files that project's agents' work in Unfiled), with
 * the command that shows Hub's suggestions and links one; with two or
 * more unlinked, one more line names `hub link --suggested`. Doctor doesn't
 * ask Hub for the suggestions itself: one call per project is too slow.
 * Issue 1334: an empty project (no repos, services or agents, often the
 * built-in `default`) is ✓ "nothing to link", never a warning: an agent
 * reading Doctor would ask the person for a link nobody needs.
 */
async function hubAddressRows(
  st: import("../../shared/hub.js").HubStatus,
): Promise<{ lines: string[]; checks: OnboardCheck[] }> {
  if (!st.configured || !st.connected) return { lines: [], checks: [] };
  const [{ readDenUrlTell, denUrlTellRow }, { readWebUrl }] = await Promise.all(
    [import("../../shared/hub-den-url.js"), import("../../shared/web-url.js")],
  );
  const row = denUrlTellRow(
    readDenUrlTell(getStateDir()),
    readWebUrl()?.url,
    st.url,
  );
  if (!row) return { lines: [], checks: [] };
  return {
    lines: [`  hub address  ⚠  ${row.detail}`],
    checks: [{ id: "hub:den-url", status: "warn", detail: row.detail }],
  };
}

export function hubProjectLines(
  connected: boolean,
  projects: {
    ws: string;
    link: { slug: string; name: string } | null;
    /** 0.4.44: the link it had, when it lost it with no unlink asked. */
    lost?: { slug: string; at: string };
    /** Issue 646: its link points at another Hub or company. */
    elsewhere?: {
      slug: string;
      name: string;
      origin: string;
      company?: string;
    };
    /** Issue 1334: no repos, no services, no agents. */
    empty?: boolean;
  }[],
  cli: string,
): { lines: string[]; checks: OnboardCheck[] } {
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  // Issue 646: a link to another Hub fails, connected or not.
  for (const { ws, link, elsewhere: e } of projects) {
    if (link || !e) continue;
    const where = `${e.origin.replace(/^https?:\/\//, "")}${e.company ? ` (company ${e.company})` : ""}`;
    const detail = `${ws}: linked to Hub project ${e.name} on ${where}, not the connected Hub, so Den sends Hub no project for it. Link it again: Settings › Hub, Connect's project review`;
    lines.push(`  hub project  ✗  ${detail}`);
    checks.push({ id: `hub:project:${ws}`, status: "fail", detail });
  }
  projects = projects.filter((p) => p.link || !p.elsewhere);
  // 0.4.44: a lost link warns even with Hub down: the config lost it.
  for (const { ws, link, lost } of projects) {
    if (link || !lost) continue;
    const detail = `${ws}: was linked to Hub project ${lost.slug} (seen ${lost.at}) and has no link now, with no unlink asked. The audit (audit.jsonl, verb hub-link and config-write) says which writer dropped it`;
    const fix = `${cli} hub link -p ${ws} ${lost.slug}`;
    lines.push(`  hub project  ⚠  ${detail}. Link it again: \`${fix}\``);
    checks.push({ id: `hub:project:${ws}`, status: "warn", detail, fix });
  }
  if (!connected || !projects.length) return { lines, checks };
  projects = projects.filter((p) => p.link || !p.lost);
  for (const { ws, link, empty } of projects) {
    if (!link && empty) {
      const detail = `${ws}: empty, nothing to link`;
      lines.push(`  hub project  ✓  ${detail}`);
      checks.push({ id: `hub:project:${ws}`, status: "ok", detail });
      continue;
    }
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
  const unlinked = projects.filter((p) => !p.link && !p.empty).length;
  if (unlinked > 1)
    lines.push(
      `  hub project  ⚠  ${unlinked} projects aren't linked. See what Hub suggests for each, and link them in one go: \`${cli} hub link --suggested\``,
    );
  return { lines, checks };
}

/**
 * Issue 335: each project's extra MCP servers, by name and url only
 * (never a bearer or its value). A bad entry, or a bearer whose
 * secrets.refs entry isn't set, warns: agents start without that one.
 */
export function projectMcpLines(
  projects: { ws: string; raw: unknown }[],
  refSet: (name: string) => boolean,
  taken: readonly string[] = [],
): { lines: string[]; checks: OnboardCheck[] } {
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  for (const { ws, raw } of projects) {
    const { servers, problems } = parseProjectMcpServers(raw, taken);
    for (const sv of servers) {
      const unset = sv.bearer && !refSet(sv.bearer);
      const detail = unset
        ? `${ws}: ${sv.name} ${sv.url}: secrets.refs.${sv.bearer} is not set, so its calls carry no bearer`
        : `${ws}: ${sv.name} ${sv.url}`;
      lines.push(`  mcp server  ${unset ? "⚠" : "✓"}  ${detail}`);
      checks.push({
        id: `mcp:server:${ws}:${sv.name}`,
        status: unset ? "warn" : "ok",
        detail,
      });
    }
    problems.forEach((pr, i) => {
      const detail = `${ws}: ${pr}`;
      lines.push(`  mcp server  ⚠  ${detail}`);
      checks.push({ id: `mcp:server:${ws}:bad:${i}`, status: "warn", detail });
    });
  }
  return { lines, checks };
}

/** Issue 335: every project's agents.mcp_servers, as written. */
async function projectsMcpRaw(): Promise<{ ws: string; raw: unknown }[]> {
  const { readWorkspacesFile } =
    await import("../../shared/environment-manager/workspaces.js");
  try {
    return Object.entries(readWorkspacesFile().workspaces ?? {})
      .map(([ws, c]) => ({ ws, raw: c?.agents?.mcp_servers }))
      .filter((p) => p.raw !== undefined && p.raw !== null);
  } catch {
    return [];
  }
}

/** Issue 335: doctor's lines and checks for the projects' MCP servers. */
async function projectMcpDoctor(): Promise<{
  lines: string[];
  checks: OnboardCheck[];
}> {
  const { namedSecretRef } = await import("../../shared/secrets/index.js");
  const { HUB_SERVER } = await import("../../shared/hub.js");
  return projectMcpLines(
    await projectsMcpRaw(),
    (n) => namedSecretRef(n) !== null,
    [product().cli, HUB_SERVER],
  );
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
    // Issue 526: Hub couldn't ask GitHub. Access may be fine: say so, and
    // never a link, even when Hub sends one.
    if (o.access === "error") {
      const detail = o.error
        ? `Den Hub couldn't check ${o.org} on GitHub: ${o.error}. Try again later.`
        : `Den Hub couldn't check ${o.org} on GitHub. Try again later.`;
      lines.push(`  hub github   ⚠  ${detail}`);
      checks.push({ id: `hub:github:${o.org}`, status: "warn", detail });
      continue;
    }
    const what =
      o.access === "all"
        ? "all repos"
        : o.access === "some"
          ? `${o.covered} of ${o.total} repos`
          : "no repos (no access)";
    // some: change repos (manage, else install). none: give access when
    // there's no installation; one that leaves these repos out sends only
    // manage_url, and that's Change repos.
    const give = o.access === "none" && !!o.installUrl;
    const url =
      o.access === "all"
        ? undefined
        : o.access === "some"
          ? (o.manageUrl ?? o.installUrl)
          : (o.installUrl ?? o.manageUrl);
    const detail = `${o.org}: Den Hub can read ${what}`;
    const ok = o.access === "all";
    lines.push(
      `  hub github   ${ok ? "✓" : "⚠"}  ${detail}${url ? `. ${give ? "Give Den Hub access" : "Change repos"}: ${url}` : ""}`,
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
  {
    ws: string;
    link: { slug: string; name: string } | null;
    lost?: { slug: string; at: string };
    elsewhere?: {
      slug: string;
      name: string;
      origin: string;
      company?: string;
    };
    empty: boolean;
  }[]
> {
  const { readWorkspacesFile } =
    await import("../../shared/environment-manager/workspaces.js");
  const { emptyProjectTest } = await import("../../shared/empty-project.js");
  const { listRecords } = await import("../../shared/agents/records.js");
  const { hubProjectOf, hubLinkElsewhere } =
    await import("../../shared/hub-project-link.js");
  const { lostHubLinks } = await import("../../shared/hub-links-seen.js");
  try {
    const file = readWorkspacesFile();
    const all = file.workspaces;
    const lost = new Map(lostHubLinks(all).map((l) => [l.ws, l.was]));
    // Issue 1334: an empty project has nothing to link.
    const isEmpty = emptyProjectTest(
      () => file,
      () => listRecords(getStateDir()),
    );
    return Object.keys(all).map((ws) => {
      const was = lost.get(ws);
      // Issue 646: a link to another Hub or company isn't this one's.
      const e = hubLinkElsewhere(ws, () => file);
      return {
        ws,
        link: hubProjectOf(ws, () => file),
        empty: isEmpty(ws),
        ...(was ? { lost: { slug: was.slug, at: was.at } } : {}),
        ...(e?.hub
          ? {
              elsewhere: {
                slug: e.slug,
                name: e.name,
                origin: e.hub.origin,
                ...(e.hub.company ? { company: e.hub.company } : {}),
              },
            }
          : {}),
      };
    });
  } catch {
    return [];
  }
}

/** What doctor's two address sections read: one check, done once. */
export interface DoctorAddress {
  state: import("../../shared/edge/address-check.js").AddressState;
  /** Whether web.url is the edge address (served here by Den's edge). */
  edge: boolean;
}

/**
 * D80: doctor's Address row. The install's address (web.url) is the one
 * people are given; unset fails doctor with its one-line fix. One a
 * migration took from what the install had is shown for the person to
 * confirm.
 *
 * Issue 455 (after 0.4.68): no address is shown before it is checked. When
 * web.url is the edge address and it hasn't answered as this Den, the row
 * gives the address that was checked (Den's own port), and says the edge
 * one isn't checked yet. It is never offered to confirm.
 */
export function addressLines(
  w: import("../../shared/web-url.js").WebUrl | null,
  title: string,
  cli: string,
  checked: DoctorAddress | null = null,
  /** Issue 666: this install's edge alias (edgeAddresses' first), if any. */
  alias: string | null = null,
  /** The install's other edge addresses, named when web.url is unconfirmed. */
  others: readonly string[] = [],
): { lines: string[]; problem: boolean; check: OnboardCheck } {
  // Issue 666: a loopback address is a problem, never ✓ and never one to
  // confirm: other devices can't open it. The fix is the alias, if any.
  const loop = w ? loopbackRefusal(w.url) : null;
  if (w && loop) {
    // Issue 455 still holds: the address that was checked comes first,
    // and an edge address not checked yet is said as such.
    let lead = "";
    let url: string | undefined;
    if (checked && checked.state.wanted === w.url) {
      const said = statedAddress(checked.state, checked.edge);
      if (said.unchecked) {
        const why = edgeUncheckedLine(said.unchecked, {
          lang: cliLanguage(),
          title,
          cli,
        });
        lead = said.address ? `${said.address}. ${why} ` : `${why} `;
        url = said.address ?? undefined;
      }
    }
    const detail =
      lead +
      (alias
        ? `${loop}. Make ${alias} the address: Settings › Den's address (${ADDRESS_SETTINGS_LINK}), or run \`${cli} web url ${alias}\``
        : `${loop}. Set the address other devices open: Settings › Den's address (${ADDRESS_SETTINGS_LINK}), or run \`${cli} web url <address>\``);
    return {
      lines: ["", `${title} doctor: Address`, "", `  address  ✗  ${detail}`],
      problem: true,
      check: {
        id: "address",
        status: "fail",
        detail,
        ...(url ? { url } : {}),
        settings: ADDRESS_SETTINGS_LINK,
        ...(alias
          ? { fix: `${cli} web url ${alias}` }
          : {
              ask: `${w.url} only opens on this machine. What address do people open this ${title} at (for example https://${cli}.local.example.com)? Then run \`${cli} web url <address>\`.`,
            }),
      },
    };
  }
  if (!w) {
    const detail = `not set: set it in Settings › Den's address (${ADDRESS_SETTINGS_LINK}), or run \`${cli} web url <address>\` (for example https://${cli}.local.example.com)`;
    return {
      lines: ["", `${title} doctor: Address`, "", `  address  ✗  ${detail}`],
      problem: true,
      check: {
        id: "address",
        status: "fail",
        detail,
        settings: ADDRESS_SETTINGS_LINK,
        // A person sets it (an agent's session can't): ask them.
        ask: `What address do people open this ${title} at (for example https://${cli}.local.example.com)? Then run \`${cli} web url <address>\`.`,
      },
    };
  }
  if (checked && checked.state.wanted === w.url) {
    const said = statedAddress(checked.state, checked.edge);
    if (said.unchecked) {
      const words = { lang: cliLanguage(), title, cli };
      const why = edgeUncheckedLine(said.unchecked, words);
      const detail = said.address ? `${said.address}. ${why}` : why;
      return {
        lines: ["", `${title} doctor: Address`, "", `  address  ⚠  ${detail}`],
        problem: false,
        check: {
          id: "address",
          status: "warn",
          detail,
          ...(said.address ? { url: said.address } : {}),
        },
      };
    }
  }
  const rest = others.filter((u) => u !== w.url);
  const detail = w.confirmed
    ? w.url
    : `${w.url}, taken from ${w.from ?? "what this install had"}: confirm it with \`${cli} web url ${w.url}\`` +
      (rest.length ? `. Other edge addresses: ${rest.join(", ")}` : "");
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
 * Issue 455: whether the install's address reaches THIS Den right now (an
 * identity probe, den-identity.ts), and when it doesn't, what holds its
 * port, the address that does work, and the two ways out (mock v3's doctor
 * lines). Always said here: doctor is one of the two quiet places the fact
 * lives (Edge is the other).
 */
export async function addressCheckLines(
  title: string,
  cli: string,
  deps: Partial<import("../../shared/edge/address-check.js").CheckDeps> = {},
  checked?: DoctorAddress | null,
): Promise<{
  lines: string[];
  check: OnboardCheck | null;
  /** Whether the install's https address reaches this Den now. */
  works: boolean;
}> {
  const { doctorAddressLines, cliLanguage } =
    await import("../../shared/edge/address-check.js");
  const w = readWebUrl();
  const st = (checked ?? (await doctorAddress(cli, deps)))?.state;
  if (!w || !st) return { lines: [], check: null, works: false };
  const d = doctorAddressLines(st, { lang: cliLanguage(), title, cli });
  const [head, ...rest] = d.lines;
  return {
    lines: [
      `  ${d.status === "ok" ? "✓" : "!"} ${head}`,
      ...rest.map((l) => `      ${l}`),
    ],
    check: {
      id: "address_reaches",
      status: d.status,
      detail: d.lines.join(" "),
      ...(st.address ? { url: st.address } : {}),
    },
    works: w.url.startsWith("https:") && st.wantedAnswer === "den",
  };
}

/**
 * When the running server last saw its https address answer as this Den
 * (its state dir's address-proof.json), or null.
 */
function addressLastAnswered(): string | null {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(getStateDir(), "address-proof.json"), "utf8"),
    ) as { lastAnswered?: unknown };
    return typeof j.lastAnswered === "string" ? j.lastAnswered : null;
  } catch {
    return null;
  }
}

/**
 * Issue 1018: doctor's Sign-in row for a test install's fixture person:
 * how its key was made (the launcher's setup value, Set up test person,
 * or at creation). Null when there's no key.
 */
export function fixtureMadeByLine(
  hasKey: boolean,
  how: import("../../shared/fixture-setup-secret.js").FixtureMadeBy | null,
): string | null {
  if (!hasKey) return null;
  const words =
    how === "setup-secret"
      ? "made from the setup secret"
      : how === "settings"
        ? "made by Settings › Access › Set up test person"
        : how === "creation"
          ? "made at creation (a new test install)"
          : "set up (how isn't recorded)";
  return `  test person  ✓  ${words}`;
}

function fixtureLineNow(): string | null {
  try {
    return fixtureMadeByLine(
      fs.existsSync(fixturePersonPath(getStateDir())),
      readFixtureMadeBy(getStateDir()),
    );
  } catch {
    return null;
  }
}

/**
 * Where the browser sign-in lives. With a working https address (web.url,
 * through the edge) the session cookie lives only there, host-only and
 * Secure. Without one it lives on the host the person uses (localhost
 * here), and browsers share a host's cookies across its ports: other apps
 * opened on that host could see it. A warning, with what to set.
 * Issue 1334: with no address at all, the Address row already asks for
 * one; this row says so (ℹ, ok) instead of a second ⚠ to ask about.
 */
export function sessionHostLines(
  w: import("../../shared/web-url.js").WebUrl | null,
  works: boolean,
  title: string,
  cli: string,
  lastAnswered: string | null = null,
): { lines: string[]; check: OnboardCheck } {
  if (!w) {
    const detail = `no address yet: the Address row says what to set. Until one is set, the sign-in lives on localhost here`;
    return {
      lines: ["", `${title} doctor: Sign-in`, "", `  sign-in  ℹ  ${detail}`],
      check: { id: "signin_host", status: "ok", detail },
    };
  }
  const named = w.url.startsWith("https:") && works ? w.url : null;
  // When an https address stopped answering as this Den, say when.
  const since =
    !named && w.url.startsWith("https:") && lastAnswered
      ? `${w.url} last answered as this ${title} at ${new Date(lastAnswered).toLocaleString()}; `
      : "";
  const detail = named
    ? `the sign-in lives only on ${named}`
    : `${since}the sign-in lives on the address the browser uses (localhost here), so other apps you open on it could see the sign-in. Set up the https address: Settings › Den's address (${ADDRESS_SETTINGS_LINK}), or run \`${cli} web url https://<address>\` and \`${cli} edge up\``;
  return {
    lines: [
      "",
      `${title} doctor: Sign-in`,
      "",
      // An https address that doesn't reach this Den yet: "!", as the
      // address check beside it says it (not an install-wide ⚠).
      `  sign-in  ${named ? "✓" : w.url.startsWith("https:") ? "!" : "⚠"}  ${detail}`,
    ],
    check: {
      id: "signin_host",
      status: named ? "ok" : "warn",
      detail,
      ...(named ? {} : { settings: ADDRESS_SETTINGS_LINK }),
    },
  };
}

/**
 * The address check doctor's Address sections share (issue 455): null when
 * web.url isn't set or the web port can't be read.
 */
/**
 * Issue 666: the edge routes to Den's web port that can be its address,
 * best first (doctor offers the first when web.url names this machine
 * only, and lists the rest while web.url is unconfirmed):
 * a route edge.routes names before the brand's, https first, never
 * loopback (rankFindings, the migration's order). Empty with no edge.
 */
export async function edgeAddresses(): Promise<string[]> {
  try {
    const { readWebPort } = await import("../../shared/edge/config.js");
    const { webRouteFindings } = await import("../../shared/edge/render.js");
    if (!hasEdgeBlock()) return [];
    const hits = webRouteFindings(
      readEdgeConfig(),
      new Set([readWebPort()]),
    ).map((r) => ({ url: r.url, from: "", named: r.named }));
    return rankFindings(hits).map((r) => r.url);
  } catch {
    return [];
  }
}

export async function doctorAddress(
  cli: string,
  deps: Partial<import("../../shared/edge/address-check.js").CheckDeps> = {},
): Promise<DoctorAddress | null> {
  const { checkAddress, localIdentityKey } =
    await import("../../shared/edge/address-check.js");
  const { readWebPort } = await import("../../shared/edge/config.js");
  const w = readWebUrl();
  if (!w) return null;
  let port: number;
  try {
    port = readWebPort();
  } catch {
    return null;
  }
  const state = await checkAddress({
    webPort: port,
    wanted: w.url,
    key: localIdentityKey(getStateDir()),
    cli,
    ...deps,
  });
  let domains: string[] = [];
  try {
    domains = hasEdgeBlock() ? edgeDomains(readEdgeConfig()) : [];
  } catch {
    domains = [];
  }
  return { state, edge: isEdgeAddress(w.url, domains) };
}

/** Issue 1334: phones and browsers with push on; unknown on an error. */
async function pushSubscriptionCount(): Promise<number | undefined> {
  try {
    const { pushSubscriptionCount: count } =
      await import("../../shared/push-subscription-count.js");
    return count(getStateDir());
  } catch {
    return undefined;
  }
}

/**
 * Issue 367: the contact push alerts give the push services. With an
 * https address (web.url) they get it; without one, a mailto fallback
 * some refuse, so a phone may get no push: warn, and say what to set.
 * Issue 1334: `subscriptions` is how many phones or browsers have push
 * on. None: nothing is lost yet, so ℹ and ok. Unknown (left out): warn.
 */
export function pushContactLines(
  w: import("../../shared/web-url.js").WebUrl | null,
  title: string,
  cli: string,
  subscriptions?: number,
): { lines: string[]; check: OnboardCheck } {
  const c = pushContact(w?.url);
  if (!c.accepted && subscriptions === 0) {
    const detail = `no phone has push alerts on yet. When one does, it needs an https address: Settings › Den's address (${ADDRESS_SETTINGS_LINK})`;
    return {
      lines: ["", `${title} doctor: Push alerts`, "", `  push  ℹ  ${detail}`],
      check: { id: "push_contact", status: "ok", detail },
    };
  }
  const detail = c.accepted
    ? `push services are given ${c.subject} as the contact`
    : `push alerts may not reach phones: with no https address, push services are given ${c.subject} as the contact, and some refuse it. Set one in Settings › Den's address (${ADDRESS_SETTINGS_LINK}), or run \`${cli} web url https://<address>\``;
  return {
    lines: [
      "",
      `${title} doctor: Push alerts`,
      "",
      `  push  ${c.accepted ? "✓" : "⚠"}  ${detail}`,
    ],
    check: {
      id: "push_contact",
      status: c.accepted ? "ok" : "warn",
      detail,
      ...(c.accepted ? {} : { settings: ADDRESS_SETTINGS_LINK }),
    },
  };
}

/**
 * Issue 728: whether the edge's proof was rotated once since agents lost
 * read access to the edge's state folder, and each stack whose generated
 * secrets they could read before, named with its owning project so that
 * project's agent rotates them (the stack's own way; Den never regenerates
 * them, which would lock a stack out of its data). A stack whose
 * generated.env changed after the rotation is done. Never a value.
 */
export function edgeRotationLines(
  title: string,
  o: {
    edgeDir?: () => string | null;
    /** Den's projects, to tell a stack's project from its name. */
    projects?: () => string[];
  } = {},
): { lines: string[]; checks: OnboardCheck[] } {
  const dir = (
    o.edgeDir ??
    (() => {
      try {
        return readEdgeConfig().stateDir;
      } catch {
        return null;
      }
    })
  )();
  if (!dir || !fs.existsSync(dir)) return { lines: [], checks: [] };
  const at = edgeProofRotation({ stateDir: dir }).rotatedAt;
  const none = !at && readEdgeProof(dir) === null;
  const rotate = none
    ? "the edge has no proof yet, nothing to rotate"
    : at
      ? `the edge's proof was rotated once, at ${at}, after agents lost read access to the edge's state folder`
      : `the edge's proof hasn't been rotated since agents lost read access to the edge's state folder: ${title} rotates it once at its next start (people stay signed in)`;
  const checks: OnboardCheck[] = [
    { id: "edge_rotate", status: at || none ? "ok" : "warn", detail: rotate },
  ];
  const since = at ? Date.parse(at) : Infinity;
  const projects = (
    o.projects ??
    (() => {
      try {
        return getActiveWorkspaces();
      } catch {
        return [];
      }
    })
  )();
  const stale = stacksWithGeneratedSecrets({ stateDir: dir }).filter((f) => {
    try {
      const m = fs.statSync(path.join(dir, "stacks", f, "generated.env"));
      return !(m.mtimeMs > since);
    } catch {
      return false;
    }
  });
  const named = stale.map((f) => {
    const p = projects
      .filter((w) => f.endsWith(`-${w}`))
      .sort((a, b) => b.length - a.length)[0];
    return p
      ? { stack: f.slice(0, -p.length - 1), project: p }
      : { stack: f, project: null };
  });
  const stacks = named.length
    ? `agents could read these stacks' generated secrets before: ${named
        .map((n) =>
          n.project
            ? `${n.stack} (project ${n.project}): ${n.project}'s agent rotates them the stack's own way`
            : `${n.stack}: its project's agent rotates them the stack's own way`,
        )
        .join(
          "; ",
        )}. ${title} never makes new values, which would lock a stack out of its data`
    : "no stack's generated secrets wait on a rotation";
  checks.push({
    id: "edge_stack_secrets",
    status: named.length ? "warn" : "ok",
    detail: stacks,
  });
  return {
    lines: [
      "",
      `${title} doctor: Edge secrets`,
      "",
      `  edge rotate  ${at || none ? "✓" : "⚠"}  ${rotate}`,
      `  stack secrets  ${named.length ? "⚠" : "✓"}  ${stacks}`,
    ],
    checks,
  };
}

/**
 * Issue 728 (part C): installs running as this login. Whether others do (by
 * count: another install's path stays out, as its registry entry does),
 * whether this install is in the install registry (their agents are denied
 * its files only once it is), and the 0600 files in its state folder that
 * agents' deny rules don't cover. Paths only, relative to the state
 * folder; never a file's contents. Links are never followed.
 */
export function sharedUserLines(
  title: string,
  o: {
    stateDir?: string;
    registry?: string;
    home?: string;
    /** The walk's caps (default 20,000 entries, 8 folders deep). */
    maxEntries?: number;
    maxDepth?: number;
    /** Whether this install's server runs now (its den-procs record). */
    serverRunning?: () => boolean;
    /**
     * Issue 1391: agents may read the trail (a personal install). Default:
     * from install_mode; a config that can't be read counts as strict.
     */
    trailReadable?: boolean;
    /** Agents whose last start was outside the OS sandbox, and their projects. */
    unsandboxed?: () => { id: string; projects: string[] }[];
    /** A project's repo folders. */
    reposOf?: (project: string) => string[];
  } = {},
): { lines: string[]; checks: OnboardCheck[] } {
  const stateDir = o.stateDir ?? getStateDir();
  const reg = o.registry ?? registryDir();
  const home = o.home ?? process.env.HOME;
  const others = listOtherInstalls(reg, {
    ownStateDir: stateDir,
    ...(home ? { home } : {}),
  }).length;
  const shared = others
    ? `${others} other install${others === 1 ? " runs" : "s run"} as this login on this computer. Their agents are kept out of ${title}'s credentials by deny rules, which bind an agent that follows them; a separate login for each install keeps them apart for certain`
    : "no other install runs as this login on this computer";
  const registered = isRegistered(reg, stateDir);
  // A fresh install (its server not started yet) is registered at its
  // start: only a running server that isn't registered is a warning.
  const running = (o.serverRunning ?? (() => serverRecorded(stateDir)))();
  const regOk = registered || !running;
  const regDetail = registered
    ? "this install is in the install registry, so other installs' agents on this login are denied its files"
    : running
      ? `this install isn't in the install registry, though ${title} is running, so other installs' agents on this login aren't denied its files. Restart ${title} to add it`
      : `this install isn't in the install registry yet: ${title} adds it at its next start`;
  const trailReadable =
    o.trailReadable ??
    (() => {
      try {
        return agentsMayReadTrail(readAgentsConfig(), stateDir);
      } catch {
        return false;
      }
    })();
  const rules = bothSpellings(stateDir).flatMap((d) =>
    stateDirDenyRules(d, home, { trailReadable }),
  );
  const maxEntries = o.maxEntries ?? 20000;
  const maxDepth = o.maxDepth ?? 8;
  const walked = uncoveredSecretFiles(
    stateDir,
    rules,
    maxEntries,
    maxDepth,
    trailReadable,
  );
  const loose = walked.files.map(safeShownPath);
  const partial = walked.capped
    ? `checked the first ${maxEntries} entries only`
    : walked.deep
      ? `checked ${maxDepth} folders deep only`
      : "";
  const outside = (o.unsandboxed ?? (() => unsandboxedAgents(stateDir)))();
  const looseWarn = (loose.length > 0 || !!partial) && outside.length > 0;
  const SHOWN = 10;
  const listed =
    loose.length && !outside.length
      ? `${loose.length} 0600 file${loose.length === 1 ? "" : "s"} in the state folder ha${loose.length === 1 ? "s" : "ve"} no Claude Read rule; the OS sandbox keeps every agent out of the state folder`
      : loose.length
        ? `agents' deny rules don't cover these 0600 files in the state folder: ${loose
            .slice(0, SHOWN)
            .join(
              ", ",
            )}${loose.length > SHOWN ? `, and ${loose.length - SHOWN} more` : ""}`
        : partial
          ? "agents' deny rules cover every 0600 file the walk reached in the state folder"
          : "agents' deny rules cover every 0600 file in the state folder";
  const reposOf = o.reposOf ?? projectRepoDirsOf;
  const readable = stateCredentialsPresent(stateDir);
  const more = walked.files.filter(
    (f) => f.split(path.sep)[0] !== SESSION_SIGNING_DIR,
  ).length;
  const agentRows = outside.map((a) => {
    const repoFiles = [
      ...new Set(
        a.projects.flatMap((p) => reposOf(p).map((d) => path.resolve(d))),
      ),
    ].filter((d) => {
      try {
        return fs.lstatSync(path.join(d, REPO_SECRETS_FILE)).isFile();
      } catch {
        return false;
      }
    }).length;
    const what = [
      ...readable,
      ...(repoFiles
        ? [
            `${repoFiles} project stack secrets file${repoFiles === 1 ? "" : "s"}`,
          ]
        : []),
      ...(more ? [`and ${more} more 0600 file${more === 1 ? "" : "s"}`] : []),
    ];
    const detail = `${safeShownPath(a.id)} runs outside the OS sandbox (by its last start's record), so its shell can read ${what.length ? what.join(", ") : "the state folder"}. A person turns its sandbox on with agents.sandbox in user.yml`;
    return { id: `agent_unsandboxed:${a.id}`, detail };
  });
  const looseDetail = partial ? `${listed} (${partial})` : listed;
  const mark = (ok: boolean) => (ok ? "✓" : "⚠");
  return {
    lines: [
      "",
      `${title} doctor: Installs on this login`,
      "",
      `  same login  ${mark(!others)}  ${shared}`,
      `  registry  ${mark(regOk)}  ${regDetail}`,
      `  0600 files  ${mark(!looseWarn)}  ${looseDetail}`,
      ...agentRows.map((r) => `  sandbox off  ⚠  ${r.detail}`),
    ],
    checks: [
      { id: "shared_user", status: others ? "warn" : "ok", detail: shared },
      {
        id: "install_registry",
        status: regOk ? "ok" : "warn",
        detail: regDetail,
      },
      {
        id: "uncovered_files",
        status: looseWarn ? "warn" : "ok",
        detail: looseDetail,
      },
      ...agentRows.map((r) => ({
        id: r.id,
        status: "warn" as const,
        detail: r.detail,
      })),
    ],
  };
}

/** Agents whose last start was outside the OS sandbox, from their records. */
function unsandboxedAgents(
  stateDir: string,
): { id: string; projects: string[] }[] {
  try {
    return listRecords(stateDir)
      .filter((r) => r.sandbox?.applied !== true)
      .map((r) => ({ id: r.id, projects: [r.workspace, ...(r.grants ?? [])] }));
  } catch {
    return [];
  }
}

/** The state folder's credentials that exist, by what they are. */
function stateCredentialsPresent(stateDir: string): string[] {
  const has = (rel: string) => fs.existsSync(path.join(stateDir, rel));
  return [
    ...(has("web.secret") ? ["web.secret"] : []),
    ...(has("web-sessions.json") ? ["the browser sign-ins"] : []),
    ...(has("actor-token") ? ["the agents' tokens"] : []),
    ...(has(path.join("hub", "token")) ? ["the Hub token"] : []),
    ...(has("push-vapid.json") ? ["the push key"] : []),
    ...(has("fixture-person.key") ? ["the test person's key"] : []),
    ...(has(SESSION_SIGNING_DIR) ? ["the agents' signing key"] : []),
  ];
}

/** Repos' stack secrets files and the cached sign-ins, by name only, and whether agents' rules deny them. */
export function repoSecretLines(
  o: {
    repoDirs?: string[];
    distRoot?: string;
    home?: string;
    /** The rules to check against (default: the ones agents start with). */
    rules?: (repoDirs: string[], authDirs: string[]) => string[];
    /** Agents whose last start was outside the OS sandbox, and their projects. */
    unsandboxed?: () => { id: string; projects: string[] }[];
    /** A project's repo folders. */
    reposOf?: (project: string) => string[];
  } = {},
): { lines: string[]; checks: OnboardCheck[] } {
  const repoDirs = o.repoDirs ?? projectRepoDirs();
  const authDir = path.join(o.distRoot ?? getDistRoot(), PLAYWRIGHT_AUTH_DIR);
  const home = o.home ?? process.env.HOME;
  const isFile = (f: string) => {
    try {
      return fs.lstatSync(f).isFile();
    } catch {
      return false;
    }
  };
  const secrets = [...new Set(repoDirs.map((d) => path.resolve(d)))]
    .map((d) => path.join(d, REPO_SECRETS_FILE))
    .filter(isFile);
  const signIns = (() => {
    try {
      return fs
        .readdirSync(authDir)
        .map((n) => path.join(authDir, n))
        .filter(isFile);
    } catch {
      return [];
    }
  })();
  const rules = (
    o.rules ??
    ((r, a) =>
      repoSecretDenyRules(
        r.flatMap(bothSpellings),
        a.flatMap(bothSpellings),
        home,
      ))
  )(repoDirs, [authDir]);
  const shown = (f: string) =>
    safeShownPath(path.join(path.basename(path.dirname(f)), path.basename(f)));
  const loose = [...secrets, ...signIns].filter(
    (f) => !readRulesCover(rules, f),
  );
  const signInsShown = (n: number) =>
    n ? [`${n} cached sign-in${n === 1 ? "" : "s"}`] : [];
  const parts = [
    ...(secrets.length ? [secrets.map(shown).join(", ")] : []),
    ...signInsShown(signIns.length),
  ];
  const reposOf = o.reposOf ?? projectRepoDirsOf;
  const exposed = (
    o.unsandboxed ??
    (() =>
      listRecords(getStateDir())
        .filter((r) => r.sandbox?.applied !== true)
        .map((r) => ({
          id: r.id,
          projects: [r.workspace, ...(r.grants ?? [])],
        })))
  )()
    .map((a) => {
      const reach = new Set(
        a.projects.flatMap((p) => reposOf(p).map((d) => path.resolve(d))),
      );
      const mine = secrets.filter((f) => reach.has(path.dirname(f)));
      const what = [...mine.map(shown), ...signInsShown(signIns.length)];
      return what.length ? `${a.id}: ${what.join(", ")}` : "";
    })
    .filter(Boolean);
  const detail = !parts.length
    ? "no stack secrets file in a project repo and no cached sign-ins"
    : loose.length
      ? `not covered by agents' rules: ${loose.map(shown).join(", ")}`
      : exposed.length
        ? `readable by agents whose sandbox is off (agents.sandbox): ${exposed.join("; ")}`
        : `the OS sandbox keeps agents out of ${parts.join(" and ")}; agents' rules deny them too`;
  const warn = loose.length > 0 || exposed.length > 0;
  return {
    lines: [`  repo secrets  ${warn ? "⚠" : "✓"}  ${detail}`],
    checks: [{ id: "repo_secret_files", status: warn ? "warn" : "ok", detail }],
  };
}

/**
 * Issue 728: state folders of 0600 files that hold no credential, left out
 * of the walk: the process records (pids only), a session's own writable
 * folder (its guardrail log, its audit queue: issue 1369), the person's
 * CLI's audit queue and the server's intake of both.
 */
/**
 * Issue 1391: state files of 0600 that hold no credential, left out of
 * the walk: the activity trail, which agents may read (only the server
 * writes it), and the copies beside it a compaction leaves.
 */
const NOT_CREDENTIAL_FILE = (name: string) =>
  name === AUDIT_FILE || name.startsWith(`${AUDIT_FILE}.`);

const NOT_CREDENTIAL_DIRS: readonly string[] = [
  DEN_PROCS_DIR,
  "audit",
  AUDIT_PERSON_QUEUE_DIR,
  AUDIT_INTAKE_DIR,
];

/** Whether a server of this install records itself as running. */
function serverRecorded(stateDir: string): boolean {
  try {
    return fs
      .readdirSync(path.join(stateDir, DEN_PROCS_DIR))
      .map((n) => /^server-(\d+)\.json$/.exec(n))
      .some((m) => !!m && pidAlive(Number(m[1])));
  } catch {
    return false;
  }
}

/**
 * The 0600 regular files under `stateDir` no Read rule covers, relative to
 * it and sorted. Never follows a link; a bounded walk, which says whether
 * it stopped at its entry cap (`capped`) or skipped deeper folders (`deep`).
 */
function uncoveredSecretFiles(
  stateDir: string,
  rules: string[],
  maxEntries: number,
  maxDepth: number,
  /** Issue 1391: the trail is readable by design, so it isn't listed. */
  trailReadable: boolean,
): { files: string[]; capped: boolean; deep: boolean } {
  const out: string[] = [];
  let seen = 0;
  let capped = false;
  let deep = false;
  const walk = (dir: string, depth: number): void => {
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (++seen > maxEntries) {
        capped = true;
        return;
      }
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && NOT_CREDENTIAL_DIRS.includes(e.name)) continue;
        if (depth >= maxDepth) deep = true;
        else walk(p, depth + 1);
      } else if (e.isFile()) {
        if (trailReadable && depth === 0 && NOT_CREDENTIAL_FILE(e.name))
          continue;
        try {
          if ((fs.lstatSync(p).mode & 0o777) !== 0o600) continue;
        } catch {
          continue;
        }
        if (!readRulesCover(rules, p)) out.push(path.relative(stateDir, p));
      }
      if (capped) return;
    }
  };
  walk(path.resolve(stateDir), 0);
  return { files: out.sort(), capped, deep };
}

/**
 * A state-folder path as doctor may print it (its output gets pasted into
 * reports): a run of over 32 hex characters becomes <id>, and a segment
 * not of [A-Za-z0-9._-]{1,64} becomes <name>, so no token in a name shows.
 */
function safeShownPath(rel: string): string {
  return rel
    .split(path.sep)
    .map((seg) => {
      const s = seg.replace(/[0-9A-Fa-f]{33,}/g, "<id>");
      return /^(?:[A-Za-z0-9._-]|<id>){1,64}$/.test(s) ? s : "<name>";
    })
    .join("/");
}

/**
 * H1 (0.4.48): whether the edge set up here carries Den's proof (the
 * generated edge.yml has the current one). Never prints the proof: only
 * whether it is there. No edge config, or no edge set up here: nothing.
 */
export function edgeProofLines(
  title: string,
  cli: string,
  edgeDir: () => string | null = () => {
    try {
      return readEdgeConfig().stateDir;
    } catch {
      return null;
    }
  },
): { lines: string[]; check?: OnboardCheck } {
  const dir = edgeDir();
  if (!dir) return { lines: [] };
  let yml: string;
  try {
    yml = fs.readFileSync(path.join(dir, "dynamic", "edge.yml"), "utf8");
  } catch {
    return { lines: [] };
  }
  const proof = readEdgeProof(dir);
  const carried = !!proof && yml.includes(proof);
  const detail = carried
    ? `the edge carries ${title}'s proof on its route; requests through it are believed only with it. A new one: \`${cli} edge up --rotate-proof\``
    : `the edge doesn't carry ${title}'s proof yet, so everyone signs in through it, this machine too. ${title} adds it at its next start, or run \`${cli} edge up\``;
  return {
    lines: [
      "",
      `${title} doctor: Edge proof`,
      "",
      `  edge proof  ${carried ? "✓" : "⚠"}  ${detail}`,
    ],
    check: { id: "edge_proof", status: carried ? "ok" : "warn", detail },
  };
}

/**
 * 0.4.48: whether the running Den listens on the Docker bridge for the
 * edge (Linux), and where, or why not, as it recorded at its start.
 * Nothing when it recorded nothing (not Linux, or no edge here).
 */
export function bridgeListenLines(
  title: string,
  state: () => ReturnType<typeof readBridgeState> = () =>
    readBridgeState(getStateDir()),
): { lines: string[]; check?: OnboardCheck } {
  const o = state();
  if (!o) return { lines: [] };
  const ok = o.state === "listening";
  const detail = bridgeLine(o, title);
  return {
    lines: [
      "",
      `${title} doctor: Docker bridge`,
      "",
      `  bridge  ${ok ? "✓" : "⚠"}  ${detail}`,
    ],
    check: { id: "bridge_listen", status: ok ? "ok" : "warn", detail },
  };
}

/**
 * SRV-P6 (0.4.48): server_agent.self_update, always: its value, where it
 * came from (user.yml, the org config not yet copied, or the default),
 * and the update check's last pass and next (the running Den writes them).
 */
export function selfUpdateLines(
  title: string,
  d: {
    config: () => Pick<
      ReturnType<typeof readServerAgentConfig>,
      "selfUpdate" | "selfUpdateFrom" | "updateCheckMs"
    >;
    state: () => CheckState | null;
    orgFile: string;
    /** Issue 1189: the pin step's record (pin.json); default the state dir's. */
    pin?: () => PinRecord | null;
  } = {
    config: () => readServerAgentConfig(),
    state: () => readCheckState(getStateDir()),
    orgFile: product().configFile,
  },
): { lines: string[]; check: OnboardCheck } {
  let r: { status: "ok" | "warn"; detail: string };
  try {
    r = selfUpdateSummary(d.config(), d.state(), d.orgFile);
  } catch (e) {
    r = {
      status: "warn",
      detail: `self_update: unknown, the config can't be read: ${(e as Error).message}`,
    };
  }
  // Issue 1189: what the self-update's pin step did last, when it says
  // something (a pull request it fell back to, a push that waits).
  let pin: string | null = null;
  try {
    pin = pinDoctorText((d.pin ?? (() => readPinRecord(getStateDir())))());
  } catch {
    pin = null;
  }
  return {
    lines: [
      "",
      `${title} doctor: New versions`,
      "",
      `  self_update  ${r.status === "ok" ? "✓" : "⚠"}  ${r.detail}`,
      ...(pin ? [`  pin          ·  ${pin}`] : []),
    ],
    check: { id: "self_update", status: r.status, detail: r.detail },
  };
}

/**
 * Issue 609: each agent whose attention marks Den never took in the last
 * day (after the hook's tries): how many, and the last reason. A warning.
 */
export function attentionLostLines(
  title: string,
  stateDir: string = getStateDir(),
  read: () => { language?: unknown } = readUserConfig,
): ReturnType<typeof lostMarkLines> {
  let lang: unknown;
  try {
    lang = read().language;
  } catch {
    lang = undefined;
  }
  return lostMarkLines(lostFiles(stateDir), {
    lang,
    title,
  });
}

/**
 * Issue 1217: the rail's pins in user.yml that need a word. An old id-only
 * pin no project holds is kept, shown under All; an entry that isn't a pin
 * is skipped (it stays in user.yml, not shown), never the whole list.
 * Shown only when there is one of either.
 */
export function oldPinsLines(
  title: string,
  read: () => { shell?: unknown } = readUserConfig,
  projectsOf?: PinProjects,
): { lines: string[]; check: OnboardCheck | null } {
  let shell: unknown;
  try {
    shell = read().shell;
  } catch {
    return { lines: [], check: null };
  }
  let of = projectsOf;
  if (!of)
    try {
      of = pinProjectsOf(readWorkspacesFile().workspaces ?? {});
    } catch {
      of = undefined;
    }
  const { kept, skipped } = pinNotes(shell, of);
  if (!kept.length && !skipped.length) return { lines: [], check: null };
  const lines = ["", `${title} doctor: Pins`, ""];
  for (const k of kept)
    lines.push(`  kept, no project  ·  ${k} (shown under All)`);
  for (const k of skipped)
    lines.push(
      `  skipped          ⚠  ${k} (not a pin; left in user.yml, not shown)`,
    );
  const detail = [
    kept.length ? `${kept.length} kept with no project` : "",
    skipped.length ? `${skipped.length} skipped, not a pin` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return {
    lines,
    check: { id: "pins", status: skipped.length ? "warn" : "ok", detail },
  };
}

/**
 * UK-2 (0.4.48): ui.request_memory_seconds became requests.keep_minutes.
 * Shown only while the old key is set: what it became, and whether it still
 * counts (until 0.4.49, when requests.keep_minutes is unset).
 */
export function requestKeepLines(
  title: string,
  read: () => Pick<UserConfig, "ui" | "requests"> = readUserConfig,
): { lines: string[]; check: OnboardCheck | null } {
  let u: Pick<UserConfig, "ui" | "requests">;
  try {
    u = read();
  } catch {
    return { lines: [], check: null };
  }
  const old = u.ui?.request_memory_seconds;
  if (old === undefined || old === null) return { lines: [], check: null };
  const mins = Math.round((Number(old) / 60) * 10) / 10;
  const detail =
    u.requests?.keep_minutes !== undefined
      ? "ui.request_memory_seconds no longer counts: requests.keep_minutes is set. Remove the old line."
      : `ui.request_memory_seconds is now requests.keep_minutes (${mins} minutes). The old line still counts until 0.4.49: move it.`;
  return {
    lines: [
      "",
      `${title} doctor: Request ledger`,
      "",
      `  keep time  ⚠  ${detail}`,
    ],
    check: { id: "request_keep", status: "warn", detail },
  };
}

/**
 * Issue 1333: "Allow this computer?" requests in the last day, from the
 * activity trail (audit.jsonl, verb signin-request), and how many nobody
 * approved. Requests are named by count only here; the trail has each
 * one's address. Never a code.
 */
export function signinRequestLines(
  title: string,
  o: { stateDir?: () => string; now?: number } = {},
): { lines: string[]; check?: OnboardCheck } {
  let text = "";
  try {
    text = fs.readFileSync(
      path.join((o.stateDir ?? getStateDir)(), AUDIT_FILE),
      "utf-8",
    );
  } catch {
    /* no trail yet: none */
  }
  const entries: { ts: string; verb: string; detail: string }[] = [];
  for (const l of text.split("\n")) {
    if (!l.includes(SIGNIN_REQUEST_VERB)) continue;
    try {
      const e = JSON.parse(l) as {
        ts?: unknown;
        verb?: unknown;
        detail?: unknown;
      };
      if (typeof e.ts === "string" && typeof e.verb === "string")
        entries.push({
          ts: e.ts,
          verb: e.verb,
          detail: String(e.detail ?? ""),
        });
    } catch {
      /* a torn line */
    }
  }
  const c = signinRequestCounts(entries, o.now);
  const detail = c.requests
    ? `${c.requests} sign-in request${c.requests === 1 ? "" : "s"} in the last day, ${c.notApproved} nobody approved. The activity trail (verb signin-request) says where each came from`
    : "no sign-in requests in the last day";
  const status = c.notApproved ? "warn" : "ok";
  return {
    lines: [
      "",
      `${title} doctor: Sign-in requests`,
      "",
      `  sign-in requests  ${status === "ok" ? "✓" : "⚠"}  ${detail}`,
    ],
    check: { id: "signin_requests", status, detail },
  };
}

/**
 * Issue 1369: the audit entries in the last day that came in as reports
 * (a process queued them, unverified, no one's word: written while the
 * server was down, by a process that exited before its send, or by
 * something writing the queue itself), and how often the intake dropped
 * queued entries. Counts only, never an entry's words.
 */
export function auditReportLines(
  title: string,
  o: { stateDir?: string; now?: Date } = {},
): { lines: string[]; check: OnboardCheck } {
  const since = (o.now ?? new Date()).getTime() - 24 * 3_600_000;
  let reports = 0;
  let drops = 0;
  for (const e of readAuditRows(o.stateDir ?? getStateDir())) {
    const at = Date.parse(String(e.ts ?? ""));
    if (!(at >= since)) continue;
    if (e.queued === true && e.unverified === true) reports++;
    else if (e.verb === QUEUE_DROPPED_VERB) drops++;
  }
  const said = reports
    ? `${reports} audit entr${reports === 1 ? "y" : "ies"} in the last day came in as reports: queued by a process, unverified, no one's word (the activity trail marks each)`
    : "no audit entry in the last day came in as a report";
  const detail = drops
    ? `${said}. The intake dropped queued entries ${drops} time${drops === 1 ? "" : "s"} (verb ${QUEUE_DROPPED_VERB} says why)`
    : said;
  const status = drops ? "warn" : "ok";
  return {
    lines: [
      "",
      `${title} doctor: Audit reports`,
      "",
      `  audit reports  ${status === "ok" ? "✓" : "⚠"}  ${detail}`,
    ],
    check: { id: "audit_reports", status, detail },
  };
}

/**
 * Issue 278: each running agent's instruction files (the ones its runtime
 * loads at start for its folder, by stat only) against a share of its
 * model's context (agent_context.instruction_share_percent). Over it: a
 * warning naming the largest file, relative to the agent's folder, and its
 * size. A warning, never a failure. Nothing when no agent runs.
 */
export function instructionSizeLines(
  title: string,
  deps: {
    records?: () => AgentRecord[];
    settings?: () => ContextWatchSettings;
    env?: NodeJS.ProcessEnv;
  } = {},
): { lines: string[]; checks: OnboardCheck[] } {
  let records: AgentRecord[] = [];
  let s: ContextWatchSettings;
  try {
    records = (deps.records ?? (() => listRecords(getStateDir())))();
    s = (
      deps.settings ??
      (() => contextWatchSettings(readUserConfig().agent_context))
    )();
  } catch {
    return { lines: [], checks: [] };
  }
  const env = deps.env ?? process.env;
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  for (const rec of records) {
    if (rec.stoppedAt) continue;
    const rt = getRuntime(rec.runtime);
    if (!rt?.instructionFiles) continue;
    const c = instructionCheck(rt.instructionFiles(rec.cwd, env), rec.cwd, {
      sharePercent: s.sharePercent,
      contextTokens: contextTokensFor(rec.model, rec.version, s.contextTokens),
      home: env.HOME,
    });
    const who = `${rec.workspace}/${rec.id}`;
    if (c.over) {
      const detail = `${who}: ${instructionWarning(c)}`;
      lines.push(`  instructions  ⚠  ${detail}`);
      checks.push({
        id: `agents:instructions:${who}`,
        status: "warn",
        detail,
        fix: `Make ${c.largest?.path ?? "the instruction files"} smaller (move detail into files the agent reads when it needs them), or raise agent_context.instruction_share_percent`,
      });
    } else
      checks.push({
        id: `agents:instructions:${who}`,
        status: "ok",
        detail: `${who}: instruction files ${sizeText(c.totalBytes)}, within ${c.sharePercent}% of a ${c.contextTokens}-token context`,
      });
  }
  if (!lines.length) return { lines: [], checks };
  return {
    lines: ["", `${title} doctor: agents' instruction files`, "", ...lines],
    checks,
  };
}

/**
 * agents.git: whether agents' commits sign and verify with their key
 * (a commit in a temp repo, checkAgentSigning), and the line that adds its
 * .pub to GitHub as a signing key. The key is agents.git.signing_key, or
 * (issue 1316) the install's own once an agent start made it. Nothing when
 * signing is off, or the person's git doesn't sign and none is set.
 */
export function signingLines(
  title: string,
  readGit: () => AgentGitSettings | undefined = () => {
    try {
      return resolveAgentSigning({
        git: readAgentsConfig().git,
        stateDir: getStateDir(),
        cwd: process.cwd(),
        env: process.env,
        ensure: existingAgentSigningKey,
      });
    } catch {
      // A bad agents: block is configLines' row.
      return undefined;
    }
  },
  check: (g: AgentGitSettings) => SigningCheck = signingInSandbox,
): { lines: string[]; problem: boolean; checks: OnboardCheck[] } {
  const git = readGit();
  if (!git) return { lines: [], problem: false, checks: [] };
  const r = check(git);
  const add = signingKeyAddLine(git);
  const lines = [
    "",
    `${title} doctor: agents' commit signing`,
    "",
    `  signing  ${r.ok ? "✓" : "✗"}  ${r.detail}`,
    `  signing  ℹ  GitHub shows them Verified once its .pub is a signing key there: ${add}`,
    "             (gh needs the admin:ssh_signing_key scope: gh auth refresh -s admin:ssh_signing_key)",
  ];
  return {
    lines,
    problem: !r.ok,
    checks: [
      {
        id: "agents:signing",
        status: r.ok ? "ok" : "fail",
        detail: r.detail,
        fix: add,
      },
    ],
  };
}

/**
 * Issue 1316: doctor's signing check as an agent's session runs it: git
 * inside the agent sandbox (when it is on), with the key's files read
 * back as a session's are. A key the sandbox hides fails, saying why.
 */
export function signingInSandbox(
  g: AgentGitSettings,
  o: {
    stateDir?: string;
    distRoot?: string;
    env?: NodeJS.ProcessEnv;
    on?: boolean;
    tmp?: string;
  } = {},
): SigningCheck {
  const env = o.env ?? process.env;
  const on =
    o.on ??
    (() => {
      try {
        return sandboxSetting(readAgentsConfig(), "den-doctor-signing");
      } catch {
        return true;
      }
    })();
  if (!on) return checkAgentSigning(g, { ...(o.tmp ? { tmp: o.tmp } : {}) });
  const input = agentSandboxInput({
    stateDir: o.stateDir ?? getStateDir(),
    distRoot: o.distRoot ?? getDistRoot(),
    env,
    // Never an agent's own id: its folder isn't one a check writes.
    agentId: "den-doctor-signing",
    readableFiles: signingReadFiles(g),
  });
  for (const f of [g.signingKey, `${g.signingKey}.pub`])
    if (fs.existsSync(f)) {
      const why = sandboxHidesFile(f, input);
      if (why)
        return {
          ok: false,
          detail: `agents can't read their signing key: ${why}`,
        };
    }
  return checkAgentSigning(g, {
    ...(o.tmp ? { tmp: o.tmp } : {}),
    wrap: (argv) => {
      const w = sandboxFor(argv, input, { on: true });
      return { argv: w.argv, env: w.env };
    },
  });
}

/**
 * `agents:` and `sessions:` (0.4.29): a bad key there stops only the agent
 * and session commands, so doctor names it, with its file and key path,
 * and carries on with every other row. Nothing is shown when both are fine.
 */
export function configLines(
  title: string,
  errorOf: (
    s: "agents" | "sessions" | "web",
  ) => ConfigError | null = sectionConfigError,
  deprecated: () => string[] = () => deprecatedKeys(),
  /** Issue 1373: agent limits both files set, to different values. */
  drift: () => { key: string; mine: unknown; theirs: unknown }[] = () =>
    agentsUserDrift(),
): { lines: string[]; problem: boolean; checks: OnboardCheck[] } {
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  // Keys still accepted that no longer do anything: a note, not a problem.
  for (const l of deprecated()) lines.push(`  agents  ℹ  ${l}`);
  // Issue 1373: user.yml's limit wins; a note, so the person knows which.
  for (const d of drift())
    lines.push(
      `  agents  ℹ  agents.${d.key}: user.yml's ${JSON.stringify(d.mine)} wins over the distribution's ${JSON.stringify(d.theirs)}`,
    );
  for (const section of ["agents", "sessions", "web"] as const) {
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
  return [
    ...userYmlOrgKeys(readUser),
    ...collapseDoneKey(),
    ...teamSelfUpdateKey(),
    ...teamJudgeKey(),
  ];
}

/**
 * Issue 52: agents.coach.judge.enabled is the person's, read only from
 * config/local/user.yml. Judging sends samples, the person's prompts among
 * them, to the model provider, so an agent working beside the
 * distribution's config can't switch it on there. Set there, doctor says
 * it does nothing and where it belongs.
 */
export function teamJudgeKey(
  read: () => { agents?: unknown } = readDenConfig,
): string[] {
  try {
    const coach = (read().agents as { coach?: unknown } | undefined)?.coach;
    const judge = (coach as { judge?: unknown } | null | undefined)?.judge;
    if (!judge || typeof judge !== "object" || !("enabled" in judge)) return [];
    const file = product().configFile;
    return [
      `${file}: agents.coach.judge.enabled does nothing there: it is the person's, set in config/local/user.yml, so an agent working beside that file can't switch on sending samples to the model provider`,
    ];
  } catch {
    return [];
  }
}

/**
 * Review M4 (0.4.48): server_agent.self_update is the person's, in
 * config/local/user.yml. Set in the team file, where the server agent
 * works: Den's first start copies it to user.yml once (migrateSelfUpdate);
 * after that it does nothing there. Doctor says which, so nobody is left
 * believing either file is the one that counts.
 */
export function teamSelfUpdateKey(
  read: () => { server_agent?: unknown } = readDenConfig,
  readUser: () => UserConfig = readUserConfig,
): string[] {
  try {
    const sa = read().server_agent as { self_update?: unknown } | undefined;
    if (!sa || typeof sa !== "object" || !("self_update" in sa)) return [];
    const file = product().configFile;
    const t = sa.self_update;
    const mine = readUser().server_agent;
    if (t !== "ask" && t !== "auto")
      return [
        `${file}: server_agent.self_update is ask or auto, not ${JSON.stringify(t)}; it is the person's now, set in config/local/user.yml`,
      ];
    if (mine?.self_update === undefined)
      return [
        `${file}: server_agent.self_update: ${t} is copied to config/local/user.yml at Den's next start, once; from then on it is the person's, set there`,
      ];
    if (mine.self_update_from)
      return [
        `${file}: server_agent.self_update was copied to config/local/user.yml (${mine.self_update_from}) and does nothing in ${file} now: remove it there`,
      ];
    return [
      `${file}: server_agent.self_update does nothing there: it is the person's, set in config/local/user.yml, so an agent working beside that file can't switch on its own Allow`,
    ];
  } catch {
    return [];
  }
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
      // Issue 503: the terminal host's PTYs, and the machine's.
      const { ptyLines, defaultPtyDeps } = await import("./doctor-ptys.js");
      const pt = await ptyLines(
        readBrand().name,
        defaultPtyDeps(getStateDir()),
      );
      r.checks.push(pt.check);
      if (pt.problem) r.ok = false;
      // Issue 563: the terminal host runs what is installed.
      const { hostModuleLines, defaultHostModuleDeps } =
        await import("./doctor-ptys.js");
      const hm = await hostModuleLines(
        product().cli,
        defaultHostModuleDeps(getStateDir()),
      );
      r.checks.push(hm.check);
      if (hm.problem) r.ok = false;
      // Issue 583: a far too broad repo root, and why Validate refuses it.
      const rr = await repoRootRows();
      r.checks.push(rr.check);
      if (rr.problem) r.ok = false;
      // Issue 701: the Hub comments this install holds.
      r.checks.push((await heldHubLines()).check);
      // Issue 1131: agents' refused calls in the last hour.
      r.checks.push((await tokenRefusalRow()).check);
      // Issue 707: the server's warning lines on disk.
      r.checks.push((await serverLogRow()).check);
      // Issue 625: the test boxes, and why one is skipped.
      const bx = await gateBoxRows();
      if (bx.lines.length) r.checks.push(bx.check);
      // Issue 1274: memory VMs promise, against the machine's RAM.
      const vm = await gateVmRows();
      if (vm.lines.length) r.checks.push(vm.check);
      // Issue 1263: throwaway containers left over from gate runs.
      r.checks.push((await throwawayRows()).check);
      // The shared GitHub watcher: calls left, reset, watches, interval.
      const gw = await githubWatchRow();
      if (gw.check) r.checks.push(gw.check);
    }
    {
      const { hubStatus } = await import("../../shared/hub.js");
      const st = await hubStatus();
      const h = hubLines(st, readBrand().name);
      if (h.check) r.checks.push(h.check);
      if (st.configured) {
        const dl = await hubDeliveryDoctor();
        if (dl.check) r.checks.push(dl.check);
        const { readAgentTokenProblems } =
          await import("../../shared/hub-agent-tokens.js");
        r.checks.push(
          ...hubAgentTokenLines(readAgentTokenProblems(getStateDir())).checks,
        );
      }
      r.checks.push(...(await hubAddressRows(st)).checks);
      // Issue 726: state and tokens from an earlier Hub.
      r.checks.push(...(await previousHubRows()).checks);
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
    r.checks.push(...(await projectMcpDoctor()).checks);
    {
      // D53 (issue 39): Compose projects Den's stacks can't call their own.
      const sc = stackClashLines(
        await safeStackClashes(),
        readBrand().name,
        product().cli,
      );
      if (sc.check) r.checks.push(sc.check);
    }
    const cfg = configLines(readBrand().name);
    r.checks.push(...cfg.checks);
    if (cfg.problem) r.ok = false;
    const sign = signingLines(readBrand().name);
    r.checks.push(...sign.checks);
    if (sign.problem) r.ok = false;
    const checked = await doctorAddress(product().cli);
    const edges = await edgeAddresses();
    const addr = addressLines(
      readWebUrl(),
      readBrand().name,
      product().cli,
      checked,
      edges[0] ?? null,
      edges,
    );
    r.checks.push(addr.check);
    if (addr.problem) r.ok = false;
    {
      const ac = await addressCheckLines(
        readBrand().name,
        product().cli,
        {},
        checked,
      );
      if (ac.check) r.checks.push(ac.check);
      r.checks.push(
        sessionHostLines(
          readWebUrl(),
          ac.works,
          readBrand().name,
          product().cli,
          addressLastAnswered(),
        ).check,
      );
    }
    r.checks.push(
      pushContactLines(
        readWebUrl(),
        readBrand().name,
        product().cli,
        await pushSubscriptionCount(),
      ).check,
    );
    r.checks.push(selfUpdateLines(readBrand().name).check);
    {
      const rk = requestKeepLines(readBrand().name);
      if (rk.check) r.checks.push(rk.check);
    }
    {
      const ep = edgeProofLines(readBrand().name, product().cli);
      if (ep.check) r.checks.push(ep.check);
    }
    // Issue 728: the edge's once-only rotation, and stacks' secrets.
    r.checks.push(...edgeRotationLines(readBrand().name).checks);
    // Issue 728: installs running as this login.
    r.checks.push(...sharedUserLines(readBrand().name).checks);
    r.checks.push(...repoSecretLines().checks);
    {
      const bl = bridgeListenLines(readBrand().name);
      if (bl.check) r.checks.push(bl.check);
    }
    // Issue 278: instruction files over the share of the context.
    r.checks.push(...instructionSizeLines(readBrand().name).checks);
    // Issue 1333: sign-in requests in the last day.
    r.checks.push(signinRequestLines(readBrand().name).check!);
    // Issue 1369: audit entries that came in as reports.
    r.checks.push(auditReportLines(readBrand().name).check);
    // Issue 609: attention marks Den never took, per agent.
    r.checks.push(...attentionLostLines(readBrand().name).checks);
    const pinsCheck = oldPinsLines(readBrand().name).check;
    if (pinsCheck) r.checks.push(pinsCheck);
    // Issue 636: whether this install is a test bed.
    r.checks.push(
      (await import("./test-person.js")).testBedLines(readBrand().name).check,
    );
    // Issue 1407: an install holding the test-install claim, never hidden.
    const claim = (await import("./test-person.js")).testInstallClaimLines(
      readBrand().name,
    ).check;
    if (claim) r.checks.push(claim);
    printJson(r);
    return r.ok ? 0 : 1;
  }
  const rows = doctorRows();
  for (const l of formatDoctor(rows, readBrand().name)) console.log(l);
  const held = approvalsLines(() => readMcpConfig().approvals);
  for (const l of held.lines) console.log(l);
  // Issue 1129: agents the restart queue still holds.
  for (const l of restartsWaitingLines(() =>
    readRestartsWaiting(getStateDir()),
  ))
    console.log(l);
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
  // Issue 503: the terminal host's PTYs, and the machine's.
  const { ptyLines, defaultPtyDeps } = await import("./doctor-ptys.js");
  const pty = await ptyLines(readBrand().name, defaultPtyDeps(getStateDir()));
  for (const l of pty.lines) console.log(l);
  // Issue 563: the terminal host runs what is installed.
  const { hostModuleLines, defaultHostModuleDeps } =
    await import("./doctor-ptys.js");
  const hm = await hostModuleLines(
    product().cli,
    defaultHostModuleDeps(getStateDir()),
  );
  for (const l of hm.lines) console.log(l);
  // Issue 583: a far too broad repo root, and why Validate refuses it.
  const roots = await repoRootRows();
  for (const l of roots.lines) console.log(l);
  // Issue 701: the Hub comments this install holds.
  for (const l of (await heldHubLines()).lines) console.log(l);
  for (const l of (await tokenRefusalRow()).lines) console.log(l);
  for (const l of (await serverLogRow()).lines) console.log(l);
  // Issue 625: the test boxes, and why one is skipped.
  for (const l of (await gateBoxRows()).lines) console.log(l);
  // Issue 1274: memory VMs promise, against the machine's RAM.
  for (const l of (await gateVmRows()).lines) console.log(l);
  // Issue 1263: throwaway containers left over from gate runs.
  {
    const tw = await throwawayRows();
    if (tw.lines.length) {
      console.log(`Throwaway containers: ${tw.check.detail}`);
      for (const l of tw.lines) console.log(l);
    }
  }
  // The shared GitHub watcher: calls left, reset, watches, interval.
  for (const l of (await githubWatchRow()).lines) console.log(l);
  {
    // HUB-1.5: only when hub.url is set.
    const { hubStatus } = await import("../../shared/hub.js");
    const st = await hubStatus();
    for (const l of hubLines(st, readBrand().name).lines) console.log(l);
    if (st.configured) {
      for (const l of (await hubDeliveryDoctor()).lines) console.log(l);
      const { readAgentTokenProblems } =
        await import("../../shared/hub-agent-tokens.js");
      for (const l of hubAgentTokenLines(readAgentTokenProblems(getStateDir()))
        .lines)
        console.log(l);
    }
    for (const l of (await hubAddressRows(st)).lines) console.log(l);
    // Issue 726: state and tokens from an earlier Hub.
    for (const l of (await previousHubRows()).lines) console.log(l);
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
  for (const l of (await projectMcpDoctor()).lines) console.log(l);
  for (const l of stackClashLines(
    await safeStackClashes(),
    readBrand().name,
    product().cli,
  ).lines)
    console.log(l);
  const cfg = configLines(readBrand().name);
  for (const l of cfg.lines) console.log(l);
  const sign = signingLines(readBrand().name);
  for (const l of sign.lines) console.log(l);
  const checked = await doctorAddress(product().cli);
  const edges = await edgeAddresses();
  const addr = addressLines(
    readWebUrl(),
    readBrand().name,
    product().cli,
    checked,
    edges[0] ?? null,
    edges,
  );
  for (const l of addr.lines) console.log(l);
  {
    const ac = await addressCheckLines(
      readBrand().name,
      product().cli,
      {},
      checked,
    );
    for (const l of ac.lines) console.log(l);
    for (const l of sessionHostLines(
      readWebUrl(),
      ac.works,
      readBrand().name,
      product().cli,
      addressLastAnswered(),
    ).lines)
      console.log(l);
    const fx = fixtureLineNow();
    if (fx) console.log(fx);
  }
  // Issue 1073: the test install's name map, used or ignored.
  {
    const tr = testResolveDoctorLine(readTestResolveState(getStateDir()));
    if (tr) console.log(tr);
  }
  // Issue 1225: what the last restore after a restart brought back, or that
  // the setting is off.
  {
    let enabled = true;
    try {
      enabled = servicesRestoreOnBoot();
    } catch {
      /* a bad value: doctor's config check says so */
    }
    const rl = restoreDoctorLine({
      enabled,
      last: readLastRestore(getStateDir()),
    });
    if (rl) console.log(rl);
    try {
      const rm = runtimeMissingDoctorLine({
        runtime: await containerRuntimeOnPath(),
        records: listDaemons(),
      });
      if (rm) console.log(rm);
    } catch {
      /* no service records to read: nothing to say */
    }
  }
  for (const l of pushContactLines(
    readWebUrl(),
    readBrand().name,
    product().cli,
    await pushSubscriptionCount(),
  ).lines)
    console.log(l);
  for (const l of selfUpdateLines(readBrand().name).lines) console.log(l);
  // Issue 1349: the gate's memory guard is off on a platform it can't read.
  {
    const g = await import("../../shared/gates/store.js");
    for (const l of memoryMeasureLines(g.realFreeMemory(), g.realSwapUsedGb()))
      console.log(l);
  }
  for (const l of requestKeepLines(readBrand().name).lines) console.log(l);
  for (const l of oldPinsLines(readBrand().name).lines) console.log(l);
  for (const l of edgeProofLines(readBrand().name, product().cli).lines)
    console.log(l);
  for (const l of edgeRotationLines(readBrand().name).lines) console.log(l);
  for (const l of sharedUserLines(readBrand().name).lines) console.log(l);
  for (const l of repoSecretLines().lines) console.log(l);
  for (const l of bridgeListenLines(readBrand().name).lines) console.log(l);
  for (const l of instructionSizeLines(readBrand().name).lines) console.log(l);
  for (const l of signinRequestLines(readBrand().name).lines) console.log(l);
  for (const l of auditReportLines(readBrand().name).lines) console.log(l);
  for (const l of attentionLostLines(readBrand().name).lines) console.log(l);
  // Issue 636: whether this install is a test bed.
  for (const l of (await import("./test-person.js")).testBedLines(
    readBrand().name,
  ).lines)
    console.log(l);
  for (const l of (await import("./test-person.js")).testInstallClaimLines(
    readBrand().name,
  ).lines)
    console.log(l);
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
      pty.problem ||
      hm.problem ||
      roots.problem ||
      cfg.problem ||
      sign.problem ||
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
    pty.problem ||
    hm.problem ||
    roots.problem ||
    cfg.problem ||
    found
    ? 1
    : 0;
}

/** Issue 726: doctor's rows for state from an earlier Hub. */
/** Issue 625: the machine's test boxes (never checked from here). */
/**
 * Issue 1274: the VMs here and what they promise. DEN_GATE_VMS=0 skips the
 * reading (the test setup sets it: a test never reads this machine's VMs).
 */
async function gateVmRows() {
  const none = {
    lines: [] as string[],
    check: { id: "gate_vms", status: "ok" as const, detail: "" },
  };
  if (process.env.DEN_GATE_VMS === "0") return none;
  try {
    const { vmLines } = await import("./doctor-vms.js");
    const { readVms } = await import("../../shared/gates/vms.js");
    const { GateStore } = await import("../../shared/gates/store.js");
    return vmLines(readVms(new GateStore().settings().vmMemoryShare));
  } catch {
    return none;
  }
}

async function gateBoxRows() {
  const { boxLines } = await import("./doctor-boxes.js");
  const { GateStore } = await import("../../shared/gates/store.js");
  try {
    return boxLines(new GateStore());
  } catch {
    return {
      lines: [] as string[],
      check: { id: "gate_boxes", status: "ok" as const, detail: "" },
    };
  }
}

/** Issue 1263: doctor reads docker's throwaway containers; removes none. */
async function throwawayRows() {
  const { throwawayLines } = await import("./doctor-throwaway.js");
  const { listThrowaway, realDocker, storeTag } =
    await import("../../shared/gates/ephemeral.js");
  const { GateStore } = await import("../../shared/gates/store.js");
  try {
    const store = new GateStore();
    const list = await listThrowaway(realDocker(10_000));
    const all = store.list();
    const live = new Set(all.map((e) => e.id));
    const checkouts = new Set(
      all.flatMap((e) => (e.checkout ? [e.checkout] : [])),
    );
    return throwawayLines(list, live, storeTag(store.dir), checkouts);
  } catch {
    return throwawayLines(null, new Set());
  }
}

async function previousHubRows(): Promise<
  ReturnType<typeof import("./doctor-hub-previous.js").previousHubLines>
> {
  const { previousHubDoctor } = await import("./doctor-hub-previous.js");
  let url: string | null = null;
  try {
    const { readHubConfig } = await import("../../shared/hub.js");
    url = readHubConfig()?.url ?? null;
  } catch {
    /* a bad hub block: its own row says so */
  }
  return previousHubDoctor(getStateDir(), url);
}

/** Issue 1131: agents' refused calls in the last hour, from the audit. */
async function tokenRefusalRow(): Promise<{
  lines: string[];
  check: OnboardCheck;
}> {
  const { tokenRefusalLines, readRefusalTrail } =
    await import("./doctor-token-refusals.js");
  return tokenRefusalLines(readBrand().name, readRefusalTrail(getStateDir()));
}

/** Issue 701: doctor's held Hub comments, from Den's held file. */
async function heldHubLines(): Promise<
  ReturnType<typeof import("./doctor-hub-held.js").heldLines>
> {
  const { heldLines, readHeldFile } = await import("./doctor-hub-held.js");
  let bellMinutes = 5;
  try {
    const { readHubConfig } = await import("../../shared/hub.js");
    bellMinutes = readHubConfig()?.deliveryHeldBellMinutes ?? 5;
  } catch {
    /* a bad hub block: its own row says so; the default here */
  }
  return heldLines(readBrand().name, readHeldFile(getStateDir()), {
    now: Date.now(),
    bellMinutes,
  });
}

/** Issue 707: doctor's row for the server's warning lines on disk. */
async function serverLogRow() {
  const { serverLogLines, serverLogFacts } =
    await import("./doctor-server-log.js");
  const { serverLogPath, serverLogMaxBytes } =
    await import("../../shared/server-log-file.js");
  let user: unknown = null;
  try {
    const { readUserConfig } = await import("../../shared/den-config.js");
    user = readUserConfig();
  } catch {
    /* a bad user.yml: its own row says so; the default here */
  }
  return serverLogLines(
    readBrand().name,
    serverLogFacts(
      serverLogPath(getStateDir()),
      serverLogMaxBytes(user),
      product().cli,
    ),
  );
}

/** Issue 583: doctor's repo roots row, for this install's projects. */
async function repoRootRows() {
  const { repoRootLines, defaultRepoRoots } =
    await import("./doctor-repo-roots.js");
  return repoRootLines(await defaultRepoRoots(), { stateDir: getStateDir() });
}

/**
 * Issue 1349: doctor's line when this platform has no free-memory or swap
 * reading: the gate's memory holds are off here, and the person should see
 * that, not a healthy-looking number.
 */
export function memoryMeasureLines(
  free: number | null,
  swap: number | null,
): string[] {
  return free === null && swap === null
    ? [`Gate slots: ${MEMORY_NOT_MEASURED_WORDS}.`]
    : [];
}
