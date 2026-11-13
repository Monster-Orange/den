/**
 * den Web UI Server
 *
 * Serves a browser-based test runner at http://localhost:7777
 * Endpoints:
 *   GET /                        — UI (index.html)
 *   GET /report/*                — Playwright HTML report (playwright-report/)
 *   GET /api/environments        — Available environments
 *   GET /api/modules?pillar=X    — Modules for a pillar (via moduleScanner)
 *   GET /api/run?pillar=X&...    — SSE stream: runs tests, emits output line-by-line
 */

import { workspaceUrl as workspaceUrlIn } from "./workspace-url.js";
import {
  handleNotificationRoutes,
  isNotificationPath,
} from "./notification-routes.js";
import { attentionWaiting, notificationDeps } from "./notification-service.js";
import {
  composeHealthTarget,
  containerCheckLabel,
  type ComposeHealthTarget,
  type ContainerHealthTarget,
} from "../../shared/stacks/compose-health.js";
import { healthCheckFields, type HealthCheckType } from "./health-row.js";
import { notCheckedReason } from "../../shared/health/not-checked.js";
import { hasRuntime, repoKind } from "../../shared/repo-kind.js";
import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { envSelector } from "../../shared/environment/env-selector.js";
import { moduleScanner } from "../../shared/test-discovery/module-scanner.js";
import { resolveFieldEnv } from "../../shared/perf/optional-fields.js";
import { testRunner } from "../cli/test-runner.js";
import { discoverRepos } from "../../pillars/smoke/discover.js";
import { planSuites } from "../../pillars/suites/run.js";
import { listServicesWithManifests } from "../../shared/manifest/workspace-manifests.js";
import {
  awsProfileEnv,
  loadAwsProfiles,
} from "../../shared/environment/aws-profiles.js";
import { loadCurrentPerfRunReport } from "../../shared/perf/report-store.js";
import type {
  Pillar,
  Environment,
  LogSource,
  ResolvedService,
  WorkspaceConfig,
} from "../../shared/types/index.js";
import { getRunDonePayload } from "./perf-report.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import {
  getActiveWorkspace,
  getActiveWorkspaces,
  activateWorkspace,
  createWorkspace,
  resolveWorkspaceInput,
  getFocusedWorkspaceName,
  getWorkspaceByName,
  isWorkspaceActive,
  listWorkspaceServices,
  readWorkspacesFile,
  resolveDepAddress,
  parseAddress,
  readManifestAnyBranch,
} from "../../shared/environment-manager/workspaces.js";
import {
  parseScope,
  scopeKey,
  pollView,
  inViewMarker,
  scopePayload,
  scopeView,
  storedView,
} from "../../shared/environment-manager/scope.js";
import { findServiceContainer } from "../../shared/environment-manager/service-container.js";
import {
  resolveHistorySource,
  ensureSnapshot,
  readPageBefore,
  searchSystemHistory,
  pruneDeadSnapshots,
  isSafeServiceName,
} from "./log-history.js";
import {
  containerTarget,
  pingContainerCheck,
  pingHttp,
  pingShellCheck,
  TimeoutStreaks,
  prewarmHealthTls,
} from "../../shared/environment-manager/health.js";
import {
  runServiceCommand,
  prepareServiceSecretEnv,
  resolveService,
  listDaemons,
  unregisterDaemon,
  checkServiceHealth,
  loadDaemonsFromFile,
  pruneDeadDaemonsAsync,
  daemonRootOf,
  daemonStaleReason,
  runningContainerBasesAsync,
  isInteractiveServiceCommand,
  rewriteLegacyOpctlKillCommandForContainer,
  shouldDetachServiceCommand,
} from "../../shared/environment-manager/service-runner.js";
import { reapDeadDaemons } from "./daemon-reaper.js";
import {
  loadManifest,
  readManifest,
} from "../../shared/manifest/read-manifest.js";
import {
  getServiceLogRoot,
  spawnStreaming,
  getServiceLogPath,
} from "../../shared/process/spawn-streaming.js";
import {
  assertDenConfigValid,
  sectionConfigError,
  readDenConfig,
  readMcpConfig,
  isProductionEnv,
  isLocalEnabled,
  readUserConfig,
  writeUserConfig,
  readReleaseConfig,
  resolveReleaseTarget,
  writeUserReleaseConfig,
  type ReleaseConfig,
} from "../../shared/den-config.js";
import {
  CONFIG_ERROR_STATUS,
  configErrorBody,
  isConfigError,
} from "../../shared/config-error.js";
import { readOrgView } from "../../shared/org.js";
import {
  engineVersion,
  getDistRoot,
  getEngineRoot,
  getStateDir,
} from "../../shared/paths.js";
import { enginePath } from "../../shared/engine.js";
import {
  releaseService,
  DEPLOYS_OFF_MESSAGE,
  type DeployPlanEntry,
  type ReleaseEvent,
} from "./release-service.js";
import { deploySessions } from "./release-deploy-session.js";
import {
  hasDenHostsEntry,
  spawnDetachedWebRestart,
} from "../cli/web-command.js";
import { recordInvocation } from "../../shared/dev-metrics/emit.js";
import {
  validateManifest,
  validateManifestLayers,
} from "../../shared/manifest/validate-manifest.js";
import { depService } from "../../shared/manifest/deps.js";
import {
  placementRefusal,
  resolveHealthCheck,
  servicePlacement,
  type Expect,
  type Placement,
} from "../../shared/manifest/placement.js";
import {
  readSudoFromVault,
  saveSudoToVault,
  sudoRef,
  sudoVaultStatus,
  sudoVaultWhere,
  SUDO_REF_NAME,
} from "../../shared/auth/sudo-vault.js";
import {
  notConfiguredMessage,
  opTokenSourceSetting,
  secretsConfigWarnings,
} from "../../shared/secrets/index.js";
import { DEN_BANNER_LINES, DEN_SUBTITLE } from "../../shared/banner.js";
import { actorLabel } from "../../shared/agent-actor.js";
import {
  actorSuffix,
  recordAction,
  recordAgentRefusal,
  recordCrossWorkspace,
  repoAtPath,
  setAuditSink,
  setAuditFile,
  AUDIT_FILE,
} from "./audit.js";
import { handleReadonlyRoutes } from "./readonly-routes.js";
import {
  defaultOnboardRouteDeps,
  handleOnboardRoutes,
  type OnboardRouteDeps,
} from "./onboard-routes.js";
import {
  auditActorOf,
  bindRefusal,
  checkRequest,
  isEdgePeer,
  isDockerBridgeAddress,
  isLoopbackAddress,
  isLoopbackBind,
  localNet,
  newCsrfToken,
  principalOf,
  requestIsHttps,
  sessionRequestAllowed,
  setPrincipal,
  signinMessage,
  type GuardContext,
  type GuardResult,
} from "./request-guard.js";
import {
  rotateWebSecret,
  verifyPersonToken,
  WebSecretStore,
} from "../../shared/web-secret.js";
import {
  ACTOR_TOKEN_PREFIX,
  checkActorToken,
  revokeAllActorTokens,
} from "../../shared/actor-token.js";
import {
  checkLoginCode,
  deviceName,
  loginCodeNonce,
  ignoredConfigWarning,
  localhostOrigin,
  loginLink,
  LOGIN_CODE_MAX_TTL_MS,
  mintLoginCode,
  readWebAuthConfig,
  safeNext,
  SESSION_COOKIE_MAX_AGE_S,
  sessionCookieName,
  sessionIdPrefix,
  WebSessionStore,
  withApproveKey,
  type WebAuthConfig,
} from "../../shared/web-session.js";
import { serveUiAsset } from "./ui-assets.js";
import { PERSON_GRANT_ROUTES, personGrantAllowed } from "./approvals.js";
import { migrateWebUrl, notSetLine, readWebUrl } from "../../shared/web-url.js";
import { ClaimNonces, checkClaimCode } from "../../shared/claim-code.js";
import {
  ATTEST_NONCES_FILE,
  attestRedirect,
  attestReturn,
  checkAttestCode,
  mintAttestCode,
} from "../../shared/attest-code.js";
import type { ClaimRules } from "./github-routes.js";
import {
  expiringTokenWarning,
  githubClientId,
  githubEndpoints,
  noClientIdMessage,
  GITHUB_SIGNIN_DOCS,
} from "../../shared/github-app.js";
import { githubDeviceClient } from "../../shared/github-device.js";
import { readWebOwner } from "../../shared/web-owner.js";
import { noRuleMessage, unclaimedSigninReason } from "./github-routes.js";
import { DeviceFlows } from "./device-flows.js";
import {
  decideFlow,
  handleGithubRoutes,
  isGithubRoute,
} from "./github-routes.js";
import { PairRequests } from "./pair-requests.js";
import { LoginWaits } from "./login-waits.js";
import { handlePairRoutes, isPairRoute } from "./pair-routes.js";
import {
  cliCommand,
  cliPrefix,
  isIpLiteral,
  machineLabel,
  parseMachineName,
  sshCommand,
  sshLogin,
  sshTarget,
  sshUser,
} from "../../shared/cli-command.js";
import { graphPrefs, patchStoredGraph } from "./graph-prefs.js";
import { agentsLayout, patchAgentsLayout } from "./agents-layout-pref.js";
import { patchHubAllowTools, readHubConfig } from "../../shared/hub.js";
import { editorOpen, patchEditorOpen } from "./editor-open-pref.js";
import { graphPageHtml } from "./graph-page.js";
import { mergeShellPrefs, shellPrefs, storedShell } from "./shell-prefs.js";
import { distributionSettings, userWebPort } from "./settings-distribution.js";
import {
  appearancePrefs,
  mergeAppearancePrefs,
  storedAppearance,
} from "./appearance-prefs.js";
import {
  activeTheme,
  handleThemeRoutes,
  type ThemeRouteDeps,
} from "./theme-routes.js";
import { findTheme } from "./theme-runtime.js";
import {
  UI_LANGUAGES,
  isUiLanguage,
  localizePage,
  uiLanguage,
} from "./ui-language.js";
import { singleFlight } from "./single-flight.js";
import { graphOrder } from "./graph-order.js";
import { clearReadCache, enableReadCache } from "../../shared/read-cache.js";
import { buildServicesList, type ServicesList } from "./services-list.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = getDistRoot();
const DIST_PUBLIC_DIR = path.join(__dirname, "public");
const SOURCE_PUBLIC_DIR = enginePath("src/ui/server/public");
const PUBLIC_DIR = fs.existsSync(path.join(DIST_PUBLIC_DIR, "index.html"))
  ? DIST_PUBLIC_DIR
  : SOURCE_PUBLIC_DIR;
const REPORT_DIR = path.join(ROOT, "playwright-report");

/** One service's health, as returned by /api/health and its stream. */
interface HealthResult {
  repo: string;
  service: string;
  label: string;
  /** The HTTP check's URL, or null (never a command: see `check`). */
  url: string | null;
  /** A shell check's command (e.g. a compose stack's `stack health`). */
  check?: string;
  repoPath: string;
  mode: "dev-managed" | "managed";
  isEntrypoint: boolean;
  /** true up; false a completed check failed (down); null not known. */
  ok: boolean | null;
  /** With ok null: a check ran but has not answered (pending, not down). */
  pending?: boolean;
  status?: number;
  error?: string;
  /** A 3xx answer's target (MCP-2.4): ok null, not down. */
  redirect?: string;
  /** With ok null and nothing checked: why not (MCP-2.4). */
  why?: string;
  /** Where the app opens for this env (open-in-new-tab), or null. */
  openUrl?: string | null;
  /** Extra named links for this env. */
  links?: OpenLink[];
  /** Where it runs for this env, and where a remote one is (R13). */
  runs: Placement["runs"];
  target: Placement["target"];
  /** From the focused workspace: the header sorts these first. */
  focused?: boolean;
  /**
   * The active workspaces that define this service (focus first). More
   * than one means a shared service: it is listed once, with its owners.
   */
  workspaces?: string[];
  /**
   * WS-6.4: whether the view scope shows it (one of its workspaces is in
   * view). Health covers every active workspace; the header's chip and
   * drawer count only these, while the pages see every row.
   */
  inView?: boolean;
}

/**
 * Health is cached briefly so switching pages doesn't re-run every check. Short
 * enough that a service going down still shows up within one poll interval.
 */
/**
 * Health results are cached host-agnostic; open links are rewritten per
 * request so a viewer on an edge alias (e.g. *.internal) gets links that
 * resolve from where they are.
 */
function viewerRewrite(
  host: string | undefined,
): (r: HealthResult) => HealthResult {
  let edge: { domain: string; aliases: string[] } | null = null;
  try {
    const cfg = readEdgeConfig();
    edge = { domain: cfg.domain, aliases: cfg.aliases ?? [] };
  } catch {
    /* no edge configured */
  }
  if (!edge || !edge.aliases.length) return (r) => r;
  const { domain, aliases } = edge;
  const fix = (u: string) => rehost(u, domain, host, aliases);
  return (r) => ({
    ...r,
    openUrl: r.openUrl ? fix(r.openUrl) : r.openUrl,
    links: r.links?.map((l) => ({ ...l, url: fix(l.url) })),
  });
}

/**
 * A health row as this request sees it: its links rewritten for the
 * viewer's host, and `inView` from the view scope now (WS-6.4: the rows
 * are cached for every active workspace; the scope is applied per answer).
 */
function healthForViewer(
  host: string | undefined,
): (r: HealthResult) => HealthResult {
  const rewrite = viewerRewrite(host);
  const inView = inViewMarker(scopeView());
  return (r) => ({ ...rewrite(r), inView: inView(r.workspaces) });
}

const HEALTH_CACHE_TTL_MS = 8_000;
/** Consecutive timed-out health cycles per check (see TimeoutStreaks). */
const healthTimeouts = new TimeoutStreaks();
const healthCache = new Map<string, { results: HealthResult[]; at: number }>();
/**
 * The full-env health run in flight per cache key. Concurrent polls and
 * streams join it (a stream replays what already landed, then follows), so
 * each cycle runs every check once: a second concurrent run doubled the
 * shell checks' processes and pushed them past their budget under load.
 */
const healthInFlight = new Map<
  string,
  {
    run: Promise<HealthResult[]>;
    landed: HealthResult[];
    listeners: Set<(r: HealthResult) => void>;
  }
>();
/** /api/services builds, shared by concurrent polls and reused briefly. */
/** The startup sweep of stale daemon records (see below the routes). */
let startupPrune: Promise<void> = Promise.resolve();
const SERVICES_CACHE_TTL_MS = 2_000;
// Manifests, the edge config and the derived graph order are reused across
// a request and the polls after it (cleared by any mutating request).
const READ_CACHE_TTL_MS = 5_000;
enableReadCache(READ_CACHE_TTL_MS);
const servicesCache = singleFlight<ServicesList>(SERVICES_CACHE_TTL_MS);
/**
 * A workspace-scoped run covers a different service set than the default
 * one, and the default one covers every active workspace (WS-6.4: the view
 * scope filters what is displayed, never what is polled).
 */
function healthCacheKey(env: Environment, workspace: string | null): string {
  return `${env}|${workspace ?? `*:${scopeKey(pollView())}`}`;
}
import {
  LOG_SWEEP_INTERVAL_MS,
  DEFAULT_PORT,
  CLI_SPAWN_TIMEOUT_MS,
  GIT_REMOTE_TIMEOUT_MS,
  DAEMON_QUICK_EXIT_MS,
  DAEMON_RETRY_DELAY_MS,
  DAEMON_SHUTDOWN_GRACE_MS,
  LIVE_TAIL_LINES,
  HEALTH_CHECK_TIMEOUT_MS,
  HOSTED_HEALTH_CHECK_TIMEOUT_MS,
} from "../../shared/constants.js";

const PORT = parseInt(process.env.PORT ?? String(readWebPortSafe()), 10);

// When this server process started. Used to detect a "stale" server — one whose
// loaded TypeScript is older than the on-disk source (the footgun where `make
// web`/`den web` keeps running old code after an edit). See computeStale().
const SERVER_STARTED_AT = Date.now();
const STALE_CACHE_TTL_MS = 2_000;
let _staleCache: { at: number; stale: boolean; scanned: number } | null = null;

/** Newest mtime (ms) among *.ts under `dir`, skipping node_modules + public/. */
function scanNewestTs(dir: string): { newest: number; count: number } {
  let newest = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        // public/* is served fresh from disk per request (never stale); the
        // server-side code that IS loaded at startup is the *.ts graph.
        if (e.name === "node_modules" || e.name === "public") continue;
        stack.push(path.join(d, e.name));
      } else if (e.name.endsWith(".ts")) {
        try {
          const m = fs.statSync(path.join(d, e.name)).mtimeMs;
          if (m > newest) newest = m;
          count++;
        } catch {
          /* file vanished mid-scan — ignore */
        }
      }
    }
  }
  return { newest, count };
}

/** True when any server-side *.ts is newer than this process's start. Cached. */
function computeStale(): { stale: boolean; scanned: number } {
  const now = Date.now();
  if (_staleCache && now - _staleCache.at < STALE_CACHE_TTL_MS) {
    return { stale: _staleCache.stale, scanned: _staleCache.scanned };
  }
  const { newest, count } = scanNewestTs(enginePath("src"));
  const stale = newest > SERVER_STARTED_AT;
  _staleCache = { at: now, stale, scanned: count };
  return { stale, scanned: count };
}
const SILENT = process.argv.includes("--silent");
/**
 * Verbose mode — adds lifecycle detail to stdout + mirrors SSE `line` events
 * from /api/run to stdout so the server terminal doubles as a live test
 * console. Opt-in via `--verbose` flag or `DEN_LOG=verbose`. Default is
 * unchanged: request lines only. The in-memory log ring populates either way
 * so the /logs page's "den/server" stream works without the flag.
 */
const VERBOSE =
  process.argv.includes("--verbose") || process.env.DEN_LOG === "verbose";

// ── In-memory log ring ────────────────────────────────────────────────────────
// Every message written via serverLog() lands here in plain-text form (ANSI
// stripped) and fans out to any subscribers — primarily the /api/server-log
// SSE stream surfaced on the /logs page. Fixed-size ring so an idle server
// doesn't grow without bound; restart drops history (not persisted to disk).

interface LogEntry {
  ts: string;
  kind: string;
  text: string;
  /** Set when an agent (via `<cli> mcp`) asked for this action: its label. */
  actor?: string;
}

const LOG_RING_MAX = 500;
const logRing: LogEntry[] = [];
const logSubscribers = new Set<(e: LogEntry) => void>();

// ANSI SGR escape sequences — stripping these requires a control-character
// literal (ESC = 0x1b), which triggers no-control-regex. Intentional.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function pushLog(kind: string, text: string, actor?: string): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    kind,
    text: stripAnsi(text),
    ...(actor ? { actor } : {}),
  };
  logRing.push(entry);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  for (const sub of logSubscribers) {
    try {
      sub(entry);
    } catch {
      /* subscriber broke — don't let it take the server down */
    }
  }
}

/**
 * Log to stdout unless --silent was passed, AND fan out to the log ring so the
 * /logs page and any connected SSE subscribers see the same stream.
 */
function serverLog(msg: string, kind: string = "info", actor?: string): void {
  pushLog(kind, msg, actor);
  if (!SILENT && !outputLost()) process.stdout.write(msg + "\n");
}

// Its output's reader gone (the terminal, runner or script that started it
// was killed): write nothing more, and shut down (shutdown-guard.ts).
guardStdio(() => beginShutdown("SIGPIPE"));

// ── Theme ────────────────────────────────────────────────────────────────────
// The active theme (user's, else the org config's `theme:`, else den). A
// theme switch is a write of user.yml `appearance:` and a new /theme.css:
// nothing else (no edge, no services, no restart).
const themeDeps: ThemeRouteDeps = {
  roots: () => ({ distRoot: getDistRoot(), engineRoot: getEngineRoot() }),
  prefs: () => appearancePrefs(readUserConfig().appearance),
  distributionTheme: () => readBrand().theme,
  warn: (line) => serverLog(line, "warn"),
  denFavicon: path.join(PUBLIC_DIR, "favicon.ico"),
};
// The pre-paint script in each page reads the user's mode and the theme's
// default mode from these placeholders, so the first paint is right.
// The UI language (R19): a page in another language than English loads
// its catalog before shell.js, so the first paint is in it.
setHtmlFill((html) => {
  let mode = "system";
  let def = "dark";
  let lang = uiLanguage(undefined);
  try {
    const user = readUserConfig();
    lang = uiLanguage(user.language);
    mode = appearancePrefs(user.appearance).mode;
    def = activeTheme(themeDeps)?.theme.default_mode ?? "dark";
  } catch {
    /* defaults */
  }
  let out = localizePage(html, lang)
    .split("@@DEN_MODE@@")
    .join(mode)
    .split("@@DEN_DEFAULT_MODE@@")
    .join(def);
  // 0.4.1: every page says when the config fails validation, so the shell
  // starts none of its config polls (each would answer 422).
  try {
    assertDenConfigValid();
  } catch (e) {
    if (isConfigError(e))
      out = out.replace(
        '<div id="den-shell"',
        () => '<div id="den-shell" data-config-invalid="1"',
      );
  }
  // 0.4.3: every page says when the edge is reachable from other machines.
  if (EDGE_EXPOSED)
    out = out.replace(
      '<div id="den-shell"',
      () =>
        `<div id="den-shell" data-edge-exposed="${escAttr(edgeExposedMessage(WEB_AUTH.edgeUnattested))}"`,
    );
  // MD-2: every page says when the engine on disk is not the one running.
  const engine = engineCheck();
  if (engine.stale)
    out = out.replace(
      '<div id="den-shell"',
      () =>
        `<div id="den-shell" data-engine-stale="${escAttr(JSON.stringify(engineBanner(engine)))}"`,
    );
  return out;
});

// ── MD-2: the engine this server loaded, against the one on disk ─────────────
const ENGINE = engineWatch(getEngineRoot);

/** The onboarding routes' deps, made on first use. */
let onboardDeps: OnboardRouteDeps | null = null;
function engineCheck(): EngineCheck {
  return ENGINE.check();
}
/** What the shell's banner and the error pages say on a mismatch. */
function engineBanner(c: EngineCheck): {
  loaded: string | null;
  onDisk: string | null;
  message: string;
} {
  return {
    loaded: c.loaded.version,
    onDisk: c.onDisk.version,
    message: engineStaleMessage(c, product().cli),
  };
}
function escAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * R26a: the shell's error page for a failed page request (404 or 500).
 * HEAD gets the status and headers only.
 */
function sendErrorPage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  data: Omit<ErrorPageData, "time" | "version" | "engine">,
): void {
  const engine = engineCheck();
  const full: ErrorPageData = {
    ...data,
    time: new Date().toISOString(),
    version: engine.loaded.version,
    ...(engine.stale ? { engine: engineBanner(engine) } : {}),
  };
  if (res.headersSent) {
    res.end();
    return;
  }
  // A refusal page (421, signed out): every /api call the shell frame
  // would make answers the same refusal, so the shell starts none of its
  // polls and streams (data-api-off; shell.js apiOff).
  const off = data.status === 421 || data.code === "signin_required";
  serveFile(
    res,
    path.join(PUBLIC_DIR, "error.html"),
    (html) => {
      const page = fillErrorPage(html, full);
      return off
        ? page.replace(
            '<div id="den-shell"',
            () => '<div id="den-shell" data-api-off="1"',
          )
        : page;
    },
    data.status,
  );
}

// Every audited action (exec, run, sync) lands in the log as a lifecycle
// line; an agent's carries its label so the /logs page can mark it.
setAuditSink((line, actor) =>
  serverLog(line, "lifecycle", actor ? actorLabel(actor) : undefined),
);
// den#6: the audit ring outlives a restart (<state dir>/audit.jsonl, 0600).
try {
  setAuditFile(path.join(getStateDir(), AUDIT_FILE));
} catch (e) {
  console.error(`[server] the audit file could not be read: ${String(e)}`);
}

/** ANSI helpers (no chalk dependency in the server) */
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function logTimestamp(): string {
  return dim(new Date().toLocaleTimeString("en-US", { hour12: false }));
}

function logStatus(code: number): string {
  if (code < 300) return green(String(code));
  if (code < 400) return yellow(String(code));
  return red(String(code));
}

/** Static extensions we skip logging (too noisy). */
const STATIC_EXTS = new Set([
  ".html",
  ".js",
  ".css",
  ".ico",
  ".map",
  ".png",
  ".svg",
  ".woff",
  ".woff2",
]);

/** Every workspace's checkouts (active or not), for repoAtPath. */
function allWorkspaceCheckouts(): ResolvedService[] {
  const catalog = readCatalog();
  return Object.entries(readWorkspacesFile().workspaces).flatMap(
    ([name, config]) => listWorkspaceServices(config, catalog, name),
  );
}

/**
 * API routes that answer whatever the config holds: the identity probe the
 * CLI and MCP use to find this server, its own log (where a config error is
 * also written), the changelog, and restarting it. And (0.3.0-dev.40, R26a's
 * 422 page) what the shell and the Settings and Logs pages need, so the
 * rail stays usable to reach the fix: the UI prefs (theme, mode, language,
 * the rail's pins) and editor settings (/api/settings: user.yml, and the
 * org config's Distribution rows read without validation), the installed
 * themes, the view scope and a workspace's editor (workspaces.yml), and
 * whether a sudo password is held. None of them reads org data.
 */
const CONFIG_FREE_ROUTES = new Set([
  "/api/server-info",
  // SEC-1a: the shell's CSRF token, which the Settings fix itself needs.
  "/api/session",
  // SEC-1b: signing out, and the CLI's `web sessions` / `web logout`.
  "/api/session/logout",
  "/api/web/sessions",
  "/api/web/logout",
  "/api/server-log",
  "/api/changelog",
  "/api/web/restart",
  "/api/settings",
  "/api/themes",
  "/api/scope",
  "/api/workspaces/settings",
  "/api/sudo-password/status",
  // The env picker on every page (falls back to local; a consumer's dev.40 finding).
  "/api/environments",
]);

/**
 * Pages that load whatever the config holds (0.3.0-dev.40): the rail's way
 * to the fix (Settings, Logs). Any other page navigation with a config that
 * fails validation gets the 422 "Config is invalid" page.
 */
const CONFIG_FREE_PAGES = new Set(["/settings", "/settings.html", "/logs"]);

// ── Sudo password store ───────────────────────────────────────────────────────
import {
  setSudoPassword,
  realSudoPath,
  clearSudoPassword,
  clearSudoShims,
  closeLockForThisRequest,
  inRequestLockScope,
  getSudoEnv,
  prewarmSudo,
  hasSudoPassword,
  hasPasswordlessSudo,
  watchSudo,
} from "./sudo-store.js";
import {
  guardStdio,
  isLostOutputError,
  outputLost,
  requestShutdown,
} from "./shutdown-guard.js";

/** This server saved the admin password to the vault or loaded it from there. */
let sudoInVault = false;

// ── HTTP helpers ─────────────────────────────────────────────────────────────
import { sweepLogs } from "../../shared/process/log-rotation.js";
import {
  readBody,
  sendJson,
  serveFile,
  serveUntrustedFile,
  UNTRUSTED_FILE_HEADERS,
  send400,
  send404,
  setHtmlFill,
} from "./http-helpers.js";
import { orgOf, listOrgs } from "../../shared/manifest/service-links.js";
import {
  engineStaleMessage,
  engineWatch,
  type EngineCheck,
} from "./engine-stamp.js";
import {
  fillErrorPage,
  jsonApiErrors,
  newRequestId,
  pluginForPath,
  routeTemplate,
  wantsHtmlPage,
  type ErrorPageData,
} from "./http-errors.js";
import {
  readOrgContext,
  resolveAllWorkspaceOrgs,
  withOrgMembership,
} from "../../shared/environment-manager/workspace-org.js";
import {
  readLatestSummary,
  securityReportsDir,
} from "../../pillars/security/findings.js";

// ── Changelog parser ──────────────────────────────────────────────────────────
import { parseChangelog } from "./changelog-parser.js";

// ── Extracted services ───────────────────────────────────────────────────────
import { GitHubService } from "./github-service.js";
import { EditorManager, SUPPORTED_LANGUAGES } from "./editor-manager.js";
import {
  handleWorkspaceRoutes,
  workspaceCreateRefusal,
} from "./workspace-routes.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
  isApprovalPath,
  type HeldActions,
} from "./approval-routes.js";
import { heldActions } from "./held-actions.js";
import type { ApprovalQueue } from "./approvals.js";
import { processPathRules } from "../cli/onboard-reads.js";
import { handleHubProxy } from "./hub-proxy-routes.js";
import {
  handleAgentRoutes,
  startAgentUpkeep,
  webDeps as agentWebDeps,
} from "./agent-routes.js";
import {
  hubUpstream,
  policyResolver,
  restartResolver,
} from "../cli/agent-ops.js";
import { handleServerAgentRoutes } from "./server-agent-routes.js";
import { freshDen } from "../cli/server-agent-ops.js";
import {
  lastRunsByRepo,
  recordRunEnd,
  recordRunStart,
  reposOfRun,
} from "./run-history.js";
import {
  CHECK_CONCURRENCY,
  CHECK_TIMEOUT_MS,
  runCapped,
  timedOutText,
  withTimeout,
} from "./check-pool.js";
import {
  handleSessionList,
  handleSessionUpgrade,
  isSessionIoPath,
  sendSessionHttp,
  SESSION_HELPERS_PATH,
} from "./session-routes.js";
import { refuseUpgrade } from "./websocket.js";
import {
  collectLifecycleExec,
  isLifecycleExecCmd,
  streamLifecycleExec,
} from "./lifecycle-exec.js";
import { readEdgeConfig, readWebPort } from "../../shared/edge/config.js";
import {
  edgeHttps,
  edgeNames,
  webRouteHosts,
} from "../../shared/edge/render.js";
import {
  EDGE_SIGNIN_NOTE,
  edgeExposedMessage,
  edgeExposure,
  edgeNetworkSubnets,
} from "../../shared/edge/exposure.js";
import { initLoginPath } from "../../shared/agents/runtime-search.js";
import {
  linksFor,
  openUrlFor,
  rehost,
  type EdgeOrigin,
  type OpenLink,
} from "../../shared/open-url.js";

import { product } from "../../shared/product.js";
import { readBrand } from "../../shared/brand.js";
import { launchdSession } from "../../shared/launchd-session.js";
/** config `web.port` (user > team), falling back to the built-in default. */
function readWebPortSafe(): number {
  try {
    return readWebPort();
  } catch {
    return DEFAULT_PORT;
  }
}
const github = new GitHubService();
const editors = new EditorManager();

// ── Health check ─────────────────────────────────────────────────────────────
// pingHttp / pingShell are imported from shared health module above.

// ── Test source resolution ───────────────────────────────────────────────────
// Returns, for each repo contributing tests to a pillar, the resolved repo path
// plus its current git branch + short SHA. Used to surface the source of truth
// in the Tests UI and the run log so workspace/registry drift is visible.

interface TestSource {
  repoName: string;
  repoPath: string;
  branch: string | null;
  shortSha: string | null;
  workspace: string | null;
}

function readGitField(gitArgs: string[], cwd: string): string | null {
  const r = spawnSync("git", gitArgs, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_REMOTE_TIMEOUT_MS,
  });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim() || null;
}

function collectTestSources(
  pillar: "synthetic" | "smoke" | "journeys" | "security",
): TestSource[] {
  const workspace = getActiveWorkspace()?.name ?? null;
  const sources: TestSource[] = [];
  for (const repo of discoverRepos()) {
    const manifest = repo.manifest as {
      synthetics?: unknown;
      smoke?: Record<string, unknown>;
      journeys?: unknown;
      security?: Record<string, unknown>;
    } | null;
    const matches =
      pillar === "synthetic"
        ? !!manifest?.synthetics
        : pillar === "journeys"
          ? !!manifest?.journeys
          : pillar === "security"
            ? Object.keys(manifest?.security ?? {}).length > 0
            : Object.keys(manifest?.smoke ?? {}).length > 0;
    if (!matches) continue;
    sources.push({
      repoName: repo.repoName,
      repoPath: repo.repoPath,
      branch: readGitField(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        repo.repoPath,
      ),
      shortSha: readGitField(["rev-parse", "--short", "HEAD"], repo.repoPath),
      workspace,
    });
  }
  return sources;
}

function formatSourceLine(src: TestSource): string {
  const wsTag = src.workspace ? ` @ ${src.workspace}` : "";
  const branch = src.branch ?? "(no branch)";
  const sha = src.shortSha ? ` (${src.shortSha})` : "";
  return `${src.repoName}${wsTag} · ${branch}${sha} — ${src.repoPath}`;
}

// ── Lifecycle helpers ─────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m${rs}s`;
}

function shortRunId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * When VERBOSE, mirror SSE `line` events to stdout prefixed with a run id so
 * the server terminal doubles as a live test console. Off by default — this
 * is the firehose mode, not for everyday use.
 */
function mirrorLine(runId: string, text: string): void {
  if (!VERBOSE) return;
  process.stdout.write(`  ${dim(`[${runId}]`)} ${stripAnsi(text)}\n`);
}

// ── Request checks (SEC-1a, SEC-1 spec §3) ─────────────────────────────────────

/**
 * The edge hostnames that route to this server: each route whose upstream
 * is this server's port (or the configured `web.port`, which the edge's
 * own route for Den names) on the docker host, under every edge domain.
 * None without an edge block.
 */
function denEdgeHosts(): string[] {
  let cfg: ReturnType<typeof readEdgeConfig>;
  try {
    cfg = readEdgeConfig();
  } catch {
    return [];
  }
  return webRouteHosts(cfg, new Set([PORT, readWebPortSafe()])).map(
    (r) => r.host,
  );
}

// Bind loopback only: this UI runs privileged local actions (sudo-backed
// service commands). DEN_BIND_HOST=0.0.0.0 exposes it deliberately, and
// (SEC-1b) only with HTTPS in front or web.allow_plain_http_remote.
const BIND_HOST = process.env.DEN_BIND_HOST ?? "127.0.0.1";

/**
 * SEC-1b: `web.allow_plain_http_remote`, read at start. A wrong value
 * refuses to start, naming its key. The 0.4.1-dev `web.session` lifetimes
 * are ignored (a session never expires), with a warning at start.
 */
const WEB_AUTH: WebAuthConfig = (() => {
  try {
    return readWebAuthConfig(getDistRoot(), product().configFile);
  } catch (e) {
    console.error(`\n  ✗ ${(e as Error).message}\n`);
    process.exit(1);
  }
})();

/** web's sign-in config read now (Settings may change it), else at start. */
function webAuthNow(): WebAuthConfig {
  try {
    return readWebAuthConfig(getDistRoot(), product().configFile);
  } catch {
    return WEB_AUTH;
  }
}

/** D17: who may claim this Den while it has no owner (read now). */
function claimRulesNow(): ClaimRules {
  const w = webAuthNow();
  return {
    ...(w.ownerGithub ? { ownerGithub: w.ownerGithub } : {}),
    ...(w.allowedGithubOrg ? { allowedGithubOrg: w.allowedGithubOrg } : {}),
    // Where it is, or would go: the distribution config.
    allowedGithubOrgFile: w.allowedGithubOrgFile ?? product().configFile,
  };
}

/** D17: the spent "This is my computer" codes (attest-code.ts). */
const ATTEST_NONCES = new ClaimNonces(getStateDir(), ATTEST_NONCES_FILE);

/** The request's Host without its port, lowercase. */
function hostNameOf(req: http.IncomingMessage): string {
  return String(req.headers.host ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "");
}

/**
 * D17: spend an attest code for this request's host: one of this server's
 * edge hostnames, the code minted for it, unused. True once.
 */
function spendAttest(req: http.IncomingMessage, code: string): boolean {
  const secret = webSecret.current();
  const host = hostNameOf(req);
  if (!secret || !denEdgeHosts().includes(host)) return false;
  const c = checkAttestCode(code, secret, host);
  return c.ok && ATTEST_NONCES.consume(c.nonce, c.expiresAt);
}

/**
 * `GET /attest?return=<edge URL>` (D17, fix A): only on localhost (only a
 * browser on this machine reaches it there). A 303 back to `return`, one of
 * this server's own edge hosts, with a short-lived code in the fragment.
 * Anything else: an error page, and no code.
 */
function handleAttest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  guard: GuardResult,
  requestId: string,
): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const refuse = (status: 400 | 403, message: string) =>
    sendErrorPage(req, res, {
      status,
      path: "/attest",
      message,
      code: status === 403 ? "not_this_computer" : "bad_return",
      requestId,
    });
  if (!guard.ok || guard.via !== "loopback" || guard.beyond)
    return refuse(
      403,
      "This works only on the computer this Den runs on, at localhost.",
    );
  const ret = attestReturn(url.searchParams.get("return"), denEdgeHosts());
  const secret = webSecret.current();
  if (!ret || !secret)
    return refuse(
      400,
      "That address isn't one of this Den's own. Open this Den at its own address and try again.",
    );
  res.writeHead(303, {
    Location: attestRedirect(ret, mintAttestCode(secret, ret.host)),
  });
  res.end();
}

/**
 * The loopback names, with the port: localhost (canonical), 127.0.0.1 and
 * [::1]; the product's own name when /etc/hosts maps it to 127.0.0.1 (the
 * URL `web up` opens then); and a loopback address DEN_BIND_HOST binds.
 */
function loopbackNames(): string[] {
  const names = ["localhost", "127.0.0.1", "[::1]"];
  try {
    if (hasDenHostsEntry(fs.readFileSync("/etc/hosts", "utf-8")))
      names.push(product().cli.toLowerCase());
  } catch {
    /* no hosts file */
  }
  const bind = BIND_HOST.trim().toLowerCase();
  if (net.isIP(bind) && isLoopbackBind(bind))
    names.push(net.isIPv6(bind) ? `[${bind}]` : bind);
  return [...new Set(names)];
}

/**
 * SEC-1b: this machine's own LAN names, with the port, for a non-loopback
 * bind that `web.allow_plain_http_remote` allows: the bound address, or
 * (0.0.0.0, ::) every interface's address and the host name. Beyond
 * loopback, so every route needs a session. An IP literal or this
 * machine's own name can't be rebound; any other name stays 421.
 */
function lanHosts(): string[] {
  const bind = BIND_HOST.trim().toLowerCase();
  if (isLoopbackBind(bind) || !WEB_AUTH.allowPlainHttpRemote) return [];
  const br = (a: string) => (net.isIPv6(a) ? `[${a}]` : a);
  if (bind !== "0.0.0.0" && bind !== "::")
    return net.isIP(bind) ? [br(bind)] : [bind];
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? [])
      if (!a.internal)
        out.push(br(a.address.toLowerCase().replace(/%.*$/, "")));
  const host = os.hostname().toLowerCase();
  if (host) out.push(host, host.endsWith(".local") ? host : `${host}.local`);
  return [...new Set(out)];
}

/** HTTPS in front of this server: an edge with TLS that routes to it. */
function edgeFronted(): boolean {
  try {
    return (
      readEdgeConfig().tls.strategy !== "none" && denEdgeHosts().length > 0
    );
  } catch {
    return false;
  }
}

const webSecret = new WebSecretStore();
const webSessions = new WebSessionStore({
  secret: () => webSecret.current(),
});
const SESSION_COOKIE = sessionCookieName(PORT);

/** The request's `den_session_<port>` cookie value, if any. */
function sessionCookie(req: http.IncomingMessage): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE)
      return part.slice(i + 1).trim();
  }
  return undefined;
}

const LAN_HOSTS = lanHosts();
/** This machine's addresses (localNet), re-read at most every 10 s. */
let LOCAL_NET = { at: 0, net: localNet() };
/** The edge's Docker networks' subnets (edgeNetworkSubnets), once at start. */
let EDGE_NETS: { address: string; netmask: string }[] = [];
function currentLocalNet(): ReturnType<typeof localNet> {
  if (Date.now() - LOCAL_NET.at > 10_000) {
    const here = localNet();
    LOCAL_NET = {
      at: Date.now(),
      net: { own: here.own, bridges: [...here.bridges, ...EDGE_NETS] },
    };
  }
  return LOCAL_NET.net;
}
/** Read the edge's Docker networks' subnets in the background (no edge: none). */
function readEdgeNetworks(): void {
  let names: string[];
  try {
    const cfg = readEdgeConfig();
    names = [edgeNames(cfg.org).network, ...cfg.networks];
  } catch {
    return;
  }
  void edgeNetworkSubnets(names)
    .then((nets) => {
      EDGE_NETS = nets;
      LOCAL_NET = { at: 0, net: LOCAL_NET.net }; // re-read on the next request
    })
    .catch(() => undefined);
}
const GUARD: GuardContext = {
  port: PORT,
  loopbackNames: loopbackNames(),
  edgeHosts: denEdgeHosts,
  lanHosts: () => LAN_HOSTS,
  verifyBearer: (token) => {
    // SEC-1c: an agent's actor token, live while its session runs.
    if (token.startsWith(ACTOR_TOKEN_PREFIX)) {
      const rec = checkActorToken(getStateDir(), token);
      if (rec === "revoked") return "revoked";
      return rec
        ? {
            kind: "agent",
            actor: rec.actor,
            workspace: rec.workspace,
            grants: rec.grants,
            session: rec.session,
          }
        : null;
    }
    const secret = webSecret.current();
    return secret ? verifyPersonToken(token, secret) : null;
  },
  csrfToken: newCsrfToken(),
  session: (req) => webSessions.lookup(sessionCookie(req)),
  peerIsLoopback: (req) => isLoopbackAddress(req.socket?.remoteAddress),
  // The edge hostname only from the edge's own peers (loopback, Docker).
  peerIsEdge: (req) => isEdgePeer(req.socket?.remoteAddress),
  // This machine's addresses and bridges, for edgeClient (SEC-2a).
  localNet: currentLocalNet,
  // A deliberate exposure (DEN_BIND_HOST beyond loopback, other than the
  // Linux edge's Docker bridge): the edge needs a sign-in too.
  exposed: !isLoopbackBind(BIND_HOST) && !isDockerBridgeAddress(BIND_HOST),
  // SEC-2a: an edge client Den can't place signs in (web.edge_unattested).
  edgeUnattested: WEB_AUTH.edgeUnattested,
};

// ── SEC-2a: Sign in with GitHub, the owner, pairing ──────────────────────────
const GITHUB_CLIENT_ID = githubClientId(WEB_AUTH.githubClientId);
const GITHUB = githubEndpoints();
const DEVICE_FLOWS = new DeviceFlows({
  client: githubDeviceClient(GITHUB),
  clientId: () => GITHUB_CLIENT_ID,
  decide: decideFlow(
    getStateDir,
    (l) => serverLog(l, "lifecycle"),
    () => claimRulesNow(),
  ),
  // A test's fake GitHub may answer interval 0; the real one never does.
  minIntervalMs: GITHUB.fake ? 50 : 1000,
  onExpiringToken: noteExpiringToken,
});

/**
 * The GitHub App has "Expire user authorization tokens" on (a token answer
 * carried expires_in or a refresh_token). Sign-in still completes; Den
 * warns once, naming the fix, and Settings › Access (GET /api/web/owner)
 * says so as a boolean. The token itself is never logged or kept.
 */
let GITHUB_TOKENS_EXPIRE = false;
function noteExpiringToken(): void {
  if (GITHUB_TOKENS_EXPIRE) return;
  GITHUB_TOKENS_EXPIRE = true;
  // The in-app log, and stderr (web.log), as the edge's exposure warning.
  const line = `  ⚠ ${expiringTokenWarning()}`;
  pushLog("warn", line);
  if (!outputLost()) process.stderr.write(line + "\n");
}

// ── SEC-2a: approve this computer with a code (pair-requests.ts) ──────────
const PAIRS = new PairRequests();

/**
 * What every printed command starts with (cli-command.ts): `<cli>` when the
 * first one on this server's PATH is this distribution's, else its
 * absolute path. PATH doesn't change while the server runs: once.
 */
let CLI_PREFIX: string | null = null;
function printedCli(): string {
  CLI_PREFIX ??= cliPrefix(product().cli, getDistRoot(), getEngineRoot());
  return CLI_PREFIX;
}

/**
 * The name people read for this machine: `web.machine_name` (user.yml,
 * read now, so a change in Settings shows at once), else the short
 * hostname. Never the browser's Host.
 */
function machineName(): string {
  let set: string | undefined;
  try {
    set = readWebAuthConfig(getDistRoot(), product().configFile).machineName;
  } catch {
    set = WEB_AUTH.machineName;
  }
  return machineLabel(set, os.hostname());
}

/** `web.machine_name` as user.yml holds it, or null (unset or unreadable). */
function machineNameSetting(user: {
  web?: Record<string, unknown>;
}): string | null {
  try {
    return parseMachineName(user.web?.machine_name);
  } catch {
    return null;
  }
}

/**
 * A path as the request log writes it: a sign-in poll's id is its
 * credential (SEC-2a: the code request's, a GitHub flow's), so it shows
 * as `:id`.
 */
function loggedPath(pathname: string): string {
  return pathname.replace(
    /^(\/api\/(?:signin\/code|github\/signin|web\/owner\/link))\/[^/]+$/,
    "$1/:id",
  );
}

/**
 * The account the signed-out page's ssh link logs in as (SEC-2a-UX):
 * `web.ssh_user` (read now), else the account Den runs as; "" for none.
 */
function sshUserNow(): string {
  let set: string | undefined;
  try {
    set = readWebAuthConfig(getDistRoot(), product().configFile).sshUser;
  } catch {
    set = WEB_AUTH.sshUser;
  }
  let osUser = "";
  try {
    osUser = os.userInfo().username;
  } catch {
    /* no account name: none on the page */
  }
  return sshUser(set, osUser);
}

/** Test runs this server is running now, by id (run-history.ts). */
const LIVE_RUNS = new Set<string>();

/** The ssh target for this request: the Host it used, minus the port. */
function sshTargetOf(req: http.IncomingMessage): string {
  return sshTarget(req.headers.host, os.hostname());
}

/**
 * A browser's live WebSockets (a session's terminal), by its session's
 * key: revoking a device closes them at once (SEC-2a).
 */
const SESSION_SOCKETS = new Map<string, Set<net.Socket>>();
function trackSessionSocket(key: string, socket: net.Socket): void {
  const set = SESSION_SOCKETS.get(key) ?? new Set<net.Socket>();
  set.add(socket);
  SESSION_SOCKETS.set(key, set);
  socket.once("close", () => {
    set.delete(socket);
    if (set.size === 0) SESSION_SOCKETS.delete(key);
  });
}
function closeSessionSockets(keys: Iterable<string>): void {
  for (const k of keys) {
    for (const sock of SESSION_SOCKETS.get(k) ?? []) sock.destroy();
    SESSION_SOCKETS.delete(k);
  }
}

/**
 * A new session for this request: its Set-Cookie line, and its approval
 * key (web-session.ts), which only this sign-in's own answer may carry.
 */
function startSession(
  req: http.IncomingMessage,
  via: "github" | "link" | "code" | "claim",
  login?: string,
): { cookie: string; approveKey: string } {
  const g = checkRequest(req, GUARD, product().cli, product().title);
  const named = g.ok ? g.via : null;
  const { id, approveKey } = webSessions.create({
    userAgent: req.headers["user-agent"],
    host: req.headers.host,
    via,
    ...(g.ok && g.client ? { client: g.client } : {}),
    ...(login ? { login } : {}),
  });
  return {
    cookie: sessionSetCookie(id, requestIsHttps(req, named)),
    approveKey,
  };
}

/** The edge hostnames that route here, and their URLs (Pair a device). */
function denEdgeRoutes(): { host: string; url: string }[] {
  try {
    return webRouteHosts(readEdgeConfig(), new Set([PORT, readWebPortSafe()]));
  } catch {
    return [];
  }
}

/**
 * What the signed-out page says about Sign in with GitHub: its state, and
 * (SEC-2a-UX) the owner's login once one is linked, for step 1's "Owner:
 * @login".
 */
function githubSignin():
  | { state: "no_client_id" | "no_owner" }
  | { state: "ready"; ownerLogin: string }
  | {
      state: "claim";
      org?: string;
      ownerGithub?: string;
      /** "This is my computer"'s start, on localhost (fix A). */
      attest?: string;
      message: string;
    } {
  if (!GITHUB_CLIENT_ID) return { state: "no_client_id" };
  const owner = readWebOwner(getStateDir());
  if (owner) return { state: "ready", ownerLogin: owner.login };
  // D17: no owner yet: who may claim it, and how.
  const r = claimRulesNow();
  if (!r.allowedGithubOrg && !r.ownerGithub) return { state: "no_owner" };
  return {
    state: "claim",
    ...(r.allowedGithubOrg
      ? {
          org: r.allowedGithubOrg,
          attest: `${localhostOrigin(PORT)}/attest`,
        }
      : {}),
    ...(r.ownerGithub ? { ownerGithub: r.ownerGithub } : {}),
    message: unclaimedSigninReason(null, r),
  };
}

/**
 * 0.4.3: why the edge is reachable beyond this machine (shared/edge/exposure.ts),
 * once at start; null until known, or when Den can't tell.
 */
let EDGE_EXPOSED: string | null = null;
function checkEdgeExposure(): void {
  // `docker inspect` only when the edge publishes host ports itself
  // (edge.publish); behind another proxy, only the hostnames tell.
  let container: string | null = null;
  try {
    const cfg = readEdgeConfig();
    container = cfg.ports ? edgeNames(cfg.org).container : null;
  } catch {
    return; // no edge
  }
  const hosts = denEdgeHosts();
  if (hosts.length === 0) return;
  void edgeExposure(hosts, container)
    .then((why) => {
      if (!why) return;
      // D80: reachable from other devices is the normal setup when each
      // one signs in first: a quiet note in the log, no page-wide alarm.
      // Only web.edge_unattested: local (no sign-in) is an alarm.
      if (WEB_AUTH.edgeUnattested !== "local") {
        pushLog("info", `  ℹ ${EDGE_SIGNIN_NOTE} (${why})`);
        return;
      }
      EDGE_EXPOSED = why;
      // The in-app log, and stderr, which is web.log even when `web up`
      // starts this --silent (stdout is not written then).
      const line = `  ⚠ ${edgeExposedMessage(WEB_AUTH.edgeUnattested)} (${why})`;
      pushLog("warn", line);
      if (!outputLost()) process.stderr.write(line + "\n");
    })
    .catch(() => undefined);
}

/**
 * The Set-Cookie for a session: HttpOnly, SameSite=Strict, Path=/, Secure
 * when the request came over HTTPS (requestIsHttps: the edge's own header
 * only from the edge), for as long as a browser keeps a cookie: the
 * session itself never expires.
 */
function sessionSetCookie(id: string, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${SESSION_COOKIE_MAX_AGE_S}${secure ? "; Secure" : ""}`
  );
}
function clearSessionCookie(secure: boolean): string {
  return (
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` +
    (secure ? "; Secure" : "")
  );
}

/** The loopback names that aren't localhost: their signed-out page links there. */
function nonCanonicalLoopback(req: http.IncomingMessage): boolean {
  const h = String(req.headers.host ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "");
  return h !== "localhost" && GUARD.loopbackNames.includes(h);
}

/**
 * The signed-out page (§2): the shell frame, "Sign in to use the terminal"
 * (shell-grade on loopback) or "Sign in to use <title>", the command that
 * prints a link, and on 127.0.0.1 or [::1] a link to the same path on
 * localhost (where the cookie is). Never a form for a secret or a token.
 */
function sendSignedOut(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: {
    pathname: string;
    search: string;
    scope: "terminal" | "agents" | "den";
    expired?: boolean;
    /** SEC-2a: a waited-on link: ask for the code `web login` printed. */
    confirm?: boolean;
    requestId: string;
    message: string;
  },
): void {
  const host = String(req.headers.host ?? "").toLowerCase();
  const toLocal = nonCanonicalLoopback(req);
  const via = GUARD.edgeHosts().includes(host.replace(/:\d+$/, ""))
    ? "edge"
    : "other";
  const origin = `${requestIsHttps(req, via === "edge" ? "edge" : null) ? "https" : "http"}://${host}`;
  const bin = printedCli();
  const loginArgs =
    toLocal || host === `localhost:${PORT}` ? [] : ["--origin", origin];
  const cmd = cliCommand(bin, "web", "login", ...loginArgs);
  const ssh = sshTargetOf(req);
  const user = sshUserNow();
  const gh = githubSignin();
  res.setHeader("Cache-Control", "no-store");
  sendErrorPage(req, res, {
    status: 401,
    code: "signin_required",
    path: opts.pathname,
    message: opts.message,
    requestId: opts.requestId,
    signin: {
      scope: opts.scope,
      name: product().title,
      cmd,
      // SEC-2a: which machine runs the commands, and how to reach it.
      machine: machineName(),
      ssh: {
        target: ssh,
        // SEC-2a-UX: the account to log in as ("" for none).
        user,
        // Open Terminal (ssh://) only for a name, never an IP literal.
        name: !isIpLiteral(ssh),
        login: sshCommand(sshLogin(ssh, user), cmd),
      },
      // SEC-2a: Sign in with GitHub, and why it can't be offered yet.
      github: {
        state: gh.state,
        owner: cliCommand(bin, "web", "owner", "link"),
        ...(gh.state === "ready" ? { ownerLogin: gh.ownerLogin } : {}),
        learnMore: GITHUB_SIGNIN_DOCS,
        ...(GITHUB_CLIENT_ID
          ? gh.state === "no_owner"
            ? { message: noRuleMessage(claimRulesNow()) }
            : gh.state === "claim"
              ? {
                  message: gh.message,
                  ...(gh.org ? { org: gh.org } : {}),
                  ...(gh.ownerGithub ? { ownerGithub: gh.ownerGithub } : {}),
                  ...(gh.attest ? { attest: gh.attest } : {}),
                }
              : {}
          : { message: noClientIdMessage(product().cli) }),
      },
      ...(opts.expired ? { expired: true } : {}),
      ...(opts.confirm ? { confirm: true } : {}),
      ...(toLocal && !opts.expired
        ? {
            localhost: `${localhostOrigin(PORT)}${opts.pathname}${opts.search}`,
          }
        : {}),
    },
  });
}

const PUBLIC_ASSET_EXTS = new Set([
  ".js",
  ".css",
  ".ico",
  ".png",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
]);
/** A GET of the UI's code or styling (never /api, a report or a page). */
function isPublicAsset(req: http.IncomingMessage, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (/^\/(api|reports?)(\/|$)/.test(pathname)) return false;
  return PUBLIC_ASSET_EXTS.has(path.extname(pathname).toLowerCase());
}

/** A refused request: R26 JSON for /api, the error page for a page. */
/**
 * A refused write is audited (AG-DROP): an agent's token past its scope
 * (agent_forbidden), and a browser's write without its CSRF token. The
 * other refusals carry no credential to name, and the request log has them.
 */
function auditGuardRefusal(
  req: http.IncomingMessage,
  pathname: string,
  g: Extract<GuardResult, { ok: false }>,
): void {
  if (g.code !== "agent_forbidden" && g.code !== "csrf") return;
  if (g.principal) setPrincipal(req, g.principal);
  const method = (req.method ?? "GET").toUpperCase();
  try {
    recordAction(
      auditActorOf(req),
      {
        verb: /^\/api\/sessions\/[^/]+\/uploads$/.test(pathname)
          ? "upload"
          : "request",
        detail: `${method} ${pathname.slice(0, 300)}`,
        outcome: "refused",
        reason: g.code,
      },
      principalOf(req),
    );
  } catch {
    /* the audit is best-effort here */
  }
}

function sendGuardRefusal(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  refusal: Extract<GuardResult, { ok: false }>,
  requestId: string,
  search = "",
): void {
  if (pathname === "/api" || pathname.startsWith("/api/"))
    return sendJson(
      res,
      {
        ok: false,
        error: refusal.error,
        code: refusal.code,
        // signin_required: why, so the page words it in its own language.
        ...(refusal.scope ? { scope: refusal.scope } : {}),
        requestId,
      },
      refusal.status,
    );
  if (refusal.code === "signin_required" && wantsHtmlPage(req, pathname))
    return sendSignedOut(req, res, {
      pathname,
      search,
      scope: refusal.scope ?? "den",
      requestId,
      message: refusal.error,
    });
  if (wantsHtmlPage(req, pathname))
    return sendErrorPage(req, res, {
      status: refusal.status,
      path: pathname,
      message: refusal.error,
      code: refusal.code,
      requestId,
    });
  res.writeHead(refusal.status, { "Content-Type": "text/plain" });
  res.end(`${refusal.error} (${refusal.code}, request ${requestId})`);
}

/**
 * `GET /auth?c=<code>&next=<path>` (§2): a valid, unused login code (60 s,
 * constant-time mac, single use) becomes a session and its cookie, then a
 * 303 to `next` when it is a same-origin path, else `/`. Anything else gets
 * the signed-out page, which never echoes the code.
 */
async function handleAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  requestId: string,
): Promise<void> {
  if (url.searchParams.has("claim"))
    return handleClaim(req, res, url, requestId);
  const secret = webSecret.current();
  const c = url.searchParams.get("c") ?? "";
  const nonce = loginCodeNonce(c);
  // SEC-2a: a link `web login` waits on asks for its code first. Opened,
  // its code is checked as of the moment it was opened (then 5 minutes).
  const wait = nonce ? LOGIN_WAITS.forNonce(nonce) : null;
  const check = secret
    ? checkLoginCode(c, secret, wait?.openedAt ?? Date.now())
    : null;
  const post = req.method === "POST";
  const gone = () => {
    res.setHeader("Referrer-Policy", "no-referrer");
    if (post)
      return sendJson(
        res,
        {
          ok: false,
          code: "expired",
          error: `This link no longer works. On ${machineName()}, run web login again for a new one.`,
        },
        410,
      );
    return sendSignedOut(req, res, {
      pathname: "/auth",
      search: "",
      scope: "den",
      expired: true,
      requestId,
      message: `That sign-in link expired or was used. Run \`${product().cli} web login\` for a new one.`,
    });
  };
  if (!check?.ok) return gone();
  if (wait && nonce) {
    if (!post) {
      if (wait.state !== "waiting" && wait.state !== "opened") return gone();
      LOGIN_WAITS.open(nonce);
      res.setHeader("Referrer-Policy", "no-referrer");
      return sendSignedOut(req, res, {
        pathname: "/auth",
        search: "",
        scope: "den",
        confirm: true,
        requestId,
        message: "Enter the code `web login` printed.",
      });
    }
    let body: { code?: unknown } = {};
    try {
      body = (JSON.parse((await readBody(req)) || "{}") ?? {}) as typeof body;
    } catch {
      return sendJson(
        res,
        { ok: false, error: "the body must be JSON: { code }" },
        400,
      );
    }
    const r = LOGIN_WAITS.confirm(nonce, String(body.code ?? ""));
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    if (!r.ok) {
      if (r.error === "expired") return gone();
      return sendJson(
        res,
        r.error === "wrong"
          ? {
              ok: false,
              code: "wrong_code",
              left: r.left,
              error:
                "That code isn't right. Check what web login printed and try again.",
            }
          : r.error === "rate_limited"
            ? {
                ok: false,
                code: "rate_limited",
                error: "Too many wrong codes. Wait a minute and try again.",
              }
            : {
                ok: false,
                code: "refused",
                error: `Too many wrong codes: this link no longer works. On ${machineName()}, run web login again.`,
              },
        r.error === "wrong" ? 401 : r.error === "rate_limited" ? 429 : 410,
      );
    }
    if (!webSessions.consumeCode(check.nonce, check.expiresAt)) return gone();
    const g = checkRequest(req, GUARD, product().cli, product().title);
    LOGIN_WAITS.used(nonce, {
      device: deviceName(req.headers["user-agent"]),
      ...(g.ok && g.client ? { client: g.client } : {}),
    });
    const s = startSession(req, "link");
    res.setHeader("Set-Cookie", s.cookie);
    res.setHeader("Cache-Control", "no-store");
    return sendJson(res, {
      ok: true,
      next: safeNext(url.searchParams.get("next")),
      approveKey: s.approveKey,
    });
  }
  // A link nobody waits on (`web login --no-wait`, or minted with no
  // server running): it signs in when opened, once, as before.
  if (post || !webSessions.consumeCode(check.nonce, check.expiresAt))
    return gone();
  const s = startSession(req, "link");
  res.writeHead(303, {
    // The approval key in the fragment: it never reaches a server.
    Location: withApproveKey(
      safeNext(url.searchParams.get("next")),
      s.approveKey,
    ),
    "Set-Cookie": s.cookie,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

/**
 * `GET /auth?claim=<code>` (0.4.15): the setup link `<cli> web claim-link`
 * prints at the end of an install. A valid, unused claim code (30 min,
 * single use across restarts) becomes a session ("claimed with a setup
 * link" in Linked devices), then a 303 to `/` with the session's approval
 * key in the fragment and no claim in the address, no referrer. Anything
 * else: the signed-out page, which says the link was used and never
 * echoes the code. An agent's token never gets here (AGENT_FORBIDDEN).
 */
const CLAIM_NONCES = new ClaimNonces(getStateDir());
function handleClaim(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  requestId: string,
): void {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  const secret = webSecret.current();
  const check =
    req.method !== "POST" && secret
      ? checkClaimCode(url.searchParams.get("claim") ?? "", secret)
      : null;
  if (!check?.ok || !CLAIM_NONCES.consume(check.nonce, check.expiresAt))
    return sendSignedOut(req, res, {
      pathname: "/auth",
      search: "",
      scope: "den",
      expired: true,
      requestId,
      message: `This setup link was used or has expired. If you didn't open it yourself, someone else may have: check Settings › Access › Linked devices. Sign in below, or run \`${product().cli} web claim-link\` in your own terminal for a new one.`,
    });
  const s = startSession(req, "claim");
  res.writeHead(303, {
    // The approval key in the fragment: it never reaches a server.
    Location: withApproveKey("/", s.approveKey),
    "Set-Cookie": s.cookie,
  });
  res.end();
}

/** `web login`'s wait (login-waits.ts), by the CLI's id. */
const LOGIN_WAIT_PATH = /^\/api\/web\/logins\/([A-Za-z0-9_-]{16,64})$/;
const LOGIN_WAITS = new LoginWaits();

/**
 * A service's declared command `cmd` for `env`, own properties only
 * (SEC-1 §6b.2): `constructor` or `__proto__` is no command, never
 * something from Object.prototype.
 */
function declaredCommand<T>(
  commands: Record<string, Record<string, T> | undefined> | undefined,
  env: string,
  cmd: string,
): T | undefined {
  const own = (o: object | undefined, k: string) =>
    o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
  if (!own(commands, env)) return undefined;
  const forEnv = commands![env];
  return own(forEnv, cmd) ? forEnv![cmd] : undefined;
}

// ── ON-3: the writes held for the person (approval-routes.ts) ─────────────────
let approvals: {
  queue: ApprovalQueue;
  actions: HeldActions;
  enabled: () => boolean;
} | null = null;
/** The held writes and their queue, made on first use. */
function approvalDeps(): {
  queue: ApprovalQueue;
  actions: HeldActions;
  enabled: () => boolean;
} {
  if (approvals) return approvals;
  const actions = heldActions({
    rules: () => processPathRules(getStateDir()),
    validate: (m) => validateManifest(m),
    workspaceCreateRefusal,
    createWorkspace: (name) => createWorkspace(name, { services: {} }),
    resolveWorkspace: resolveWorkspaceInput,
    activateWorkspace: (name) => activateWorkspace(name),
    workspaceActive: (name) => isWorkspaceActive(name),
    workspaceExists: (name) =>
      Object.prototype.hasOwnProperty.call(
        readWorkspacesFile().workspaces ?? {},
        name,
      ),
    defaultWorkspace: () => getFocusedWorkspaceName() ?? "default",
    // The exec route's checks for a local `up` (R13 placement, HITL).
    // An inactive workspace is fine: the Allow activates it (held-actions.ts).
    serviceTarget: (service, ws) => {
      const resolved = resolveService(service, ws);
      if (!resolved)
        return {
          ok: false,
          error: `Den doesn't know a service "${service}"${ws ? ` in project "${ws}"` : ""}; the services tool lists what it runs`,
        };
      const manifest = readManifest(resolved.repoPath);
      const refusal = placementRefusal(
        resolved.address,
        servicePlacement(manifest, resolved.subsystem, "local"),
        (e) => isProductionEnv(e),
        "up",
      );
      if (refusal) return { ok: false, error: refusal };
      const def = manifest
        ? declaredCommand(
            manifest.services?.[resolved.subsystem]?.commands,
            "local",
            "up",
          )
        : undefined;
      if (def && isInteractiveServiceCommand(def))
        return {
          ok: false,
          error: `"up" for ${resolved.address} needs an interactive terminal: the person runs \`${product().cli} up ${resolved.address}\``,
        };
      return { ok: true, address: resolved.address };
    },
    // `up` as /api/service/exec runs it, collected instead of streamed.
    tryService: async (address, ws) => {
      const resolved = resolveService(address, ws);
      if (!resolved)
        return {
          ok: false,
          exitCode: null,
          ready: false,
          lines: [`Den no longer knows a service "${address}"`],
        };
      prewarmSudo();
      return collectLifecycleExec(
        {
          resolved,
          cmd: "up",
          workspace: ws,
          env: { E2E_ENVIRONMENT: "local", ...getSudoEnv() },
        },
        {
          run: runServiceCommand,
          health: (r) => checkServiceHealth(r, "local"),
          secretEnv: (a, c, w) => prepareServiceSecretEnv(a, c, w),
        },
      );
    },
  });
  approvals = {
    actions,
    queue: createApprovalQueue(actions, () => getStateDir()),
    // Read per ask: a config edit takes effect without a restart. A bad
    // value throws, and the handler holds nothing then.
    enabled: () => readMcpConfig().approvals,
  };
  return approvals;
}
/** The agent ids with a held write waiting (their rows say "waiting"). */
function waitingAgentIds(): Set<string> {
  // NT-3b: one "needs you" state: a held Allow, or the attention hooks.
  const out = new Set<string>(attentionWaiting().keys());
  if (!approvals) return out;
  for (const actor of approvals.queue.waitingActors())
    if (actor.startsWith("agent:")) out.add(actor.slice("agent:".length));
  return out;
}

/** NT-3b: why each one waits; a held Allow over what the hooks said. */
function waitingReasons(): Map<string, string> {
  const out = new Map<string, string>(attentionWaiting());
  if (approvals)
    for (const actor of approvals.queue.waitingActors())
      if (actor.startsWith("agent:"))
        out.set(actor.slice("agent:".length), "approval");
  return out;
}

/** A test module's name as a run takes it (SEC-1 §6b.2): never a path out. */
const SAFE_MODULE_RE = /^[A-Za-z0-9_@][A-Za-z0-9._@/-]{0,127}$/;

// ── Server ────────────────────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // D70: a workspace by its name ("back office") reaches its slug's routes.
  try {
    req.url = workspaceUrlIn(
      req.url ?? "/",
      () => readWorkspacesFile().workspaces,
    );
  } catch {
    /* unreadable config: the routes say so */
  }
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;
  // R26: one id per request, on every response and on its failure's log line.
  const requestId = requestIdOf(req);
  if (!res.headersSent) res.setHeader("X-Request-Id", requestId);
  // R26b: every /api error answers JSON, whatever the route sends.
  if (pathname === "/api" || pathname.startsWith("/api/"))
    jsonApiErrors(res, requestId);

  // ── Request logging ────────────────────────────────────────────────────────
  // /api/health fires on the UI's 5s polling interval forever — it dominates
  // the request log and crowds out anything useful. Always filtered, from both
  // stdout and the in-memory ring. Static assets are skipped for the same
  // reason. Real errors on those paths still surface via send400/throw.
  {
    const ext = path.extname(pathname);
    const isStatic = STATIC_EXTS.has(ext) || pathname === "/";
    const isHealthPoll = pathname === "/api/health";
    if (!isStatic && !isHealthPoll) {
      const start = Date.now();
      const method = bold((req.method ?? "GET").padEnd(4));
      res.on("finish", () => {
        const ms = dim(`${Date.now() - start}ms`);
        serverLog(
          `  ${logTimestamp()}  ${method}  ${loggedPath(pathname)}  →  ${logStatus(res.statusCode)}  ${ms}` +
            (res.statusCode >= 400 ? dim(`  req ${requestId}`) : ""),
          "request",
        );
      });
    }
  }

  // ── Request checks (SEC-1a): Host, credential, Origin, CSRF ────────────────
  // Before any route, and before a refused request can clear a cache.
  const guard = checkRequest(req, GUARD, product().cli, product().title);
  // The UI's own scripts and styles answer any host, and without a
  // session, so the 421 and signed-out pages (which need shell.js and the
  // theme) render; they hold no data. The request log above records the
  // refusal (status, request id; never the query, where a login code is).
  if (
    !guard.ok &&
    !(
      (guard.code === "misdirected" || guard.code === "signin_required") &&
      isPublicAsset(req, pathname)
    )
  ) {
    auditGuardRefusal(req, pathname, guard);
    return sendGuardRefusal(req, res, pathname, guard, requestId, url.search);
  }
  if (guard.ok) setPrincipal(req, guard.principal);
  // SEC-1c (R8): an agent's request never passes the lock.
  if (guard.ok && guard.principal?.kind === "agent") closeLockForThisRequest();

  // ── Sign-in (SEC-1b, §2) ───────────────────────────────────────────────────
  // Before config validation: signing in never depends on the config.
  if (
    pathname === "/auth" &&
    (req.method === "GET" || req.method === "HEAD" || req.method === "POST")
  )
    return handleAuth(req, res, url, requestId);
  // D17: "This is my computer" (fix A), on localhost only.
  if (pathname === "/attest" && (req.method === "GET" || req.method === "HEAD"))
    return handleAttest(req, res, url, guard, requestId);
  // SEC-2a: `web login` registers its link's wait, then polls it
  // (shell-grade: the CLI's bearer).
  if (pathname === "/api/web/logins" && req.method === "POST") {
    let body: { nonce?: unknown; code?: unknown; expiresAt?: unknown } = {};
    try {
      body = (JSON.parse((await readBody(req)) || "{}") ?? {}) as typeof body;
    } catch {
      return send400(res, "the body must be JSON: { nonce, code, expiresAt }");
    }
    const exp = Number(body.expiresAt);
    const id =
      Number.isFinite(exp) &&
      exp > Date.now() &&
      exp - Date.now() <= LOGIN_CODE_MAX_TTL_MS + 5_000
        ? LOGIN_WAITS.register(
            String(body.nonce ?? ""),
            String(body.code ?? ""),
            exp,
          )
        : null;
    if (!id) return send400(res, "not a login link's nonce, code and expiry");
    res.setHeader("Cache-Control", "no-store");
    return sendJson(res, { ok: true, id });
  }
  {
    const w = LOGIN_WAIT_PATH.exec(pathname);
    if (w && (req.method === "GET" || req.method === "HEAD")) {
      res.setHeader("Cache-Control", "no-store");
      const v = LOGIN_WAITS.get(w[1]);
      if (!v) return sendJson(res, { ok: false, state: "expired" }, 404);
      return sendJson(res, {
        ok: true,
        state: v.state,
        ...(v.device ? { device: v.device } : {}),
        ...(v.client ? { client: v.client } : {}),
        ...(v.usedAt ? { usedAt: new Date(v.usedAt).toISOString() } : {}),
        expiresAt: new Date(v.expiresAt).toISOString(),
      });
    }
  }
  if (
    pathname === "/signin" &&
    (req.method === "GET" || req.method === "HEAD")
  ) {
    // Read-only and sign-in free (§6b.3): it checks the session itself.
    // Signed in, or on loopback (no sign-in there), it goes on to a
    // same-origin `next`; signed out beyond loopback, it is the signed-out
    // page (the `web login` hint, never a form for the secret).
    // D67: `again=1` (the approvals banner's Sign in): the sign-in page
    // even with a session, or on loopback: approving needs a signed-in
    // browser with an approval key, which a browser without one (signed
    // in before 0.4.15, its storage cleared, or never) gets here.
    const again = url.searchParams.get("again") === "1";
    if (guard.ok && (guard.session || !guard.beyond) && !again) {
      res.writeHead(303, {
        Location: safeNext(url.searchParams.get("next")),
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    return sendSignedOut(req, res, {
      pathname,
      search: url.search,
      scope: "den",
      requestId,
      message: signinMessage("den", product().cli, product().title),
    });
  }
  // AG-4a-term's session routes (`/api/sessions/<id>/io`): shell-grade, and
  // an agent's token reaches its own session's only (request-guard). The io
  // is a WebSocket (the server's upgrade handler): a plain GET of it is 426.
  // D32's /api/sessions/helpers (a count, read-grade) is not a session's:
  // the list's handler below answers it.
  if (
    pathname.startsWith("/api/sessions/") &&
    pathname !== SESSION_HELPERS_PATH
  ) {
    await sendSessionHttp(req, res, pathname);
    return;
  }
  // NT: the bell, and agents saying they wait for their person.
  if (guard.ok && isNotificationPath(pathname)) {
    await handleNotificationRoutes(req, res, pathname, notificationDeps());
    return;
  }
  // ON-3: an agent's held writes; Allow from the person's browser only.
  if (
    guard.ok &&
    isApprovalPath(pathname) &&
    (await handleApprovalRoutes(req, res, pathname, guard, approvalDeps()))
  )
    return;
  // 0.4.15: what lets another browser in needs the person, not just
  // loopback (approvals.ts: an agent with a shell is on loopback too).
  if (req.method === "POST" && PERSON_GRANT_ROUTES.includes(pathname)) {
    const g = guard.ok ? guard : null;
    const ok = g ? personGrantAllowed(req, g, printedCli()) : null;
    if (!ok?.ok) {
      recordAction(
        auditActorOf(req),
        {
          verb: "person-grant",
          detail: pathname,
          outcome: "refused" as const,
          reason: "signin_to_approve",
        },
        principalOf(req),
      );
      return sendJson(
        res,
        {
          ok: false,
          code: "signin_to_approve",
          error: ok && !ok.ok ? ok.error : "Sign in first.",
        },
        403,
      );
    }
  }
  // SEC-2a: Sign in with GitHub, the owner's link, Pair a device. Before
  // config validation, like the sign-in above.
  if (
    isGithubRoute(pathname) &&
    (await handleGithubRoutes(req, res, pathname, {
      flows: DEVICE_FLOWS,
      clientId: () => GITHUB_CLIENT_ID,
      tokensExpire: () => GITHUB_TOKENS_EXPIRE,
      cli: product().cli,
      sendJson,
      readBody,
      signIn: startSession,
      edgeRoutes: denEdgeRoutes,
      mintLink: (origin) => {
        const secret = webSecret.current();
        if (!secret) return null;
        const now = Date.now();
        const ttl = webAuthNow().loginLinkTtlMs;
        return {
          url: loginLink(origin, mintLoginCode(secret, now, ttl)),
          expiresAt: now + ttl,
        };
      },
      log: (l) => serverLog(l, "lifecycle"),
      stateDir: getStateDir,
      claimRules: claimRulesNow,
      spendAttest,
    }))
  )
    return;

  // SEC-2a: approve this computer with a code. Before config validation.
  if (
    isPairRoute(pathname) &&
    (await handlePairRoutes(req, res, pathname, {
      pairs: PAIRS,
      sendJson,
      readBody,
      signIn: (r) => startSession(r, "code"),
      client: (r) => {
        const g = checkRequest(r, GUARD, product().cli, product().title);
        return g.ok ? g.client : undefined;
      },
      commands: (r, code) => {
        const approve = cliCommand(printedCli(), "web", "approve", code);
        return {
          approve,
          ssh: sshCommand(sshLogin(sshTargetOf(r), sshUserNow()), approve),
        };
      },
      audit: (r, verb, detail, refused) =>
        recordAction(
          auditActorOf(r),
          {
            verb,
            detail,
            ...(refused
              ? { outcome: "refused" as const, reason: refused }
              : {}),
          },
          principalOf(r),
        ),
    }))
  )
    return;

  // A mutating request may change what /api/services would list (exec and
  // sync stream over GET, for EventSource).
  if (
    (req.method !== "GET" && req.method !== "HEAD") ||
    /\/(exec|sync)$/.test(pathname)
  ) {
    servicesCache.clear();
    clearReadCache();
  }

  // ── Config validation ──────────────────────────────────────────────────────
  // A config that fails validation answers every API route that reads it as
  // the ConfigError the handler below maps to 422 JSON, before any route's own
  // catch can turn it into a 400, a 500 or an empty list. Pages still load.
  if (pathname.startsWith("/api/") && !CONFIG_FREE_ROUTES.has(pathname))
    assertDenConfigValid();
  // A page navigation, likewise: the shell frame with the 422 page, not a
  // page whose every call then fails (R26a). Static files never get here
  // as a navigation (wantsHtmlPage needs Accept: text/html).
  if (
    wantsHtmlPage(req, pathname) &&
    !CONFIG_FREE_PAGES.has(pathname) &&
    (path.extname(pathname) === ".html" ||
      !STATIC_EXTS.has(path.extname(pathname)))
  )
    assertDenConfigValid();

  // ── Static UI ──────────────────────────────────────────────────────────────
  // The Settings page (R21). Local Dev's old settings panel link
  // (/local-dev?settings=1) lands on its category there.
  if (pathname === "/settings" || pathname === "/settings.html") {
    return serveFile(res, path.join(PUBLIC_DIR, "settings.html"));
  }
  if (
    (pathname === "/local-dev" || pathname === "/local-dev.html") &&
    url.searchParams.has("settings")
  ) {
    res.writeHead(302, { Location: "/settings#editor" });
    res.end();
    return;
  }
  // Local Dev is the default page when local environment is enabled.
  if (
    pathname === "/" ||
    pathname === "/local-dev" ||
    pathname === "/local-dev.html"
  ) {
    if (!isLocalEnabled()) {
      res.writeHead(302, { Location: "/tests" });
      res.end();
      return;
    }
    // ON-6: a fresh Den's first page is its own agent (no redirect: a
    // setup link's #ak= fragment stays on this address).
    if (pathname === "/" && (await freshDen()))
      return serveFile(res, path.join(PUBLIC_DIR, "server-agent.html"));
    return serveFile(res, path.join(PUBLIC_DIR, "local-dev.html"));
  }

  // The server agent's page (ON-6): this Den's own agent, in a terminal.
  if (pathname === "/server-agent" || pathname === "/server-agent.html") {
    return serveFile(res, path.join(PUBLIC_DIR, "server-agent.html"));
  }

  // The Graph page (R22): Local Dev's page in its full-width graph view.
  if (pathname === "/graph" || pathname === "/graph.html") {
    if (!isLocalEnabled()) {
      res.writeHead(302, { Location: "/tests" });
      res.end();
      return;
    }
    return serveFile(
      res,
      path.join(PUBLIC_DIR, "local-dev.html"),
      graphPageHtml,
    );
  }

  // The Agents tab (AG-4a-term, AG spec §5d): sessions and terminal panes.
  if (pathname === "/agents" || pathname === "/agents.html") {
    // A typo under agents: is the 422 config page here (only here: the
    // rest of the UI still works).
    const bad = sectionConfigError("agents");
    if (bad && wantsHtmlPage(req, pathname)) throw bad;
    return serveFile(res, path.join(PUBLIC_DIR, "agents.html"));
  }

  if (pathname === "/tests" || pathname === "/index.html") {
    return serveFile(res, path.join(PUBLIC_DIR, "index.html"));
  }

  if (pathname === "/services" || pathname === "/services.html") {
    return serveFile(res, path.join(PUBLIC_DIR, "services.html"));
  }
  if (pathname === "/environments" || pathname === "/environments.html") {
    return serveFile(res, path.join(PUBLIC_DIR, "environments.html"));
  }

  if (pathname === "/release" || pathname === "/release.html") {
    return serveFile(res, path.join(PUBLIC_DIR, "release.html"));
  }

  // The Edge page (PL-SPEC §10): read-only, from /api/edge.
  if (pathname === "/edge" || pathname === "/edge.html") {
    return serveFile(res, path.join(PUBLIC_DIR, "edge.html"));
  }

  if (pathname === "/logs") {
    return serveFile(res, path.join(PUBLIC_DIR, "logs.html"));
  }

  if (pathname === "/header.js") {
    return serveFile(res, path.join(PUBLIC_DIR, "header.js"));
  }

  // The active theme as CSS, its mark and fonts, and the theme list.
  if (handleThemeRoutes(req, res, pathname, themeDeps)) return;

  // The graph's modules (graph.js, panel.js, …) and vendored libraries (ELK).
  if (serveUiAsset(res, pathname, PUBLIC_DIR)) return;

  if (pathname === "/perf-report.js") {
    return serveFile(res, path.join(PUBLIC_DIR, "perf-report.js"));
  }

  // Imported by header.js (the workspace pill's picker models).
  if (pathname === "/workspace-picker.js") {
    return serveFile(res, path.join(PUBLIC_DIR, "workspace-picker.js"));
  }

  if (pathname === "/favicon.ico") {
    return serveFile(res, path.join(PUBLIC_DIR, "favicon.ico"));
  }

  // ── Playwright report ──────────────────────────────────────────────────────
  // A test run wrote it (an agent may have): sandboxed, never Den's origin.
  // `/report/…` only: `/reports/security/…` is ZAP's, below.
  if (pathname === "/report" || pathname.startsWith("/report/")) {
    const relPath = pathname.slice("/report".length) || "/index.html";
    const filePath = path.resolve(path.join(REPORT_DIR, relPath));

    // Path traversal guard — require a separator boundary so a sibling dir
    // sharing the REPORT_DIR prefix (e.g. "playwright-report-evil") can't pass.
    if (
      filePath !== REPORT_DIR &&
      !filePath.startsWith(REPORT_DIR + path.sep)
    ) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Serve index.html for directories
    const target =
      fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
        ? path.join(filePath, "index.html")
        : filePath;

    return serveUntrustedFile(res, target);
  }

  // ── API: environments ──────────────────────────────────────────────────────
  // Orgs the catalog's repos belong to, with config/den.yml display names.
  // ORG-1d: a repo's org is an org listing it, else one whose source claims
  // its owner, else its GitHub owner; a claimed owner is not listed. Service
  // rows keep `org` as the repo's GitHub owner (C3).
  // Each entry also says whether it is the default org (`github_org`) and
  // which workspaces on this machine belong to it (ORG-1a). Nothing else
  // changes: same entries, order and fields (ORG-SPEC C3).
  if (pathname === "/api/orgs") {
    const ctx = readOrgContext();
    const catalog = ctx.catalog;
    const orgs = withOrgMembership(
      listOrgs(catalog, ctx.config.orgs ?? {}),
      resolveAllWorkspaceOrgs(),
      ctx.file,
      ctx.config,
    );
    if (url.searchParams.get("repos") !== "1") return sendJson(res, orgs);
    const repos = Object.fromEntries(
      Object.keys(catalog).map((r) => [r, orgOf(r, catalog, ctx.config.orgs)]),
    );
    return sendJson(res, { orgs, repos });
  }

  if (pathname === "/api/environments") {
    try {
      const allEnvs = await envSelector.getAvailableEnvironments();
      const { environments: enabledEnvs } = readDenConfig();
      const envs = allEnvs.filter((e) => enabledEnvs.includes(e));
      return sendJson(res, envs);
    } catch (err) {
      serverLog(`  ⚠ /api/environments: ${(err as Error).message}`);
      return sendJson(res, ["local"]);
    }
  }

  // ── API: app URL for current env ──────────────────────────────────────────
  if (pathname === "/api/app-url") {
    const env = url.searchParams.get("env") ?? "local";
    try {
      const cfgPath = path.join(ROOT, "config", "environments", `${env}.json`);
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as {
        baseUrls?: { web?: string };
      };
      return sendJson(res, { url: cfg.baseUrls?.web ?? null });
    } catch (err) {
      serverLog(`  ⚠ /api/app-url: ${(err as Error).message}`);
      return sendJson(res, { url: null });
    }
  }

  // ── API: modules ───────────────────────────────────────────────────────────
  if (pathname === "/api/modules") {
    const pillar = url.searchParams.get("pillar") as Pillar | null;
    if (!pillar) return send400(res, "pillar required");
    try {
      const modules = await moduleScanner.scanModules(pillar);
      return sendJson(
        res,
        modules.map((m) => ({
          name: m.name,
          displayName: m.displayName,
          icon: m.icon,
          testCount: m.testCount,
          // Declarative launch-time options the web UI renders generically.
          optionalFields: m.optionalFields ?? [],
        })),
      );
    } catch (err) {
      serverLog(`  ⚠ /api/modules: ${(err as Error).message}`);
      return sendJson(res, []);
    }
  }

  // ── API: security scans ─────────────────────────────────────────────────────
  // The newest ZAP run per env + mode (what the Tests page lists), and its
  // HTML reports, served from reports/security/ only.
  if (pathname === "/api/security/latest") {
    const env = url.searchParams.get("env") ?? "local";
    const modes = ["baseline", "api", "full"];
    return sendJson(
      res,
      modes
        .map((m) => readLatestSummary(env, m))
        .filter((x): x is NonNullable<typeof x> => x !== null),
    );
  }
  if (pathname.startsWith("/reports/security/")) {
    const root = securityReportsDir();
    const rel = decodeURIComponent(pathname.slice("/reports/security/".length));
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !/\.(html|json)$/.test(file))
      return send404(res);
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": file.endsWith(".html")
          ? "text/html; charset=utf-8"
          : "application/json",
        // ZAP's report pulls its own scripts; keep it away from Den's origin data.
        ...UNTRUSTED_FILE_HEADERS,
      });
      return res.end(body);
    } catch {
      return send404(res);
    }
  }

  // ── API: an agent's refused call (F2) ─────────────────────────────────────
  // The MCP server's guards refuse some calls before they reach an action
  // route; it reports them here so the activity trail shows failed attempts.
  // Agents only (the audit header), and the entry is all it can write.
  if (pathname === "/api/activity" && req.method === "POST") {
    // An agent's token, or (unverified) an MCP server's audit headers.
    const actor = auditActorOf(req);
    if (!actor) return sendJson(res, { error: "agents only" }, 403);
    const raw = await readBody(req).catch(() => "");
    if (raw.length > 4096) return send400(res, "report too large");
    let report: Record<string, unknown> = {};
    try {
      report = JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {
      return send400(res, "invalid JSON");
    }
    // A call that named a path (manifest_validate) is recorded under the
    // catalog repo that path is inside, across every workspace's checkouts.
    if (typeof report.repo !== "string" && report.path !== undefined) {
      let repo: string | null = null;
      try {
        repo = repoAtPath(report.path, allWorkspaceCheckouts());
      } catch {
        /* unresolvable workspaces: recorded under the tool only */
      }
      if (repo) report = { ...report, repo };
    }
    // A call into a granted workspace (AG-2a): both workspaces recorded.
    if (report.crossWorkspace !== undefined) {
      const crossed = recordCrossWorkspace(actor, report, principalOf(req));
      if (!crossed) return send400(res, "not a cross-workspace report");
      return sendJson(res, { recorded: true, ts: crossed.ts });
    }
    const entry = recordAgentRefusal(actor, report, principalOf(req));
    return sendJson(res, { recorded: true, ts: entry.ts });
  }

  // ── API: stacks, edge, security plan (read-only; see readonly-routes.ts) ──
  if (await handleReadonlyRoutes(req, res, pathname, url)) return;

  // ── API: onboarding reads (ON-3; see onboard-routes.ts) ──────────────────
  if (
    await handleOnboardRoutes(
      req,
      res,
      pathname,
      url,
      (onboardDeps ??= defaultOnboardRouteDeps(
        (m) => validateManifest(m),
        ENGINE.loaded.version ?? engineVersion() ?? "unknown",
      )),
    )
  )
    return;

  // ── API: test sources ─────────────────────────────────────────────────────
  // Returns the repos that contribute tests for a given pillar, with their
  // current branch + short SHA. Lets the Tests UI show "you are testing
  // against X" so workspace vs registered-repo drift is visible.
  if (pathname === "/api/test-sources") {
    const pillar = url.searchParams.get("pillar");
    if (
      pillar !== "synthetic" &&
      pillar !== "smoke" &&
      pillar !== "journeys" &&
      pillar !== "security"
    ) {
      return sendJson(res, []);
    }
    try {
      return sendJson(res, collectTestSources(pillar));
    } catch (err) {
      serverLog(`  ⚠ /api/test-sources: ${(err as Error).message}`);
      return sendJson(res, []);
    }
  }

  // ── API: den server log (SSE) ──────────────────────────────────────────
  // Tails this server's own stdout-equivalent log stream. The /logs page opens
  // it as "den/server" alongside service log panes so engineers can watch
  // den's lifecycle events without leaving the browser. The ring replays
  // recent history on connect; new entries stream as they happen.
  //
  // Events emitted:
  //   { type: "history", entries: LogEntry[] }  — once, on open
  //   { type: "log", entry: LogEntry }          — per new entry
  if (pathname === "/api/server-log") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const emit = (obj: unknown): void => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        /* client disconnected mid-write; cleanup runs on `close` */
      }
    };
    emit({ type: "history", entries: logRing.slice() });
    const subscriber = (entry: LogEntry): void => {
      emit({ type: "log", entry });
    };
    logSubscribers.add(subscriber);
    req.on("close", () => {
      logSubscribers.delete(subscriber);
    });
    return;
  }

  // ── API: latest perf report ────────────────────────────────────────────────
  if (pathname === "/api/perf-report/current") {
    const report = loadCurrentPerfRunReport(ROOT);
    if (!report) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No perf report available" }));
      return;
    }

    return sendJson(res, report);
  }

  // ── API: health check ─────────────────────────────────────────────────────
  /**
   * Workspaces a health run covers: one named workspace, else every active
   * one, focus first, whatever the view scope (WS-6.4). Health is
   * machine-level: a service running under a non-focused active workspace
   * is still up, and the Workspaces page must say so for any workspace.
   * The scope filters what is displayed: each row's `inView` (forViewer).
   */
  function healthWorkspaces(
    workspaceName: string | null,
  ): Array<{ name: string; config: WorkspaceConfig }> {
    if (workspaceName) {
      const named = getWorkspaceByName(workspaceName);
      return named ? [named] : [];
    }
    return pollView().workspaces.filter((w) => w.config);
  }

  /**
   * Run every health check for `env` (or one service via `addressFilter`).
   * `onResult` fires per check as it lands, so a caller can stream instead of
   * waiting on the slowest.
   */
  async function computeHealth(
    env: Environment,
    addressFilter: string | null,
    onResult?: (r: HealthResult) => void,
    workspaceName: string | null = null,
  ): Promise<HealthResult[]> {
    // Use workspace-aware service lists so repos added via the catalog/workspace
    // (e.g. files-api) are included, not just .den/ symlinks.
    const workspaces = healthWorkspaces(workspaceName);
    if (workspaces.length === 0) return [];
    const catalog = readCatalog();
    // One entry per address across active workspaces; focus wins a duplicate,
    // and only one checkout of a shared address can be running anyway. The
    // owning workspace travels with the service — dep addresses resolve against
    // the workspace the service came from.
    const byAddress = new Map<
      string,
      { svc: ResolvedService; ws: { name: string; config: WorkspaceConfig } }
    >();
    const owners = new Map<string, string[]>();
    for (const ws of workspaces)
      for (const svc of listWorkspaceServices(ws.config, catalog, ws.name)) {
        // Modules and libraries have no runtime, so no health dot.
        if (!hasRuntime(repoKind(svc.repoPath))) continue;
        if (!byAddress.has(svc.address))
          byAddress.set(svc.address, { svc, ws });
        const o = owners.get(svc.address) ?? [];
        if (!o.includes(ws.name)) owners.set(svc.address, [...o, ws.name]);
      }
    let services = [...byAddress.values()];
    if (addressFilter) {
      services = services.filter((s) => s.svc.address === addressFilter);
    }

    const entries: Array<{
      address: string;
      deps: string[];
      repo: string;
      service: string;
      label: string;
      checkType: HealthCheckType;
      target: string;
      repoPath: string;
      mode: "dev-managed" | "managed";
      isEntrypoint: boolean;
      /** Conventional http://<repo>/healthz probe for no-health-check primaries. */
      conventional: string | null;
      openUrl: string | null;
      links: OpenLink[];
      /** The GitHub org that owns the repo. */
      org: string;
      /** Codes that count as up for a remote target.url probe. */
      expect?: Expect;
      /** pingShell options (Den's own `stack health` can report unknown). */
      compose: ComposeHealthTarget | null;
      /** A `type: container` check: answered from the shared listing. */
      container: ContainerHealthTarget | null;
      /** The repo has no manifest (the row is kept, unchecked). */
      noManifest?: boolean;
      meta: Pick<HealthResult, "runs" | "target" | "focused" | "workspaces">;
    }> = [];
    const focusName = getFocusedWorkspaceName();
    let edgeDomain: string | null = null;
    // The links follow the edge's TLS: http on its http port for `tls: none`
    // (0.3.0-dev.40, DOC-1: the panel's Opens said https).
    let edgeOrigin: EdgeOrigin | undefined;
    try {
      const edge = readEdgeConfig();
      edgeDomain = edge.domain;
      edgeOrigin = edgeHttps(edge)
        ? { https: true, port: edge.ports?.https ?? 443 }
        : { https: false, port: edge.ports?.http ?? 80 };
    } catch {
      /* no edge configured: local links come from manifests only */
    }
    for (const { svc: resolved, ws } of services) {
      const manifest = readManifestAnyBranch(
        resolved.repoName,
        resolved.repoPath,
      );
      if (!manifest) {
        // Keep the row (as "unknown"/muted) instead of dropping it: a service
        // vanishing from the payload reads as "everything else is fine" and a
        // merge-by-key client would freeze its last dot.
        entries.push({
          address: resolved.address,
          deps: [],
          repo: resolved.repoName,
          service: resolved.subsystem,
          label: resolved.subsystem,
          checkType: "none",
          target: "",
          repoPath: resolved.repoPath,
          mode: resolved.mode,
          isEntrypoint: false,
          conventional: null,
          openUrl: null,
          links: [],
          org: orgOf(resolved.repoName, catalog),
          compose: null,
          container: null,
          noManifest: true,
          meta: {
            runs: "none",
            target: null,
            focused: ws.name === focusName,
            workspaces: owners.get(resolved.address) ?? [ws.name],
          },
        });
        continue;
      }
      const svcCfg = manifest.services?.[resolved.subsystem];
      // A compose-run repo with no declared check gets the stack's own health
      // (container state + Docker healthchecks), as `den status` does.
      const compose =
        env === "local"
          ? composeHealthTarget(
              manifest,
              resolved.subsystem,
              resolved.repoName,
              ws.name,
            )
          : null;
      // One resolution path with `<cli> status` (placement.ts): a remote
      // service is checked by target.env's declaration, else target.url.
      const plan = resolveHealthCheck(
        manifest,
        resolved.subsystem,
        env,
        compose?.cmd ?? null,
      );
      const healthCfg = plan.check;
      const remote = plan.placement.runs === "remote";
      // Keep services with no health check (checkType "none") so systems like
      // jobs-runtime still appear — as an "unknown" (muted) dot, matching
      // `den status`, rather than vanishing from the health row.
      const deps = (svcCfg?.depends_on ?? []).map((rawDep) => {
        const d = depService(rawDep);
        const { repoName } = parseAddress(
          resolveDepAddress(d, catalog, ws.config, ws.name),
          catalog,
        );
        return repoName === resolved.repoName
          ? resolveDepAddress(d, catalog, ws.config, ws.name)
          : repoName;
      });
      entries.push({
        address: resolved.address,
        deps,
        repo: resolved.repoName,
        service: resolved.subsystem,
        label: plan.label ?? healthCfg?.label ?? resolved.subsystem,
        checkType: healthCfg
          ? healthCfg.type === "shell" || healthCfg.type === "container"
            ? healthCfg.type
            : "http"
          : "none",
        target: healthCfg
          ? healthCfg.type === "shell"
            ? healthCfg.cmd
            : healthCfg.type === "container"
              ? containerCheckLabel(containerTarget(healthCfg))
              : healthCfg.url
          : "",
        repoPath: resolved.repoPath,
        mode: resolved.mode,
        isEntrypoint: manifest.entrypoint === resolved.subsystem,
        // Conventional local discovery (mirrors checkServiceHealth): a PRIMARY
        // service with no declared local health check may still serve the stack
        // convention at http://<repo>/healthz via opctl DNS.
        conventional: (() => {
          if (healthCfg || env !== "local" || remote) return null;
          const keys = Object.keys(manifest.services ?? {});
          const isPrimary = manifest.entrypoint
            ? resolved.subsystem === manifest.entrypoint
            : keys.length === 1;
          return isPrimary ? `http://${resolved.repoName}/healthz` : null;
        })(),
        openUrl: openUrlFor({
          manifest,
          subsystem: resolved.subsystem,
          repoName: resolved.repoName,
          env,
          healthUrl: healthCfg && "url" in healthCfg ? healthCfg.url : null,
          edgeDomain,
          edgeOrigin,
        }),
        links: linksFor(manifest, resolved.subsystem, env),
        org: orgOf(resolved.repoName, catalog),
        ...(plan.expect ? { expect: plan.expect } : {}),
        compose,
        container:
          healthCfg?.type === "container" ? containerTarget(healthCfg) : null,
        meta: {
          runs: plan.placement.runs,
          target: plan.placement.target,
          focused: ws.name === focusName,
          workspaces: owners.get(resolved.address) ?? [ws.name],
        },
      });
    }

    // Order systems top-down like the dependency graph — entry repo first
    // (shop-web) … infra-stack last — so the health row reads the same
    // direction as the graph (and `den status`). orderForDown is the reverse
    // of the deps-first startup order.
    const rank = new Map(
      graphOrder(workspaces[0]?.name).map((repo, i) => [repo, i]),
    );
    const sortedEntries = [...entries].sort((a, b) => {
      const ra = rank.get(a.repo) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.repo) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || a.address.localeCompare(b.address);
    });

    const checkEntry = async ({
      repo,
      service,
      label,
      checkType,
      target,
      repoPath,
      mode,
      isEntrypoint,
      conventional,
      meta,
      expect,
      compose,
      container,
      noManifest,
    }) => {
      if (checkType !== "none") {
        const started = Date.now();
        const ping =
          checkType === "shell"
            ? await pingShellCheck(
                target,
                awsProfileEnv(env),
                repoPath,
                compose,
              )
            : checkType === "container" && container
              ? await pingContainerCheck(container)
              : await pingHttp(
                  target,
                  env === "local" && meta.runs !== "remote"
                    ? HEALTH_CHECK_TIMEOUT_MS
                    : HOSTED_HEALTH_CHECK_TIMEOUT_MS,
                  expect,
                );
        return {
          repo,
          service,
          label,
          ...healthCheckFields(checkType, target),
          repoPath,
          mode,
          isEntrypoint,
          ...meta,
          ms: Date.now() - started,
          // A first timeout is pending; a repeat on the next cycle is down.
          ...healthTimeouts.judge(
            `${env}|${repo}|${service}|${checkType}|${target}`,
            ping,
          ),
        };
      }
      // No declared health check: try the conventional probe when eligible.
      // Success → real "ok"; failure stays "unknown" (ok:null renders muted,
      // not red — we can't distinguish "down" from "no endpoint").
      if (conventional) {
        const probe = await pingHttp(conventional);
        if (probe.ok) {
          return {
            repo,
            service,
            label,
            url: conventional,
            repoPath,
            mode,
            isEntrypoint,
            ...meta,
            ...probe,
          };
        }
      }
      return {
        repo,
        service,
        label,
        url: null,
        repoPath,
        mode,
        isEntrypoint,
        ...meta,
        ok: null,
        why: notCheckedReason({
          env,
          runs: meta.runs,
          target: meta.target,
          manifest: !noManifest,
          conventional,
        }),
      };
    };
    // Stream each result the moment it lands. The checks run concurrently but
    // the slowest (shell probes that shell out to the aws CLI, ~0.45s) used to
    // gate ALL of them, so every dot waited on the worst one.
    // `idx` carries the graph-ranked position above into each STREAMED result.
    // Streaming emits in completion order, which varies per poll (shell probes
    // finish at wildly different speeds), so without a stable key the client
    // repaints the dots in a different order every 5s.
    // 0.4.17: at most CHECK_CONCURRENCY at once, each with at most
    // CHECK_TIMEOUT_MS: a dead host's check says "timed out after 10 s" and
    // never holds up the run (check-pool.ts).
    const late = (e: (typeof sortedEntries)[number]): HealthResult => ({
      repo: e.repo,
      service: e.service,
      label: e.label,
      ...(e.checkType !== "none"
        ? healthCheckFields(e.checkType, e.target)
        : { url: null }),
      repoPath: e.repoPath,
      mode: e.mode,
      isEntrypoint: e.isEntrypoint,
      ...e.meta,
      ms: CHECK_TIMEOUT_MS,
      ok: false,
      error: timedOutText(CHECK_TIMEOUT_MS),
    });
    const run = (e: (typeof sortedEntries)[number], idx: number) =>
      withTimeout(checkEntry(e), CHECK_TIMEOUT_MS, () => late(e)).then((r) => {
        const ranked = { ...r, openUrl: e.openUrl, links: e.links, idx };
        onResult?.(ranked);
        return ranked;
      });
    // Compose and container checks are answered in-process from one shared
    // docker listing (the call in flight): they start no process, so they
    // run outside the cap, all at once, and a cycle still lists once.
    const inProcess = (e: (typeof sortedEntries)[number]) =>
      (e.checkType === "container" && !!e.container) ||
      (e.checkType === "shell" && !!e.compose && e.target === e.compose.cmd);
    const indexed = sortedEntries.map((e, idx) => ({ e, idx }));
    const results = new Array<HealthResult>(sortedEntries.length);
    await Promise.all([
      ...indexed
        .filter(({ e }) => inProcess(e))
        .map(({ e, idx }) =>
          run(e, idx).then((r) => {
            results[idx] = r;
          }),
        ),
      runCapped(
        indexed.filter(({ e }) => !inProcess(e)),
        CHECK_CONCURRENCY,
        ({ e, idx }) =>
          run(e, idx).then((r) => {
            results[idx] = r;
          }),
      ),
    ]);
    return results;
  }

  /** Join the full-env health run in flight for (env, workspace), or start one. */
  function sharedHealthRun(env: Environment, workspace: string | null) {
    const key = healthCacheKey(env, workspace);
    const inFlight = healthInFlight.get(key);
    if (inFlight) return inFlight;
    const landed: HealthResult[] = [];
    const listeners = new Set<(r: HealthResult) => void>();
    const run = computeHealth(
      env,
      null,
      (r) => {
        landed.push(r);
        for (const l of listeners)
          try {
            l(r);
          } catch {
            /* a gone client must not stop the run */
          }
      },
      workspace,
    )
      .then((results) => {
        healthCache.set(key, { results, at: Date.now() });
        return results;
      })
      .finally(() => healthInFlight.delete(key));
    const shared = { run, landed, listeners };
    healthInFlight.set(key, shared);
    return shared;
  }

  // Full-env health, cached. Every page navigation used to re-run all 30 checks
  // from scratch — and the slowest are shell probes that shell out to the aws
  // CLI (~0.45s each) — so the dots took ~0.6s to resolve on EVERY switch. A
  // single-service `?address=` probe always runs live: it exists to re-check one
  // node on demand, where staleness is the whole thing being avoided.
  if (pathname === "/api/health") {
    const forViewer = healthForViewer(req.headers.host);
    const env = (url.searchParams.get("env") ?? "local") as Environment;
    const addressFilter = url.searchParams.get("address");
    const wsParam = url.searchParams.get("workspace");
    if (wsParam && !getWorkspaceByName(wsParam))
      return send400(res, `unknown project "${wsParam}"`);
    if (addressFilter) {
      return sendJson(
        res,
        (await computeHealth(env, addressFilter, undefined, wsParam)).map(
          forViewer,
        ),
      );
    }
    const refresh = url.searchParams.get("refresh") === "1";
    const cacheKey = healthCacheKey(env, wsParam);
    const hit = refresh ? null : healthCache.get(cacheKey);
    if (hit && Date.now() - hit.at < HEALTH_CACHE_TTL_MS) {
      return sendJson(res, hit.results.map(forViewer));
    }
    return sendJson(
      res,
      (await sharedHealthRun(env, wsParam).run).map(forViewer),
    );
  }

  // Same checks, streamed: each result is sent the moment it lands so the fast
  // ones paint immediately instead of every dot waiting on the slowest.
  if (pathname === "/api/health/stream") {
    const forViewer = healthForViewer(req.headers.host);
    const env = (url.searchParams.get("env") ?? "local") as Environment;
    const wsParam = url.searchParams.get("workspace");
    if (wsParam && !getWorkspaceByName(wsParam))
      return send400(res, `unknown project "${wsParam}"`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (o: unknown): void => {
      res.write(`data: ${JSON.stringify(o)}\n\n`);
    };

    const refresh = url.searchParams.get("refresh") === "1";
    const cacheKey = healthCacheKey(env, wsParam);
    const hit = refresh ? null : healthCache.get(cacheKey);
    if (hit && Date.now() - hit.at < HEALTH_CACHE_TTL_MS) {
      // Cached: replay in one go. Nothing to stagger — it's already known.
      for (const r of hit.results)
        send({ type: "result", result: forViewer(r) });
      send({ type: "done", cached: true });
      return res.end();
    }

    try {
      const shared = sharedHealthRun(env, wsParam);
      const forward = (r: HealthResult): void =>
        send({ type: "result", result: forViewer(r) });
      for (const r of shared.landed) forward(r);
      shared.listeners.add(forward);
      try {
        await shared.run;
      } finally {
        shared.listeners.delete(forward);
      }
      send({ type: "done", cached: false });
    } catch (e) {
      send({ type: "error", error: (e as Error).message });
    }
    return res.end();
  }

  // ── API: services list (catalog-aware) ───────────────────────────────────
  if (pathname === "/api/services") {
    const env = (url.searchParams.get("env") ?? "local") as Environment;
    // Optional: caller may request services for a specific (non-active) workspace.
    const wsOverride = url.searchParams.get("workspace") ?? null;
    // Every open tab polls this: concurrent requests share one build, and a
    // settled one is reused briefly (any mutating request clears it).
    return sendJson(
      res,
      await servicesCache.get(
        // No workspace named: what the view scope has in view.
        `${env}|${wsOverride ?? `*:${scopeKey(scopeView())}`}`,
        () => buildServicesList(env, wsOverride),
        url.searchParams.get("refresh") === "1",
      ),
    );
  }

  // ── API: service exec (SSE) — catalog-aware ────────────────────────────────
  if (pathname === "/api/service/exec") {
    const repoName = url.searchParams.get("repo");
    const svcName = url.searchParams.get("service");
    const cmdName = url.searchParams.get("cmd");
    const env = (url.searchParams.get("env") ?? "local") as Environment;

    if (!repoName || !svcName || !cmdName)
      return send400(res, "repo, service, and cmd are required");

    // Open the SSE stream immediately so any resolution errors are visible
    // in the output pane rather than triggering onerror ("Connection closed").
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // LK-0: the command's sudo without the password is a needs-sudo event.
    const emit = watchSudo((obj: unknown): void => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }, `${repoName}/${svcName} ${cmdName}`);
    // Every fail here is before anything ran: a refusal or a lookup miss.
    // Recorded, so failed attempts show in the activity trail (F2).
    const fail = (msg: string): void => {
      recordAction(
        auditActorOf(req),
        {
          verb: "exec",
          detail: `${repoName}/${svcName} ${cmdName} (${env})`,
          outcome: "refused",
          reason: msg,
        },
        principalOf(req),
      );
      emit({ type: "error", text: msg });
      emit({ type: "done", exitCode: 1, duration: 0 });
      res.end();
    };

    const wsParam = url.searchParams.get("workspace");
    if (wsParam && !isWorkspaceActive(wsParam)) {
      return fail(`Project "${wsParam}" is not active — activate it first`);
    }

    // Resolve repo path via resolveService (handles single-service repos where
    // the manifest key differs from the repo name, e.g. tasks-runner →
    // tool-runner). Try bare repo name first so single-service repos
    // don't need an explicit "repo/svc" address in the workspace config.
    let repoPath: string | undefined;
    let cmdDef:
      | string
      | { cmd: string; detachable?: boolean; interactive?: boolean }
      | undefined;

    const resolved =
      resolveService(`${repoName}/${svcName}`, wsParam ?? undefined) ??
      resolveService(repoName, wsParam ?? undefined);
    if (resolved) {
      repoPath = resolved.repoPath;
      const manifest = readManifest(repoPath);
      // R13: nothing runs a command on a remote service.
      const refusal = placementRefusal(
        `${repoName}/${svcName}`,
        servicePlacement(manifest, resolved.subsystem, env),
        (e) => isProductionEnv(e),
        cmdName,
      );
      if (refusal) return fail(refusal);
      if (manifest) {
        cmdDef = declaredCommand(
          manifest.services?.[resolved.subsystem]?.commands,
          env,
          cmdName,
        );
      }
      // Lifecycle commands run through the service runner, as the CLI's do:
      // restart without a declared restart is down + up, up on a healthy
      // service starts nothing, down honours workspace ownership.
      if (env === "local" && isLifecycleExecCmd(cmdName)) {
        if (cmdDef && isInteractiveServiceCommand(cmdDef))
          return fail(
            `"${cmdName}" requires an interactive terminal (HITL).\n` +
              `Run in your terminal:\n  ${product().cli} ${cmdName} ${resolved.address}`,
          );
        const execId = shortRunId();
        const execDesc = `${repoName}/${svcName} ${cmdName} (${env})`;
        const execActor = auditActorOf(req);
        recordAction(
          execActor,
          {
            verb: "exec",
            detail: `${execDesc} [${execId}]`,
          },
          principalOf(req),
        );
        prewarmSudo();
        void streamLifecycleExec(
          {
            resolved,
            cmd: cmdName,
            workspace: wsParam ?? undefined,
            env: { E2E_ENVIRONMENT: env, ...getSudoEnv() },
            emit: (e) => {
              if (e.type === "line" && typeof e.text === "string")
                mirrorLine(execId, e.text);
              emit(e);
            },
            end: () => res.end(),
            onClientClose: (fn) => res.on("close", fn),
            onExit: (exitCode, duration) => {
              serverLog(
                `■ exec ${execDesc} · exit=${exitCode} · ${formatDuration(duration)} [${execId}]${actorSuffix(execActor)}`,
                "lifecycle",
                execActor ? actorLabel(execActor) : undefined,
              );
              recordInvocation({
                command: "service.exec",
                surface: "ux",
                durationMs: duration,
                exit: exitCode,
                extra: { action: cmdName, env },
              });
            },
          },
          {
            run: runServiceCommand,
            health: (r) => checkServiceHealth(r, "local"),
            secretEnv: (address, cmd, workspace) =>
              prepareServiceSecretEnv(address, cmd, workspace),
          },
        );
        return;
      }
    }

    if (!cmdDef) {
      // Legacy fallback: repos registered via .den/ symlinks / registered-repos.json
      const repos = discoverRepos();
      const repo = repos.find((r) => r.repoName === repoName);
      repoPath = repo?.repoPath;
      const refusal = repo
        ? placementRefusal(
            `${repoName}/${svcName}`,
            servicePlacement(repo.manifest, svcName, env),
            (e) => isProductionEnv(e),
            cmdName,
          )
        : null;
      if (refusal) return fail(refusal);
      cmdDef = declaredCommand(
        repo?.manifest.services?.[svcName]?.commands,
        env,
        cmdName,
      );
    }

    if (!cmdDef || !repoPath) {
      // An un-cloned managed repo has no manifest to read commands from.
      // Report THAT, not "command not found" — the command may well exist; the
      // repo just isn't on disk yet.
      if (
        resolved &&
        resolved.mode === "managed" &&
        !fs.existsSync(resolved.repoPath)
      ) {
        return fail(
          `${repoName} is not cloned yet — run Sync (or ⋮ → clone now) to clone it into ` +
            `${product().servicesDir}/, then retry "${cmdName}".`,
        );
      }
      const ws = getActiveWorkspace();
      return fail(
        `Command "${cmdName}" not found for ${repoName}/${svcName} in env "${env}".` +
          (!ws ? " No active project." : ` Active project: ${ws.name}.`) +
          ` resolved=${JSON.stringify(resolved ?? null)}`,
      );
    }

    const cmdString = rewriteLegacyOpctlKillCommandForContainer(
      cmdName,
      typeof cmdDef === "string" ? cmdDef : cmdDef.cmd,
      repoName,
      (line) => emit({ type: "line", text: line }),
    );
    const detached = shouldDetachServiceCommand(cmdName, cmdDef);
    const interactive = isInteractiveServiceCommand(cmdDef);

    if (interactive) {
      return fail(
        `"${cmdName}" requires an interactive terminal (HITL).\n` +
          `Run in your terminal:\n  cd ${repoPath}\n  ${cmdString}`,
      );
    }

    const startTime = Date.now();
    emit({ type: "cmd", text: `$ ${cmdString}`, detached });

    const execId = shortRunId();
    const execDesc = `${repoName}/${svcName} ${cmdName} (${env})`;
    const execActor = auditActorOf(req);
    recordAction(
      execActor,
      {
        verb: "exec",
        detail: `${execDesc} [${execId}]`,
      },
      principalOf(req),
    );

    // For detachable commands (up/restart), the service is spawned as a daemon
    // writing to a log file so it survives den restarts.  The tail proc
    // streams that log back to the SSE and keeps the connection open
    // indefinitely — the client stays attached until it closes the tab.
    const logPath = detached ? getServiceLogPath(repoName, svcName) : undefined;
    if (logPath) emit({ type: "line", text: `→ log: ${logPath}` });

    let active = true; // false once client disconnects

    prewarmSudo();
    const svcProc = spawnStreaming(
      cmdString,
      [],
      { ...process.env, E2E_ENVIRONMENT: env, ...getSudoEnv() },
      (line) => {
        mirrorLine(execId, line);
        emit({ type: "line", text: line });
      },
      (exitCode) => {
        if (!active) return; // client already closed — don't write to dead response
        const duration = Date.now() - startTime;
        serverLog(
          `■ exec ${execDesc} · exit=${exitCode} · ${formatDuration(duration)} [${execId}]${actorSuffix(execActor)}`,
          "lifecycle",
          execActor ? actorLabel(execActor) : undefined,
        );
        // Dev-tooling telemetry: one invocation per service command run. The
        // action is whitelisted to common lifecycle verbs (low cardinality);
        // repo/service identifiers are internal and omitted.
        recordInvocation({
          command: "service.exec",
          surface: "ux",
          durationMs: duration,
          exit: exitCode,
          extra: {
            action: [
              "up",
              "down",
              "restart",
              "setup",
              "build",
              "logs",
            ].includes(cmdName)
              ? cmdName
              : "other",
            env,
          },
        });
        if (cmdName === "down" && exitCode === 0) {
          unregisterDaemon(resolved?.address ?? `${repoName}/${svcName}`);
        }
        if (exitCode !== 0)
          emit({ type: "error", text: `Command failed (exit ${exitCode})` });
        emit({ type: "done", exitCode, duration });
        res.end();
      },
      repoPath,
      detached,
      logPath,
      // For detachable commands (up): fire when the launch script itself exits.
      // This happens when `make up` hands off to a container runtime and exits.
      // The client uses this to transition from startup output to ongoing logs.
      detached
        ? (exitCode) => {
            if (!active) return;
            emit({
              type: "service-exited",
              exitCode,
              repoName,
              subsystem: svcName,
            });
          }
        : undefined,
    );

    if (detached) {
      // Tell the client the daemon is up; keep the tail proc (svcProc) alive
      // so startup output keeps streaming until `make up` finishes.
      // Kill the tail proc only when the client disconnects (tab closed).
      emit({ type: "started", detached: true });
      res.on("close", () => {
        active = false;
        try {
          svcProc.kill();
        } catch {
          /* already exited */
        }
      });
    }
    return;
  }

  // ── API: service logs (SSE) ───────────────────────────────────────────────
  if (pathname === "/api/service/logs") {
    const repoName = url.searchParams.get("repo");
    const svcName = url.searchParams.get("service");
    const env = (url.searchParams.get("env") ?? "local") as Environment;

    if (!repoName || !svcName)
      return send400(res, "repo and service are required");

    const repos = discoverRepos();
    const repo = repos.find((r) => r.repoName === repoName);
    const logSource = repo?.manifest.services?.[svcName]?.logs?.[env] as
      | LogSource
      | undefined;

    if (!logSource) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(
        `No log source configured for ${repoName}/${svcName} in env "${env}"`,
      );
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const emit = (obj: unknown): void => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    if (logSource.type === "process") {
      emit({
        type: "error",
        text: "process logs: attach to a running process is not yet supported",
      });
      res.end();
      return;
    }

    if (logSource.type === "shell") {
      emit({ type: "cmd", text: `$ ${logSource.cmd}` });

      let active = true;
      const lineBuffer: string[] = [];
      let confirmed = false;
      let quickTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        quickTimer = null;
        confirmed = true;
        for (const line of lineBuffer) emit({ type: "line", text: line });
        lineBuffer.length = 0;
      }, DAEMON_QUICK_EXIT_MS);

      const proc = testRunner.spawnStreaming(
        logSource.cmd,
        [],
        { ...process.env },
        (line) => {
          if (confirmed) {
            emit({ type: "line", text: line });
          } else {
            lineBuffer.push(line);
          }
        },
        (exitCode) => {
          if (!active) return;
          if (quickTimer !== null) {
            clearTimeout(quickTimer);
            quickTimer = null;
            lineBuffer.length = 0;
            emit({
              type: "line",
              text: `No running log stream for ${repoName}/${svcName}; the service may be down.`,
            });
          } else if (exitCode !== 0) {
            emit({
              type: "line",
              text: `── log stream exited (${exitCode}) ──`,
            });
          }
          emit({ type: "done", exitCode, duration: 0 });
          res.end();
        },
        repo?.repoPath,
        true, // detached — own process group
      );

      res.on("close", () => {
        active = false;
        if (quickTimer !== null) {
          clearTimeout(quickTimer);
          quickTimer = null;
        }
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already exited */
        }
      });
      return;
    }

    if (logSource.type === "cloudwatch") {
      const region =
        logSource.region ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
      const profile = loadAwsProfiles()[env];
      const args = [
        "logs",
        "tail",
        logSource.logGroup,
        "--follow",
        "--region",
        region,
      ];
      if (logSource.logStream)
        args.push("--log-stream-name-prefix", logSource.logStream);
      if (profile) args.push("--profile", profile);

      emit({ type: "cmd", text: `$ aws ${args.join(" ")}` });

      // Track output lines to detect AWS auth errors
      const AUTH_KEYWORDS = [
        "session has expired",
        "reauthenticate",
        "aws login",
        "aws sso login",
        "not authorized",
        "invalid token",
        "ExpiredToken",
        "NoCredentialsError",
      ];
      let authRequired = false;

      // Strip static credential env vars so --profile takes effect.
      // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY have higher precedence than
      // --profile and will silently override it if left in the environment.
      const awsEnv = { ...process.env };
      if (profile) {
        delete awsEnv.AWS_ACCESS_KEY_ID;
        delete awsEnv.AWS_SECRET_ACCESS_KEY;
        delete awsEnv.AWS_SESSION_TOKEN;
        delete awsEnv.AWS_SECURITY_TOKEN;
        delete awsEnv.AWS_PROFILE;
        delete awsEnv.AWS_DEFAULT_PROFILE;
      }

      const proc = testRunner.spawnStreaming(
        "aws",
        args,
        awsEnv,
        (line) => {
          const lower = line.toLowerCase();
          if (AUTH_KEYWORDS.some((k) => lower.includes(k.toLowerCase())))
            authRequired = true;
          emit({ type: "line", text: line });
        },
        (exitCode) => {
          emit({
            type: "done",
            exitCode,
            duration: 0,
            authRequired: authRequired && exitCode !== 0,
          });
          res.end();
        },
        undefined,
        true, // detached — own process group
      );

      res.on("close", () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already exited */
        }
      });
      return;
    }

    emit({
      type: "error",
      text: `Unsupported log source type: ${(logSource as LogSource).type}`,
    });
    res.end();
    return;
  }

  // ── API: each repo's last test run (0.4.17, run-history.ts) ─────────────────
  if (pathname === "/api/runs/last") {
    return sendJson(res, {
      repos: lastRunsByRepo(getStateDir(), LIVE_RUNS),
    });
  }

  // ── API: running daemons list ──────────────────────────────────────────────
  if (pathname === "/api/service/daemons") {
    await startupPrune;
    const daemons = listDaemons().map((d) => ({
      address: d.address,
      repoName: d.repoName,
      subsystem: d.subsystem,
      repoPath: d.repoPath,
      branch: d.branch ?? null,
      workspaces: d.workspaces ?? [],
      logPath: d.logPath,
      startedAt: d.startedAt.toISOString(),
    }));
    return sendJson(res, daemons);
  }

  // ── API: service taillog (SSE) — live log stream for a running service ───────
  //
  // Source resolution, in order:
  //   1. The service's manifest `logs.local` shell command (e.g. `docker logs -f`)
  //   2. The service's running container → `docker logs -f`: a compose
  //      stack's `<stack>-<workspace>-<service>-1`, else an
  //      `opctl_<base>_<hash>` one matched from the repo's op manifest / repo
  //      name — real runtime logs with zero manifest config
  //   3. The den daemon startup log (~/.den/logs/<repo>/<service>.log) —
  //      last resort, covers host-run processes with no container
  // A manifest command that exits within the quick-exit window (container not
  // found, stale filter) drops to tier 2/3, retrying tier 1 in between.
  // ── API: service log HISTORY — paged backwards to container startup ────────
  //
  // Docker retains the full log of the current container instance; this pages
  // it backwards with opaque cursors (byte offsets into an immutable snapshot
  // — see log-history.ts). env=local only in v1; other envs return
  // { unsupported: true } so the client renders a friendly notice.
  if (pathname === "/api/service/history") {
    // This handler sits ABOVE the blanket /api/service* local-dev guard
    // (later in this function), so it must enforce the guard itself.
    if (!isLocalEnabled()) {
      res.writeHead(403);
      res.end("local-dev is disabled");
      return;
    }
    const repoName = url.searchParams.get("repo");
    const svcName = url.searchParams.get("service");
    const env = url.searchParams.get("env") ?? "local";
    const cursor = url.searchParams.get("cursor") || null;
    const limit = Math.min(
      Math.max(
        parseInt(url.searchParams.get("limit") ?? "2000", 10) || 2000,
        1,
      ),
      10_000,
    );
    if (!repoName || !svcName)
      return send400(res, "repo and service are required");
    if (!isSafeServiceName(repoName) || !isSafeServiceName(svcName))
      return send400(res, "invalid repo/service name");
    try {
      const source = resolveHistorySource(repoName, svcName, env);
      if (source.kind === "unsupported")
        return sendJson(res, { unsupported: true, reason: source.reason });
      const snapshot = ensureSnapshot(source);
      if (!snapshot)
        return sendJson(res, {
          unsupported: true,
          reason: "could not snapshot the container log",
        });
      return sendJson(res, readPageBefore(snapshot, cursor, limit));
    } catch (e) {
      return send400(res, (e as Error).message);
    }
  }

  // ── API: cross-system history search ───────────────────────────────────────
  //
  // Greps the FULL history of each requested system (targets = the /logs
  // toolbar's list, computed client-side so scoping lives in one place).
  if (pathname === "/api/logs/search") {
    // /api/logs is not covered by the downstream /api/service* local-dev
    // guard — enforce it here.
    if (!isLocalEnabled()) {
      res.writeHead(403);
      res.end("local-dev is disabled");
      return;
    }
    const q = url.searchParams.get("q") ?? "";
    const env = url.searchParams.get("env") ?? "local";
    const targets = (url.searchParams.get("targets") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 40)
      .map((t) => {
        const slash = t.lastIndexOf("/");
        return { repo: t.slice(0, slash), service: t.slice(slash + 1) };
      })
      .filter(
        (t) =>
          t.repo &&
          t.service &&
          isSafeServiceName(t.repo) &&
          isSafeServiceName(t.service),
      );
    if (q.trim().length < 2) return send400(res, "q must be at least 2 chars");
    if (targets.length === 0) return send400(res, "targets required");
    void Promise.all(targets.map((t) => searchSystemHistory(t, q, env))).then(
      (results) => sendJson(res, { q, results }),
    );
    return;
  }

  if (pathname === "/api/service/taillog") {
    const repoName = url.searchParams.get("repo");
    const svcName = url.searchParams.get("service");
    if (!repoName || !svcName)
      return send400(res, "repo and service are required");

    // Resolve manifest log source. The client names an exact service, so
    // when the manifest has that key, use it directly — resolveService's
    // bare-repo correction rewrites the subsystem to the ENTRYPOINT (a
    // shop/db request would otherwise read api's log source).
    const tailResolved =
      resolveService(repoName) ?? resolveService(`${repoName}/${svcName}`);
    const tailManifest = tailResolved
      ? readManifest(tailResolved.repoPath)
      : null;
    const tailSubsystem = tailManifest?.services?.[svcName]
      ? svcName
      : (tailResolved?.subsystem ?? svcName);
    const logSource = tailManifest?.services?.[tailSubsystem]?.logs?.[
      "local"
    ] as LogSource | undefined;

    const daemonLogPath = getServiceLogPath(repoName, svcName);
    const fallbackCmd = `tail -F -n ${LIVE_TAIL_LINES} "${daemonLogPath}"`;

    const manifestCmd =
      logSource?.type === "shell" && logSource.cmd ? logSource.cmd : null;
    const manifestCwd = manifestCmd ? tailResolved?.repoPath : undefined;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let active = true;
    const emit = (obj: unknown): void => {
      if (!active) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    // If the manifest log command exits within QUICK_EXIT_MS, we consider it a
    // transient failure (e.g. container not yet running) and retry.  After
    // MAX_RETRIES quick exits we give up and fall back to the daemon log.
    const QUICK_EXIT_MS = DAEMON_QUICK_EXIT_MS;
    const RETRY_DELAY_MS = DAEMON_RETRY_DELAY_MS;
    const MAX_RETRIES = 12; // up to ~60s of retries before giving up

    let currentProc: ReturnType<typeof spawnStreaming> | null = null;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Fallback tier 1: resolve the service's running container (its compose
    // stack's, else opctl's `opctl_<base>_<hash>`) and stream
    // `docker logs -f`. This gives REAL runtime logs for services with no (or
    // broken) manifest `logs.local` — no den daemon file needed. Returns
    // false when no such container is running.
    const startDockerFallback = (): boolean => {
      const container = findServiceContainer(
        repoName,
        tailResolved?.repoPath,
        tailSubsystem,
      );
      if (!container) return false;
      emit({
        type: "line",
        text: `── streaming container logs: ${container} ──`,
      });
      currentProc = spawnStreaming(
        `docker logs -f --tail ${LIVE_TAIL_LINES} ${container}`,
        [],
        { ...process.env },
        (line) => emit({ type: "line", text: line }),
        (exitCode) => {
          if (!active) return;
          // Container stopped/removed — end the stream; the client's
          // auto-reattach re-resolves against whatever is running next.
          emit({
            type: "line",
            text: `── container log stream ended (${exitCode}) ──`,
          });
          res.end();
        },
        undefined,
        true,
      );
      return true;
    };

    // Fallback tier 2 (last resort): tail the den daemon startup log —
    // covers host-run processes (no container to derive logs from).
    const startDaemonFileFallback = (): void => {
      emit({
        type: "line",
        text: "── container log unavailable — watching startup log ──",
      });
      currentProc = spawnStreaming(
        fallbackCmd,
        [],
        { ...process.env },
        (line) => emit({ type: "line", text: line }),
        () => {
          if (active) res.end();
        },
        undefined,
        true,
      );
    };

    const startFallback = (): void => {
      if (startDockerFallback()) return;
      startDaemonFileFallback();
    };

    const tryManifestCmd = (): void => {
      // Buffer lines during the quick-exit window — only flush them to the
      // client once we know the command has been alive long enough to be real.
      // This prevents docker error messages from cluttering the tab on retries.
      const lineBuffer: string[] = [];
      let confirmed = false; // true once QUICK_EXIT_MS has passed without exit

      let quickTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        quickTimer = null;
        confirmed = true;
        // Flush any buffered lines now that we know the command is alive.
        for (const line of lineBuffer) emit({ type: "line", text: line });
        lineBuffer.length = 0;
      }, QUICK_EXIT_MS);

      currentProc = spawnStreaming(
        manifestCmd!,
        [],
        { ...process.env },
        (line) => {
          if (confirmed) {
            emit({ type: "line", text: line });
          } else {
            lineBuffer.push(line);
          }
        },
        (exitCode) => {
          if (!active) return;
          if (quickTimer !== null) {
            // Exited before QUICK_EXIT_MS — the manifest log command is broken
            // or the container isn't ready. When den's own daemon log exists
            // (den spawned this service), fall back to it IMMEDIATELY instead
            // of retrying a dead command for ~60s of silent tab (the exact
            // failure mode of stale `docker ps --filter name=…` log commands).
            clearTimeout(quickTimer);
            quickTimer = null;
            lineBuffer.length = 0; // discard noisy error output
            if (startDockerFallback()) {
              // streaming the conventional container's logs
            } else if (fs.existsSync(daemonLogPath)) {
              startDaemonFileFallback();
            } else if (retryCount < MAX_RETRIES) {
              retryCount++;
              retryTimer = setTimeout(() => {
                retryTimer = null;
                if (active) tryManifestCmd();
              }, RETRY_DELAY_MS);
            } else {
              startFallback();
            }
          } else if (exitCode !== 0) {
            // Ran for a while then exited with error.
            emit({
              type: "line",
              text: `── log stream exited (${exitCode}) ──`,
            });
            res.end();
          } else {
            res.end();
          }
        },
        manifestCwd,
        true,
      );
    };

    if (manifestCmd) {
      tryManifestCmd();
    } else {
      // No manifest log source (e.g. shop-web, control-plane): conventional
      // container logs first, daemon startup log as last resort.
      startFallback();
    }

    res.on("close", () => {
      active = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        currentProc?.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    });
    return;
  }

  // ── API: run tests (SSE) ───────────────────────────────────────────────────
  if (pathname === "/api/run") {
    const pillar = url.searchParams.get("pillar") as Pillar | null;
    const modules = url.searchParams.getAll("module").filter(Boolean);
    const env = (url.searchParams.get("env") ?? "local") as Environment;
    const baseApiUrl = url.searchParams.get("baseApiUrl") ?? undefined;
    const useLocalCheckout = url.searchParams.get("useLocalCheckout") === "1";
    const modeParam = url.searchParams.get("mode");
    const securityMode =
      modeParam === "api" || modeParam === "full" ? modeParam : "baseline";
    // Per-perf-test declarative optional-field values, as URL-encoded JSON:
    //   { [moduleName]: { [fieldName]: value } }
    // Each module's declared `optionalFields` are resolved to env vars below and
    // routed ONLY to that module's k6 process (never globally).
    const optsRaw = url.searchParams.get("opts");
    let opts: Record<string, Record<string, unknown>> = {};
    if (optsRaw) {
      try {
        const parsed = JSON.parse(optsRaw);
        if (parsed && typeof parsed === "object") {
          opts = parsed as Record<string, Record<string, unknown>>;
        }
      } catch {
        // Malformed opts → ignore; fall back to per-field defaults.
      }
    }

    if (!pillar) return send400(res, "pillar required");
    // SEC-1 §6b.2: a run takes the ids of declared modules, never a path. A
    // module that climbs out (`..`), is absolute, or reads as a flag would
    // point the runner at a script of the caller's choosing.
    const badModule = modules.find(
      (m) => !SAFE_MODULE_RE.test(m) || m.split("/").includes(".."),
    );
    if (badModule !== undefined)
      return send400(
        res,
        `module ${JSON.stringify(badModule.slice(0, 80))} is not a module name`,
      );

    // Resolve declarative optional fields → per-module env. Only the perf pillar
    // declares optionalFields; for every other pillar this is an empty map.
    let moduleEnv: Record<string, Record<string, string>> | undefined;
    if (pillar === "performance") {
      moduleEnv = {};
      try {
        const perfModules = await moduleScanner.scanModules("performance");
        // When "All modules" is selected the client sends no `module` params;
        // resolve fields for every perf module so its defaults still apply.
        const targetNames =
          modules.length > 0 ? modules : perfModules.map((m) => m.name);
        for (const m of perfModules) {
          if (!targetNames.includes(m.name)) continue;
          const fields = m.optionalFields ?? [];
          if (fields.length === 0) continue;
          const values = (opts[m.name] ?? {}) as Record<
            string,
            string | number | boolean | undefined
          >;
          const env = resolveFieldEnv(fields, values);
          if (Object.keys(env).length > 0) moduleEnv[m.name] = env;
        }
      } catch (err) {
        serverLog(`  ⚠ /api/run optionalFields: ${(err as Error).message}`);
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const emit = (obj: unknown): void => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    const steps = testRunner.buildCommand({
      pillar,
      environment: env,
      modules,
      baseApiUrl,
      useLocalCheckout,
      moduleEnv,
      securityMode,
    });

    if (steps.length === 0) {
      emit({
        type: "error",
        text: `No command configured for pillar: ${pillar}`,
      });
      res.end();
      return;
    }

    // Log the source(s) of truth before the first step so run output captures
    // which repo/branch/SHA was actually tested. Silent for pillars that don't
    // read tests from repos (integration, perf are den-owned).
    if (
      pillar === "synthetic" ||
      pillar === "smoke" ||
      pillar === "journeys" ||
      pillar === "security"
    ) {
      try {
        const sources = collectTestSources(pillar);
        if (sources.length === 0) {
          emit({ type: "line", text: `→ source: (no repos discovered)` });
        } else {
          for (const s of sources) {
            emit({ type: "line", text: `→ source: ${formatSourceLine(s)}` });
          }
        }
      } catch (err) {
        emit({
          type: "line",
          text: `→ source: (resolution failed: ${(err as Error).message})`,
        });
      }
    }

    const runId = shortRunId();
    const modDesc = modules.length ? modules.join(",") : "all";
    const runDesc = `${pillar}/${env} · modules=${modDesc}`;
    const runActor = auditActorOf(req);
    recordAction(
      runActor,
      { verb: "run", detail: `${runDesc} [${runId}]` },
      principalOf(req),
    );
    if (
      pillar === "synthetic" ||
      pillar === "smoke" ||
      pillar === "journeys" ||
      pillar === "security"
    ) {
      try {
        const sources = collectTestSources(pillar);
        for (const s of sources) {
          serverLog(`  source: ${formatSourceLine(s)} [${runId}]`, "lifecycle");
        }
      } catch {
        /* already emitted above as an SSE line */
      }
    }

    const startTime = Date.now();
    let overallExit = 0;
    // 0.4.17: the server's run history (every browser's runs, kept), which
    // Workspaces' Last test run reads per repo.
    // Every run kind that runs a repo's own tests names it, the suites
    // pillar (`tests:`) and a repo's performance modules included.
    const tested = await reposOfRun(String(pillar), String(env), modules, {
      pillarSources: (p) =>
        collectTestSources(p as Pillar).map((x) => x.repoName),
      suiteRepos: (e, only) =>
        planSuites(listServicesWithManifests(), e as Environment, only).run.map(
          (x) => x.repo,
        ),
      perfModules: async () =>
        (await moduleScanner.scanModules("performance")).map((m) => m.name),
      repoNames: () => discoverRepos().map((r) => r.repoName),
    });
    LIVE_RUNS.add(runId);
    recordRunStart(getStateDir(), {
      id: runId,
      pillar: String(pillar),
      env: String(env),
      repos: tested,
    });
    let recorded = false;

    const finishLifecycle = (exitCode: number, note?: string): void => {
      if (!recorded) {
        recorded = true;
        LIVE_RUNS.delete(runId);
        recordRunEnd(getStateDir(), runId, exitCode);
      }
      const dur = formatDuration(Date.now() - startTime);
      const extra = note ? ` · ${note}` : "";
      serverLog(
        `■ run ${runDesc} · exit=${exitCode} · ${dur}${extra} [${runId}]${actorSuffix(runActor)}`,
        "lifecycle",
        runActor ? actorLabel(runActor) : undefined,
      );
      // Dev-tooling telemetry: one invocation per test run (pillar/env are
      // low-cardinality enums; module count only — never module names/args).
      recordInvocation({
        command: "test.run",
        surface: "ux",
        durationMs: Date.now() - startTime,
        exit: exitCode,
        extra: {
          pillar: String(pillar),
          env: String(env),
          modules: modules.length,
        },
      });
    };

    const runStep = (i: number): void => {
      if (i >= steps.length) {
        finishLifecycle(overallExit);
        emit(
          getRunDonePayload({
            pillar,
            exitCode: overallExit,
            duration: Date.now() - startTime,
            rootDir: ROOT,
          }),
        );
        res.end();
        return;
      }

      const step = steps[i];
      emit({ type: "cmd", text: `$ ${step.command} ${step.args.join(" ")}` });

      testRunner.spawnStreaming(
        step.command,
        step.args,
        step.env,
        (line) => {
          mirrorLine(runId, line);
          emit({ type: "line", text: line });
        },
        (exitCode) => {
          if (exitCode !== 0) {
            if (overallExit === 0) {
              overallExit = exitCode;
            }
            if (!step.continueOnFailure) {
              emit({
                type: "error",
                text: `Step "${step.label}" failed (exit ${exitCode}) — aborting`,
              });
              finishLifecycle(exitCode, `step "${step.label}" failed`);
              emit(
                getRunDonePayload({
                  pillar,
                  exitCode,
                  duration: Date.now() - startTime,
                  rootDir: ROOT,
                }),
              );
              res.end();
              return;
            }
          }
          runStep(i + 1);
        },
      );
    };

    runStep(0);
    return;
  }

  // ── API: AWS re-authenticate (SSE) ───────────────────────────────────────
  if (pathname === "/api/aws/login") {
    const env = (url.searchParams.get("env") ?? "local") as Environment;
    const profiles = loadAwsProfiles();
    const profile = profiles[env];

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const emit = (obj: unknown): void => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    if (!profile) {
      emit({
        type: "error",
        text: `No AWS profile configured for env "${env}". Run: make aws-configure`,
      });
      emit({ type: "done", exitCode: 1, duration: 0 });
      res.end();
      return;
    }

    const args = ["sso", "login", "--profile", profile];
    emit({ type: "cmd", text: `$ aws ${args.join(" ")}` });

    const proc = testRunner.spawnStreaming(
      "aws",
      args,
      { ...process.env },
      (line) => emit({ type: "line", text: line }),
      (exitCode) => {
        emit({ type: "done", exitCode, duration: 0 });
        res.end();
      },
      undefined,
      false, // not detached — we want signals to reach it
    );

    res.on("close", () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    });
    return;
  }

  // ── API: service catalog ──────────────────────────────────────────────────
  if (pathname === "/api/catalog") {
    return sendJson(res, readCatalog());
  }

  // ── API: den config ────────────────────────────────────────────────────
  if (pathname === `/api/${product().cli}/config` && req.method === "GET") {
    // `org` resolved (id defaults to edge.org) for the header's org label.
    const config = readDenConfig();
    // `default_org` (ORG-1a) is the default work org, `github_org`; `org`
    // stays the instance org (readOrgView).
    return sendJson(res, {
      ...config,
      org: readOrgView(),
      default_org: config.github_org?.trim() || null,
    });
  }

  // ── API: server info + staleness (drives the header "stale server" pill) ────
  // ── API: the browser's session (SEC-1a, SEC-1b) ──────────────────────────
  // The CSRF token the shell sends on mutating calls (X-Den-CSRF), for a
  // same-origin caller only: the session's own when signed in
  // (actor "person-browser"); else, on loopback, this server start's.
  // Beyond loopback without a session there is none to hand out (every
  // route there needs a session first).
  if (pathname === "/api/session" && req.method === "GET") {
    if (!sessionRequestAllowed(req, GUARD))
      return sendJson(
        res,
        {
          ok: false,
          error: "same-origin callers only",
          code: "origin_rejected",
        },
        403,
      );
    res.setHeader("Cache-Control", "no-store");
    const g = guard.ok ? guard : null;
    // An agent's token gets no browser CSRF token: it has its bearer.
    if (g?.principal?.kind === "agent")
      return sendJson(res, {
        csrf: null,
        actor: g.principal.actor,
        signedIn: false,
      });
    // SEC-2a: who this browser is (the rail's identity chip), and, once
    // after a sign-in, that it just signed in (the shell's toast).
    if (g?.session) {
      const rec = webSessions.list().find((x) => x.key === g.session!.key);
      const github = rec?.via === "github";
      return sendJson(res, {
        csrf: g.session.csrf,
        actor: "person-browser",
        signedIn: true,
        identity: {
          kind: github ? "github" : "device",
          via: rec?.via ?? "link",
          ...(github && rec?.login ? { login: rec.login } : {}),
        },
        ...(webSessions.takeWelcome(g.session.key)
          ? {
              justSignedIn: true,
              product: product().title,
              machine: machineName(),
            }
          : {}),
      });
    }
    return sendJson(res, {
      csrf: g?.beyond ? null : GUARD.csrfToken,
      actor: null,
      signedIn: false,
      ...(g && !g.beyond ? { identity: { kind: "local" } } : {}),
      // SEC-2a-UX: the signed-out page watches this, so Sign in with
      // GitHub appears once an owner is linked, with no reload. The
      // owner's login is what that page shows anyway.
      ...(g?.beyond || !g ? { github: githubSignin() } : {}),
    });
  }
  // Sign out: this browser's session ends and its cookie is cleared.
  if (pathname === "/api/session/logout" && req.method === "POST") {
    const g = guard.ok ? guard : null;
    const ended = g?.session ? webSessions.end(g.session.key) : false;
    if (g?.session) closeSessionSockets([g.session.key]);
    res.setHeader(
      "Set-Cookie",
      clearSessionCookie(requestIsHttps(req, g?.via ?? null)),
    );
    return sendJson(res, { ok: true, ended });
  }
  // `<cli> web sessions` (shell-grade: the person's bearer, or a session).
  if (pathname === "/api/web/sessions" && req.method === "GET") {
    const mine = guard.ok ? guard.session?.key : undefined;
    return sendJson(res, {
      sessions: webSessions.list().map((x) => ({
        id: sessionIdPrefix(x.key),
        createdAt: new Date(x.createdAt).toISOString(),
        lastSeenAt: new Date(x.lastSeenAt).toISOString(),
        userAgent: x.userAgent,
        host: x.host,
        // SEC-2a: a linked device's name, how it signed in, its address.
        name: deviceName(x.userAgent),
        via: x.via ?? "link",
        ...(x.login ? { login: x.login } : {}),
        ...(x.client ? { client: x.client } : {}),
        ...(x.key === mine ? { current: true } : {}),
      })),
    });
  }
  // `<cli> web logout [<id>] [--all]` (shell-grade). `rotate` (--all) also
  // replaces web.secret: every session and person token derived from the
  // old one stops verifying; the CLI re-reads the file, so it keeps working.
  // And (SEC-1 §6c.2) it revokes every agent's actor token: a running
  // agent's next call gets 401 token_revoked. One browser's or every
  // browser's logout without --all leaves agent tokens alone.
  if (pathname === "/api/web/logout" && req.method === "POST") {
    let body: { id?: unknown; rotate?: unknown } = {};
    try {
      body = (JSON.parse((await readBody(req)) || "{}") ?? {}) as typeof body;
    } catch {
      return send400(res, "the body must be JSON: { id?, rotate? }");
    }
    if (body.id !== undefined && typeof body.id !== "string")
      return send400(res, "id must be a session id prefix");
    try {
      const endedKeys =
        typeof body.id === "string"
          ? [webSessions.endByPrefix(body.id).key]
          : webSessions.list().map((x) => x.key);
      if (typeof body.id !== "string") webSessions.endAll();
      // SEC-2a: a revoked device's open terminals close now, too.
      closeSessionSockets(endedKeys);
      const ended = endedKeys.map(sessionIdPrefix);
      const rotated = body.rotate === true;
      let agentTokens = 0;
      if (rotated) {
        rotateWebSecret();
        agentTokens = revokeAllActorTokens(getStateDir());
      }
      return sendJson(res, {
        ok: true,
        ended,
        rotated,
        ...(rotated ? { agentTokens } : {}),
      });
    } catch (e) {
      return sendJson(
        res,
        { ok: false, error: (e as Error).message, code: "not_found" },
        404,
      );
    }
  }

  if (pathname === "/api/server-info" && req.method === "GET") {
    const { stale, scanned } = computeStale();
    const engine = engineCheck();
    return sendJson(res, {
      pid: process.pid,
      port: PORT,
      // The Den this server runs (its routes): the MCP server compares it
      // with the routes it needs. loaded and onDisk (MD-2): the engine at
      // startup and on disk now; engineStale when they differ.
      version: ENGINE.loaded.version ?? engineVersion() ?? null,
      loaded: engine.loaded,
      onDisk: engine.onDisk,
      engineStale: engine.stale,
      // Whose server this is: `<cli> web up|down`, `mcp connect` and
      // `service install` compare both with their own and never act on
      // another distribution's server (see cli/server-identity.ts).
      root: ROOT,
      product: product().name,
      // D20: the launchd session it runs in (Aqua ends at logout); doctor
      // shows it. null off macOS.
      launchd: launchdSession(),
      startedAt: new Date(SERVER_STARTED_AT).toISOString(),
      uptimeMs: Date.now() - SERVER_STARTED_AT,
      stale,
      scanned,
      // ON-6: no repo in any workspace yet (the server agent page's own
      // `fresh`): the shell skips What's new on a brand-new Den.
      fresh: await freshDen(),
      // D64: how long the browser's Restart Den waits before it shows the
      // CLI line (ui.restart_wait_seconds in config/local/user.yml).
      restartWaitSeconds: restartWaitSeconds(),
    });
  }

  // ── API: restart the web server (from the "stale server" UI) ────────────────
  // Spawns a detached `den web restart` that stops THIS process and starts a
  // fresh daemon on the same port. Respond first, then spawn on the next tick so
  // the response flushes before the driver child arrives to stop us.
  if (pathname === "/api/web/restart" && req.method === "POST") {
    serverLog("↻ web restart requested from the UI", "lifecycle");
    sendJson(res, { restarting: true, pid: process.pid });
    setImmediate(() => {
      try {
        spawnDetachedWebRestart(PORT);
      } catch (e) {
        serverLog(`  ⚠ web restart failed to spawn: ${(e as Error).message}`);
      }
    });
    return;
  }

  // ── API: release config (GET effective / PUT personal override) ────────────
  // Deliberately placed before the local-dev guard: the Release tab is for
  // hosted deploys and must work when `local` is disabled.
  if (pathname === "/api/release/config") {
    if (req.method === "GET") return sendJson(res, releaseService.config());
    if (req.method === "PUT") {
      try {
        const patch = JSON.parse(await readBody(req)) as Partial<ReleaseConfig>;
        if (typeof patch !== "object" || patch === null || Array.isArray(patch))
          return send400(res, "expected a release config object");
        if (patch.repos !== undefined) {
          if (!Array.isArray(patch.repos))
            return send400(res, "repos must be an array");
          for (const r of patch.repos) {
            if (!r || typeof r.name !== "string" || typeof r.wave !== "number")
              return send400(
                res,
                "each repo needs a string name and numeric wave",
              );
          }
        }
        // Whether the page may deploy is config/den.yml's call, never the page's.
        delete (patch as { deploy?: boolean }).deploy;
        writeUserReleaseConfig(patch);
        return sendJson(res, releaseService.config());
      } catch (e) {
        return send400(res, `Invalid request: ${(e as Error).message}`);
      }
    }
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  // ── API: release status (verify table) ─────────────────────────────────────
  if (pathname === "/api/release/status" && req.method === "GET") {
    const env = url.searchParams.get("env") ?? "";
    const refresh = url.searchParams.get("refresh") === "1";
    const cfg = releaseService.config();
    if (!cfg.environments.includes(env))
      return send400(res, `Unknown env: ${env}`);
    try {
      const rows = await releaseService.verifyEnv(env, refresh);
      return sendJson(res, { env, rows, fetchedAt: new Date().toISOString() });
    } catch (e) {
      serverLog(`  ⚠ /api/release/status: ${(e as Error).message}`);
      return sendJson(res, { env, rows: [], error: (e as Error).message });
    }
  }

  // ── API: live CD runs (Release page poll) ──────────────────────────────────
  // Deliberately not env-scoped — see RepoRunState: a run object does not carry
  // the environment it targets, so a run in flight blocks that repo outright.
  if (pathname === "/api/release/runs" && req.method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    try {
      return sendJson(res, {
        runs: await releaseService.listRepoRuns(refresh),
      });
    } catch (e) {
      serverLog(`  ⚠ /api/release/runs: ${(e as Error).message}`);
      return sendJson(res, { runs: [], error: (e as Error).message });
    }
  }

  // ── API: release branches (deploy-time branch selector) ────────────────────
  if (pathname === "/api/release/branches" && req.method === "GET") {
    const repo = url.searchParams.get("repo") ?? "";
    const cfg = releaseService.config();
    if (!cfg.repos.some((r) => r.name === repo))
      return send400(res, `Unknown repo: ${repo}`);
    try {
      return sendJson(res, await releaseService.listBranches(repo));
    } catch {
      return sendJson(res, ["main"]);
    }
  }

  // ── API: release deploy (session-backed) ───────────────────────────────────
  // Decoupled from the browser so the log survives page navigation and den
  // keeps monitoring even with no client attached: POST starts a background
  // deploy SESSION, GET ?session= attaches an SSE stream that REPLAYS the log so
  // far then streams live events, DELETE dismisses (closes) it.
  // Policy: prod requires confirm==="prod"; deploy-all→prod is enforced
  // main-only; a single non-main→prod deploy is an allowed "hotfix".
  if (pathname === "/api/release/deploy/active" && req.method === "GET") {
    return sendJson(res, deploySessions.active());
  }

  if (pathname === "/api/release/deploy") {
    // ── Start (POST) → { id, label, status, ... } | 4xx ──
    if (req.method === "POST") {
      if (!readReleaseConfig().deploy) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: DEPLOYS_OFF_MESSAGE }));
        return;
      }
      let body: {
        env?: string;
        mode?: string;
        repo?: string;
        ref?: string;
        confirm?: string;
      };
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return send400(res, "invalid JSON body");
      }
      const env = body.env ?? "";
      const mode = body.mode ?? "all";
      const repoParam = body.repo ?? null;
      const refParam = body.ref || "";
      const confirm = body.confirm ?? "";

      const cfg = releaseService.config();
      if (!cfg.environments.includes(env))
        return send400(res, `Unknown env: ${env}`);
      const isProd = env === "prod";
      if (isProd && confirm !== "prod")
        return send400(res, "Production deploy requires typed confirmation.");

      const notices: ReleaseEvent[] = [];
      let plan: DeployPlanEntry[];
      let label: string;
      if (mode === "single") {
        if (!repoParam)
          return send400(res, "repo required for a single deploy.");
        const r = cfg.repos.find((x) => x.name === repoParam);
        if (!r) return send400(res, `Unknown repo: ${repoParam}`);
        const target = resolveReleaseTarget(r, env, cfg);
        if (target.environments.length > 1)
          return send400(
            res,
            `${r.name} has ${target.environments.length} ${env} environments (${target.environments.join(", ")}); deploy each one from GitHub.`,
          );
        const ref = refParam || target.branch;
        if (ref !== target.branch) {
          const branches = await releaseService.listBranches(repoParam);
          if (!branches.includes(ref))
            return send400(res, `Unknown branch "${ref}" for ${repoParam}.`);
        }
        if (isProd && ref !== target.branch)
          notices.push({
            type: "log",
            level: "warn",
            text: `⚠ HOTFIX: dispatching "${ref}" (not ${target.branch}) to PRODUCTION.`,
          });
        plan = [
          {
            repo: r.name,
            workflow: target.workflows[0],
            ref,
            wave: r.wave,
            inputs: target.inputs,
          },
        ];
        label = `${r.name} @ ${ref} → ${env}`;
      } else {
        const enabled = cfg.repos.filter((r) => r.enabled !== false);
        if (!enabled.length)
          return send400(res, "No repos enabled for deploy.");
        const targets = new Map(
          enabled.map((r) => [r.name, resolveReleaseTarget(r, env, cfg)]),
        );
        // A repo with several environments here (one per tenant) is never
        // part of deploy-all: each tenant is its own decision.
        const multi = enabled.filter(
          (r) => targets.get(r.name)!.environments.length > 1,
        );
        for (const r of multi)
          notices.push({
            type: "log",
            level: "warn",
            text: `Skipping ${r.name}: ${targets.get(r.name)!.environments.length} ${env} environments; deploy each from GitHub.`,
          });
        plan = enabled
          .filter((r) => !multi.includes(r))
          .map((r) => {
            const t = targets.get(r.name)!;
            return {
              repo: r.name,
              workflow: t.workflows[0],
              ref: t.branch,
              wave: r.wave,
              inputs: t.inputs,
            };
          });
        if (isProd) {
          const nonMain = plan.filter((p) => p.ref !== "main");
          if (nonMain.length)
            return send400(
              res,
              `Deploy-all to prod is main-only. Off-main: ${nonMain
                .map((p) => `${p.repo}@${p.ref}`)
                .join(", ")}. Use a per-repo Hotfix instead.`,
            );
        }
        label = `all → ${env}`;
      }

      notices.unshift({
        type: "log",
        text: `▶ deploy ${mode} → ${env} · ${plan.length} repo(s)`,
      });

      // Concurrent deploys of different systems are fine — only the same
      // repo+env twice would race two runs against one GitHub concurrency
      // group.
      const clashing = deploySessions.conflicts(env, plan);
      if (clashing.length > 0) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Already deploying to ${env}: ${clashing.join(", ")}. Wait for it to finish or dismiss its log.`,
            repos: clashing,
          }),
        );
        return;
      }
      const session = deploySessions.start({ env, mode, label, plan, notices });
      serverLog(
        `▶ release deploy ${mode} → ${env} (${plan.length} repos) [${session.id}]`,
        "lifecycle",
      );
      return sendJson(res, session);
    }

    // ── Attach (GET, SSE): replay buffered log, then stream live ──
    if (req.method === "GET") {
      const id = url.searchParams.get("session") ?? "";
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const emit = (ev: unknown): void => {
        try {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        } catch {
          /* client gone */
        }
      };
      const unsub = deploySessions.attach(id, emit);
      if (!unsub) {
        emit({
          type: "log",
          level: "error",
          text: "Deploy session not found (it may have finished long ago or been closed).",
        });
        emit({ type: "done", ok: false, summary: "Session unavailable." });
        res.end();
        return;
      }
      req.on("close", unsub);
      return;
    }

    // ── Dismiss (DELETE): user closed the log ──
    if (req.method === "DELETE") {
      const id = url.searchParams.get("session") ?? "";
      return sendJson(res, { ok: deploySessions.dismiss(id) });
    }

    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  // ── Local-dev API guard ───────────────────────────────────────────────────
  // All workspace / service management APIs require local environment to be enabled.
  if (
    (pathname.startsWith("/api/workspaces") ||
      pathname.startsWith("/api/workspace/") ||
      pathname.startsWith("/api/service")) &&
    !isLocalEnabled()
  ) {
    res.writeHead(403);
    res.end("Local environment is not enabled for this deployment");
    return;
  }

  // ── D52: Hub, for agents, through Den (hub-proxy.ts) ────────────────────
  if (
    await handleHubProxy(req, res, pathname, {
      upstream: (who) => hubUpstream(agentWebDeps(), who),
    })
  )
    return;
  // ── The server agent (ON-6, server-agent-routes.ts) ──────────────────────
  if (await handleServerAgentRoutes(req, res, pathname)) return;
  // ── Agents on the Workspaces page (AG-4a, agent-routes.ts) ───────────────
  if (await handleAgentRoutes(req, res, pathname)) return;
  // ── The Agents tab's list (AG-4a-term, session-routes.ts) ────────────────
  // Beyond loopback a terminal needs a signed-in session (or a bearer).
  if (
    await handleSessionList(
      req,
      res,
      pathname,
      guard.ok && (!guard.beyond || !!guard.session || !!guard.principal),
      {
        waitingAgents: waitingAgentIds,
        waitingWhy: waitingReasons,
        rotationPolicy: () => policyResolver(agentWebDeps()),
        restartResume: () => restartResolver(agentWebDeps()),
      },
    )
  )
    return;

  // ── Workspace routes (extracted to workspace-routes.ts) ──────────────────
  await handleWorkspaceRoutes(req, res, pathname, url, editors, github);
  if (res.headersSent) return;

  // ── API: manifest validation ──────────────────────────────────────────────
  // POST /api/manifest/validate   body: { content: string }  (raw YAML string)
  // GET  /api/manifest/validate?path=<absolute-path>
  if (pathname === "/api/manifest/validate") {
    if (req.method === "POST") {
      try {
        const body = await readBody(req);
        const { content } = JSON.parse(body) as { content?: string };
        if (typeof content !== "string")
          return send400(res, '"content" string required');
        return sendJson(res, validateManifest(content));
      } catch (e) {
        return send400(res, `Invalid request: ${(e as Error).message}`);
      }
    }
    if (req.method === "GET") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return send400(res, '"path" query param required');
      try {
        const isDir =
          fs.existsSync(filePath) && fs.lstatSync(filePath).isDirectory();
        // A repo folder: every layer that applies (repo or held, override,
        // merged), flattened into the usual shape; each error names its file.
        if (isDir) {
          const layered = validateManifestLayers(filePath);
          if (layered.layers.length > 0)
            return sendJson(res, {
              valid: layered.valid,
              version: layered.layers[0].result.version,
              errors: layered.layers.flatMap((l) => l.result.errors),
              warnings: layered.layers.flatMap((l) => l.result.warnings),
              manifestLayers: loadManifest(filePath).layers,
              layers: layered.layers,
            });
        }
        const denYml = isDir
          ? path.join(filePath, `${product().manifestYml}`)
          : filePath;
        const content = fs.readFileSync(denYml, "utf-8");
        return sendJson(res, validateManifest(content));
      } catch (e) {
        return sendJson(res, {
          valid: false,
          version: 1,
          errors: [{ path: "", message: (e as Error).message }],
          warnings: [],
        });
      }
    }
  }

  // ── API: changelog ────────────────────────────────────────────────────────
  // GET /api/changelog  — parses CHANGELOG.md and returns structured entries
  if (pathname === "/api/changelog" && req.method === "GET") {
    const changelogPath = enginePath("CHANGELOG.md");
    try {
      const raw = fs.readFileSync(changelogPath, "utf-8");
      const entries = parseChangelog(raw);
      return sendJson(res, entries);
    } catch {
      return sendJson(res, []);
    }
  }

  // ── API: local-dev toggle ─────────────────────────────────────────────────
  // POST /api/local-dev  body: { enabled: boolean }
  if (pathname === "/api/local-dev" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { enabled } = JSON.parse(body) as { enabled?: boolean };
      if (typeof enabled !== "boolean")
        return send400(res, '"enabled" boolean required');
      const user = readUserConfig();
      writeUserConfig({ ...user, local_dev: enabled });
      return sendJson(res, { ok: true, local_dev: enabled });
    } catch (e) {
      return send400(res, `Invalid request: ${(e as Error).message}`);
    }
  }

  // ── API: sudo password ────────────────────────────────────────────────────
  // LK-0: the admin password is for sudo, and nothing else: no route asks
  // for it as an access check. A run that is about to run sudo without it
  // streams a needs-sudo event (watchSudo); the page asks, then runs again.
  // POST /api/sudo-password  body: { password: string, saveToVault?: boolean }
  // POST /api/sudo-password/forget         → { ok, vaultCleared, vaultError? }
  // GET  /api/sudo-password/status         → { set, passwordless,
  //        saved: "vault" | "session" | null, vault: { configured, label } }
  // GET  /api/sudo-password/vault-status   → { backend, label, configured,
  //        canSave, backendAvailable, reason?, hasStored, opAvailable (deprecated) }
  // POST /api/sudo-password/load-from-vault → { ok, reason?, message? }
  if (pathname === "/api/sudo-password") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      const body = await readBody(req);
      const { password, saveToVault } = JSON.parse(body) as {
        password?: string;
        saveToVault?: boolean;
      };
      if (typeof password !== "string" || !password)
        return send400(res, '"password" string required');
      // Validate the password before storing it.
      try {
        // -k: ignore cached credentials for this check (don't permanently invalidate)
        execFileSync(realSudoPath(), ["-k", "-S", "-v"], {
          input: password + "\n",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: CLI_SPAWN_TIMEOUT_MS,
        });
      } catch {
        return sendJson(res, { ok: false, error: "Incorrect password" }, 401);
      }
      setSudoPassword(password);
      let savedToVault = false;
      let vaultError: string | undefined;
      let refCreated = false;
      if (saveToVault) {
        // LK-4: with no secrets.refs.sudo, this creates the item and writes
        // the ref to user.yml. The error never carries the password.
        try {
          refCreated = (await saveSudoToVault(password)).ref === "created";
          savedToVault = true;
          sudoInVault = true;
        } catch (err) {
          vaultError = (err as Error).message;
        }
      }
      return sendJson(res, {
        ok: true,
        savedToVault,
        ...(refCreated ? { refCreated } : {}),
        vaultError,
      });
    } catch (e) {
      return send400(res, `Invalid request: ${(e as Error).message}`);
    }
  }

  if (pathname === "/api/sudo-password/status") {
    // passwordless: NOPASSWD sudoer (or warm cache) — sudo needs none.
    // saved (Settings, LK-0): "vault" once this server saved it there or
    // loaded it from there, "session" when it is held in memory only.
    const set = hasSudoPassword();
    return sendJson(res, {
      set,
      passwordless: hasPasswordlessSudo(),
      saved: sudoInVault ? "vault" : set ? "session" : null,
      vault: sudoVaultWhere(),
    });
  }

  // Forget (Settings, LK-0): the password this server holds goes, and the
  // vault's copy when this server knows there is one (written empty, which
  // every read takes as none). sudo's own cache is dropped too.
  if (pathname === "/api/sudo-password/forget") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    clearSudoPassword();
    try {
      execFileSync(realSudoPath(), ["-k"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: CLI_SPAWN_TIMEOUT_MS,
      });
    } catch {
      /* best-effort */
    }
    let vaultCleared = false;
    let vaultError: string | undefined;
    if (sudoInVault) {
      try {
        await saveSudoToVault("");
        vaultCleared = true;
        sudoInVault = false;
      } catch (err) {
        vaultError = (err as Error).message;
      }
    }
    return sendJson(res, {
      ok: true,
      vaultCleared,
      ...(vaultError ? { vaultError } : {}),
    });
  }

  // Advertises vault capability to the UI so it knows whether to show the
  // "Save to <backend>" checkbox and whether auto-load is worth trying. With
  // no secrets.refs.sudo it says "not configured" and spawns nothing.
  if (pathname === "/api/sudo-password/vault-status") {
    return sendJson(res, await sudoVaultStatus());
  }

  // Auto-unlock path: UI calls this when status.set is false. We read from
  // vault, validate via sudo -k -S -v, and set the in-memory store on success.
  // Returns a reason code on failure so the UI can fall through to manual
  // entry without surfacing op CLI noise.
  if (pathname === "/api/sudo-password/load-from-vault") {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!sudoRef()) {
      return sendJson(res, {
        ok: false,
        reason: "not-configured",
        message: notConfiguredMessage(SUDO_REF_NAME),
      });
    }
    const password = await readSudoFromVault();
    if (!password) {
      return sendJson(res, { ok: false, reason: "not-found" });
    }
    try {
      execFileSync(realSudoPath(), ["-k", "-S", "-v"], {
        input: password + "\n",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: CLI_SPAWN_TIMEOUT_MS,
      });
    } catch {
      // Stored password no longer matches the system — likely the user
      // changed their admin password. Leave it in the vault; UI will prompt
      // and they can choose to overwrite on save.
      return sendJson(res, { ok: false, reason: "stale" });
    }
    setSudoPassword(password);
    sudoInVault = true;
    return sendJson(res, { ok: true });
  }

  // ── API: user settings ────────────────────────────────────────────────────
  // GET  /api/settings  → { editor, editors, terminal, terminals, editor_overrides, languages,
  //                         log_window_lines, graph, appearance, shell, distribution,
  //                         user_web_port, local_dev, cli_tabs, language, ui_languages,
  //                         op_token_source }
  // POST /api/settings  body: { editor?, terminal?, editor_overrides?, graph?, appearance?, shell?,
  //                             language? }
  //   graph: { direction, group, density, panelWidth } (see graph-prefs.ts)
  //   appearance: { theme: id | null, mode: system|dark|light } (appearance-prefs.ts)
  //   shell: { pins, collapsed, hidden, order, dock, dockHeight } (shell-prefs.ts)
  //   agents_layout: focus | tabs | tile, the Agents tab's layout (AG-4b,
  //     agents-layout-pref.ts; user.yml agents.layout); null clears it
  //   editor_open: vscode | cursor | zed | none, where a path in an agent's
  //     pane opens (AG-4b, editor-open-pref.ts); null clears it (none)
  //   language: the UI's language, en | ja | es (ui-language.ts); null or
  //     "en" clears it (English is the default)
  //   hub_allow_tools: true | false, hub.allow_tools (HUB-1.5: agents use
  //     Hub's tools without asking); null clears it (on)
  // It writes config/local/user.yml only. `distribution` is read-only: what
  // the org config (tracked) sets, for the Settings page's Distribution rows.
  // Every key POST accepts has a row in the Settings page's registry
  // (settings-registry.js; settings-inventory.test.ts checks).
  // The view scope: which active workspaces the pages, the health row and
  // `status` show. A view preference only (user.yml `view`): it changes no
  // edge route, container or service, and never the focus.
  if (pathname === "/api/scope") {
    if (req.method === "GET") return sendJson(res, scopePayload(scopeView()));
    if (req.method === "POST") {
      let body: { scope?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as { scope?: unknown };
      } catch {
        return send400(res, "invalid JSON");
      }
      const parsed = parseScope(body.scope, getActiveWorkspaces());
      if (!parsed.ok) return send400(res, parsed.error);
      const user = readUserConfig();
      const view = storedView(parsed.value);
      if (view) user.view = view;
      else delete user.view;
      writeUserConfig(user);
      return sendJson(res, scopePayload(scopeView(parsed.value)));
    }
  }

  if (pathname === "/api/settings") {
    if (req.method === "GET") {
      const user = readUserConfig();
      const editorList = editors.listEditors();
      const terminalList = editors.listTerminals();
      return sendJson(res, {
        editor: user.editor ?? null,
        editors: editorList,
        terminal: user.terminal ?? null,
        terminals: terminalList,
        editor_overrides: user.editor_overrides ?? {},
        languages: SUPPORTED_LANGUAGES,
        log_window_lines: user.log_window_lines ?? 20_000,
        graph: graphPrefs(user.graph),
        appearance: appearancePrefs(user.appearance),
        shell: shellPrefs(user.shell),
        agents_layout: agentsLayout(user),
        editor_open: editorOpen(user),
        distribution: distributionSettings(getDistRoot()),
        // Set from the command line (`<cli> config`), shown read-only.
        user_web_port: userWebPort(user as Record<string, unknown>),
        local_dev: user.local_dev !== false,
        cli_tabs: user.cli_tabs === true,
        // The UI's language (R19), and the ones it has catalogs for.
        language: uiLanguage(user.language),
        ui_languages: UI_LANGUAGES,
        // SEC-2a: the name the signed-out page gives this machine, and
        // what it is when unset (the short hostname).
        machine_name: machineNameSetting(user),
        machine_name_default: machineLabel(null, os.hostname()),
        // Where the 1Password token comes from (the source, never the token).
        op_token_source: opTokenSourceSetting(),
      });
    }
    if (req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          editor?: string | null;
          terminal?: string | null;
          editor_overrides?: Record<string, string> | null;
          graph?: unknown;
          appearance?: unknown;
          shell?: unknown;
          language?: unknown;
          machine_name?: unknown;
          agents_layout?: unknown;
          editor_open?: unknown;
          hub_allow_tools?: unknown;
        };
        const user = readUserConfig();
        // HUB-1.5: hub.allow_tools, Hub's tools without asking (Settings ›
        // Agents › Hub); null clears it (the default, on).
        if (body.hub_allow_tools !== undefined) {
          const h = patchHubAllowTools(
            user as Record<string, unknown>,
            body.hub_allow_tools,
          );
          if (!h.ok) return send400(res, h.error);
        }
        // AG-4b: the Agents tab's layout, a view preference only.
        if (body.agents_layout !== undefined) {
          const l = patchAgentsLayout(user, body.agents_layout);
          if (!l.ok) return send400(res, l.error);
        }
        // AG-4b: where a path link in an agent's pane opens.
        if (body.editor_open !== undefined) {
          const e = patchEditorOpen(user, body.editor_open);
          if (!e.ok) return send400(res, e.error);
        }
        // SEC-2a: web.machine_name (user.yml); null or "" clears it.
        if (body.machine_name !== undefined) {
          let name: string | null;
          try {
            name = parseMachineName(body.machine_name);
          } catch (e) {
            return send400(res, (e as Error).message);
          }
          const web = { ...(user.web ?? {}) };
          if (name) web.machine_name = name;
          else delete web.machine_name;
          if (Object.keys(web).length) user.web = web;
          else delete user.web;
        }
        // null clears (0.3.0-dev.32, a consumer's nit): a block or a key
        // set to null is removed from user.yml, and a block left empty
        // goes too, so setting a pref and clearing it again leaves the
        // file byte-identical.
        // The rail's pins and collapse (R14): a view preference only.
        if (body.shell === null) delete user.shell;
        else if (body.shell !== undefined) {
          const sh = mergeShellPrefs(shellPrefs(user.shell), body.shell);
          if (!sh.ok) return send400(res, sh.error);
          const stored = storedShell(sh.value);
          if (stored) user.shell = stored;
          else delete user.shell;
        }
        if (body.graph === null) delete user.graph;
        else if (body.graph !== undefined) {
          const g = patchStoredGraph(user.graph, body.graph);
          if (!g.ok) return send400(res, g.error);
          if (g.value) user.graph = g.value as UserConfig["graph"];
          else delete user.graph;
        }
        // A UI preference only: the page swaps /theme.css and data-mode.
        if (body.appearance === null) delete user.appearance;
        else if (body.appearance !== undefined) {
          const a = mergeAppearancePrefs(
            appearancePrefs(user.appearance),
            body.appearance,
            (id) => !!findTheme(themeDeps.roots(), id)?.ok,
          );
          if (!a.ok) return send400(res, a.error);
          const stored = storedAppearance(a.value);
          if (stored) user.appearance = stored;
          else delete user.appearance;
        }
        // The UI's language (R19): stored only when it isn't English.
        if (body.language !== undefined) {
          const clear =
            body.language === null ||
            body.language === "" ||
            body.language === "en";
          if (!clear && !isUiLanguage(body.language))
            return send400(
              res,
              `language must be one of ${UI_LANGUAGES.map((l) => `"${l}"`).join(", ")}`,
            );
          if (clear) delete user.language;
          else user.language = body.language as string;
        }
        if (body.editor === null || body.editor === "") {
          delete user.editor;
        } else if (body.editor !== undefined) {
          if (!editors.isKnownEditor(body.editor))
            return send400(res, `Unknown editor "${body.editor}"`);
          user.editor = body.editor;
        }
        if (body.terminal === null || body.terminal === "") {
          delete user.terminal;
        } else if (body.terminal !== undefined) {
          if (!editors.isKnownTerminal(body.terminal))
            return send400(res, `Unknown terminal "${body.terminal}"`);
          user.terminal = body.terminal;
        }
        if (body.editor_overrides === null) {
          delete user.editor_overrides;
        } else if (body.editor_overrides !== undefined) {
          const langKeys = new Set<string>(
            SUPPORTED_LANGUAGES.map((l) => l.key),
          );
          const cleaned: Record<string, string> = {};
          for (const [lang, editorKey] of Object.entries(
            body.editor_overrides,
          )) {
            if (!langKeys.has(lang))
              return send400(res, `Unknown language "${lang}"`);
            if (!editorKey) continue; // empty = use default
            if (!editors.isKnownEditor(editorKey))
              return send400(res, `Unknown editor "${editorKey}"`);
            cleaned[lang] = editorKey;
          }
          if (Object.keys(cleaned).length > 0) {
            user.editor_overrides = cleaned;
          } else {
            delete user.editor_overrides;
          }
        }
        writeUserConfig(user);
        return sendJson(res, {
          ok: true,
          editor: user.editor ?? null,
          terminal: user.terminal ?? null,
          editor_overrides: user.editor_overrides ?? {},
          graph: graphPrefs(user.graph),
          appearance: appearancePrefs(user.appearance),
          shell: shellPrefs(user.shell),
          language: uiLanguage(user.language),
          machine_name: machineNameSetting(user),
          agents_layout: agentsLayout(user),
          editor_open: editorOpen(user),
        });
      } catch (e) {
        return send400(res, `Invalid request: ${(e as Error).message}`);
      }
    }
  }

  // ── API: open repo in editor ──────────────────────────────────────────────
  // POST /api/editor/open  body: { path: string }
  if (pathname === "/api/editor/open" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { path?: string };
      if (!body.path) return send400(res, '"path" is required');

      // Walk up to the nearest existing ancestor if the path doesn't exist.
      let openPath = body.path;
      while (openPath && !fs.existsSync(openPath)) {
        const parent = path.dirname(openPath);
        if (parent === openPath) break; // reached filesystem root
        openPath = parent;
      }

      const user = readUserConfig();
      // Resolve editor: per-language > workspace > global default
      const ws = getActiveWorkspace();
      const effectiveEditor = editors.resolveEditorForRepo(
        openPath,
        user.editor,
        user.editor_overrides,
        ws?.config.editor,
      );
      if (!effectiveEditor)
        return sendJson(
          res,
          { ok: false, error: "No editor configured. Set one in Settings." },
          400,
        );
      const cmd = editors.resolveEditorCmd(effectiveEditor);
      if (!cmd)
        return sendJson(
          res,
          {
            ok: false,
            error: `Editor "${effectiveEditor}" not found on this machine.`,
          },
          400,
        );
      const safePath = openPath.replace(/'/g, "'\\''");
      if (editors.isTerminalEditor(effectiveEditor)) {
        // Write a temporary .command file (Terminal.app executes these on open,
        // no Automation permission required — unlike osascript do script).
        const tmp = path.join(
          os.tmpdir(),
          `${product().cli}-open-${Date.now()}.command`,
        );
        fs.writeFileSync(tmp, `#!/bin/bash\ncd '${safePath}' && '${cmd}' .\n`, {
          mode: 0o755,
        });
        const result = spawnSync("open", [tmp], {
          timeout: CLI_SPAWN_TIMEOUT_MS,
        });
        // Give Terminal a moment to read the file before we remove it.
        setTimeout(() => {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
        }, 3_000);
        if (result.status !== 0) {
          const stderr = result.stderr?.toString().trim() ?? "";
          return sendJson(
            res,
            {
              ok: false,
              error: stderr || "Failed to open Terminal.app.",
              runCmd: `${cmd} ${openPath}`,
            },
            500,
          );
        }
      } else {
        spawn(cmd, [openPath], { detached: true, stdio: "ignore" }).unref();
      }
      return sendJson(res, { ok: true });
    } catch (e) {
      return send400(res, `Invalid request: ${(e as Error).message}`);
    }
  }

  // ── API: open directory in terminal app ──────────────────────────────────
  // POST /api/terminal/open  body: { path: string }
  if (pathname === "/api/terminal/open" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req)) as { path?: string };
      if (!body.path) return send400(res, '"path" is required');

      // Walk up to the nearest existing ancestor.
      let openPath = body.path;
      while (openPath && !fs.existsSync(openPath)) {
        const parent = path.dirname(openPath);
        if (parent === openPath) break;
        openPath = parent;
      }

      const user = readUserConfig();
      if (!user.terminal)
        return sendJson(
          res,
          {
            ok: false,
            error: "No terminal app configured. Set one in Settings.",
          },
          400,
        );

      const appName = editors.resolveTerminalApp(user.terminal);
      if (!appName)
        return sendJson(
          res,
          {
            ok: false,
            error: `Terminal "${user.terminal}" not found on this machine.`,
          },
          400,
        );

      // Write a temporary .command script that cd's into the directory and
      // starts an interactive shell. Most macOS terminal apps execute .command
      // files when opened via `open -a`.
      const safePath = openPath.replace(/'/g, "'\\''");
      const tmp = path.join(
        os.tmpdir(),
        `${product().cli}-term-${Date.now()}.command`,
      );
      fs.writeFileSync(tmp, `#!/bin/bash\ncd '${safePath}' && exec $SHELL\n`, {
        mode: 0o755,
      });
      const result = spawnSync("open", ["-a", appName, tmp], {
        timeout: 5_000,
      });
      setTimeout(() => {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }, 3_000);

      if (result.status !== 0) {
        const stderr = result.stderr?.toString().trim() ?? "";
        return sendJson(
          res,
          {
            ok: false,
            error: stderr || `Failed to open ${appName}.`,
            runCmd: `cd '${safePath}'`,
          },
          500,
        );
      }
      return sendJson(res, { ok: true });
    } catch (e) {
      return send400(res, `Invalid request: ${(e as Error).message}`);
    }
  }

  // A route that throws, for the error frame's tests and screenshots only
  // (DEN_DEBUG_ROUTES=1): a page and an API call.
  if (
    process.env.DEN_DEBUG_ROUTES === "1" &&
    (pathname === "/_den/throw" || pathname === "/api/_den/throw")
  ) {
    throw new Error("a debug route threw (DEN_DEBUG_ROUTES)");
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  sendNotFound(req, res, pathname, requestId);
}

/**
 * No route answered. /api: the R26b JSON (an `engine_stale` code naming
 * both versions when the engine on disk is newer: its routes are the ones
 * that 404 here). A page: the shell's 404 page (R26a). Anything else (an
 * asset): plain text, as before.
 */
function sendNotFound(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  requestId: string,
): void {
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    const engine = engineCheck();
    if (engine.stale)
      return sendJson(
        res,
        {
          ok: false,
          error: engineStaleMessage(engine, product().cli),
          code: "engine_stale",
          loaded: engine.loaded.version,
          onDisk: engine.onDisk.version,
        },
        404,
      );
    return sendJson(
      res,
      {
        ok: false,
        error: `No such API route: ${req.method ?? "GET"} ${pathname}`,
        code: "not_found",
      },
      404,
    );
  }
  if (wantsHtmlPage(req, pathname))
    return sendErrorPage(req, res, {
      status: 404,
      path: pathname,
      requestId,
      plugin: pluginForPath(pathname, ROOT),
    });
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

/** The request's id: assigned once (the handler and its catch share it). */
const REQUEST_IDS = new WeakMap<http.IncomingMessage, string>();
function requestIdOf(req: http.IncomingMessage): string {
  let id = REQUEST_IDS.get(req);
  if (!id) {
    id = newRequestId();
    REQUEST_IDS.set(req, id);
  }
  return id;
}

const server = http.createServer((req, res) => {
  // An async handler with no catch turns any route throw into an unhandled
  // rejection — which CRASHES the whole server on modern Node (freezing every
  // health dot) and leaves the request hanging. Fail the one request instead.
  // Each request in its own lock scope (SEC-1c: an agent's stays shut).
  inRequestLockScope(() => handleRequest(req, res)).catch((err: unknown) => {
    // R26: the log has the stack under the request id; the browser gets the
    // id, never the stack. The route is its template: no query values.
    const requestId = requestIdOf(req);
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routeTemplate(pathname);
    const method = req.method ?? "GET";
    // A config that fails validation is the user's to fix, not a crash: the
    // /api frame answers 422 config_invalid (jsonApiErrors adds requestId), a
    // page gets the error page saying so, anything else the message as text.
    if (isConfigError(err)) {
      serverLog(
        `  ⚠ ${method} ${route} (req ${requestId}): ${err.message}`,
        "error",
      );
      try {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (pathname === "/api" || pathname.startsWith("/api/")) {
          sendJson(res, configErrorBody(err), CONFIG_ERROR_STATUS);
          return;
        }
        if (wantsHtmlPage(req, pathname)) {
          sendErrorPage(req, res, {
            status: CONFIG_ERROR_STATUS,
            path: pathname,
            message: err.message,
            issues: configErrorBody(err).issues,
            cli: product().cli,
            requestId,
          });
          return;
        }
        res.writeHead(CONFIG_ERROR_STATUS, { "Content-Type": "text/plain" });
        res.end(`${err.message} (request ${requestId})`);
      } catch {
        /* socket already gone */
      }
      return;
    }
    const stack =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    serverLog(
      `  ✗ ${method} ${route} failed (req ${requestId}): ${stack}`,
      "error",
    );
    if (SILENT)
      console.error(
        `[server] ${method} ${route} failed (req ${requestId}):`,
        err,
      );
    try {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        sendJson(
          res,
          {
            ok: false,
            error: `${method} ${route} failed on the server`,
            code: "internal",
          },
          500,
        );
        return;
      }
      if (wantsHtmlPage(req, pathname)) {
        sendErrorPage(req, res, { status: 500, method, route, requestId });
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`internal server error (request ${requestId})`);
    } catch {
      /* socket already gone */
    }
  });
});

// WebSocket upgrades pass the same checks (SEC-1 §3: Origin on every
// upgrade; CSRF as the `den.csrf.<token>` subprotocol). One route takes
// one: a session's io (AG-4a-term, session-routes.ts); any other passing
// upgrade answers 404.
server.on(
  "upgrade",
  (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => undefined);
    const requestId = requestIdOf(req);
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const guard = checkRequest(req, GUARD, product().cli, product().title);
    const refuse = (status: number, error: string, code: string) =>
      refuseUpgrade(
        socket,
        status,
        { ok: false, error, code, requestId },
        http.STATUS_CODES[status] ?? "",
      );
    if (!guard.ok) {
      serverLog(
        `  ${logTimestamp()}  ${bold("WS  ")}  ${pathname}  →  ${logStatus(guard.status)}` +
          dim(`  req ${requestId}`),
        "request",
      );
      auditGuardRefusal(req, pathname, guard);
      return refuse(guard.status, guard.error, guard.code);
    }
    setPrincipal(req, guard.principal);
    if (!isSessionIoPath(pathname))
      return refuse(404, "No WebSocket route here", "not_found");
    if (guard.session) trackSessionSocket(guard.session.key, socket);
    handleSessionUpgrade(req, socket, head, pathname, requestId).catch(
      (err: unknown) => {
        serverLog(
          `  ✗ WS ${routeTemplate(pathname)} failed (req ${requestId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
          "error",
        );
        socket.destroy();
      },
    );
  },
);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  ✗ Port ${PORT} is already in use.\n` +
        `\n  Another ${product().cli} server may be running, or its service holds the port.` +
        `\n  ${product().cli} service status   # is the service running it?` +
        `\n  ${product().cli} web restart      # restarts the service, or the plain server\n`,
    );
    process.exit(1);
  }
  throw err;
});

// Restore daemon registry from the previous session, then drop any whose opctl
// containers are no longer running. Stale entries — from a prior session, or a
// service stopped outside den — otherwise reopen as tabs in the web UI and
// clutter the shutdown prompt. Container liveness (not health) is the signal: a
// service's shared-infra health check stays green even when the service is down.
// The container listing runs as async child processes (a sync `docker ps`
// here held the event loop at startup); /api/service/daemons waits for it,
// so the UI never gets a stale entry on its first load.
loadDaemonsFromFile();
startupPrune = pruneDeadDaemonsAsync()
  .then((pruned) => {
    if (pruned.length > 0)
      console.error(
        `Cleared ${pruned.length} stale daemon(s): ${pruned.join(", ")}`,
      );
  })
  .catch((e: unknown) => {
    console.error(`[server] stale-daemon sweep failed: ${String(e)}`);
  });

// Background recovery: after a short delay (long enough for services to be
// responding), health-check each loaded daemon. Removal requires strong
// evidence — a missing service, or two consecutive "error" health checks
// (a single transient timeout/5xx never unregisters a possibly-running
// daemon). See daemon-reaper.ts; behavior pinned by its unit tests.
void (async () => {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, DAEMON_SHUTDOWN_GRACE_MS),
  );
  const reaped = await reapDeadDaemons({
    listDaemons,
    resolveService,
    getActiveWorkspaces,
    checkServiceHealth: (service) => checkServiceHealth(service),
    unregisterDaemon,
    delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    retryDelayMs: DAEMON_RETRY_DELAY_MS,
    rootOf: daemonRootOf,
    staleReason: daemonStaleReason,
    runningContainers: runningContainerBasesAsync,
  });
  if (reaped.removed.length > 0)
    console.error(
      `Reaped ${reaped.removed.length} stopped daemon(s): ${reaped.removed.join(", ")}`,
    );
})();

const prunedSnapshots = pruneDeadSnapshots();
if (prunedSnapshots > 0) {
  serverLog(`Pruned ${prunedSnapshots} orphaned log-history snapshot(s)`);
}

// Cap service logs. Long-lived daemons never respawn (a localstack tail reached
// 8.6 GB), so the spawn-time check alone is not enough — sweep on startup and
// periodically. unref'd so it never holds the process open.
function sweepServiceLogs(): void {
  try {
    const rotated = sweepLogs(getServiceLogRoot());
    if (rotated.length > 0) {
      serverLog(
        `Rotated ${rotated.length} oversized log(s): ${rotated
          .map((p) => path.basename(path.dirname(p)) + "/" + path.basename(p))
          .join(", ")}`,
      );
    }
  } catch (e) {
    serverLog(`Log sweep failed: ${(e as Error).message}`);
  }
}
sweepServiceLogs();
setInterval(sweepServiceLogs, LOG_SWEEP_INTERVAL_MS).unref();

// Last-resort guards: an uncaught throw in an async callback (spawn handlers,
// timers — code the per-request catch can't see) would kill the whole
// dashboard; a TDZ bug in a down-flow callback did exactly that. For a local
// dev server, staying alive degraded beats dying — log loudly and continue.
// Never log a lost-output error, or anything once the output is gone: that
// write fails too, and looped (shutdown-guard.ts).
process.on("uncaughtException", (err) => {
  if (isLostOutputError(err) || outputLost()) return;
  console.error("[server] uncaught exception (continuing):", err);
});
process.on("unhandledRejection", (reason) => {
  if (isLostOutputError(reason) || outputLost()) return;
  console.error("[server] unhandled rejection (continuing):", reason);
});

// Build, before serving, what the first health poll and /api/services would
// otherwise build inside a request: the dependency-graph order and the HTTPS
// checks' trust context (both synchronous).
try {
  for (const ws of getActiveWorkspaces()) graphOrder(ws);
  prewarmHealthTls();
} catch (e) {
  serverLog(`  ⚠ cache warm-up failed: ${(e as Error).message}`);
}

// Ignored config keys (a distribution's web.allow_plain_http_remote, the
// old web.session lifetimes): the in-app log, and stderr, which is web.log
// even when `web up` starts this --silent. Before the bind refusal, which
// such a key often explains.
{
  const ignored = ignoredConfigWarning(WEB_AUTH);
  if (ignored) {
    pushLog("warn", `  ⚠ ${ignored}`);
    if (!outputLost()) process.stderr.write(`  ⚠ ${ignored}\n`);
  }
}
// §4: a non-loopback bind needs HTTPS in front, or the person's say-so.
{
  const refusal = bindRefusal(BIND_HOST, {
    allowPlainHttpRemote: WEB_AUTH.allowPlainHttpRemote,
    fronted: edgeFronted(),
  });
  if (refusal) {
    console.error(`\n  ✗ ${refusal}\n`);
    process.exit(1);
  }
}
// SEC-1a: the secret the CLI's person token is derived from (0600 in the
// state dir). Never printed or logged; a failure leaves bearers unverifiable.
try {
  webSecret.ensure();
} catch (e) {
  serverLog(`  ⚠ web.secret could not be created: ${(e as Error).message}`);
}
// AG-0.1: the login shell's PATH, once, in the background (3 s at most),
// so agents find their CLI as the person's terminal would: a launchd
// service's PATH leaves out ~/.local/bin. Until (or unless) it answers, the
// search is this PATH and the runtimes' install directories.
void initLoginPath();
// AG-14: agents interrupted by a restart, and stopped ones to forget.
startAgentUpkeep((line) => serverLog(line, "lifecycle"));
// D80: the install's address (web.url), the one people are given. An
// install made before it takes its edge route's once, before the server
// answers (so the first `web up` reads it), for doctor to confirm. Never
// localhost.
const ADDRESS = migrateWebUrl(() => {
  try {
    const ports = new Set([readWebPort(), PORT]);
    const urls = webRouteHosts(readEdgeConfig(), ports).map((r) => r.url);
    const url =
      urls.find((u) => u.startsWith("https:")) ??
      urls.find((u) => /^http:\/\/[^/]+\.localhost(:\d+)?$/i.test(u));
    return url ? { url, from: "the edge route to this server" } : undefined;
  } catch {
    return undefined; // no edge config: nothing to take
  }
});
server.listen(PORT, BIND_HOST, () => {
  printBanner(ADDRESS ?? readWebUrl());
  // #57: agents whose record names a project by its pre-D70 key follow it.
  void import("../../shared/agents/heal-workspace.js").then(async (m) => {
    const { isServerScope } =
      await import("../../shared/agents/server-agent.js");
    try {
      const n = m.healRecordWorkspaces(
        getStateDir(),
        readWorkspacesFile().workspaces,
        isServerScope,
      );
      if (n.length)
        serverLog(`  Moved ${n.length} agent(s) to their project's new key`);
    } catch {
      /* the file unreadable: the agents list heals them later */
    }
  });
  // H5: tell Hub this install's projects now, then whenever they change.
  void import("./hub-sync-service.js").then((m) => {
    let every = 30;
    try {
      every = readHubConfig()?.syncCheckSeconds ?? 30;
    } catch {
      /* a bad hub block: doctor says so; the default here */
    }
    m.startProjectSync(every);
  });
  // 0.4.40: Hub comments reach this install's agents.
  void import("./hub-delivery-service.js").then((m) => {
    // Always registered: a later Connect starts it (no token: it waits).
    let cfg: ReturnType<typeof readHubConfig> = null;
    try {
      cfg = readHubConfig();
    } catch {
      /* a bad hub block: doctor says so; the defaults here */
    }
    void m.startDeliveries({
      heartbeatSeconds: cfg?.deliveryHeartbeatSeconds ?? 15,
      pollSeconds: cfg?.deliveryPollSeconds ?? 30,
      waiting: waitingAgentIds,
      log: (l) => serverLog(`  ${l}`, "warn"),
    });
  });
});

/** The start banner: the install's address (D80), never localhost. */
function printBanner(address: { url: string } | null): void {
  const pkgVersion = engineVersion() ?? "?";

  console.log();
  for (const line of DEN_BANNER_LINES) {
    console.log(`\x1b[36m${line}\x1b[0m`); // cyan without chalk dependency
  }
  console.log();
  console.log(`  ${DEN_SUBTITLE.trim()}`);
  console.log(`  v${pkgVersion}`);
  console.log();
  console.log(
    `  Web UI  →  ${address ? address.url : notSetLine(product().cli)}`,
  );
  console.log();
  // Once per start: a secrets config that leaves Den's own features off.
  for (const w of secretsConfigWarnings()) serverLog(`  ⚠ ${w}`);
  checkEdgeExposure();
  readEdgeNetworks();
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function stopDaemons(): Promise<void> {
  const daemons = listDaemons();
  if (daemons.length === 0) return;

  console.log("\nStopping services…");

  const isTTY = process.stdout.isTTY;
  const total = daemons.length;

  if (isTTY) {
    // Print every service line up front, then update in-place using ANSI cursor movement.
    for (const d of daemons) {
      process.stdout.write(`  ⏳ ${d.address}\n`);
    }
    // Cursor is now one row below the last service line.

    const updateLine = (idx: number, mark: string, suffix: string): void => {
      const movesUp = total - idx; // rows to climb to reach this service line
      process.stdout.write(
        `\x1b[${movesUp}A` + // move cursor up to the service's line
          `\r\x1b[2K` + // clear the line
          `  ${mark} ${daemons[idx].address}${suffix}` +
          `\x1b[${movesUp}E`, // move cursor back to beginning of original row
      );
    };

    await Promise.allSettled(
      daemons.map(
        (d, i) =>
          new Promise<void>((resolve) => {
            runServiceCommand({
              address: d.address,
              command: "down",
              onLine: () => {},
              onClose: (exitCode) => {
                updateLine(
                  i,
                  exitCode === 0 ? "✓" : "✗",
                  exitCode !== 0 ? ` (exit ${exitCode})` : "",
                );
                resolve();
              },
            });
          }),
      ),
    );
    process.stdout.write("\n");
  } else {
    // Non-TTY: simple line-per-service output, no cursor tricks.
    await Promise.allSettled(
      daemons.map(
        (d) =>
          new Promise<void>((resolve) => {
            process.stdout.write(`  ↓ ${d.address}\n`);
            runServiceCommand({
              address: d.address,
              command: "down",
              onLine: () => {},
              onClose: (exitCode) => {
                process.stdout.write(
                  `  ${exitCode === 0 ? "✓" : "✗"} ${d.address}\n`,
                );
                resolve();
              },
            });
          }),
      ),
    );
  }

  console.log("Services stopped.");
}

async function handleShutdown(signal: string): Promise<void> {
  clearSudoShims();
  // The registry lives in the state dir, which is resolved from the
  // distribution root on every call: if that can no longer be found (den.yml
  // moved or removed while the server ran), still exit. Never product() here:
  // it resolves the same root.
  let daemons: ReturnType<typeof listDaemons>;
  try {
    daemons = listDaemons();
  } catch (e) {
    console.error(
      `\n[server] ${signal}: cannot read the running-services registry ` +
        `(${(e as Error).message}); exiting and leaving any services running.`,
    );
    process.exit(0);
  }
  if (daemons.length === 0) {
    process.exit(0);
  }

  // Lost output (SIGPIPE): nobody can answer a prompt.
  const isTTY = process.stdin.isTTY && signal !== "SIGPIPE";

  if (!isTTY) {
    // Non-interactive shutdown usually means `den web` is being restarted.
    // Do not tear down service daemons just because the UI process is cycling.
    console.log(
      `\n${product().title} web received ${signal}; leaving ${daemons.length} running service${daemons.length === 1 ? "" : "s"} alive.`,
    );
    process.exit(0);
  }

  // Interactive terminal: ask the user.
  console.log(`\nRunning services (started by ${product().cli}):`);
  for (const d of daemons) {
    const age = Math.round((Date.now() - d.startedAt.getTime()) / 1000);
    console.log(`  • ${d.address}  (up ${age}s)`);
  }

  process.stdout.write("\nStop these services before exiting? [Y/n] ");

  // Restore normal terminal input for readline.
  if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  process.stdin.resume();

  await new Promise<void>((resolve) => {
    process.stdin.once("data", async (chunk) => {
      const answer = chunk.toString().trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") {
        await stopDaemons();
      } else {
        console.log("Leaving services running.");
      }
      resolve();
    });
  });

  process.exit(0);
}

/**
 * Run the shutdown for `signal`. A failure still ends the process, at once
 * rather than at the deadline.
 */
function shutdownOn(signal: string): void {
  handleShutdown(signal).catch((e: unknown) => {
    console.error(`[server] ${signal}: shutdown failed (exiting):`, e);
    process.exit(1);
  });
}

/**
 * Start the shutdown once; a second signal exits at once, and a shutdown
 * nobody waits on (stdin isn't a TTY) is forced to exit after a deadline
 * (shutdown-guard.ts).
 */
function beginShutdown(signal: string): void {
  requestShutdown(signal, shutdownOn, {
    interactive: Boolean(process.stdin.isTTY) && signal !== "SIGPIPE",
  });
}

process.on("SIGINT", () => {
  if (!outputLost()) console.log(""); // newline after ^C
  beginShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  beginShutdown("SIGTERM");
});

/** D64: ui.restart_wait_seconds, a positive number, else 90. */
function restartWaitSeconds(): number {
  try {
    const v = Number(readUserConfig().ui?.restart_wait_seconds);
    return Number.isFinite(v) && v > 0 ? v : 90;
  } catch {
    return 90;
  }
}
