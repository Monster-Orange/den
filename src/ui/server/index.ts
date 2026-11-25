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

// Issue 814: first, before anything writes to the state folder.
import { BORN_AS_TEST_INSTALL } from "./test-install-birth.js";
import {
  COACH_ROUTES,
  handleCoachRoute,
  type CoachRouteDeps,
} from "./coach-routes.js";
import { runCoach } from "../../shared/coach/run.js";
import { readCoachReport } from "../../shared/coach/store.js";
import {
  dismissFinding,
  openFindings,
  readDismissals,
} from "../../shared/coach/findings.js";
import {
  COACH_DEFAULTS,
  type CoachSettings,
} from "../../shared/coach/settings.js";
import {
  healthCacheTtlMs,
  healthPollSeconds,
} from "../../shared/health-poll.js";
import { line, reviewLines } from "../../shared/review-lines.js";
import { workspaceUrl as workspaceUrlIn } from "./workspace-url.js";
import {
  handleNotificationRoutes,
  isNotificationPath,
} from "./notification-routes.js";
import { handleAppFeedRoutes, isAppFeedPath } from "./app-feed-routes.js";
import { githubWatchSettings } from "../../shared/github-watch/settings.js";
import {
  handleGithubWatchRoutes,
  isGithubWatchPath,
} from "./github-watch-routes.js";
import {
  alertFeed,
  attentionDetail,
  attentionWaiting,
  notificationDeps,
} from "./notification-service.js";
import type { UpdateWait } from "./update-check.js";

import {
  isUpdateAsk,
  securityUpdateNote,
  backNoteHeldNote,
  BACK_NOTE_HELD_SUBJECT,
  staleUpdateAsk,
  updateWaitNotes,
} from "./update-check.js";
import { applyKeepAlive } from "./keep-alive.js";
import { deliveryHeld, typingHeld } from "./attention.js";
import { pausedAgents, startContextWatch } from "./context-watch-service.js";
import { contextWatchSettings } from "../../shared/agents/context-watch.js";
import {
  crashLoopSettings,
  markCleanStop,
  markStopped,
  recordBoot,
  runByServiceManager,
} from "../../shared/crash-loop.js";
import {
  PERSON_ONLY_SETTINGS,
  FIXTURE_PAGE_SETTINGS,
  patchCliRows,
} from "../../shared/settings-cli-rows.js";
import {
  composeHealthTarget,
  containerCheckLabel,
  type ComposeHealthTarget,
  type ContainerHealthTarget,
} from "../../shared/stacks/compose-health.js";
import { healthCheckFields, type HealthCheckType } from "./health-row.js";
import { notCheckedReason } from "../../shared/health/not-checked.js";
import { repoHasRuntime } from "../../shared/repo-kind.js";
import * as http from "http";
import { EventEmitter } from "events";
import { checkIntent } from "../../shared/agents/permissions.js";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import { lookup as dnsLookup } from "dns/promises";
import {
  listWaitingInstalls,
  testPersonSetupAction,
  type TestPersonSetupDeps,
} from "./test-person-held.js";
import { auditConfig } from "../../shared/config-audit.js";
import { userConfigPath } from "../../shared/den-config.js";
import { readWebSecret } from "../../shared/web-secret.js";
import {
  TEST_ANNOUNCE_ENV_KEY,
  installIdOf,
  listAnnounced,
  SETUP_GRANT_MAX_SECONDS,
  announceDir,
  announceTestInstall,
  takeSetupGrant,
  unannounceTestInstall,
} from "../../shared/test-install-grant.js";
import {
  TEST_RESOLVE_ENV_KEY,
  parseTestResolve,
  setTestResolve,
  testResolveIgnored,
  testResolver,
  writeTestResolveState,
} from "../../shared/test-resolve.js";
import * as path from "path";
import semver from "semver";
import { edgeProofChecker } from "../../shared/edge/proof.js";
import { edgeKeyDirs } from "../../shared/edge/key-dirs.js";
import { registerInstall, registryDir } from "../../shared/install-registry.js";
import {
  rotateEdgeProofAtStart,
  syncEdgeProof,
} from "../../shared/edge/runtime.js";
import {
  bridgeGateway,
  bridgeLine,
  bridgeStateFile,
  bridgeWanted,
  writeBridgeState,
  type BridgeOutcome,
} from "../../shared/edge/bridge-listen.js";
import { readCheckState as readCheckStateSync } from "../../shared/update-check-state.js";
import { execFile, execFileSync, spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { envSelector } from "../../shared/environment/env-selector.js";
import { moduleScanner } from "../../shared/test-discovery/module-scanner.js";
import { resolveFieldEnv } from "../../shared/perf/optional-fields.js";
import { testRunner } from "../cli/test-runner.js";
import { discoverRepos } from "../../pillars/smoke/discover.js";
import { planSuites } from "../../pillars/suites/run.js";
import {
  listReposWithManifests,
  listServicesWithManifests,
  workspaceNames,
} from "../../shared/manifest/workspace-manifests.js";
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
import { oldKindWarning } from "../../shared/run-outcome.js";
import {
  readCatalog,
  resolveRepoGhSlug,
} from "../../shared/environment-manager/catalog.js";
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
  writeWorkspacesFile,
  resolveDepAddress,
  parseAddress,
  readManifestAnyBranch,
  workspacesOverridingAgentMode,
  workspaceEventFeedsRaw,
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
  tailArgv,
} from "./log-history.js";
import { resolveServiceInProjects } from "../../shared/environment-manager/service-in-projects.js";
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
import { runningDockerNamesAsync } from "../../shared/environment-manager/opctl.js";
import { restoreNote } from "./restore-note.js";
import { servicesRestoreOnBoot } from "../../shared/environment-manager/restore-on-boot.js";
import { queueConfig, restartQueue } from "./restart-queue-service.js";
import { toolsOldRow } from "./tools-old-service.js";
import {
  heldManifestsDir,
  readManifest,
} from "../../shared/manifest/read-manifest.js";
import {
  getServiceLogRoot,
  spawnStreaming,
  getServiceLogPath,
} from "../../shared/process/spawn-streaming.js";
import {
  assertDenConfigValid,
  getReposRoot,
  sectionConfigError,
  readDenConfig,
  readMcpConfig,
  orgEnvironments,
  readServerAgentConfig,
  migrateSelfUpdate,
  readAgentsConfig,
  setUserAgentSandbox,
  setUserSandboxOn,
  TOKEN_PEER_WAIT_MS_DEFAULT,
  UPDATE_WAIT_SECONDS_DEFAULT,
  isProductionEnv,
  isLocalEnabled,
  readUserConfig,
  readInstallMode,
  resolveInstallMode,
  type DenConfig,
  type InstallMode,
  mergeUserConfig,
  type UserConfig,
  writeUserConfig,
  panesReconnect,
  agentsListWaits,
  agentsKeepRunningAfterLogout,
  testGrantSeconds,
  uiRestartWaitSeconds,
  readWebServiceConfig,
  webUrlCheckSeconds,
  readReleaseConfig,
  resolveReleaseTarget,
  writeUserReleaseConfig,
  type ReleaseConfig,
  readWebKeepAliveSeconds,
  WEB_KEEP_ALIVE_SECONDS_DEFAULT,
  shellPathTimeoutMs,
  agentsResume,
  agentsShellPathTimeoutSeconds,
  agentsDraftHoldMaxMinutes,
  heldWriteWaitMinutes,
  readSessionsConfig,
} from "../../shared/den-config.js";
import { useNotificationConfig } from "../../shared/notifications.js";

// Issue 1348: the bell's store lock times, from user.yml `notifications:`.
useNotificationConfig(() => readUserConfig().notifications);
import {
  CONFIG_ERROR_STATUS,
  configErrorBody,
  isConfigError,
} from "../../shared/config-error.js";
import { readOrgView } from "../../shared/org.js";
import {
  ENGINE_PACKAGE,
  engineVersion,
  getDistRoot,
  getEngineRoot,
  getProfile,
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
  denCliCommand,
  hasDenHostsEntry,
  spawnDetachedWebRestart,
  webServerEnv,
} from "../cli/web-command.js";
import { recordInvocation } from "../../shared/dev-metrics/emit.js";
import { validateManifest } from "../../shared/manifest/validate-manifest.js";
import { validateAtPath } from "./manifest-validate-path.js";
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
import {
  GateLockBusy,
  GateStore,
  gateLocked,
  checkGatePatch,
  serverFreeMemory,
  serverSwapUsedGb,
  type GateSettingsPatch,
} from "../../shared/gates/store.js";
import { realDocker } from "../../shared/gates/ephemeral.js";
import {
  gateBoxOps,
  gateRunnerTokenOp,
  handleGateRoutes,
  isGatePath,
} from "./gate-routes.js";
import { RunnerTokens } from "../../shared/gates/runner-tokens.js";
import { actorLabel } from "../../shared/agent-actor.js";
import {
  actorSuffix,
  recordAction,
  recordQueuedAuditRow,
  recordSentAuditRow,
  recordAgentRefusal,
  recordCrossWorkspace,
  repoAtPath,
  setAuditSink,
  setAsideOldTrail,
  setAuditFile,
  AUDIT_FILE,
} from "./audit.js";
import { setConfigAuditSink } from "../../shared/config-audit.js";
import { cliAuditRequest } from "./audit-cli-route.js";
import {
  droppedDetail,
  QUEUE_DROPPED_VERB,
  rememberSentAuditCopy,
  sentAuditBudget,
  startAuditQueueIntake,
  wasSentAuditCopy,
} from "../../shared/audit-queue.js";
import { handleReadonlyRoutes } from "./readonly-routes.js";
import {
  defaultOnboardRouteDeps,
  handleOnboardRoutes,
  type OnboardRouteDeps,
} from "./onboard-routes.js";
import {
  agentPrincipalOf,
  AGENT_VIEW_CLIENT,
  agentRefusal,
  auditActorOf,
  notAPersonOf,
  fixturePersonOf,
  markOperatorAct,
  bindRefusal,
  checkRequest,
  isEdgePeer,
  isDockerBridgeAddress,
  isLoopbackAddress,
  isLoopbackBind,
  localNet,
  principalOf,
  requestIsHttps,
  sessionRequestAllowed,
  setPrincipal,
  signinMessage,
  type GuardContext,
  type GuardResult,
  type Via,
  viewAgent,
} from "./request-guard.js";
import {
  clientRequestId,
  createRequestLedger,
  ledgerGate,
  ledgerOwner,
  validRequestId,
} from "./request-ledger.js";
import {
  rotateWebSecret,
  verifyPersonToken,
  WebSecretStore,
} from "../../shared/web-secret.js";
import {
  ACTOR_TOKEN_PREFIX,
  agentTokenLive,
  checkActorToken,
  sessionPid,
  revokeAllActorTokens,
} from "../../shared/actor-token.js";
import {
  checkLoginCode,
  deviceName,
  ignoredConfigWarning,
  localhostOrigin,
  loginCodeNonce,
  loginLink,
  LOGIN_CODE_MAX_TTL_MS,
  mintLoginCode,
  readWebAuthConfig,
  safeNext,
  sessionIdPrefix,
  WebSessionStore,
  withApproveKey,
  type SessionVia,
  type WebAuthConfig,
  SessionStoreUnreadable,
  SESSIONS_LOCK_WAIT_MS,
} from "../../shared/web-session.js";
import {
  checkFixtureCode,
  FIXTURE_LABEL,
  FIXTURE_LINK_PARAM,
  FIXTURE_PRINCIPAL,
  fixtureKeyFingerprint,
  fixtureScopeRefusal,
  fixtureSessionExpired,
  notTestInstallRefusal,
  setupFixturePerson,
  TEST_INSTALL_ENV_KEY,
  testInstallBinding,
  testInstallByHandRefusal,
  verifiedFixtureKey,
} from "../../shared/fixture-person.js";
import {
  FIXTURE_SETUP_SECRET_ENV_KEY,
  SETUP_SECRET_AUDIT,
  SetupSecret,
  setupSecretRefusal,
  writeFixtureMadeBy,
} from "../../shared/fixture-setup-secret.js";
import {
  AGENT_VIEW_LINK_NOTE,
  AGENT_VIEW_LINK_PARAM,
  AGENT_VIEW_LINK_TTL_MS,
  AgentViewCodes,
  agentViewExpired,
  agentViewOffText,
  agentViewRefusedText,
  agentViewScopeRefusal,
  isAgentViewLink,
} from "../../shared/agent-view.js";
import {
  dropPendingRecord,
  hasForwardingHeaders,
  OPERATOR_LABEL,
  OPERATOR_PRINCIPAL,
  operatorAct,
  operatorRefusal,
  verifiedCreationRecord,
  writeCreationRecord,
} from "../../shared/test-operator.js";
import {
  inTestPersonScope,
  notTestBedRefusal,
  TEST_PERSON_HEADER,
  testPersonCredentialRefusal,
} from "../../shared/test-person.js";
import { routeClass } from "./route-classes.js";
import { envName, readEnv } from "../../shared/profile.js";
import {
  clearSessionCookies,
  readSessionCookie,
  sessionSetCookie as sessionCookieLine,
} from "./session-cookie.js";
import {
  localHttpsAddress,
  NamedAddressWatch,
  type NamedAnswer,
} from "./named-address.js";
import {
  kitPage,
  kitSiteDir,
  serveSiteFile,
  serveUiAsset,
  sitePage,
} from "./ui-assets.js";
import {
  PERSON_GRANT_ROUTES,
  approverAllowed,
  personGrantAllowed,
} from "./approvals.js";
import {
  migrateWebUrl,
  notSetLine,
  readWebUrl,
  setWebUrl,
  type WebUrlChange,
} from "../../shared/web-url.js";
import { peopleWebUrl } from "../../shared/agent-links.js";
import { tellHubDenUrl } from "../../shared/hub-den-url.js";
import { webUrlSetAction } from "./web-url-held.js";
import {
  adoptAllowed,
  handleWebUrlRoutes,
  offeredAlias,
} from "./web-url-routes.js";
import { aliasCandidates, isLoopbackUrl } from "../../shared/web-url-check.js";
import {
  handleAccountsRoute,
  handleKeepRunningRoutes,
  handleSignInTokenRoute,
  noteKeepRunningOffer,
} from "./keep-running-routes.js";
import { handleEdgeUpRoute } from "./edge-up-routes.js";
import { handleAddressRoutes } from "./address-routes.js";
import {
  identityAnswer,
  identityKey,
  probeIdentity,
} from "../../shared/den-identity.js";
import {
  addressCheckSettings,
  checkAddress,
  cliLanguage,
  edgeUncheckedLine,
  isEdgeAddress,
  portState,
  statedAddress,
} from "../../shared/edge/address-check.js";
import { containerState } from "../../shared/edge/runtime.js";
import { sh as edgeSh } from "../../shared/edge/exec.js";
import { runEdgeUp } from "../../shared/edge/up.js";
import {
  agentTokenStatus,
  clearAgentToken,
  dropStaleEnvTokenRecord,
  saveAgentToken,
  TOKEN_DOCS,
  TOKEN_RUNTIME,
} from "../../shared/agents/signin-token.js";
import {
  accountsView,
  accountLabel,
  addAccount,
  removeAccount,
  saveAccountToken,
  setAccountOrder,
  signInRuntime,
} from "../../shared/agents/signin-accounts.js";
import { getRuntime, runtimeIds } from "../../shared/agents/runtimes.js";
import { accountNameOf } from "../../shared/agents/catalog.js";
import { serviceJobState } from "../cli/doctor-where.js";
import { cmdService, detachedRunner } from "../cli/service-command.js";
import {
  decideReport,
  handleReportRoutes,
  machineSection,
  publicSearchOpen,
  reportAgentOf,
  runGh,
  shotReaderOf,
  type ReportRouteDeps,
} from "./report-routes.js";
import { reportHeld } from "./report-held.js";
import { publicRepoVisibility } from "./report-visibility.js";
import {
  feedbackSettings,
  readFeedbackSettings,
} from "../../shared/report-store.js";
import { reportShotHub } from "./report-shot-hub.js";
import {
  shotKeepDays,
  shotLimits,
  shotStore,
} from "../../shared/report-shots.js";
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
import { FirstRun } from "./first-run.js";
import { signinMethods } from "./signin-methods.js";
import { ownerNameFromGithub } from "../../shared/owner-github.js";
import { noRuleMessage, unclaimedSigninReason } from "./github-routes.js";
import { DeviceFlows, type Decide } from "./device-flows.js";
import {
  decideFlow,
  handleGithubRoutes,
  isGithubRoute,
} from "./github-routes.js";
import { PairRequests, pairUnseenMs } from "./pair-requests.js";
import { LoginWaits } from "./login-waits.js";
import {
  CREATE_REFUSED,
  denAddressOf,
  handlePairRoutes,
  isPairRoute,
} from "./pair-routes.js";
import {
  meshNameOf,
  pairEventDetail,
  SIGNIN_REQUEST_VERB,
} from "./signin-request-log.js";
import { mayWriteSessions } from "./session-writes.js";
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
import {
  agentsLayout,
  helpersShown,
  patchAgentsLayout,
  patchHelpersShown,
} from "./agents-layout-pref.js";
import {
  bellFoldDays,
  bellKinds,
  patchBellFoldDays,
  patchBellKinds,
} from "./bell-prefs.js";
import {
  forgetHubToken,
  hubTokenProblem,
  patchHubAllowTools,
  patchHubGroups,
  hubGroupsMode,
  patchHubUrl,
  readHubConfig,
  type HubConfig,
} from "../../shared/hub.js";
import { patchHubDeliveryLoop } from "../../shared/hub-loop.js";
import { editorOpen, patchEditorOpen } from "./editor-open-pref.js";
import {
  contextUrlProblem,
  embedSettings,
  frameHeaders,
  patchEmbed,
} from "./embed-settings.js";
import {
  appKeyOps,
  handleEmbedRoutes,
  type EmbedWaiting,
} from "./embed-routes.js";
import { ServerKeys } from "./embed-server-keys.js";
import { handleAgentLink } from "./agent-link-routes.js";
import { graphPageHtml } from "./graph-page.js";
import { terminalLinkRedirect, terminalsPageHtml } from "./terminals-page.js";
import {
  fixtureSave,
  mergeShellPrefs,
  prunedFixturePins,
  writeFixturePins,
  pinnedItems,
  shellPrefs,
  storedShell,
  pinProjectsOf,
  type PinProjects,
} from "./shell-prefs.js";
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
import { isTimeZone, timeZonePref, zonePage } from "./time-zone-pref.js";
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
  /** How long the check took, or the time it was given when it timed out. */
  ms?: number;
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
/**
 * Issue 707: while it runs silent (as a service), warn and error lines also
 * go to <state>/logs/server.log (server_log.max_mb, rotated once), so they
 * outlive a restart. The cap is read again at most once a minute.
 */
let serverLogCap = { at: 0, bytes: serverLogMaxBytes(null) };
const toServerLogFile = serverLogWriter({
  stateDir: () => getStateDir(),
  maxBytes: () => {
    if (Date.now() - serverLogCap.at > 60_000) {
      let user: unknown = null;
      try {
        user = readUserConfig();
      } catch {
        /* a bad user.yml: the default */
      }
      serverLogCap = { at: Date.now(), bytes: serverLogMaxBytes(user) };
    }
    return serverLogCap.bytes;
  },
});

/**
 * Issue 1344: lifecycle, warn and error lines always reach web.log: on
 * stdout when it is a file (web up, a service), also under --silent;
 * else appended to <state>/logs/<cli>/web.log. Never twice.
 */
const STDOUT_IS_FILE = fdIsFile(1);
const toWebLog = webLogWriter({
  stdoutIsFile: () => STDOUT_IS_FILE && !outputLost(),
  writeStdout: (s) => void process.stdout.write(s),
  path: () => webLogPath(getStateDir(), product().cli),
});

function serverLog(msg: string, kind: string = "info", actor?: string): void {
  pushLog(kind, msg, actor);
  const onStdout = !SILENT && !outputLost();
  // Issue 1368: redacted, as every other log path is.
  if (onStdout) process.stdout.write(stdoutLine(msg));
  toWebLog(kind, stripAnsi(msg), onStdout);
  if (SILENT) toServerLogFile(kind, stripAnsi(msg));
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
  // Issue 644: the kit's tab icon, for a theme with a text mark.
  denFavicon: path.join(kitSiteDir(), "favicon.ico"),
};
// The pre-paint script in each page reads the user's mode and the theme's
// default mode from these placeholders, so the first paint is right.
// The UI language (R19): a page in another language than English loads
// its catalog before shell.js, so the first paint is in it.
setHtmlFill((html) => {
  let mode = "system";
  let def = "dark";
  let lang = uiLanguage(undefined);
  let zone: string | null = null;
  try {
    const user = readUserConfig();
    lang = uiLanguage(user.language);
    zone = timeZonePref(user.time_zone);
    mode = appearancePrefs(user.appearance).mode;
    def = activeTheme(themeDeps)?.theme.default_mode ?? "dark";
  } catch {
    /* defaults */
  }
  // issue 206: the person's time zone, when picked, for the first paint.
  // Issue 644: the kit's head snippet (tab icons, manifest, theme colour).
  let out = zonePage(sitePage(kitPage(localizePage(html, lang))), zone)
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
// Issue 231: pages name their styles and scripts with this version.
setAssetVersion(ENGINE.loaded.version);

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
 * HEAD gets the status and headers only (Node's server sends no body).
 */
function sendErrorPage(
  _req: http.IncomingMessage,
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
// Issue 1391: agents may read the trail now, so the one written before
// every row was redacted moves aside first, before it is read or added
// to (the queue's intake starts below).
let trailSetAside = 0;
try {
  trailSetAside = setAsideOldTrail(getStateDir()).moved;
} catch (e) {
  console.error(
    `the older activity trail could not be set aside: ${String(e)}`,
  );
}
try {
  setAuditFile(path.join(getStateDir(), AUDIT_FILE));
} catch (e) {
  console.error(`[server] the audit file could not be read: ${String(e)}`);
}
if (trailSetAside)
  recordAction(null, {
    verb: "audit",
    detail:
      "the activity trail written before every row was redacted is set aside, where agents can't read it",
  });
// 0.4.44: workspaces.yml writes and Hub link changes made in this process
// go through the server's own audit (activity, the log, audit.jsonl).
setConfigAuditSink((row) => void recordAction(null, row));
/** Issue 1369: one principal's sent audit entries an hour. */
const CLI_AUDIT_BUDGET = sentAuditBudget();
// Issue 1369: the CLI's audit entries, queued outside this process, come
// in now and while it runs: audit.jsonl has one writer.
startAuditQueueIntake(getStateDir(), (row) => void recordQueuedAuditRow(row), {
  seen: wasSentAuditCopy,
  onDropped: (c) =>
    void recordAction(null, {
      verb: QUEUE_DROPPED_VERB,
      detail: droppedDetail(c),
    }),
});

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

/**
 * Issue 402, clause 6: the projects (active or not) whose repos include an
 * item's repo, from their services and managed clones: an old id-only pin
 * takes the one project, else none.
 */
function pinProjects(): PinProjects {
  let all: Record<string, { services?: object; repos?: object }> = {};
  try {
    all = readWorkspacesFile().workspaces ?? {};
  } catch {
    /* no projects readable: old pins become none */
  }
  return pinProjectsOf(all);
}

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
  // MODE-5: the address row fixes what the config holds.
  "/api/web-url",
  "/api/web-url/probe",
  "/api/web-url/adopt",
  "/api/themes",
  "/api/scope",
  "/api/workspaces/settings",
  "/api/sudo-password/status",
  // The env picker on every page (falls back to local; a consumer's dev.40 finding).
  "/api/environments",
  // Issue 395: the edge row on Settings reads its state. It reads only the
  // edge's own config and docker, never org data (starting it stays gated).
  "/api/edge",
  // Issue 455: the identity probe, and the address check (the banner and
  // Edge): web.secret, web.url and the edge's own config only.
  "/api/den-identity",
  "/api/edge/address",
  "/api/edge/address/check",
  "/api/edge/address/take-over",
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
  sweepStaleSudoDirs,
  closeLockForThisRequest,
  inRequestLockScope,
  getSudoEnv,
  prewarmSudo,
  hasSudoPassword,
  hasPasswordlessSudo,
  watchSudo,
} from "./sudo-store.js";
// Issue 121: sudo shim folders an earlier run left behind (a crash): gone.
sweepStaleSudoDirs();
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
  readBodyCapped,
  readMethodOnly,
  sendJson,
  sendMethodNotAllowed,
  SERVED_METHODS,
  serveFile,
  serveUntrustedFile,
  UNTRUSTED_FILE_HEADERS,
  send400,
  send404,
  setHtmlFill,
  setAssetVersion,
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
  githubOrgFor,
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
import { setFixtureTestInstall } from "./fixture-projects.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
  isApprovalPath,
  notePolicyRun,
  type HeldActions,
  type HeldCheck,
} from "./approval-routes.js";
import { heldLapsed, heldLost, syncHeldBell } from "./held-bell.js";
import { bellGateOverruns } from "./gate-overrun-bell.js";
import {
  ISSUE_WRITE_PATH,
  handleIssueWriteRoute,
  type IssueWriteDeps,
} from "./issue-write-routes.js";
import {
  IssueWriteLimit,
  issueWriteSettings,
} from "../../shared/issue-write.js";
import { defaultInstallLabel } from "./hub-connect.js";
import {
  listRecords as listAgentRecords,
  readRecord as readAgentRecord,
} from "../../shared/agents/records.js";
import {
  askSandboxOn,
  legacyAgentIds,
  sandboxOnHeldOp,
} from "../../shared/agents/sandbox-rollout.js";
import {
  checkAgentSandboxSet,
  runAgentSandboxSet,
  writeSandboxNote,
  type SandboxSetDeps,
} from "../../shared/agents/sandbox-set.js";
import {
  checkSettingChange,
  runSettingChange,
  settingChangeDeps,
  settingKind,
  personSetCaps,
  undoSettingChange,
} from "../cli/setting-change.js";
import {
  checkGateSettingsSet,
  runGateSettingsSet,
  type GateSettingsSetDeps,
} from "../../shared/gates/settings-set.js";
import {
  approvalsView,
  patchApprovals,
  pinsAsWatched,
  policyFor,
  readPolicySetting,
  writeTargets,
} from "../../shared/approval-policy.js";
import { alertSettings, patchAlerts } from "./alerts.js";
import {
  SERVER_AGENT_ID,
  serverAgentName,
} from "../../shared/agents/server-agent.js";
import { heldActions } from "./held-actions.js";
import {
  agentNameOf,
  checkHubCreateHeld,
  defaultHubCreateDeps,
  hubCreateLook,
  runHubCreateHeld,
} from "./hub-create-routes.js";
import {
  checkHubLinkHeld,
  defaultHubLinkHeldDeps,
  runHubLinkHeld,
} from "./hub-link-held.js";
import { checkHubAddress, runHubAddress } from "./hub-address.js";
import {
  checkVerifyRun,
  handleVerifyRoutes,
  runVerify,
  type VerifyServerDeps,
} from "./verify-routes.js";
import {
  handleScheduleRoutes,
  isSchedulePath,
  type ScheduleServerDeps,
} from "./verify-schedule-routes.js";
import { lookupTimeouts } from "../cli/proc-lookup.js";
import { sessionRootPids } from "../../shared/person-here.js";
import {
  serverLogMaxBytes,
  serverLogWriter,
} from "../../shared/server-log-file.js";
import { denProcessPids, registerDenProcess } from "../../shared/den-procs.js";

/** Sign-in: Den's own processes, this server always among them. */
function denPidsNow(): number[] | null {
  const recorded = denProcessPids(getStateDir());
  return recorded ? [process.pid, ...recorded] : null;
}
import { hookCallSettings } from "../../shared/agents/guardrails/hook-call.js";
import {
  agentPeerWait,
  callerLine,
  callerPid,
  forwardedRequest,
  callerMiss,
  peerSettled,
  personCallerRefusal,
  refusalDetail,
  tokenCaller,
  watchPeer,
} from "./token-binding.js";
import {
  backMessage,
  recordPageRestart,
  restartMarkerPath,
  selfUpdateAutoAllow,
  selfUpdateAsks,
  takeRestartMarker,
  tellBack,
  writeRestartMarker,
} from "./server-restart.js";
import type { Approval, ApprovalQueue } from "./approvals.js";
import { processPathRules } from "../cli/onboard-reads.js";
import { handleHubProxy } from "./hub-proxy-routes.js";
import {
  noteHubMcpCall,
  noteHubMcpInit,
  noteHubMcpTools,
} from "../../shared/agents/hub-mcp-connect.js";
import {
  handleAgentRoutes,
  refreshTerminalHost,
  startAgentUpkeep,
  terminalHostRefreshing,
  startLogoutWatch,
  webDeps as agentWebDeps,
} from "./agent-routes.js";
import { hostRestartOp } from "./host-restart-held.js";
import {
  agentInputState,
  checkAgentCreate,
  checkAgentFolder,
  agentRecord,
  checkAgentMode,
  checkPersonaCreate,
  checkPersonaUpdate,
  checkProjectMode,
  checkProjectMcpAdd,
  runProjectMcpAdd,
  checkProjectMcpRemove,
  runProjectMcpRemove,
  checkProjectMcpUpdate,
  runProjectMcpUpdate,
  createAgent,
  runAgentFolder,
  restartAgent,
  runAgentMode,
  runPersonaCreate,
  runPersonaUpdate,
  runProjectMode,
  importSandboxOff,
  runAgentImport,
  personaLookup,
  hubUpstream,
  policyResolver,
  restartResolver,
  modeResolver,
  staleAgents,
  busyAgentHolds,
  runningAgentIds,
} from "../cli/agent-ops.js";
import { handleServerAgentRoutes } from "./server-agent-routes.js";
import { freshDen } from "../cli/server-agent-ops.js";
import { loggedPath } from "./logged-path.js";
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
import {
  hasEdgeBlock,
  readEdgeConfig,
  readWebPort,
} from "../../shared/edge/config.js";
import {
  readAccessLogConfig,
  requestIdOf as traceRequestId,
} from "../../shared/edge/access-log.js";
import { sweepAccessLog } from "../../shared/edge/access-sweep.js";

/** #63: how often the edge's raw access log is masked and emptied. */
const EDGE_ACCESS_SWEEP_MS = 1000;
import {
  edgeDomains,
  edgeHttps,
  edgeNames,
  webRouteFindings,
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
import {
  fdIsFile,
  stdoutLine,
  webLogPath,
  webLogWriter,
} from "../../shared/web-log-file.js";
import { readBrand } from "../../shared/brand.js";
import { launchdSession } from "../../shared/launchd-session.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
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

/** One git answer, async: slow git never holds up the server (issue 132). */
function readGitField(gitArgs: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      gitArgs,
      { cwd, encoding: "utf-8", timeout: GIT_REMOTE_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

/** The pillars whose sources are a repo manifest's own sections. */
type SourcePillar = Extract<
  Pillar,
  "synthetic" | "smoke" | "journeys" | "security"
>;

/** The repos whose manifests feed `pillar`'s tests (no git). */
function testSourceRepos(
  pillar: SourcePillar,
): ReturnType<typeof discoverRepos> {
  return discoverRepos().filter((repo) => {
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
    return matches;
  });
}

/** Those repos with their branch and short SHA, read in parallel. */
async function collectTestSources(pillar: SourcePillar): Promise<TestSource[]> {
  const workspace = getActiveWorkspace()?.name ?? null;
  return Promise.all(
    testSourceRepos(pillar).map(async (repo) => {
      const [branch, shortSha] = await Promise.all([
        readGitField(["rev-parse", "--abbrev-ref", "HEAD"], repo.repoPath),
        readGitField(["rev-parse", "--short", "HEAD"], repo.repoPath),
      ]);
      return {
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        branch,
        shortSha,
        workspace,
      };
    }),
  );
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
 *
 * Once Den's own named https address works, the sign-in lives there, so
 * loopback /attest sends the browser there (sendToNamedAddress). On the
 * address, a signed-in browser the edge places on this machine gets its
 * code at once; one it can't place goes to localhost once with a hop (a
 * code minted for ATTEST_HOP, 2 minutes, used once), which proves the
 * browser is here. A browser not signed in gets the sign-in page there:
 * never a redirect back, so no loop.
 */
const ATTEST_HOP = "den-attest-hop";
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
  const named = NAMED.address();
  const onNamed =
    guard.ok &&
    guard.via === "edge" &&
    !!named &&
    new URL(named).hostname === hostNameOf(req);
  if (onNamed) {
    if (!guard.session && guard.principal?.kind !== "person")
      return sendSignedOut(req, res, {
        pathname: "/attest",
        search: url.search,
        scope: "den",
        requestId,
        message: signinMessage("den", product().cli, product().title),
      });
    const raw = url.searchParams.get("return");
    const ret = attestReturn(raw, denEdgeHosts());
    const secret = webSecret.current();
    if (!ret || !raw || !secret)
      return refuse(
        400,
        "That address isn't one of this Den's own. Open this Den at its own address and try again.",
      );
    // The edge places the browser on this machine: the code at once.
    if (!guard.beyond) {
      res.writeHead(303, {
        Location: attestRedirect(ret, mintAttestCode(secret, ret.host)),
      });
      res.end();
      return;
    }
    // It can't: through localhost once, which only this machine reaches.
    const hop = new URLSearchParams({
      return: raw,
      hop: mintAttestCode(secret, ATTEST_HOP),
    });
    res.writeHead(303, {
      Location: `${localhostOrigin(PORT)}/attest?${hop.toString()}`,
    });
    res.end();
    return;
  }
  if (!guard.ok || guard.via !== "loopback" || guard.beyond)
    return refuse(
      403,
      "This works only on the computer this Den runs on, at localhost.",
    );
  // The hop from the named address: it proves a browser signed in there
  // asked, and this request proves the browser is here. Once, in its time.
  const hop = url.searchParams.get("hop");
  if (hop !== null) {
    const secret = webSecret.current();
    const c = secret ? checkAttestCode(hop, secret, ATTEST_HOP) : null;
    if (!c?.ok || !ATTEST_NONCES.consume(c.nonce, c.expiresAt))
      return refuse(
        403,
        `That link was used or has expired. Open ${product().title} at its own address and press This is my computer again.`,
      );
    const ret = attestReturn(url.searchParams.get("return"), denEdgeHosts());
    if (!ret || !secret)
      return refuse(
        400,
        "That address isn't one of this Den's own. Open this Den at its own address and try again.",
      );
    res.writeHead(303, {
      Location: attestRedirect(ret, mintAttestCode(secret, ret.host)),
    });
    res.end();
    return;
  }
  // 0.4.71: and only for a browser signed in there (or the person's CLI):
  // the code it hands out may make its holder the owner.
  if (!guard.session && guard.principal?.kind !== "person")
    return sendSignedOut(req, res, {
      pathname: "/attest",
      search: url.search,
      scope: "den",
      requestId,
      message: signinMessage("den", product().cli, product().title),
    });
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
/**
 * 0.4.48: on Linux, with an edge here, Den also listens on the Docker
 * bridge's gateway (bridge-listen.ts). Its connections go to the same
 * server, so every request check applies as on loopback: a peer on the
 * bridge is beyond loopback, and X-Forwarded-For counts only with the
 * edge's proof (H1). Never delays the start; never stops it.
 */
async function startBridgeListener(): Promise<void> {
  const record = (o: BridgeOutcome) => {
    try {
      writeBridgeState(getStateDir(), o);
    } catch {
      /* doctor says nothing then */
    }
    serverLog(
      `  ${o.state === "listening" ? "" : "⚠ "}${bridgeLine(o, product().title)}`,
      o.state === "listening" ? "lifecycle" : "warn",
    );
  };
  const wanted = bridgeWanted({
    platform: process.platform,
    setting: WEB_AUTH.bridgeListen,
    bindHost: process.env.DEN_BIND_HOST,
    edgeHere: denEdgeHosts().length > 0,
  });
  if (wanted) {
    if (!wanted.quiet) record({ state: "skipped", why: wanted.why });
    else fs.rmSync(bridgeStateFile(getStateDir()), { force: true });
    return;
  }
  const g = await bridgeGateway(undefined, WEB_AUTH.bridgeProbeSeconds * 1000);
  if ("why" in g) return record({ state: "skipped", why: g.why });
  const srv = net.createServer((sock) => server.emit("connection", sock));
  srv.once("error", (e: NodeJS.ErrnoException) =>
    record({
      state: "skipped",
      why: `it couldn't listen on ${g.address}:${PORT} (${e.code ?? e.message})`,
    }),
  );
  srv.listen(PORT, g.address, () => {
    let plainHttp = true;
    try {
      plainHttp = readEdgeConfig().tls.strategy === "none";
    } catch {
      /* no edge config: said as plain */
    }
    record({ state: "listening", address: g.address, plainHttp });
  });
}

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
  // Issue 1299: a failed read of the sessions file, in the server log.
  // Issue 1299 review: a write never blocks the server waiting for the
  // lock; a request that may write sessions waits first, on timers
  // (sessionsLockWait in handleRequest), and others are served meanwhile.
  lockWaitMs: () => 0,
  onProblem: (msg, kind) => {
    serverLog(`  ⚠ ${msg}`, "warn");
    // A damaged file moved aside signs every browser out: the activity
    // trail says so, so a person knows why.
    if (kind === "moved-aside")
      recordAction(null, {
        verb: "sessions-reset",
        detail: `${msg}; every browser signs in again`,
      });
  },
});
/** Issue 819: whether a person has ever signed in here (first-run.ts). */
const FIRST_RUN = new FirstRun({
  stateDir: getStateDir,
  sessionVias: () => webSessions.list().map((s) => s.via ?? "link"),
  ownerLinked: () => readWebOwner(getStateDir()) !== null,
});
/**
 * The request's session cookie value, if any: over https the
 * `__Host-den_session_<port>` one (or the plain one a browser signed in
 * there before kept), over http the plain `den_session_<port>`.
 */
function sessionCookie(
  req: http.IncomingMessage,
  secure: boolean,
): string | undefined {
  return readSessionCookie(req.headers.cookie, PORT, secure);
}

/** web.url, re-read at most every 5 s (the request checks ask often). */
let WEB_URL_NOW = { at: 0, url: null as string | null };

/**
 * Issue 869: tell the connected Hub this install's address after it
 * changes (hub-den-url.ts). Never waited on; the save never fails for it.
 */
function tellHubAddress(url: string): void {
  void tellHubDenUrl(url, {
    hub: async () => (await import("./hub-sync-service.js")).hubAndToken(),
    put: async (h, t, u) =>
      (await import("../../shared/hub.js")).hubPutDenUrl(h, t, u),
    stateDir: getStateDir(),
  }).catch(() => undefined);
}

/**
 * This install's address, saved the one way every path saves it
 * (Settings, `web url`, an alias made the address, web_url_set):
 * confirmed, audited, read again at once, and told to Hub.
 */
function saveWebUrl(url: string, how?: WebUrlChange): string {
  const saved = setWebUrl(url, undefined, undefined, how);
  WEB_URL_NOW = { at: 0, url: null }; // re-read at once
  tellHubAddress(saved);
  return saved;
}
function webUrlNow(): string | null {
  if (Date.now() - WEB_URL_NOW.at > 5_000)
    WEB_URL_NOW = { at: Date.now(), url: readWebUrl()?.url ?? null };
  return WEB_URL_NOW.url;
}
/**
 * Whether Den's own named https address works (named-address.ts): then
 * the session lives only there. Browsers share a host's cookies across
 * its ports, so a loopback name gets no session, and its sign-in goes
 * there. Before the first check, the config's word: the address is an
 * https edge route to this server.
 */
/** How both address watches check web.url (NAMED, LOCAL_NAMED). */
const ADDRESS_WATCH = {
  webUrl: webUrlNow,
  probe: async (url: string): Promise<NamedAnswer> => {
    const s = webSecret.current();
    const st = await checkAddress({
      webPort: PORT,
      wanted: url,
      key: s ? identityKey(s) : null,
      cli: product().cli,
      settings: addressCheckSettings(),
    });
    return st.wantedAnswer;
  },
  cacheMs: () => addressCheckSettings().cacheMs,
  dropAfter: () => addressCheckSettings().dropAfter ?? 2,
  unknownKeepMs: () => addressCheckSettings().unknownKeepMs ?? 300_000,
};
const NAMED = new NamedAddressWatch({
  ...ADDRESS_WATCH,
  // Proven: sessions count only when minted on the address; every other
  // session ends now, its terminals with it.
  onProven: () => {
    try {
      const ended = webSessions.endWhere((x) => x.secure !== true);
      closeSessionSockets(ended);
      if (ended.length)
        serverLog(
          `  ${product().title}'s address is proven: sign-in lives there now; ${ended.length} other sign-in(s) ended`,
          "lifecycle",
        );
    } catch (e) {
      serverLog(
        `  ⚠ sign-ins not made on ${product().title}'s address could not be ended: ${(e as Error).message}`,
        "warn",
      );
    }
  },
  // For doctor: whether it is proven, and when it last answered as this Den.
  onChange: (st) => {
    try {
      writeFileAtomic(
        path.join(getStateDir(), ADDRESS_PROOF_FILE),
        JSON.stringify({
          proven: st.proven,
          lastAnswered: st.lastAnswered
            ? new Date(st.lastAnswered).toISOString()
            : null,
        }),
        { mode: 0o600 },
      );
    } catch {
      /* doctor says nothing then */
    }
  },
});

/**
 * Issue 601: an https web.url on a loopback name (kept from before issue
 * 666, with no alias to take its place) is never Den's named address
 * (NAMED): every other device is never sent to it, and no session ends
 * for it. Once it is proven, only a browser on this machine that opens
 * the loopback sign-in page is sent there (sendToNamedAddress), as before
 * issue 666: there it means this Den.
 */
const LOCAL_NAMED = new NamedAddressWatch({
  ...ADDRESS_WATCH,
  pick: localHttpsAddress,
});

const LAN_HOSTS = lanHosts();
/** H1: the edge's state folder (its proof's), re-read at most every 10 s. */
let EDGE_DIR = { at: 0, dir: null as string | null };
/** Doctor's view of the address's proof (named-address.ts), in the state dir. */
const ADDRESS_PROOF_FILE = "address-proof.json";

/**
 * Whether the request reached Den on its proven https address: through the
 * edge with its proof, on the address's own name.
 */
function onTheAddress(req: http.IncomingMessage, there: string): boolean {
  return (
    httpsOf(req, "edge") &&
    hostNameOf(req).replace(/\.$/, "") === new URL(there).hostname
  );
}

/**
 * Issue 666: this install's own aliases that may be its address (its edge
 * routes to this server, never a loopback name, https first).
 */
function addressAliases(): string[] {
  return aliasCandidates(denEdgeRoutes().map((r) => r.url));
}

/**
 * The alias the request came in on: through the edge with its proof, over
 * https, on one of addressAliases. Null otherwise (a spoofed Host from a
 * peer that isn't the edge never counts).
 */
function aliasHere(req: http.IncomingMessage): string | null {
  if (!httpsOf(req, "edge")) return null;
  const h = hostNameOf(req).replace(/\.$/, "");
  return addressAliases().find((a) => new URL(a).hostname === h) ?? null;
}

/** The signed-out page's issue 666 offer, when the request is on an alias. */
function adoptOffer(req: http.IncomingMessage): {
  offer?: { alias: string; current: string | null; loopback: boolean };
} {
  const here = aliasHere(req);
  if (!here) return {};
  const w = readWebUrl();
  const alias = offeredAlias(w, here, [], NAMED.works());
  return alias
    ? {
        offer: {
          alias,
          current: w?.url ?? null,
          loopback: isLoopbackUrl(w?.url),
        },
      }
    : {};
}

/**
 * Issue 869: whether an address's host is this machine or one Den already
 * serves: the current address's host, an edge name (its domains and
 * aliases, and names under them), or a name that resolves to one of this
 * machine's own addresses (its interfaces, the mesh's among them, or
 * loopback). A host that is none of these gets web_url_set's warning.
 */
async function addressHostKnown(host: string): Promise<boolean> {
  const h = host.toLowerCase().replace(/\.$/, "");
  try {
    const now = readWebUrl();
    if (now && new URL(now.url).hostname.toLowerCase() === h) return true;
  } catch {
    /* no current address */
  }
  try {
    const domains = hasEdgeBlock() ? edgeDomains(readEdgeConfig()) : [];
    if (domains.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  } catch {
    /* no edge */
  }
  const mine = new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .flatMap((i) => (i ? [i.address.toLowerCase()] : [])),
  );
  try {
    const found = await dnsLookup(h, { all: true });
    return (
      found.length > 0 &&
      found.every(
        (a) =>
          mine.has(a.address.toLowerCase()) ||
          a.address === "::1" ||
          a.address.startsWith("127."),
      )
    );
  } catch {
    return false;
  }
}

/** Whether the request is the owner's (web-url-routes adoptAllowed). */
function adoptOwner(
  req: http.IncomingMessage,
): { ok: true; who: string } | { ok: false; why: string } {
  const g = checkRequest(req, GUARD, product().cli, product().title);
  if (!g.ok) return { ok: false, why: g.error };
  const p = g.principal;
  const browser = p?.kind === "person-browser" && g.session ? g.session : null;
  const rec = browser
    ? webSessions.list().find((s) => s.key === browser.key)
    : undefined;
  const a = adoptAllowed({
    agent: p?.kind === "agent" || !!auditActorOf(req),
    personToken: p?.kind === "person",
    beyond: g.beyond,
    session: browser
      ? {
          ...(rec?.via ? { via: rec.via } : {}),
          ...(rec?.login ? { login: rec.login } : {}),
        }
      : null,
    ownerLogin: ownerIdentity()?.login ?? null,
  });
  return a.ok
    ? { ok: true, who: `${principalOf(req) ?? "person"} (${a.how})` }
    : a;
}

/** HTTPS: the edge's X-Forwarded-Proto counts only with its proof (H1). */
function httpsOf(req: http.IncomingMessage, via: Via | null): boolean {
  return requestIsHttps(req, via, EDGE_PROVED(req));
}
const EDGE_PROVED = edgeProofChecker(() => {
  if (Date.now() - EDGE_DIR.at > 10_000) {
    let dir: string | null = null;
    try {
      dir = readEdgeConfig().stateDir;
    } catch {
      /* no edge config: nothing proves */
    }
    EDGE_DIR = { at: Date.now(), dir };
  }
  return EDGE_DIR.dir;
});
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
/**
 * #70: agents.token_binding (default on), read at most every 5 s. A bad
 * agents block: on (doctor names the key).
 */
let BINDING = { at: 0, on: true, waitMs: TOKEN_PEER_WAIT_MS_DEFAULT };
function readBinding(): typeof BINDING {
  if (Date.now() - BINDING.at < 5_000) return BINDING;
  let on = true;
  let waitMs = TOKEN_PEER_WAIT_MS_DEFAULT;
  try {
    const a = readAgentsConfig();
    on = a.tokenBinding !== false;
    waitMs = a.tokenPeerWaitMs ?? TOKEN_PEER_WAIT_MS_DEFAULT;
  } catch {
    on = true;
  }
  BINDING = { at: Date.now(), on, waitMs };
  return BINDING;
}
function tokenBindingOn(): boolean {
  return readBinding().on;
}
/**
 * Issue 242: an agent's call (its token, on loopback) waits, at most
 * agents.token_peer_wait_ms (the ms returned), for the lookup its
 * connection started, so a busy Den doesn't refuse it as from an unknown
 * process. Anything else: null, and it goes on at once, as before.
 */
function agentPeerWaitMs(req: http.IncomingMessage): number | null {
  return agentPeerWait(req, readBinding());
}
const GUARD: GuardContext = {
  port: PORT,
  loopbackNames: loopbackNames(),
  edgeHosts: denEdgeHosts,
  lanHosts: () => LAN_HOSTS,
  verifyBearer: (token, req) => {
    // SEC-1c: an agent's actor token, live while its session runs.
    if (token.startsWith(ACTOR_TOKEN_PREFIX)) {
      const rec = checkActorToken(getStateDir(), token);
      if (rec === "revoked") return "revoked";
      // #70: and only from its own session's processes.
      if (rec && tokenBindingOn()) {
        const root = rec.session.id
          ? sessionPid(getStateDir(), rec.session.id)
          : null;
        const from = tokenCaller(req, root);
        if (from !== "ok") {
          // Issue 609: why it wasn't placed. A caller that had already
          // closed its connection is refused all the same, but nothing is
          // there to answer: audited as gone, not as a refused agent.
          const why = from === "unknown" ? callerMiss(req) : null;
          const gone = why === "gone";
          recordAction(
            null,
            {
              verb: "agent-token",
              detail: refusalDetail({
                actor: rec.actor,
                from,
                caller: callerPid(req),
                root,
                method: req.method ?? "GET",
                path: new URL(req.url ?? "/", "http://x").pathname,
                why,
              }),
              ...(gone ? {} : { outcome: "refused" as const }),
              reason: gone ? "token_caller_gone" : `token_${from}`,
            },
            rec.actor,
          );
          return "elsewhere";
        }
      }
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
  // Issue 621: a gate-only runner token (it reaches RUNNER_ROUTES only).
  verifyRunner: (token) => {
    const c = RunnerTokens.at(getStateDir()).check(token);
    return c.ok
      ? { id: c.runner.id, name: c.runner.name }
      : c.code === "token_revoked"
        ? "revoked"
        : null;
  },
  session: (req, via) => {
    const s = webSessions.lookup(sessionCookie(req, httpsOf(req, via)));
    // Issue 810: a fixture session ends as soon as what allowed it goes.
    if (s?.via === "fixture" && !fixtureSessionStands(s)) {
      // Best effort: with the lock busy it ends at a later request.
      try {
        webSessions.end(s.key);
      } catch {
        /* still refused below */
      }
      return null;
    }
    // Issue 796: an agent's view ends at its time, when the install turns
    // views off, or when the agent's token goes; it counts on loopback only.
    if (s?.via === "agent-view") {
      if (!agentViewStands(s)) {
        try {
          webSessions.end(s.key);
        } catch {
          /* still refused below; it ends at a later request */
        }
        closeSessionSockets([s.key]);
        return null;
      }
      if (via !== "loopback") return null;
    }
    return s ? { ...s, secure: s.secure === true } : null;
  },
  // Once Den's own named https address works, the session lives there.
  loopbackSessions: () => !NAMED.works(),
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
  // H1: the edge's forwarded client is believed only with its proof.
  edgeProved: (req) => EDGE_PROVED(req),
  // Issue 636: the test-person path, on a test bed (issue 810's binding).
  testBed: () => testInstallNow(),
};

// ── SEC-2a: Sign in with GitHub, the owner, pairing ──────────────────────────
/** FB (den#81): a "report" flow files its held report; the rest sign in. */
function reportOrSignin(signin: Decide): Decide {
  return (purpose, identity, ctx) =>
    purpose === "report" ? decideReport(ctx) : signin(purpose, identity, ctx);
}
const GITHUB_CLIENT_ID = githubClientId(WEB_AUTH.githubClientId);
const GITHUB = githubEndpoints();
/** Issue 403: Hub, for a report's screenshot (every Hub call is in there). */
const REPORT_SHOT_HUB = reportShotHub({
  hub: async () => (await import("./hub-sync-service.js")).hubAndToken(),
  // Settings (reports.*), read at each call.
  maxBytes: () => shotLimits(readUserConfig()).hubBytes,
  timeoutMs: () => shotLimits(readUserConfig()).hubTimeoutMs,
});
const DEVICE_FLOWS = new DeviceFlows({
  client: githubDeviceClient(GITHUB),
  clientId: () => GITHUB_CLIENT_ID,
  decide: reportOrSignin(
    decideFlow(
      getStateDir,
      (l) => serverLog(l, "lifecycle"),
      () => claimRulesNow(),
    ),
  ),
  // A test's fake GitHub may answer interval 0; the real one never does.
  minIntervalMs: GITHUB.fake ? 50 : 1000,
  onExpiringToken: noteExpiringToken,
  // Issue 362: one address's new sign-ins a minute, as its pairing requests.
  perClient: () => webAuthNow().pairRequestsPerMinute,
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
/** Issue 819: the new-device limits are Settings, read when used. */
const PAIRS = new PairRequests({
  // Issue 1333: each request's start and end, in the activity trail.
  onEvent: (e) =>
    void recordAction(null, {
      verb: SIGNIN_REQUEST_VERB,
      detail: pairEventDetail(e),
    }),
  unseenMs: pairUnseenMs(),
  perClient: () => webAuthNow().pairRequestsPerMinute,
  maxAttempts: () => webAuthNow().approveAttempts,
  windowMs: () => webAuthNow().approveWindowSeconds * 1000,
});

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

/** issue_write's limit: the install's writes in the last hour, every agent's. */
const issueWriteLimit = new IssueWriteLimit();

/**
 * issue_write's wiring: the agent's record and persona role, the
 * project's GitHub repos (the catalog's gh, else the project's org), the
 * settings from user.yml, pr_close's gh call path (runGh), and the audit.
 */
function issueWriteDeps(req: http.IncomingMessage): IssueWriteDeps {
  return {
    agentOf: (id) => {
      const rec = readAgentRecord(getStateDir(), id);
      if (!rec) return null;
      let role: string | undefined;
      try {
        role = personaLookup(agentWebDeps())(rec)?.role;
      } catch {
        role = undefined;
      }
      return {
        name: rec.displayName || rec.persona || id,
        ...(role ? { role } : {}),
      };
    },
    projectExists: (p) =>
      Object.hasOwn(readWorkspacesFile().workspaces ?? {}, p),
    projectRepos: (p) => {
      const ws = (readWorkspacesFile().workspaces ?? {})[p];
      if (!ws) return [];
      const names = new Set<string>([
        ...Object.keys(ws.services ?? {}).map((a) => a.split("/")[0]),
        ...Object.keys(ws.repos ?? {}),
      ]);
      const catalog = readCatalog();
      const out: string[] = [];
      for (const n of names)
        try {
          out.push(resolveRepoGhSlug(n, catalog, () => githubOrgFor(p)));
        } catch {
          /* a repo with no GitHub owner: not one issue_write reaches */
        }
      return out.sort();
    },
    settings: () =>
      issueWriteSettings(
        () => readUserConfig(),
        () => readDenConfig(),
      ),
    limit: issueWriteLimit,
    gh: runGh,
    installLabel: () => defaultInstallLabel(),
    audit: (e) => {
      try {
        recordAction(
          auditActorOf(req),
          {
            verb: "issue_write",
            detail: `${e.project ? `project ${e.project}: ` : ""}${e.summary}`,
            ...(e.refused ? { outcome: "refused" as const } : {}),
            ...(e.reason ? { reason: e.reason } : {}),
          },
          principalOf(req),
        );
      } catch {
        /* the audit is best-effort; the write's answer still goes back */
      }
    },
  };
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

/** Issue 1299: web.sessions_lock_wait_ms (its default when unreadable). */
function sessionsLockWait(): number {
  try {
    return webAuthNow().sessionsLockWaitMs;
  } catch {
    return SESSIONS_LOCK_WAIT_MS;
  }
}

/**
 * A new session for this request: its Set-Cookie line, and its approval
 * key (web-session.ts), which only this sign-in's own answer may carry.
 */
function startSession(
  req: http.IncomingMessage,
  via: SessionVia,
  login?: string,
  name?: string,
  fixtureKey?: string,
  view?: { agent: string; workspace: string },
): { cookie: string; approveKey: string } {
  const g = checkRequest(req, GUARD, product().cli, product().title);
  const named = g.ok ? g.via : null;
  // Minted over the edge's proven https: the only kind that counts once
  // the address is proven.
  const secure = httpsOf(req, named);
  // Issue 819: a person's sign-in ends first run, for good.
  if (via !== "fixture" && via !== "agent-view") FIRST_RUN.mark();
  const { id, approveKey } = webSessions.create({
    userAgent: req.headers["user-agent"],
    host: req.headers.host,
    ...(named ? { reach: named } : {}),
    secure,
    via,
    ...(fixtureKey ? { fixtureKey } : {}),
    ...(view ? { agent: view.agent, agentWorkspace: view.workspace } : {}),
    ...(g.ok && g.client ? { client: g.client } : {}),
    ...(login ? { login } : {}),
    ...(login && name ? { name } : {}),
  });
  return {
    cookie: sessionSetCookie(id, secure),
    approveKey,
  };
}

/**
 * The install owner's GitHub identity, for the account entry of a local
 * browser on the Den machine only (never a browser signed in with a link
 * or a code: it may be someone else's): the linked owner (web-owner.json),
 * else web.owner_github (recorded from gh at `web up`), with the display
 * name kept beside each. Files only: no gh call here. Null: none known.
 */
function ownerIdentity(): {
  login: string;
  name?: string;
  role: "owner";
} | null {
  const linked = readWebOwner(getStateDir());
  if (linked)
    return {
      login: linked.login,
      ...(linked.name ? { name: linked.name } : {}),
      role: "owner",
    };
  const w = webAuthNow();
  if (!w.ownerGithub) return null;
  return {
    login: w.ownerGithub,
    ...(w.ownerGithubName ? { name: w.ownerGithubName } : {}),
    role: "owner",
  };
}

/**
 * Issue 406: a GitHub sign-in's display name: the session's own, else (a
 * session from before names were kept) the linked owner's, when it is the
 * owner's login (only the owner signs in with GitHub). Undefined: none.
 */
function githubSessionName(rec: {
  login?: string;
  name?: string;
}): string | undefined {
  if (rec.name) return rec.name;
  const owner = readWebOwner(getStateDir());
  return owner?.name &&
    rec.login &&
    owner.login.toLowerCase() === rec.login.toLowerCase()
    ? owner.name
    : undefined;
}

/** A local browser's identity (GET /api/session): local, with the owner's when known. */
function localIdentity(): { kind: "local"; owner?: object } {
  const owner = ownerIdentity();
  return { kind: "local", ...(owner ? { owner } : {}) };
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
 * The Set-Cookie for a session (session-cookie.ts): over HTTPS
 * (requestIsHttps: the edge's own header only from the edge) the
 * `__Host-` cookie, host-only and Secure; else the plain host-only one.
 * HttpOnly, SameSite=Lax, Path=/; a GET that runs something refuses a
 * cross-site Sec-Fetch-Site besides (request-guard.ts).
 */
function sessionSetCookie(id: string, secure: boolean): string {
  return sessionCookieLine(PORT, id, secure);
}

/**
 * Sign-in's routes on a loopback name, once Den's own named https address
 * works (NAMED): the session lives only there. A page (GET /auth, /signin)
 * gets a plain 303 to the same path and query there (a one-time code is
 * spent there, not here); a sign-in API call is refused with the address.
 * True when it answered.
 */
const SIGNIN_PAGES = new Set(["/auth", "/signin"]);
const SIGNIN_APIS = /^\/api\/(?:github\/signin|signin\/code)(?:\/|$)/;
function sendToNamedAddress(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  guard: GuardResult,
): boolean {
  // Once proven, sign-in on every other host goes to the address.
  if (!guard.ok) return false;
  // Issue 796: an agent's view link opens on loopback only.
  if (isAgentViewLink(url)) return false;
  const method = (req.method ?? "GET").toUpperCase();
  const get = method === "GET" || method === "HEAD";
  // /auth on every method it answers (a code's POST too: it mints a
  // session); /signin; /attest unless it carries the address's hop
  // (handleAttest), which it answers itself.
  const page =
    (url.pathname === "/auth" && (get || method === "POST")) ||
    (SIGNIN_PAGES.has(url.pathname) && get) ||
    (url.pathname === "/attest" && get && !url.searchParams.has("hop"));
  if (!page && !SIGNIN_APIS.test(url.pathname)) return false;
  // Issue 601: an address only this machine opens (LOCAL_NAMED), for a
  // browser on this machine opening a sign-in page (/signin, /auth) only.
  // Issue 666: never for another device; its sign-in APIs and /attest stay
  // where they are, and so does every session.
  const there =
    NAMED.address() ??
    (SIGNIN_PAGES.has(url.pathname) &&
    get &&
    guard.via === "loopback" &&
    !guard.beyond
      ? LOCAL_NAMED.address()
      : null);
  if (!there || onTheAddress(req, there)) return false;
  if (page) {
    res.writeHead(303, {
      Location: `${there}${url.pathname}${url.search}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end();
    return true;
  }
  sendJson(
    res,
    {
      ok: false,
      code: "signin_elsewhere",
      error: `Sign in at ${there}: ${product().title} keeps the sign-in on its own address.`,
      address: there,
    },
    403,
  );
  return true;
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
    /**
     * Issue 819: the pairing screen a sign-in link opened: its request's
     * poll id, code and expiry, for this page only.
     */
    pair?: { id: string; code: string; expiresAt: string; expiresIn: number };
    /** Issue 819: the pairing screen's lead line, as a message key. */
    pairLead?: string;
    /**
     * SEC-2a; issue 819: first run, a link `web login` printed opened away
     * from the Den computer: its page asks for the code that terminal shows.
     */
    confirm?: boolean;
    /**
     * Issue 819: nothing to sign in or approve here; this message key says
     * what to do next (first run, away from the Den computer).
     */
    lead?: string;
    requestId: string;
    message: string;
  },
): void {
  const host = String(req.headers.host ?? "").toLowerCase();
  const toLocal = nonCanonicalLoopback(req);
  const via = GUARD.edgeHosts().includes(host.replace(/:\d+$/, ""))
    ? "edge"
    : "other";
  const origin = `${httpsOf(req, via === "edge" ? "edge" : null) ? "https" : "http"}://${host}`;
  const bin = printedCli();
  const loginArgs =
    toLocal || host === `localhost:${PORT}` ? [] : ["--origin", origin];
  // Once the address is proven, sign-in happens there.
  const there = NAMED.address();
  const cmd = there
    ? cliCommand(bin, "web", "login", "--origin", there)
    : cliCommand(bin, "web", "login", ...loginArgs);
  // 0.4.71: a browser on this machine (localhost, from a loopback peer):
  // the page words it for here, and its fallback is `web up`.
  const local =
    host === `localhost:${PORT}` &&
    isLoopbackAddress(req.socket?.remoteAddress);
  const ssh = sshTargetOf(req);
  const user = sshUserNow();
  const gh = githubSignin();
  // Issue 868: from another computer? The request checks' own answer
  // (the edge's attested client), else the peer.
  const g = checkRequest(req, GUARD, product().cli, product().title);
  const remote = g.beyond ?? !isLoopbackAddress(req.socket?.remoteAddress);
  const methods = signinMethods({
    github: gh,
    signedInBrowser: personBrowserSignedIn(),
    remote,
    firstRun: !FIRST_RUN.done(),
    terminal: cmd,
    restart: cliCommand(bin, "web", "restart"),
  });
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
      // Off the address once it is proven: the page names where to sign in.
      ...(there && !onTheAddress(req, there) ? { address: there } : {}),
      // Issue 666: on this install's own alias while the address is
      // unset, loopback or not working: "Make <alias> its address", for
      // the owner to confirm once signed in (POST /api/web-url/adopt).
      ...adoptOffer(req),
      ...(local ? { local: true, up: cliCommand(bin, "web", "up") } : {}),
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
      methods,
      ...(opts.expired ? { expired: true } : {}),
      ...(opts.pair ? { pair: opts.pair } : {}),
      ...(opts.pairLead ? { pairLead: opts.pairLead } : {}),
      ...(opts.confirm ? { confirm: true } : {}),
      ...(opts.lead ? { lead: opts.lead } : {}),
      // Issue 819: the pairing screen's lead in English (the page words it).
      ...(opts.pair ? { message: opts.message } : {}),
      ...(toLocal && !opts.expired && !there && !opts.pair
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
  if (/^\/(api|reports?|requests)(\/|$)/.test(pathname)) return false;
  return PUBLIC_ASSET_EXTS.has(path.extname(pathname).toLowerCase());
}

/** A refused request: R26 JSON for /api, the error page for a page. */
/**
 * A refused write is audited (AG-DROP): an agent's token past its scope
 * (agent_forbidden), a browser's write without its CSRF token, and a
 * refused test-person call (issue 636). The
 * other refusals carry no credential to name, and the request log has them.
 */
function auditGuardRefusal(
  req: http.IncomingMessage,
  pathname: string,
  g: Extract<GuardResult, { ok: false }>,
): void {
  if (
    g.code !== "agent_forbidden" &&
    g.code !== "csrf" &&
    // Issue 636: a refused test-person call (it never ran).
    g.code !== "test_person_refused" &&
    g.code !== "not_test_bed"
  )
    return;
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
  // UK-2: /requests/<id> is the API's too (the working pop-up's Check again).
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/requests/")
  )
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
  res.end(`${refusal.error} (${refusal.code}, request id ${requestId})`);
}

/**
 * Sign-in: a call that registers a sign-in link or lets a browser in, from
 * anything but a signed-in browser (the CLI's bearer), is answered only
 * for a caller on this machine outside every running session's process
 * tree (personCallerRefusal). True when it was refused (and answered).
 */
async function personCallerRefused(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  guard: GuardResult,
  pathname: string,
): Promise<boolean> {
  if (guard.ok && guard.principal?.kind === "person-browser") return false;
  const why = await personCallerWhy(req);
  if (!why) return false;
  recordAction(
    auditActorOf(req),
    {
      verb: "person-grant",
      detail: pathname,
      outcome: "refused" as const,
      reason: "person_only",
    },
    principalOf(req),
  );
  sendJson(res, { ok: false, code: "person_only", error: why }, 403);
  return true;
}

/**
 * Why this caller isn't the person at this machine (personCallerRefusal:
 * on loopback, not forwarded, outside every running session's process
 * tree), or null when it is.
 */
async function personCallerWhy(
  req: http.IncomingMessage,
): Promise<string | null> {
  await peerSettled(req, readBinding().waitMs);
  return personCallerRefusal({
    loopback: isLoopbackAddress(req.socket?.remoteAddress),
    forwarded: forwardedRequest(req, GUARD),
    line: callerLine(req),
    roots: sessionRootPids(getStateDir()),
    den: denPidsNow(),
  });
}

/**
 * Issue 819: whether this browser is the person at the Den computer
 * itself: on loopback, not forwarded, outside every agent's session
 * (personCallerWhy). First run signs such a browser in with a link or the
 * setup link at once.
 */
async function personHere(req: http.IncomingMessage): Promise<boolean> {
  return (await personCallerWhy(req)) === null;
}

/**
 * Issue 819: the pairing screen a sign-in link lands on: a new request
 * (pair-requests.ts), shown with its code on the signed-out page, which
 * polls it by its id until a signed-in browser approves or denies it.
 * `lead`: why it is here, as a message key and its English. The code and
 * the id go to this page only; neither is logged.
 */
function sendPairing(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  lead: { key: string; message: string },
  link?: { nonce: string; startedAt?: number },
  spend?: { spend: () => boolean; gone: () => void },
): void {
  const g = checkRequest(req, GUARD, product().cli, product().title);
  const client = g.ok ? g.client : undefined;
  const r = PAIRS.tryCreate({
    userAgent: req.headers["user-agent"],
    client,
    host: denAddressOf(req),
    ...(link ? { link: link.nonce, linkAt: link.startedAt } : {}),
  });
  if (r.ok && client)
    void meshNameOf(client).then((n) => {
      if (n) PAIRS.setClientName(r.ref, n);
    });
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  if (!r.ok)
    return sendSignedOut(req, res, {
      pathname: "/auth",
      search: "",
      scope: "den",
      requestId,
      lead:
        r.error === "rate_limited"
          ? "err.signin.tooManyRequests"
          : "err.signin.tooManyWaiting",
      message: CREATE_REFUSED[r.error].error,
    });
  // The link is spent only once its request is made: a refusal above
  // leaves it usable. A link spent meanwhile ends that request.
  if (spend && !spend.spend()) {
    PAIRS.withdraw(r.id);
    return spend.gone();
  }
  // Issue 819: the wait never carries the pairing code (it stays on the
  // new device's screen).
  if (link)
    LOGIN_WAITS.pairing(link.nonce, r.expiresAt, {
      device: deviceName(req.headers["user-agent"]),
      ...(client ? { client } : {}),
    });
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  return sendSignedOut(req, res, {
    pathname: "/auth",
    search: "",
    scope: "den",
    requestId,
    message: lead.message,
    pair: {
      id: r.id,
      code: r.code,
      expiresAt: new Date(r.expiresAt).toISOString(),
      expiresIn: Math.max(0, r.expiresAt - Date.now()),
    },
    pairLead: lead.key,
  });
}

/** Issue 819: the pairing screen's lead once this install is set up. */
function pairLinkLead(): { key: string; message: string } {
  return {
    key: "err.signin.pairLinkLead",
    message:
      "To let this browser in, approve it from a browser that is already signed in: open Settings › Access there and approve the code below.",
  };
}

/**
 * Issue 819: first run, a link nothing here can finish (opened away from
 * the Den computer, or by an agent's process there): what to do next. The
 * link is not spent and no request is made.
 */
function sendFirstRunHere(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
): void {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  return sendSignedOut(req, res, {
    pathname: "/auth",
    search: "",
    scope: "den",
    requestId,
    lead: "err.signin.firstRunHere",
    message: `${product().title} isn't set up yet: finish its first sign-in on ${machineName()} itself, with the setup link or \`${product().cli} web login\` run in your own terminal there.`,
  });
}

/**
 * `GET /auth?c=<code>&next=<path>` (§2; issue 819): a valid, unused login
 * code (constant-time mac, single use). A browser already signed in keeps
 * its session (the code is spent). Otherwise:
 *
 *  - first run (first-run.ts), the person at the Den computer
 *    (personHere) is signed in at once. A link `web login` registered,
 *    opened anywhere else, asks for the code that terminal printed (POST
 *    with it signs in). Any other link shows what to do next, unspent;
 *  - from then on the link is spent as it opens the pairing screen, and a
 *    signed-in browser approves that device.
 *
 * Anything else gets the signed-out page, which never echoes the code. A
 * HEAD (a link preview) spends nothing.
 */
async function handleAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  requestId: string,
): Promise<void> {
  if (url.searchParams.has("claim"))
    return handleClaim(req, res, url, requestId);
  if (url.searchParams.has(FIXTURE_LINK_PARAM))
    return handleFixtureAuth(req, res, url, requestId);
  if (url.searchParams.has(AGENT_VIEW_LINK_PARAM))
    return handleAgentViewAuth(req, res, url, requestId);
  const method = (req.method ?? "GET").toUpperCase();
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  if (method === "HEAD") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end();
    return;
  }
  const secret = webSecret.current();
  const c = url.searchParams.get("c") ?? "";
  const nonce = loginCodeNonce(c);
  const pending = nonce ? LOGIN_WAITS.forNonce(nonce) : null;
  // A link whose page asks for its code is checked as of when it opened.
  const check = secret
    ? checkLoginCode(c, secret, pending?.openedAt ?? Date.now())
    : null;
  if (method === "POST")
    return confirmFirstRunLink(req, res, url, check, requestId);
  const gone = () =>
    sendSignedOut(req, res, {
      pathname: "/auth",
      search: "",
      scope: "den",
      expired: true,
      requestId,
      message: `That sign-in link expired or was used. Run \`${product().cli} web login\` for a new one.`,
    });
  if (!check?.ok) return gone();
  const wait = LOGIN_WAITS.forNonce(check.nonce);
  // A wait that ended (used, denied, refused, expired) spends its link.
  if (wait && wait.state !== "waiting" && wait.state !== "opened")
    return gone();
  const meta = (g: GuardResult) => ({
    device: deviceName(req.headers["user-agent"]),
    ...(g.ok && g.client ? { client: g.client } : {}),
  });
  // 0.4.71: `web up` sends an open tab here each time; a browser already
  // signed in keeps its session (the code is spent), so Linked devices
  // doesn't fill with one per run. `web login` is told it was used.
  const already = checkRequest(req, GUARD, product().cli, product().title);
  if (already.ok && already.session) {
    if (!webSessions.consumeCode(check.nonce, check.expiresAt)) return gone();
    if (wait) LOGIN_WAITS.used(check.nonce, meta(already));
    res.writeHead(303, { Location: safeNext(url.searchParams.get("next")) });
    res.end();
    return;
  }
  if (!FIRST_RUN.done()) {
    const here = await personHere(req);
    // The address may have been proven meanwhile: sign-in then goes there.
    if (sendToNamedAddress(req, res, url, already)) return;
    if (!here) {
      // A link `web login` printed (with its code): its page asks for
      // that code. Anything else: finish on the Den computer, unspent.
      if (wait?.confirmable) {
        LOGIN_WAITS.open(check.nonce);
        return sendSignedOut(req, res, {
          pathname: "/auth",
          search: "",
          scope: "den",
          confirm: true,
          requestId,
          message: "Enter the code `web login` printed.",
        });
      }
      return sendFirstRunHere(req, res, requestId);
    }
  } else if (sendToNamedAddress(req, res, url, already)) return;
  const spendLink = () => webSessions.consumeCode(check.nonce, check.expiresAt);
  // Checked again right before the session: another first-run sign-in
  // may have finished while this one waited. Nothing awaits between here
  // and startSession. Once set up, the link is spent only when its
  // request is made.
  if (FIRST_RUN.done())
    return sendPairing(
      req,
      res,
      requestId,
      pairLinkLead(),
      wait ? { nonce: check.nonce, startedAt: wait.startedAt } : undefined,
      { spend: spendLink, gone },
    );
  if (!spendLink()) return gone();
  if (wait) LOGIN_WAITS.used(check.nonce, meta(already));
  const s = startSession(req, "link");
  res.writeHead(303, {
    // The approval key in the fragment: it never reaches a server.
    Location: withApproveKey(
      safeNext(url.searchParams.get("next")),
      s.approveKey,
    ),
    "Set-Cookie": s.cookie,
  });
  res.end();
}

/**
 * SEC-2a; issue 819: `POST /auth?c=…` with `{ code }`: first run, the
 * code `web login` printed for a link opened away from the Den computer.
 * The right code signs this browser in (the link is spent); five wrong
 * ones end the link. Once a person has signed in here, it signs nothing
 * in: the link opened again shows the pairing screen.
 */
async function confirmFirstRunLink(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  check: ReturnType<typeof checkLoginCode> | null,
  requestId: string,
): Promise<void> {
  void requestId;
  const gone = (error?: string) =>
    sendJson(
      res,
      {
        ok: false,
        code: "expired",
        error:
          error ??
          `This link no longer works. On ${machineName()}, run web login again for a new one.`,
      },
      410,
    );
  let body: { code?: unknown } = {};
  try {
    body = (JSON.parse((await readBody(req)) || "{}") ?? {}) as typeof body;
    if (typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return sendJson(
      res,
      {
        ok: false,
        code: "bad_request",
        error: "the body must be JSON: { code }",
      },
      400,
    );
  }
  if (!check?.ok) return gone();
  if (FIRST_RUN.done())
    return gone(
      `${product().title} is already set up: open the link again, and a browser that is signed in approves this one.`,
    );
  const r = LOGIN_WAITS.confirm(check.nonce, String(body.code ?? ""));
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
  // The address may have been proven while the body was read: sign-in on
  // a loopback name then goes there, and nothing is minted here.
  const there = NAMED.address();
  if (there && !onTheAddress(req, there))
    return sendJson(
      res,
      {
        ok: false,
        code: "signin_elsewhere",
        error: `Sign in at ${there}: ${product().title} keeps the sign-in on its own address.`,
        address: there,
      },
      403,
    );
  if (!webSessions.consumeCode(check.nonce, check.expiresAt)) return gone();
  // Checked again right before the session (another sign-in may have
  // finished first run meanwhile).
  if (FIRST_RUN.done())
    return gone(
      `${product().title} is already set up: run web login again, and a browser that is signed in approves this one.`,
    );
  const g = checkRequest(req, GUARD, product().cli, product().title);
  LOGIN_WAITS.used(check.nonce, {
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

/**
 * `GET /auth?claim=<code>` (0.4.15): the setup link `<cli> web claim-link`
 * prints at the end of an install. A valid, unused claim code (30 min,
 * single use across restarts), on first run and on this computer (issue
 * 819), becomes a session ("claimed with a setup link" in Linked devices),
 * then a 303 to `/` with the session's approval key in the fragment and no
 * claim in the address, no referrer. Once the install is set up (or away
 * from this computer) it is spent as it opens the pairing screen. Anything
 * else: the signed-out page, which says the link was used and never
 * echoes the code. An agent's token never gets here (AGENT_FORBIDDEN).
 */
/**
 * Issue 810: the launcher's test-only flag, read once from the server's
 * own start environment (never a file), then taken out of it so nothing
 * this server starts (agents, terminals) inherits it.
 */
const TEST_INSTALL_LAUNCH_FLAG = (() => {
  const on = readEnv(getProfile(), TEST_INSTALL_ENV_KEY) === "1";
  delete process.env[envName(getProfile(), TEST_INSTALL_ENV_KEY)];
  return on;
})();

/**
 * Issue 1073: the launcher's name map for Den's own address checks, read
 * once from the server's start environment (never a file, a setting or a
 * request) and taken out of it like the flag above. It counts only while
 * this install is a test install (asked at every lookup); otherwise it is
 * ignored, and the log and doctor say so.
 */
const TEST_RESOLVE = (() => {
  const name = envName(getProfile(), TEST_RESOLVE_ENV_KEY);
  const raw = readEnv(getProfile(), TEST_RESOLVE_ENV_KEY);
  delete process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = parseTestResolve(raw);
  if (!parsed.ok) return { name, ignored: parsed.error };
  if (!TEST_INSTALL_LAUNCH_FLAG)
    return { name, ignored: "this install wasn't started as a test install" };
  return { name, map: parsed.map };
})();

/**
 * Issue 1018: the launcher's one-time setup value, read once from the
 * server's own start environment and taken out of process.env, like the
 * flag, so nothing this server starts (agents, terminals) inherits it.
 * That hides it from children only: the process's own start environment
 * stays readable to the same OS user (`ps eww <pid>`, Linux's
 * /proc/<pid>/environ), the same limit as every secret this user's
 * processes hold. Held in memory as a digest; spent values are recorded
 * in the state folder, so a restart with one doesn't revive it; dropped
 * at start unless this is a test install then.
 */
const FIXTURE_SETUP_SECRET = (() => {
  const v = readEnv(getProfile(), FIXTURE_SETUP_SECRET_ENV_KEY);
  delete process.env[envName(getProfile(), FIXTURE_SETUP_SECRET_ENV_KEY)];
  return new SetupSecret(v, getStateDir());
})();

/**
 * Issue 816: the launcher's opt-in for announcing this test install on
 * this computer (<PREFIX>_TEST_ANNOUNCE=1), read once from the start
 * environment and taken out of it, like the flag above.
 */
const TEST_ANNOUNCE_FLAG = (() => {
  const on = readEnv(getProfile(), TEST_ANNOUNCE_ENV_KEY) === "1";
  delete process.env[envName(getProfile(), TEST_ANNOUNCE_ENV_KEY)];
  return on;
})();

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Issue 810: whether this install is a test install right now: the mark,
 * the launch flag, its own state dir (not the product's default), and no
 * owner or signed-in person (a GitHub sign-in, the setup link, a pairing
 * code, or a `web login` link). The one link or approved session that
 * pressed Set up test person doesn't count, nor `except` (the caller's
 * own, while it presses it). Checked at every fixture path and on every fixture request.
 */
function testInstallNow(except?: string): boolean {
  let mark = false;
  try {
    mark = webAuthNow().testInstall;
  } catch {
    mark = false;
  }
  const stateDir = getStateDir();
  return testInstallBinding({
    mark,
    launchFlag: TEST_INSTALL_LAUNCH_FLAG,
    defaultStateDir:
      realOrResolved(stateDir) === realOrResolved(getProfile().stateDir),
    owned:
      !!readWebOwner(stateDir) ||
      webSessions.list().some(
        (s) =>
          s.via === "github" ||
          s.via === "claim" ||
          // A link (unset: a link from before 0.4.5), or (issue 819) a
          // device a signed-in browser approved: the person's own browsers.
          ((s.via === "link" || s.via === "code" || s.via === undefined) &&
            !s.testOperator &&
            s.key !== except),
      ),
  }).ok;
}
// Issue 1215: the fixture person's project acts check the mark too.
setFixtureTestInstall(() => testInstallNow());

// Issue 1073: install the name map's hook, and tell the log and doctor.
if (TEST_RESOLVE && "map" in TEST_RESOLVE && TEST_RESOLVE.map) {
  setTestResolve(testResolver(TEST_RESOLVE.map, () => testInstallNow()));
  writeTestResolveState(getStateDir(), {
    state: "used",
    names: [...TEST_RESOLVE.map.keys()],
  });
} else if (TEST_RESOLVE && "ignored" in TEST_RESOLVE && TEST_RESOLVE.ignored) {
  serverLog(
    `  ${testResolveIgnored(TEST_RESOLVE.name, TEST_RESOLVE.ignored)}`,
    "lifecycle",
  );
  writeTestResolveState(getStateDir(), {
    state: "ignored",
    env: TEST_RESOLVE.name,
    why: TEST_RESOLVE.ignored,
  });
} else writeTestResolveState(getStateDir(), null);

/** Issue 810: the fixture key this server sealed, or null. */
function fixtureKeyNow(): Buffer | null {
  return verifiedFixtureKey(getStateDir(), webSecret.current());
}

// Issue 728: list this install for the others on this OS user (any
// distribution's), so their agents are denied its credential files and keys.
try {
  const { dropped } = registerInstall(registryDir(), {
    stateDir: getStateDir(),
    edgeKeyDirs: edgeKeyDirs(getDistRoot()),
  });
  if (dropped.length)
    serverLog(
      `  ⚠ install registry: left out edge folders it can't name exactly: ${dropped.join(", ")}`,
      "warn",
    );
} catch (e) {
  serverLog(`  ⚠ install registry: ${(e as Error).message}`, "warn");
}

/**
 * Issue 816: keep this test install's announcement true. It is there only
 * while the launcher opted in, this is a test install, and its test person
 * isn't set up yet; it goes when any of those ends, and at exit.
 */
let ANNOUNCED = false;
function syncTestAnnouncement(): void {
  const want = TEST_ANNOUNCE_FLAG && testInstallNow() && !fixtureKeyNow();
  try {
    if (want)
      announceTestInstall(announceDir(), {
        stateDir: getStateDir(),
        port: PORT,
        pid: process.pid,
      });
    else if (ANNOUNCED) unannounceTestInstall(announceDir(), getStateDir());
    ANNOUNCED = want;
  } catch (e) {
    serverLog(`  ⚠ test install announcement: ${(e as Error).message}`, "warn");
  }
}
if (TEST_ANNOUNCE_FLAG) {
  setInterval(syncTestAnnouncement, 30_000).unref();
  process.on("exit", () => {
    if (ANNOUNCED) unannounceTestInstall(announceDir(), getStateDir());
  });
}

/**
 * Issue 814: whether this is an operator install right now: a test
 * install (testInstallNow), created as one (its sealed creation record),
 * bound to loopback only. Checked on every test operator request.
 */
function operatorInstallNow(): boolean {
  return (
    isLoopbackBind(BIND_HOST) &&
    testInstallNow() &&
    verifiedCreationRecord(getStateDir(), webSecret.current())
  );
}

/**
 * Issue 814: at a new test install's first start (test-install-birth.ts
 * claimed its empty state folder), once its secret exists: seal the
 * creation record and give it its fixture person, so no one has to press
 * Set up test person. When the claim wasn't a test install after all (no
 * mark, an owner), the claim is dropped.
 */
function sealNewTestInstall(): void {
  if (!BORN_AS_TEST_INSTALL) return;
  const stateDir = getStateDir();
  const secret = webSecret.current();
  if (!secret || !testInstallNow()) return dropPendingRecord(stateDir);
  writeCreationRecord(stateDir, secret);
  const had = !!fixtureKeyNow();
  const r = had
    ? ({ ok: true } as const)
    : setupFixturePerson(stateDir, {
        testInstall: true,
        agent: false,
        webSecret: secret,
        configFile: product().configFile,
      });
  if (r.ok && !had) writeFixtureMadeBy(stateDir, "creation");
  recordAction(
    null,
    {
      verb: "test-install",
      detail: r.ok
        ? `a new test install: its ${FIXTURE_LABEL} given at creation, and the ${OPERATOR_LABEL}'s acts on loopback`
        : `a new test install: its ${FIXTURE_LABEL} couldn't be made (${r.code})`,
    },
    OPERATOR_PRINCIPAL,
  );
  serverLog(
    `  ${logTimestamp()}  a new test install: ${FIXTURE_LABEL} and ${OPERATOR_LABEL} ready`,
    "lifecycle",
  );
}

/**
 * Issue 810: whether a fixture session still stands: a test install, the
 * sealed key it signed in with still the current one, and within its
 * lifetime.
 */
function fixtureSessionStands(s: {
  createdAt: number;
  fixtureKey?: string;
}): boolean {
  let minutes: number;
  try {
    minutes = webAuthNow().fixtureSessionMinutes;
  } catch {
    return false;
  }
  const key = fixtureKeyNow();
  return (
    testInstallNow() &&
    !!key &&
    !!s.fixtureKey &&
    s.fixtureKey === fixtureKeyFingerprint(key) &&
    !fixtureSessionExpired(s.createdAt, Date.now(), minutes)
  );
}

/**
 * Issue 810: `GET /auth?fixture=<code>&next=<path>`: the gate runner's
 * sign-in as the fixture person (`web fixture-login`). Only on a test
 * install (web.test_install in the distribution config), only with a code
 * the fixture person's secret minted, once. The session's `via` is
 * "fixture": logged and audited as the fixture person, never the human,
 * and it never approves (approvals.ts) or reaches Hub (fixtureScopeRefusal).
 * Refusals never echo the code.
 */
function handleFixtureAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  requestId: string,
): void {
  const refuse = (status: number, why: string, msg: string) => {
    recordAction(
      null,
      {
        verb: "signin",
        detail: `${FIXTURE_LABEL} sign-in refused`,
        outcome: "refused",
        reason: why,
      },
      FIXTURE_PRINCIPAL,
    );
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(`${msg} (request id ${requestId})`);
  };
  // GET only: a HEAD (a link preview) never spends the one-time code.
  if (req.method !== "GET")
    return refuse(405, "method", "Open the fixture sign-in link with GET.");
  if (!testInstallNow())
    return refuse(
      403,
      "not_test_install",
      notTestInstallRefusal(product().configFile),
    );
  const secret = fixtureKeyNow();
  const check = secret
    ? checkFixtureCode(url.searchParams.get(FIXTURE_LINK_PARAM) ?? "", secret)
    : null;
  if (!check?.ok || !webSessions.consumeCode(check.nonce, check.expiresAt))
    return refuse(
      401,
      check && !check.ok ? check.reason : secret ? "used" : "no_fixture_person",
      `That ${FIXTURE_LABEL} sign-in link expired, was used, or isn't this install's. Run \`${product().cli} web fixture-login\` for a new one.`,
    );
  const s = startSession(
    req,
    "fixture",
    undefined,
    undefined,
    fixtureKeyFingerprint(secret!),
  );
  recordAction(
    null,
    { verb: "signin", detail: `${FIXTURE_LABEL} signed in (live checks)` },
    FIXTURE_PRINCIPAL,
  );
  serverLog(
    `  ${logTimestamp()}  ${FIXTURE_LABEL} signed in (live checks, a test install)`,
    "lifecycle",
  );
  res.writeHead(303, {
    // No approval key: the fixture person never approves.
    Location: safeNext(url.searchParams.get("next")),
    "Set-Cookie": s.cookie,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

// ── Issue 796: an agent's read-only view of this Den's pages ─────────────────

/** The one-time view links not yet opened (memory only). */
const AGENT_VIEW_CODES = new AgentViewCodes();

/**
 * Issue 796: whether an agent's view still stands: views on, within its
 * minutes, and the agent's token still live (stopping the agent, or `web
 * logout --all`, ends its view too).
 */
function agentViewStands(s: { createdAt: number; agent?: string }): boolean {
  const w = webAuthNow();
  const id = (s.agent ?? "").replace(/^agent:/, "");
  return (
    w.agentView &&
    !!id &&
    !agentViewExpired(s.createdAt, Date.now(), w.agentViewMinutes) &&
    agentTokenLive(getStateDir(), id)
  );
}

/** Issue 796: one refused or logged step of an agent's view, in the audit. */
function auditAgentView(
  agent: string,
  workspace: string,
  detail: string,
  refused?: string,
): void {
  recordAction(
    {
      kind: "agent",
      client: AGENT_VIEW_CLIENT,
      clientVersion: "-",
      mcpPid: null,
      session: "",
      agent: agent as `agent:${string}`,
      workspace,
    },
    {
      verb: "agent-view",
      detail: detail.slice(0, 200),
      ...(refused ? { outcome: "refused" as const, reason: refused } : {}),
    },
    agent,
  );
}

/**
 * Issue 796: `POST /api/agents/self/view` (MCP page_view): an agent asks
 * for a read-only view of this Den's pages. Its actor token only (never a
 * person's credential, a browser session or a claimed agent), on this
 * machine's loopback only, and only while `web.agent_view` is on. Answers
 * a one-time link, opened once within a minute on this machine.
 */
async function handleAgentViewRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  guard: Extract<GuardResult, { ok: true }>,
): Promise<void> {
  const p = guard.principal;
  if (p?.kind !== "agent")
    return sendJson(
      res,
      {
        ok: false,
        code: "agent_only",
        error:
          "A read-only page view is for an agent running in this Den, with its own token. A person signs in instead.",
      },
      403,
    );
  const refuse = (status: number, code: string, error: string) => {
    auditAgentView(p.actor, p.workspace, "view link refused", code);
    return sendJson(res, { ok: false, code, error }, status);
  };
  if (guard.beyond)
    return refuse(
      403,
      "agent_view_loopback",
      "A read-only page view is made on this machine only, never from another one.",
    );
  const w = webAuthNow();
  if (!w.agentView)
    return refuse(403, "agent_view_off", agentViewOffText(product().cli));
  let body: { next?: unknown } = {};
  try {
    body = (JSON.parse((await readBody(req)) || "{}") ?? {}) as typeof body;
  } catch {
    return send400(res, "the body must be JSON: { next? }");
  }
  const next = safeNext(typeof body.next === "string" ? body.next : "/agents");
  const { code, expiresAt } = AGENT_VIEW_CODES.mint({
    agent: p.actor,
    workspace: p.workspace,
  });
  auditAgentView(p.actor, p.workspace, `view link made for ${next}`);
  return sendJson(res, {
    ok: true,
    url:
      `${localhostOrigin(PORT)}/auth?${AGENT_VIEW_LINK_PARAM}=${encodeURIComponent(code)}` +
      (next === "/" ? "" : `&next=${encodeURIComponent(next)}`),
    expiresAt: new Date(expiresAt).toISOString(),
    linkSeconds: AGENT_VIEW_LINK_TTL_MS / 1000,
    minutes: w.agentViewMinutes,
    // Issue 1243: localhost on purpose (it opens on loopback only, as the
    // agent). The agent keeps it; a person gets the page on web.url.
    note: AGENT_VIEW_LINK_NOTE,
  });
}

/**
 * Issue 796: `GET /auth?agent_view=<code>&next=<path>`: the agent's
 * browser opens its view. On loopback only, with a code this server
 * minted for the agent, once. The session (via "agent-view") is the
 * agent's: no approval key, never first run, never an owner.
 */
function handleAgentViewAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  requestId: string,
): void {
  const refuse = (status: number, why: string, msg: string) => {
    recordAction(null, {
      verb: "agent-view",
      detail: "an agent's view link refused",
      outcome: "refused",
      reason: why,
    });
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(`${msg} (request id ${requestId})`);
  };
  // GET only: a HEAD (a link preview) never spends the one-time code.
  if (req.method !== "GET")
    return refuse(405, "method", "Open the view link with GET.");
  const g = checkRequest(req, GUARD, product().cli, product().title);
  if (!g.ok || g.beyond || g.via !== "loopback")
    return refuse(
      403,
      "agent_view_loopback",
      "An agent's view link opens on this machine only.",
    );
  if (!webAuthNow().agentView)
    return refuse(403, "agent_view_off", agentViewOffText(product().cli));
  const who = AGENT_VIEW_CODES.redeem(
    url.searchParams.get(AGENT_VIEW_LINK_PARAM) ?? "",
  );
  if (!who)
    return refuse(
      401,
      "used",
      "That view link expired, was used, or isn't this install's. Ask page_view for a new one.",
    );
  const s = startSession(
    req,
    "agent-view",
    undefined,
    undefined,
    undefined,
    who,
  );
  auditAgentView(who.agent, who.workspace, "read-only view opened");
  serverLog(
    `  ${logTimestamp()}  ${who.agent} opened a read-only view (${webAuthNow().agentViewMinutes} min)`,
    "lifecycle",
  );
  res.writeHead(303, {
    // No approval key: an agent's view never approves.
    Location: safeNext(url.searchParams.get("next")),
    "Set-Cookie": s.cookie,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

/**
 * Issue 810: Settings › Access › Test install. GET: whether this is a test
 * install and whether the fixture person is set up (never its secret).
 * POST: Set up test person, only from a person's own browser session (a
 * GitHub sign-in, the setup link, a pairing code or a `web login` link,
 * with its CSRF token), on a test install. Every bearer (the person's CLI
 * too), a claimed agent and the fixture person are refused. Setting it up
 * again replaces the key, which ends every older fixture session.
 */
/** Issue 52: agents.coach now; its defaults (off) when the config can't be read. */
function coachSettingsNow(): CoachSettings {
  try {
    return readAgentsConfig().coach ?? { ...COACH_DEFAULTS };
  } catch {
    return { ...COACH_DEFAULTS };
  }
}

/** Issue 52: what the Coach's routes need from this server. */
function coachRouteDeps(): CoachRouteDeps {
  return {
    sendJson,
    notAPerson: notAPersonOf,
    settings: coachSettingsNow,
    latest: () => readCoachReport(getStateDir()),
    run: () =>
      runCoach({ stateDir: getStateDir(), settings: coachSettingsNow() }),
    audit: (req, e) =>
      void recordAction(auditActorOf(req), e, principalOf(req)),
    findings: (report) => ({
      open: openFindings(getStateDir(), report?.findings ?? []),
      dismissed: readDismissals(getStateDir()),
    }),
    dismiss: (id, reason) =>
      dismissFinding(getStateDir(), id, reason, "person"),
    readBody,
  };
}

async function handleFixturePersonRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    res.setHeader("Allow", "GET, HEAD, POST");
    return sendJson(res, { ok: false, error: "use GET or POST" }, 405);
  }
  const g = checkRequest(req, GUARD, product().cli, product().title);
  const session = g.ok ? g.session : null;
  const browser =
    g.ok &&
    g.principal?.kind === "person-browser" &&
    !g.principal.fixture &&
    !!session &&
    g.principal.session === session.key &&
    (session.via === undefined || PERSON_VIAS.has(session.via)) &&
    !notAPersonOf(req);
  if (method === "GET" || method === "HEAD") {
    // The person's own session doesn't count against the install for
    // them, as on the press: else signing in hides the button.
    const testInstall = testInstallNow(browser ? session!.key : undefined);
    return sendJson(res, {
      ok: true,
      testInstall,
      ready: testInstall && !!fixtureKeyNow(),
    });
  }
  if (g.ok && !g.principal)
    return sendJson(
      res,
      {
        ok: false,
        code: "signin_required",
        error: "Sign in on this page to set up the test person.",
      },
      401,
    );
  const r = setupFixturePerson(getStateDir(), {
    testInstall: testInstallNow(browser ? session!.key : undefined),
    agent: !browser,
    webSecret: webSecret.current(),
    configFile: product().configFile,
  });
  if (r.ok && browser) webSessions.markTestOperator(session!.key);
  if (r.ok) writeFixtureMadeBy(getStateDir(), "settings");
  syncTestAnnouncement();
  recordAction(
    auditActorOf(req),
    {
      verb: "fixture-person",
      detail: r.ok
        ? `${FIXTURE_LABEL} set up (test install)`
        : `${FIXTURE_LABEL} setup refused`,
      ...(r.ok ? {} : { outcome: "refused" as const, reason: r.code }),
    },
    principalOf(req),
  );
  if (!r.ok)
    return sendJson(res, { ok: false, code: r.code, error: r.error }, 403);
  return sendJson(res, { ok: true, testInstall: true, ready: true });
}

/**
 * Issue 1018: `POST /api/web/fixture-person/setup-secret {secret}`: a test
 * install's CLI (`web fixture-person --from-setup-secret`) makes the
 * fixture person with the launcher's one-time setup value, no browser
 * needed. Refused first for an agent (a person grant, as everywhere),
 * before the value is read; then off a test install; then by the value
 * itself (none at start, used, wrong), which the first try spends. On a
 * match, the key is made exactly as Set up test person makes it. No
 * answer, log line or audit line holds the value.
 */
/** Issue 1018: the setup route's body, `{"secret": …}`, at most this. */
const SETUP_SECRET_BODY_MAX = 4096;

async function handleFixtureSetupSecretRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, { ok: false, error: "use POST" }, 405);
  }
  const g = checkRequest(req, GUARD, product().cli, product().title);
  let presented: unknown = undefined;
  let tooBig = false;
  try {
    const raw = await readBodyCapped(req, SETUP_SECRET_BODY_MAX);
    tooBig = raw === null;
    const b = JSON.parse(raw ?? "{}") as { secret?: unknown } | null;
    presented = b?.secret;
  } catch {
    presented = undefined;
  }
  const refuse = (code: string, error: string, status = 403) => {
    recordAction(
      auditActorOf(req),
      {
        verb: "fixture-person",
        detail: `${FIXTURE_LABEL} from the setup secret: refused`,
        outcome: "refused",
        reason: code,
      },
      principalOf(req),
    );
    return sendJson(res, { ok: false, code, error }, status);
  };
  const person =
    g.ok &&
    g.principal?.kind === "person" &&
    !g.principal.testPerson &&
    !notAPersonOf(req);
  // Only from this machine, as the test-person path (issue 636): beyond
  // it, the value and the person's bearer would cross the network.
  if (person && g.beyond)
    return refuse(
      "not_this_machine",
      `The ${FIXTURE_LABEL} is made from the setup value only on this computer, from its own command line; never through the edge or the network.`,
    );
  if (!person)
    return refuse(
      "person_only",
      `Only the person's own command line makes the ${FIXTURE_LABEL} from the setup value: an agent, a claimed agent or the ${FIXTURE_LABEL} itself can't.`,
    );
  if (!testInstallNow())
    return refuse(
      "not_test_install",
      notTestInstallRefusal(product().configFile),
    );
  // Before the value: a body over the cap spends nothing.
  if (tooBig)
    return refuse(
      "body_too_big",
      `The request is over ${SETUP_SECRET_BODY_MAX} bytes; it sends only {"secret": …}. Nothing was spent.`,
      413,
    );
  const t = FIXTURE_SETUP_SECRET.take(presented);
  presented = undefined;
  if (!t.ok) return refuse(t.code, setupSecretRefusal(t.code, product().cli));
  const r = setupFixturePerson(getStateDir(), {
    testInstall: true,
    agent: false,
    webSecret: webSecret.current(),
    configFile: product().configFile,
  });
  if (!r.ok) return refuse(r.code, r.error);
  writeFixtureMadeBy(getStateDir(), "setup-secret");
  syncTestAnnouncement();
  // Who made it: the person whose bearer sent the value (as Settings'
  // Set up test person records its presser); the fixture person is what.
  recordAction(
    auditActorOf(req),
    {
      verb: "fixture-person",
      detail: `${SETUP_SECRET_AUDIT} (${FIXTURE_PRINCIPAL})`,
    },
    principalOf(req),
  );
  serverLog(`  ${logTimestamp()}  ${SETUP_SECRET_AUDIT}`, "lifecycle");
  return sendJson(res, { ok: true, testInstall: true, ready: true });
}

/**
 * Issue 816: `GET /api/web/test-installs`: the test installs announced on
 * this computer that pass every check and whose port answers as that
 * install, for Settings' Set up test person. The signed-in person only: an
 * agent, a fixture session or a request with no sign-in gets 403 (a
 * loopback GET passes the request checks with no token, so it is checked
 * here). Each by id, ~/ state folder and port; never a secret or its path.
 */
async function handleTestInstallsListRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const m = (req.method ?? "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return sendJson(res, { ok: false, error: "use GET" }, 405);
  }
  const g = checkRequest(req, GUARD, product().cli, product().title);
  const p = g.ok ? g.principal : undefined;
  const person =
    !!p &&
    (p.kind === "person" || p.kind === "person-browser") &&
    !("testPerson" in p && p.testPerson) &&
    !("fixture" in p && p.fixture) &&
    !notAPersonOf(req);
  // Nobody signed in: 401, as other reads that need a sign-in answer. An
  // agent, a fixture or a test person: 403.
  if (!person)
    return sendJson(
      res,
      {
        ok: false,
        code: p ? "person_only" : "signin_required",
        error:
          "Only the signed-in person sees the test installs on this computer.",
      },
      p ? 403 : 401,
    );
  // Issue 816 review: probed and still waiting, so a forged announcement of
  // a real install never offers Set up.
  const installs = await listWaitingInstalls(testPersonSetupDeps());
  return sendJson(res, { ok: true, installs });
}

/**
 * Issue 816: `POST /api/web/fixture-person/grant {grant, challenge}`: your
 * own Den, at your Allow of test_person_setup, makes this test install's
 * test person. It needs both: this install's person bearer on this machine
 * (never beyond the edge) and a fresh grant for this install, spent first.
 * It answers the challenge as this Den, so the sender knows its bearer
 * reached this install and not something else on the port. An agent's
 * token or a fixture session is refused before the body is read.
 */
const GRANT_BODY_MAX = 1024;
async function handleFixtureGrantRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, { ok: false, error: "use POST" }, 405);
  }
  const g = checkRequest(req, GUARD, product().cli, product().title);
  const refuse = (code: string, error: string, status = 403) => {
    recordAction(
      auditActorOf(req),
      {
        verb: "fixture-person",
        detail: `${FIXTURE_LABEL} from a grant: refused`,
        outcome: "refused",
        reason: code,
      },
      principalOf(req),
    );
    return sendJson(res, { ok: false, code, error }, status);
  };
  const person =
    g.ok &&
    g.principal?.kind === "person" &&
    !g.principal.testPerson &&
    !notAPersonOf(req);
  if (person && g.beyond)
    return refuse(
      "not_this_machine",
      `The ${FIXTURE_LABEL} is made from a grant only on this computer; never through the edge or the network.`,
    );
  if (!person)
    return refuse(
      "person_only",
      `Only your own ${product().title}, at your Allow, makes the ${FIXTURE_LABEL} from a grant: an agent or the ${FIXTURE_LABEL} itself can't.`,
    );
  if (!testInstallNow())
    return refuse(
      "not_test_install",
      notTestInstallRefusal(product().configFile),
    );
  let grant: unknown = undefined;
  let challenge: unknown = undefined;
  let tooBig = false;
  try {
    const raw = await readBodyCapped(req, GRANT_BODY_MAX);
    tooBig = raw === null;
    const b = JSON.parse(raw ?? "{}") as {
      grant?: unknown;
      challenge?: unknown;
    } | null;
    grant = b?.grant;
    challenge = b?.challenge;
  } catch {
    grant = undefined;
  }
  if (tooBig)
    return refuse(
      "body_too_big",
      `The request is over ${GRANT_BODY_MAX} bytes. Nothing was spent.`,
      413,
    );
  const secret = webSecret.current();
  if (!secret) return refuse("no_secret", "This install has no web secret.");
  const t = takeSetupGrant(typeof grant === "string" ? grant : "", {
    secret,
    stateDir: getStateDir(),
    maxSeconds: SETUP_GRANT_MAX_SECONDS,
  });
  grant = undefined;
  if (!t.ok) return refuse(t.code, `The grant was refused: ${t.code}.`);
  const r = setupFixturePerson(getStateDir(), {
    testInstall: true,
    agent: false,
    webSecret: secret,
    configFile: product().configFile,
  });
  if (!r.ok) return refuse(r.code, r.error);
  writeFixtureMadeBy(getStateDir(), "grant");
  syncTestAnnouncement();
  const detail = `${FIXTURE_LABEL} made from a grant by install ${t.from} (${FIXTURE_PRINCIPAL})`;
  recordAction(
    auditActorOf(req),
    { verb: "fixture-person", detail },
    principalOf(req),
  );
  serverLog(`  ${logTimestamp()}  ${detail}`, "lifecycle");
  const answer = identityAnswer(identityKey(secret), challenge);
  return sendJson(res, {
    ok: true,
    testInstall: true,
    ready: true,
    ...(answer ? { answer } : {}),
  });
}

/**
 * Issue 636: `POST /api/web/test-person {command}`: a test bed's CLI
 * starting `<cli> --test-person <command>`. The request checks already let
 * it in only with the person's token and the test-person header, from
 * this machine, on a test bed; here it is checked once more and the row
 * recorded (`via: "test-person"`). Only then does the CLI act.
 */
async function handleTestPersonRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, { ok: false, error: "use POST" }, 405);
  }
  const g = checkRequest(req, GUARD, product().cli, product().title);
  const onPath =
    g.ok && g.principal?.kind === "person" && g.principal.testPerson === true;
  let command = "";
  try {
    const b = JSON.parse((await readBody(req)) || "{}") as {
      command?: unknown;
    } | null;
    if (typeof b?.command === "string") command = b.command;
  } catch {
    command = "";
  }
  command = command.replace(/[^A-Za-z0-9._ …-]/g, "").slice(0, 120);
  if (!onPath || !testInstallNow()) {
    recordAction(
      auditActorOf(req),
      {
        verb: "test-person",
        detail: `${command || "a command"} as the person: refused`,
        outcome: "refused",
        reason: onPath ? "not_test_bed" : "test_person_refused",
      },
      principalOf(req),
    );
    return sendJson(
      res,
      {
        ok: false,
        code: onPath ? "not_test_bed" : "test_person_refused",
        error: onPath
          ? notTestBedRefusal(product().configFile)
          : testPersonCredentialRefusal(),
      },
      403,
    );
  }
  recordAction(
    null,
    {
      verb: "test-person",
      detail: `${command || "a command"} as the person (the test-person path, a test bed)`,
    },
    principalOf(req),
  );
  serverLog(
    `  ${logTimestamp()}  the CLI acts as the person: ${command || "a command"} (the test-person path, a test bed)`,
    "lifecycle",
  );
  return sendJson(res, { ok: true });
}

/** Issue 810: the sign-ins that are a person's own browser session. */
const PERSON_VIAS: ReadonlySet<string> = new Set([
  "github",
  "claim",
  "code",
  "link",
]);

/**
 * Issue 868: whether a person's browser is signed in here and could
 * approve a new device (it holds an approval key; never the fixture
 * person). Once Den's own address works, only a session made there counts.
 */
function personBrowserSignedIn(): boolean {
  const named = NAMED.works();
  return webSessions
    .list()
    .some(
      (s) =>
        (s.via === undefined || PERSON_VIAS.has(s.via)) &&
        !!s.approveKeyHash &&
        (!named || s.secure === true),
    );
}

/**
 * Issue 819: why this request may not approve or deny a waiting device, or
 * null when it may: a person's signed-in browser, its session's CSRF token
 * and approval key (approverAllowed), never the fixture person. The CLI's
 * bearer, an agent's token and a signed-out page are each told what to do.
 */
function deviceApproverRefusal(
  req: http.IncomingMessage,
): { status: number; code: string; error: string } | null {
  const g = checkRequest(req, GUARD, product().cli, product().title);
  const inBrowser =
    "Approving a device needs a person's signed-in browser: open Settings › Access in a browser where you're signed in, and approve it there.";
  if (!g.ok)
    return {
      status: g.status,
      code: "approve_needs_browser",
      error: inBrowser,
    };
  const p = g.principal;
  if (p?.kind === "agent")
    return {
      status: 403,
      code: "approve_not_agent",
      error:
        "Only a person approves a device, from a signed-in browser (Settings › Access). An agent can't.",
    };
  // Issue 796: nor an agent's read-only view.
  if (p?.kind === "person-browser" && p.view)
    return {
      status: 403,
      code: "approve_not_agent",
      error:
        "Only a person approves a device, from a signed-in browser (Settings › Access). An agent's view can't.",
    };
  if (p?.kind === "person-browser" && p.fixture)
    return {
      status: 403,
      code: "fixture_cannot_approve",
      error:
        "The fixture person can't approve a device: a person approves it from a signed-in browser (Settings › Access).",
    };
  if (!p || p.kind !== "person-browser" || !g.session)
    return { status: 403, code: "approve_needs_browser", error: inBrowser };
  const ok = approverAllowed(req, g);
  if (ok.ok) return null;
  return { status: 403, code: ok.code, error: ok.error };
}

const CLAIM_NONCES = new ClaimNonces(getStateDir());
async function handleClaim(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  requestId: string,
): Promise<void> {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  const secret = webSecret.current();
  const check =
    req.method === "GET" && secret
      ? checkClaimCode(url.searchParams.get("claim") ?? "", secret)
      : null;
  if (!check?.ok)
    return sendSignedOut(req, res, {
      pathname: "/auth",
      search: "",
      scope: "den",
      expired: true,
      requestId,
      message: `This setup link was used or has expired. If you didn't open it yourself, someone else may have: check Settings › Access › Linked devices. Sign in below, or run \`${product().cli} web claim-link\` in your own terminal for a new one.`,
    });
  // Issue 819: first run only, and only by the person at this computer;
  // anywhere else on first run, it says so and stays unspent.
  const first = !FIRST_RUN.done() && (await personHere(req));
  if (!first && !FIRST_RUN.done()) return sendFirstRunHere(req, res, requestId);
  // Checked again after the wait above, right before the session (another
  // first-run sign-in may have finished meanwhile). Nothing awaits between
  // here and startSession, and spending the setup link below leaves a
  // trace first-run.ts reads as set up, so it is checked first.
  const firstNow = first && !FIRST_RUN.done();
  const claimGone = () =>
    sendSignedOut(req, res, {
      pathname: "/auth",
      search: "",
      scope: "den",
      expired: true,
      requestId,
      message: `This setup link was used or has expired. If you didn't open it yourself, someone else may have: check Settings › Access › Linked devices. Sign in below, or run \`${product().cli} web claim-link\` in your own terminal for a new one.`,
    });
  const spendClaim = () => CLAIM_NONCES.consume(check.nonce, check.expiresAt);
  // Once set up, the setup link is spent only when its request is made.
  if (!firstNow)
    return sendPairing(
      req,
      res,
      requestId,
      {
        key: "err.signin.claimSetUp",
        message: `${product().title} is already set up, so the setup link doesn't sign in by itself any more. Approve this browser from one that is signed in: Settings › Access, then the code below.`,
      },
      undefined,
      { spend: spendClaim, gone: claimGone },
    );
  if (!spendClaim()) return claimGone();
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

/**
 * FB (den#81): Report's server side, as the page, the command line and
 * (issue 565) an agent's held `report` use it. A request's own reader of
 * kept screenshots is added by the route.
 */
function reportRouteDeps(): ReportRouteDeps {
  return {
    settings: () =>
      readFeedbackSettings(
        getEngineRoot(),
        path.join(getDistRoot(), product().configFile),
        readUserConfig().feedback,
      ),
    stateDir: () => getStateDir(),
    gh: runGh,
    names: () => {
      const w = readWebUrl();
      let webHost: string | undefined;
      try {
        webHost = w ? new URL(w.url).hostname : undefined;
      } catch {
        webHost = undefined;
      }
      return {
        home: os.homedir(),
        hosts: [os.hostname(), ...(webHost ? [webHost] : [])],
        orgs: [product().name],
      };
    },
    diagnostics: async () => ({
      Den: `${product().cli} ${engineVersion() ?? "?"}`,
      Machine: machineSection(),
    }),
    agentOf: (r) => reportAgentOf(agentPrincipalOf(r), auditActorOf(r)),
    personOf: () => "person",
    flows: GITHUB_CLIENT_ID ? DEVICE_FLOWS : undefined,
    searchOpen: GITHUB.fake ? undefined : publicSearchOpen(GITHUB.api),
    // Issue 403: a report's screenshot to Hub, with the install's Bearer.
    shotHub: REPORT_SHOT_HUB,
    shotMaxBytes: () => shotLimits(readUserConfig()).keptBytes,
    publicRepo: GITHUB.fake ? undefined : publicRepoVisibility(GITHUB.api),
    // Issue 565: who filed a report and where it went, in the trail.
    audit: ({ by, repo, url, added }) =>
      recordAction(
        null,
        {
          verb: "report-file",
          detail: `${added ? "added to" : "filed"} ${url || repo} on ${repo}, by ${by}`,
        },
        by.startsWith("agent:") ? by : undefined,
      ),
    readBody,
    sendJson: (r, body, status) => sendJson(r, body, status),
  };
}

// ── ON-3: the writes held for the person (approval-routes.ts) ─────────────────
type ApprovalDeps = {
  queue: ApprovalQueue;
  actions: HeldActions;
  enabled: () => boolean;
  autoAllow: (
    action: string,
    agent: string,
    workspace: string | undefined,
  ) => string | null;
  policy: NonNullable<Parameters<typeof handleApprovalRoutes>[4]["policy"]>;
  installMode: () => InstallMode;
  notify: NonNullable<Parameters<typeof handleApprovalRoutes>[4]["notify"]>;
  held: NonNullable<Parameters<typeof handleApprovalRoutes>[4]["held"]>;
  changed: () => void;
  webUrl: () => string | null;
};
let approvals: ApprovalDeps | null = null;
/**
 * Issue 816: test_person_setup's deps, outside approvalDeps. Everything it
 * sends goes to 127.0.0.1:<port> of a checked announcement, never a name.
 */
function testPersonSetupDeps(): TestPersonSetupDeps {
  const base = (port: number) => `http://127.0.0.1:${port}`;
  const timeoutMs = () => addressCheckSettings().timeoutMs;
  return {
    ownId: installIdOf(getStateDir()),
    home: os.homedir(),
    list: () => listAnnounced(announceDir(), { ownStateDir: getStateDir() }),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    probe: async (a) => {
      const secret = readWebSecret(a.stateDir);
      if (!secret) return false;
      const r = await probeIdentity(base(a.port), {
        key: identityKey(secret),
        timeoutMs: timeoutMs(),
        retries: 0,
      });
      return r.ok;
    },
    waiting: async (a) => {
      try {
        const res = await fetch(`${base(a.port)}/api/web/fixture-person`, {
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs()),
        });
        const j = (await res.json()) as {
          testInstall?: unknown;
          ready?: unknown;
        };
        return (
          res.status === 200 && j.testInstall === true && j.ready === false
        );
      } catch {
        return false;
      }
    },
    readSecret: (dir) => readWebSecret(dir),
    ttlSeconds: () => testGrantSeconds(),
    post: async (port, bearer, body) => {
      const res = await fetch(`${base(port)}/api/web/fixture-person/grant`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs()),
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body,
      });
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        json = {};
      }
      return { status: res.status, json };
    },
    audit: (row) =>
      auditConfig({ ...row, verb: "test-person-setup" }, getStateDir()),
  };
}

/**
 * Issue 869: web_url_set's deps. Outside approvalDeps on purpose: this held
 * write reads the stored web.url (its "Now:" line, and the address it
 * replaces), while approvalDeps' links use the people address (issue 1016).
 */
function webUrlSetDeps(): Parameters<typeof webUrlSetAction>[0] {
  return {
    knownHost: addressHostKnown,
    read: () => readWebUrl(),
    set: (url, how) => saveWebUrl(url, how),
    ping: (url, ms) => pingHttp(url, ms),
    checkMs: () => webUrlCheckSeconds() * 1000,
  };
}

/** The held writes and their queue, made on first use. */
function approvalDeps(): ApprovalDeps {
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
      // Issue 362: the command the dialog shows, and its Allow is for.
      const command =
        def === undefined ? undefined : typeof def === "string" ? def : def.cmd;
      return {
        ok: true,
        address: resolved.address,
        ...(command ? { command } : {}),
      };
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
    // SRV-1a: the marker the next server takes, then D64's restart.
    restartDen: async (reason, asked) => {
      const auto = !!asked?.decidedBy?.startsWith("auto:");
      try {
        writeRestartMarker(getStateDir(), {
          id: asked?.id ?? "",
          reason,
          ...(asked?.agent ? { agent: asked.agent } : {}),
          allowed: auto ? "auto" : "person",
          fromVersion: engineVersion() ?? "?",
          fromPid: process.pid,
          at: new Date().toISOString(),
        });
      } catch (e) {
        return {
          ok: false,
          error: `Den couldn't leave its restart note: ${(e as Error).message}`,
        };
      }
      const by = asked?.agent ? `agent:${asked.agent}` : "the person";
      recordAction(
        null,
        {
          verb: "server-restart",
          detail: `asked by ${by}, allowed ${auto ? "by server_agent.self_update: auto" : "by the person"}: ${reason}${asked?.id ? ` [${asked.id}]` : ""}`,
        },
        asked?.agent ? `agent:${asked.agent}` : undefined,
      );
      serverLog(`↻ web restart asked by ${by}: ${reason}`, "lifecycle");
      // After this answer (and the decide's) has gone out.
      setTimeout(() => {
        try {
          spawnDetachedWebRestart(PORT);
        } catch (e) {
          serverLog(`  ⚠ web restart failed to spawn: ${(e as Error).message}`);
        }
      }, 250);
      return { ok: true, restarting: true, pid: process.pid };
    },
    // SRV-1b: update from npm, the watch to roll back, then the restart.
    installPersonal: isPersonalInstall,
    denVersion: () => engineVersion() ?? null,
    holdForPerson: (action, card, agent) => holdForPerson(action, card, agent),
    updateDen: async (version, reason, asked, o) => {
      const u = await import("./den-update.js");
      const auto = !!asked?.decidedBy?.startsWith("auto:");
      const by = asked?.agent ? `agent:${asked.agent}` : "the person";
      const root = getDistRoot();
      const engine = getEngineRoot();
      let waitMs: number;
      try {
        waitMs = readServerAgentConfig().updateWaitMs;
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const npm = u.npmCommand();
      const cli = denCliCommand();
      const env = webServerEnv(PORT);
      const stateDir = getStateDir();
      const audit = (detail: string) =>
        recordAction(
          null,
          { verb: "server-update", detail: detail.slice(0, 400) },
          asked?.agent ? `agent:${asked.agent}` : undefined,
        );
      audit(
        `asked by ${by}, allowed ${auto ? "by server_agent.self_update: auto" : "by the person"}: to ${version}: ${reason}${asked?.id ? ` [${asked.id}]` : ""}`,
      );
      const res = await u.updateDen(version, {
        root,
        engine,
        stateDir,
        pkg: {
          name: ENGINE_PACKAGE,
          version: engineVersion() ?? "0.0.0",
        },
        npmView: (spec) => u.npmViewVersion(npm, spec, root),
        npm,
        cli: [cli.cmd, ...cli.baseArgs],
        run: (argv, cwd) => u.runCommand(argv, cwd, env),
        watch: (script, plan) =>
          u.spawnWatch(
            script,
            plan,
            root,
            env,
            path.join(stateDir, "logs", product().cli, "update-watch.log"),
          ),
        note: (why) => {
          const marker = {
            id: asked?.id ?? "",
            reason: why,
            // SRV-P6: no agent asked (Den's own check): the server agent,
            // which keeps the pin, is told when Den is back.
            ...(asked?.agent
              ? { agent: asked.agent }
              : { agent: SERVER_AGENT_ID, by: "den" as const }),
            allowed: (auto ? "auto" : "person") as "auto" | "person",
            fromVersion: engineVersion() ?? "?",
            fromPid: process.pid,
            at: new Date().toISOString(),
          };
          writeRestartMarker(stateDir, marker);
          return { path: restartMarkerPath(stateDir), marker };
        },
        ...(o?.stableNotOlder ? { stableNotOlder: true } : {}),
        // Issue 562 review: Den's own auto update reads the wait again.
        ...(auto && autoRestartHold ? { beforeRestart: autoRestartHold } : {}),
        restart: () => {
          serverLog(`↻ update restart asked by ${by}: ${reason}`, "lifecycle");
          setTimeout(() => {
            try {
              spawnDetachedWebRestart(PORT);
            } catch (e) {
              serverLog(
                `  ⚠ web restart failed to spawn: ${(e as Error).message}`,
              );
            }
          }, 250);
        },
        port: PORT,
        pid: process.pid,
        waitMs,
      });
      audit(
        res.ok
          ? `Den ${res.from} → ${res.to}: installed, doctor ran, restarting (the watch rolls back if ${res.to} isn't up in ${Math.round(waitMs / 1000)} s)`
          : `not updated: ${res.error}`,
      );
      return res;
    },
    // Issue 565: an agent files a report as the page does (public: Allow).
    report: reportHeld(reportRouteDeps()),
    // Issue 816: set up a test install's test person on this computer.
    testPersonSetup: testPersonSetupAction(testPersonSetupDeps()),
    // Issue 160: an agent asks to bring a conversation in (asks by default).
    agentImport: (a) => runAgentImport(agentWebDeps(), a),
    // Issue 1328: an agent brought in outside the sandbox needs the person.
    agentImportSandbox: (persona) => {
      try {
        return importSandboxOff(agentWebDeps(), persona);
      } catch {
        return null;
      }
    },
    // Issue 160: an agent closes a stale or superseded pull request after
    // a Hub note (auto unless the repo is watched or pinned).
    prClose: async ({ repo, pr, comment }) => {
      const r = await runGh([
        "pr",
        "close",
        String(pr),
        "--repo",
        repo,
        "--comment",
        comment,
      ]);
      return r.code === 0
        ? { ok: true, repo, pr }
        : {
            ok: false,
            error: `gh pr close: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`,
          };
    },
    // Issue 160: an agent asks to change the approval policy (always asks).
    approvalPolicy: {
      read: (project) => {
        if (!project) {
          const v = readUserConfig().approvals;
          return v && typeof v === "object"
            ? (v as Record<string, unknown>)
            : undefined;
        }
        const all = readWorkspacesFile().workspaces ?? {};
        if (!Object.hasOwn(all, project))
          throw new Error(`there is no project "${project}"`);
        const v = all[project].approvals;
        return v && typeof v === "object"
          ? (v as Record<string, unknown>)
          : undefined;
      },
      write: (project, setting) => writeApprovals(project, setting),
    },
    // SRV-P1: an agent asks to add an agent to a project.
    agentCreate: {
      check: (a, who) => checkAgentCreate(agentWebDeps(), a, who),
      run: (a) => createAgent(agentWebDeps(), a),
    },
    // #267: Den's own agent asks to set, change or clear Hub's address.
    hubAddress: {
      check: (a, who) =>
        checkHubAddress(
          { readUser: () => readUserConfig() as Record<string, unknown> },
          a,
          who,
        ),
      run: (a) =>
        runHubAddress(
          {
            readUser: () =>
              structuredClone(readUserConfig()) as Record<string, unknown>,
            writeUser: (u) => writeUserConfig(u as UserConfig),
            disconnect: async (force) => {
              const m = await import("./hub-connect.js");
              return new m.HubConnect().disconnect(force);
            },
            // Issue 726: the old Hub's state is archived, its bell cleared.
            changed: async (url) => {
              const m = await import("./hub-change.js");
              return m.noteHub(await m.defaultHubChangeDeps(), { url });
            },
            // The restart den_restart_server runs (its note, audit, spawn).
            restart: (reason) =>
              actions.den_restart.run({ reason }) as Promise<{
                ok: boolean;
                error?: string;
              }>,
          },
          a,
        ),
    },
    // Issue 271: an agent asks Hub for a new project to link a project to.
    hubCreate: {
      check: (a, who) => {
        const look = hubCreateLook();
        return look
          ? checkHubCreateHeld(look, a, who)
          : { ok: false, error: "this Den can't read its projects here" };
      },
      run: async (a, asked) =>
        runHubCreateHeld(await defaultHubCreateDeps(), a, asked, agentNameOf),
    },
    // Issue 647: an agent asks to link a project to an existing Hub project.
    hubLink: {
      check: async (a, who) =>
        checkHubLinkHeld(
          { ...(await defaultHubLinkHeldDeps()), personal: isPersonalInstall },
          a,
          who,
        ),
      run: async (a, asked) =>
        runHubLinkHeld(await defaultHubLinkHeldDeps(), a, asked),
    },
    // SRV-P4: an agent asks to set a project's mode, or move an agent.
    projectMode: {
      check: (a, who) => checkProjectMode(agentWebDeps(), a, who),
      run: (a) => runProjectMode(agentWebDeps(), a),
    },
    // Issue 335: an agent asks to add an HTTP MCP server to a project.
    projectMcp: {
      check: (a, who) => checkProjectMcpAdd(agentWebDeps(), a, who),
      run: (a) => runProjectMcpAdd(agentWebDeps(), a),
    },
    // Issue 352: an agent asks to remove one, or change its url or bearer.
    projectMcpRemove: {
      check: (a, who) => checkProjectMcpRemove(agentWebDeps(), a, who),
      run: (a) => runProjectMcpRemove(agentWebDeps(), a),
    },
    projectMcpUpdate: {
      check: (a, who) => checkProjectMcpUpdate(agentWebDeps(), a, who),
      run: (a) => runProjectMcpUpdate(agentWebDeps(), a),
    },
    agentFolder: {
      check: (a, who) => checkAgentFolder(agentWebDeps(), a, who),
      run: (a) => runAgentFolder(agentWebDeps(), a),
    },
    // Issue 199: an agent asks to make another follow its project's mode;
    // Den's mode check restarts it after its turn, same conversation.
    // Issue 334: Settings › Embedding's app keys, on the person's Allow.
    appKeys: appKeyOps({
      settings: () => embedSettings(readUserConfig()),
      stateDir: () => getStateDir(),
      serverKeys: () => ServerKeys.at(getStateDir()),
    }),
    // Issue 621: a gate-only token for a CI runner, on the person's Allow.
    gateRunnerToken: gateRunnerTokenOp({
      runners: () => RunnerTokens.at(getStateDir()),
    }),
    // Issue 625: an agent asks to add or remove a test box; the person allows.
    ...(() => {
      const box = gateBoxOps({
        store: () => gates(),
        personal: isPersonalInstall,
      });
      return { gateBoxSet: box.set, gateBoxRemove: box.remove };
    })(),
    // Issue 869: Den's own agent proposes the address; the person Allows.
    webUrlSet: webUrlSetAction(webUrlSetDeps()),
    // Issue 731: doctor's fix for a terminal host Den couldn't restart:
    // the web start's refresh (wait for idle, restart, resume, audit).
    terminalHostRestart: hostRestartOp({
      refreshing: terminalHostRefreshing,
      personal: isPersonalInstall,
      // Issue 1403: any agent mid-turn (or a background job it started).
      turnsRunning: async () => {
        const d = agentWebDeps();
        return (await busyAgentHolds(d, await runningAgentIds(d))).length > 0;
      },
      waitSeconds: () => {
        try {
          return readSessionsConfig().hostRestartWaitSeconds;
        } catch {
          return 900;
        }
      },
      start: (o) =>
        refreshTerminalHost(
          agentWebDeps(),
          (line) => serverLog(line, "lifecycle"),
          "held",
          o ?? {},
        ),
      log: (line) => serverLog(line, "lifecycle"),
      hold: (card, agent) =>
        holdForPerson("host_restart", card as HeldCheck, agent),
    }),
    agentMode: {
      check: (a, who) => checkAgentMode(agentWebDeps(), a, who),
      run: (a) =>
        runAgentMode(agentWebDeps(), a, {
          apply: () =>
            import("./agent-routes.js").then((m) => m.applyModesNow()),
        }),
    },
    // Issue 1328: one agent's sandbox off (the person's own Allow) or on.
    agentSandbox: agentSandboxHeldOp(),
    settingChange: settingChangeHeldOp(),
    gateSettings: gateSettingsHeldOp(),
    // #176: the pin commit, when the approval policy holds it.
    pinCommit: pinCommitHeldOp(),
    // Issue 936: the rollout's Turn on, for agents from before the sandbox.
    sandboxOn: sandboxOnServerOp(),
    // Issue 208: a Verify run on a shared environment.
    verifyRun: {
      check: (a, who) => checkVerifyRun(verifyDeps(), a, who),
      // Issue 209: its record says who asked and who allowed it.
      run: (a, asked) => runVerify(verifyDeps(), a, {}, asked),
    },
    // SRV-P3: clones go where Den finds repos.
    reposRoot: () => getReposRoot(),
    // SRV-P2: an agent asks to add or change a persona.
    personas: {
      checkCreate: (a, who) => checkPersonaCreate(agentWebDeps(), a, who),
      create: async (a) => ({
        ok: true,
        persona: await runPersonaCreate(agentWebDeps(), a),
      }),
      checkUpdate: (a, who) => checkPersonaUpdate(agentWebDeps(), a, who),
      update: async (a) => ({
        ok: true,
        persona: await runPersonaUpdate(agentWebDeps(), a),
      }),
    },
  });
  approvals = {
    actions,
    // Issue 746: one that lapses unanswered rings the bell and tells its asker.
    // Issue 742: it waits held_writes.wait_minutes (read per ask), and
    // what waits is kept under the state dir: a restart brings it back,
    // and what it can't bring back is lost, out loud.
    queue: createApprovalQueue(actions, () => getStateDir(), {
      ttlMs: () => heldWriteWaitMinutes() * 60_000,
      file: path.join(getStateDir(), HELD_WRITES_FILE),
      onExpire: (a) => void heldWriteLapsed(a),
      onLost: (a, why) => void heldWriteLost(a, why),
    }),
    // Read per ask: a config edit takes effect without a restart. A bad
    // value throws, and the handler holds nothing then.
    enabled: () => readMcpConfig().approvals,
    // SRV-1a: the server agent's own restart, per server_agent.self_update.
    // A project's agent's den_update always waits for a person.
    autoAllow: (action, agent, workspace) =>
      selfUpdateAutoAllow(action, agent, workspace, selfUpdateAuto),
    // Issue 160: the approval policy, the person's (user.yml) and each
    // project's (workspaces.yml), read per ask. A bad value throws: held.
    // Issue 160: what the write is on, against what the person watches
    // (approvals.watch) and pinned to the rail (their favorites).
    // Issue 1391: personal (the default) or strict, read per ask.
    installMode: () => installModeOf(readUserConfig()),
    policy: (action, project, widens, ask) => {
      const user = readUserConfig();
      // Den Builder's call (issue 1391): an explicit self_update: ask is
      // the person's say on a restart, on a personal install too.
      // Issue 1403: den_update follows server_agent.self_update, too.
      if (selfUpdateAsks(action, readServerAgentConfig))
        return { kind: "ask", from: "server_agent.self_update: ask" };
      return policyFor(action, {
        widens,
        mode: installModeOf(user),
        ...(ask?.category ? { setting: { category: ask.category } } : {}),
        areas: ask?.areas,
        install: readPolicySetting(user.approvals),
        project: project ? projectPolicy(project) : undefined,
        targets: writeTargets(action, ask?.args ?? {}, project),
        pins: pinsAsWatched(pinnedItems(shellPrefs(user.shell).pins)),
      });
    },
    notify: (a, project) => notePolicyRun(notificationDeps().store, a, project),
    // Issue 172: a write held for the person's Allow alerts them.
    held: (agent, project) =>
      void alertFeed().needs({ agent, workspace: project ?? "", why: "allow" }),
    // Issue 142: a held write counts in the bell while it waits.
    changed: syncHeldWrites,
    // Issue 1016: an agent's held write carries its full Allow link.
    webUrl: () => peopleWebUrl(),
  };
  return approvals;
}
/**
 * Issue 142: the bell's held-write items made to match what waits now
 * (held-bell.ts). Best effort: the queue and the Allow dialog have it.
 */
function syncHeldWrites(): void {
  try {
    syncHeldBell(
      notificationDeps().store,
      approvals ? approvals.queue.pending() : [],
      { projectOf: heldProjectOf },
    );
  } catch {
    /* the bell is best effort */
  }
}
/** The project a held write is in: its args', else its asking agent's. */
function heldProjectOf(a: Approval): string | undefined {
  return typeof a.args.project === "string"
    ? a.args.project
    : a.agent
      ? (readAgentRecord(getStateDir(), a.agent)?.workspace ?? undefined)
      : undefined;
}
/**
 * Issue 746: a held write lapsed unanswered. The bell says so, and the
 * agent that asked is told in its session once it is at its prompt (never
 * into a dialog for its person), as Den's own "Server is back" line is
 * (tellBack, up to ui.restart_wait_seconds). One audit row says who was
 * told what.
 */
async function heldWriteLapsed(a: Approval): Promise<void> {
  let store: ReturnType<typeof notificationDeps>["store"];
  try {
    store = notificationDeps().store;
  } catch {
    return;
  }
  const told = await heldLapsed(a, {
    store,
    projectOf: heldProjectOf,
    tell: tellHeldAsker,
  });
  try {
    recordAction(
      null,
      {
        verb: "approval-expired",
        detail: `lapsed unanswered: ${a.action}: ${a.summary} [${a.id}]; ${a.actor} ${told}`,
      },
      a.actor,
    );
  } catch {
    /* the trail is best effort here */
  }
}
/**
 * Issue 746: tells a held write's asking agent `text` in its session once
 * it is at its prompt (never into a dialog for its person), as Den's own
 * "Server is back" line is (tellBack, up to ui.restart_wait_seconds).
 */
async function tellHeldAsker(agent: string, text: string): Promise<string> {
  const ops = await import("../cli/agent-ops.js");
  const { webDeps } = await import("./agent-routes.js");
  const d = webDeps();
  const server = agent === SERVER_AGENT_ID;
  return tellBack(text, {
    state: () =>
      server
        ? ops.serverAgentInputState(d)
        : ops.agentInputState(d, agent, typingHeldIds()),
    type: (t) => ops.typeIntoAgent(d, agent, t),
    dialog: () =>
      server
        ? ops.serverAgentDialogOpen(d)
        : ops.agentDialogKind(d, agent).then((k) => k !== null),
    waitMs: restartWaitSeconds() * 1000,
  });
}
/** Issue 742: the held-write queue's file, under the state dir. */
const HELD_WRITES_FILE = "held-writes.json";
/**
 * Issue 742: a restart could not bring back a held write (or, the queue
 * file unreadable, any). The bell says so, the asking agent is told, and
 * one audit row says what was lost and who was told.
 */
async function heldWriteLost(a: Approval | null, why: string): Promise<void> {
  let told = "nobody told";
  try {
    told = await heldLost(a, why, {
      store: notificationDeps().store,
      projectOf: heldProjectOf,
      tell: tellHeldAsker,
    });
  } catch {
    /* the bell is best effort; the trail below still says it */
  }
  try {
    recordAction(
      null,
      {
        verb: "approval-lost",
        detail: a
          ? `lost at a restart: ${a.action}: ${a.summary} [${a.id}] (${why}); ${a.actor} ${told}`
          : `lost at a restart: ${why}`,
      },
      a?.actor,
    );
  } catch {
    /* the trail is best effort here */
  }
}
/**
 * Issue 142: at the start and every few seconds while any wait (one that
 * expired: its item goes). Issue 742: the queue is made at the start, so
 * what waited before a restart is read back and shows in the bell.
 */
/**
 * Issue 1328: agent_sandbox_set on this install: the agent's record, the
 * resolved agents config, the one user.yml key, the note in the state
 * folder, and Restart after its turn (the conversation kept).
 */
function agentSandboxHeldOp() {
  const deps = (): SandboxSetDeps => ({
    record: (id, project) => agentRecord(agentWebDeps(), id, project),
    agentsConfig: () => readAgentsConfig(),
    write: (id, on) => setUserAgentSandbox(id, on),
    note: (id, n) => writeSandboxNote(getStateDir(), id, n),
    restart: (id, project) =>
      restartAgent(agentWebDeps(), id, project, "after-turn").catch((e) => {
        serverLog(
          `  ⚠ agent_sandbox_set: ${id} didn't restart: ${(e as Error).message}. Restart it from the Agents page`,
          "warn",
        );
      }),
    now: () => new Date().toISOString(),
  });
  return {
    check: (
      a: Record<string, unknown>,
      who?: { agent?: string; project?: string },
    ) => checkAgentSandboxSet(deps(), a, who),
    run: (a: Record<string, unknown>, asked?: { agent?: string }) =>
      runAgentSandboxSet(deps(), a, asked),
  };
}

/**
 * Issue 1371: setting_change on this install: the person's user.yml, a
 * backup in the state folder, and the server's audit. The card and args
 * only go to the queue: never the file's text.
 */
function settingChangeHeldOp() {
  const deps = () =>
    settingChangeDeps({
      userFile: userConfigPath(),
      stateDir: getStateDir(),
      audit: (detail, reason) =>
        auditConfig({
          verb: "config-write",
          detail,
          ...(reason ? { reason } : {}),
        }),
    });
  return {
    check: (a: Record<string, unknown>, who?: { agent?: string }) => {
      const c = checkSettingChange(deps(), a, who);
      if (!c.ok) return c;
      const { text: _t, before: _b, kind: _k, ...card } = c;
      return card;
    },
    // Issue 1391: who decided (auto:… is the policy) moves a cap's baseline.
    run: async (
      a: Record<string, unknown>,
      asked?: { agent?: string; decidedBy?: string },
    ) =>
      runSettingChange(deps(), a, {
        ...(asked?.agent ? { agent: asked.agent } : {}),
        ...(asked?.decidedBy ? { decidedBy: asked.decidedBy } : {}),
      }),
  };
}

/**
 * Issue 1395: gate_settings_set on this install: the gate's settings in
 * effect, the install's mode and the person's Limits choice (read per
 * ask), and the gate's one writer under its lock.
 */
function gateSettingsHeldOp() {
  const deps = (): GateSettingsSetDeps => {
    const user = readUserConfig();
    // den.yml and user.yml; never throws (a bad value is strict).
    const mode = installModeOf(user);
    return {
      settings: (patch) => gates().settings(patch),
      write: async (patch, by) => {
        await gateLocked(() => gates().writeSettings(patch, by));
      },
      installMode: () => mode,
      kind: (key, value, before) => settingKind(key, mode, value, before),
      choices: () => readPolicySetting(user.approvals)?.settings,
    };
  };
  return {
    check: (a: Record<string, unknown>) => checkGateSettingsSet(deps(), a),
    run: async (
      a: Record<string, unknown>,
      asked?: { agent?: string; decidedBy?: string },
    ) => runGateSettingsSet(deps(), a, asked),
  };
}

/** Issue 936: den_sandbox_on, counting the agents from before it now. */
function sandboxOnServerOp(): ReturnType<typeof sandboxOnHeldOp> {
  return sandboxOnHeldOp({
    count: () =>
      legacyAgentIds(listAgentRecords(getStateDir()), readAgentsConfig())
        .length,
    turnOn: () => setUserSandboxOn(),
    personal: isPersonalInstall,
  });
}

/**
 * Issue 936, the rollout: Den asks once, as a held write in the bell, to
 * turn the sandbox on for agents from before it; then each hour, should
 * the person have let it lapse. Best effort.
 */
function startSandboxOnAsk(): void {
  const ask = () => {
    try {
      const ap = approvalDeps();
      void askSandboxOn(ap.queue, sandboxOnServerOp()).then((asked) => {
        if (asked) syncHeldWrites();
      });
    } catch {
      /* no queue here: doctor still says it */
    }
  };
  ask();
  setInterval(ask, 60 * 60_000).unref();
}

function startHeldWritesBell(): void {
  let shown = true;
  try {
    approvalDeps();
  } catch {
    /* made on first use instead; the bell follows then */
  }
  syncHeldWrites();
  setInterval(() => {
    const n = approvals ? approvals.queue.pending().length : 0;
    if (!n && !shown) return;
    syncHeldWrites();
    shown = n > 0;
  }, 5000).unref();
}
/** Issue 160: Settings' approval policy rows, as /api/settings answers them. */
export function approvalsSettings(
  raw: unknown,
  mode: InstallMode = "strict",
): {
  approvals_policy: string | null;
  approvals_watch: string[];
  approvals_critical: string[];
  approvals_settings: ReturnType<typeof approvalsView>["settings"];
} {
  const v = approvalsView(raw, mode);
  return {
    approvals_policy: v.policy,
    approvals_watch: v.watch,
    approvals_critical: v.critical,
    approvals_settings: v.settings,
  };
}

/** Issue 1391: the install's mode for Settings; a bad value says strict. */
/**
 * Issue 1391: den.yml's install_mode, for the mode; strict when the
 * distribution's config can't be read (fails closed).
 */
function denModeConfig(): Pick<DenConfig, "install_mode"> {
  try {
    return { install_mode: readDenConfig().install_mode };
  } catch {
    return { install_mode: "strict" };
  }
}
/** Issue 1391: Den's config for the caps' values in force ({} unreadable). */
function denForCaps(): DenConfig {
  try {
    return readDenConfig();
  } catch {
    return {} as DenConfig;
  }
}
/**
 * Issue 1403: a routine run that stopped (a turn started, or the version
 * npm gives is older or a prerelease) waits for the person instead: the
 * same ask, pending in the bell, for the agent that asked.
 */
function holdForPerson(action: string, card: HeldCheck, agent?: string): void {
  if (!card.ok) return;
  try {
    approvalDeps().queue.request({
      actor: agent ? `agent:${agent}` : "den",
      ...(agent ? { agent } : {}),
      action,
      args: card.args,
      summary: card.summary,
      params: card.params,
      details: card.details,
      ...(card.detailKeys?.length ? { detailKeys: card.detailKeys } : {}),
    });
    syncHeldWrites();
  } catch (e) {
    serverLog(
      `  ⚠ ${action}: not held for the person: ${(e as Error).message}`,
      "lifecycle",
    );
  }
}
/** Issue 1403: the install is personal; a throw means strict. */
function isPersonalInstall(): boolean {
  try {
    return installModeOf(readUserConfig()) === "personal";
  } catch {
    return false;
  }
}
/** Issue 1391: the install's mode (den.yml and user.yml); never throws. */
function installModeOf(user: UserConfig): InstallMode {
  return readInstallMode(user, denModeConfig());
}
/**
 * Issue 160: write the approval policy, the install's (user.yml) or one
 * project's (workspaces.yml); undefined clears it. Checked first.
 */
function writeApprovals(
  project: string | undefined,
  setting: Record<string, unknown> | undefined,
): void {
  const checked = setting
    ? readPolicySetting(
        setting,
        project ? `workspaces.${project}.approvals` : "approvals",
      )
    : undefined;
  const empty = !checked || Object.keys(checked).length === 0;
  if (!project) {
    const user = readUserConfig();
    if (empty) delete user.approvals;
    else user.approvals = checked;
    writeUserConfig(user);
    return;
  }
  const file = readWorkspacesFile();
  const ws = file.workspaces?.[project];
  if (!ws) throw new Error(`there is no project "${project}"`);
  if (empty) delete ws.approvals;
  else ws.approvals = checked;
  writeWorkspacesFile(file);
}
/**
 * #176: commit and push (or open a pull request for) the pin of `version`
 * (pin-commit.ts). `policy`: the approval policy decides first, and a
 * held den_pin_commit waits for the person; the Allow's own run passes
 * false.
 */
async function runPinCommit(
  version: string,
  policy: boolean,
): Promise<import("./pin-commit.js").PinStep> {
  const pc = await import("./pin-commit.js");
  const mode = readServerAgentConfig().pinCommit;
  if (mode === "off")
    return { did: "skipped", version, why: "server_agent.pin_commit: off" };
  let signingKey: string | undefined;
  try {
    signingKey = readAgentsConfig().git?.signingKey;
  } catch {
    signingKey = undefined;
  }
  return pc.commitPin(version, {
    root: getDistRoot(),
    stateDir: getStateDir(),
    git: pc.pinGit(getDistRoot(), { signingKey }),
    mode,
    ...(policy
      ? {
          allow: () => {
            try {
              return policyFor("den_pin_commit", {
                install: readPolicySetting(readUserConfig().approvals),
              }).kind === "ask"
                ? "ask"
                : "run";
            } catch {
              // A policy Den can't read holds the write (never runs unasked).
              return "ask";
            }
          },
          ask: async (v: string) => {
            const ap = approvalDeps();
            const ok = await ap.actions.den_pin_commit.check({ version: v });
            if (!ok.ok) return false;
            try {
              const a = ap.queue.request({
                actor: "den:update-check",
                action: "den_pin_commit",
                args: ok.args,
                summary: ok.summary,
                params: ok.params,
                details: ok.details,
                ttlMs: updateAskTtlMs(),
              });
              recordAction(null, {
                verb: "approval-ask",
                detail: `den_pin_commit: ${a.summary} [${a.id}]`,
              });
              return true;
            } catch {
              return false;
            }
          },
        }
      : {}),
  });
}

/** #176: den_pin_commit, held for the person when the policy says ask. */
function pinCommitHeldOp(): import("./held-actions.js").HeldOp {
  return {
    check: (a) => {
      const version = typeof a.version === "string" ? a.version.trim() : "";
      if (!semver.valid(version))
        return { ok: false, error: "version: one like 0.4.44" };
      if (version !== engineVersion())
        return {
          ok: false,
          error: `this Den runs ${engineVersion() ?? "?"}, not ${version}`,
        };
      let mode: string;
      try {
        mode = readServerAgentConfig().pinCommit;
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      if (mode === "off")
        return { ok: false, error: "server_agent.pin_commit is off" };
      return {
        ok: true,
        args: { version },
        summary: `commit the distribution's pin to Den ${version}`,
        params: { version },
        // Issue 205: each Review line in the page's language.
        ...reviewLines([
          mode === "pr"
            ? line(
                `Den commits package.json and package-lock.json on the branch den/pin-${version} and opens a pull request.`,
                "ap.det.den_pin_commit.pr",
                { version },
              )
            : line(
                "Den commits package.json and package-lock.json and pushes them to the branch's upstream.",
                "ap.det.den_pin_commit.push",
              ),
          line(
            "Nothing else in the distribution's folder is committed.",
            "ap.det.den_pin_commit.only",
          ),
        ]),
      };
    },
    run: async (a) => {
      const step = await runPinCommit(String(a.version), false);
      void pinBellNotice(step);
      const ok =
        step.did === "pushed" ||
        step.did === "pr" ||
        step.did === "clean" ||
        step.did === "done";
      return ok
        ? { ok: true, step }
        : { ok: false, error: JSON.stringify(step) };
    },
  };
}

/** #176: the bell for the pin step: one item, the newest replacing it. */
async function pinBellNotice(
  step: import("./pin-commit.js").PinStep,
): Promise<void> {
  try {
    const { pinBellMessage } = await import("./pin-commit.js");
    const m = pinBellMessage(step, product().title);
    if (!m) return;
    const store = notificationDeps().store;
    const subject = "record:den-pin";
    store.withdraw(subject, "service");
    store.add({
      kind: "service",
      subject,
      scope: "workspace/den-server",
      text: m.text,
      msg: { key: m.key, vars: m.vars },
      link: m.link,
    });
  } catch {
    /* the bell is best effort */
  }
}

/** Issue 160: project `ws`'s own approval policy (workspaces.yml), checked. */
function projectPolicy(ws: string) {
  const all = readWorkspacesFile().workspaces ?? {};
  return Object.hasOwn(all, ws)
    ? readPolicySetting(all[ws].approvals, `workspaces.${ws}.approvals`)
    : undefined;
}
/**
 * SRV-1a/1b: server_agent.self_update is auto. Read per ask; a config Den
 * can't read holds the ask for the person (never runs it unasked).
 */
function selfUpdateAuto(): boolean {
  try {
    return readServerAgentConfig().selfUpdate === "auto";
  } catch {
    return false;
  }
}
/** Issue 208: what Verify's plan and run read (verify-routes.ts). */
function verifyDeps(): VerifyServerDeps {
  return {
    stateDir: () => getStateDir(),
    projectExists: (p) => !!getWorkspaceByName(p),
    focusedProject: () => getFocusedWorkspaceName(),
    repos: (p) => listReposWithManifests(p),
    environments: () => orgEnvironments(),
    // Issue 441: verify.environments and verify.import, read per request.
    verifyConfig: () => readDenConfig().verify,
  };
}
/** Issue 214: Verify's schedules, on top of the verify deps. */
function scheduleDeps(): ScheduleServerDeps {
  return {
    ...verifyDeps(),
    projects: () => workspaceNames(),
    bell: (n) => {
      notificationDeps().store.add(n);
    },
    log: (l) => serverLog(`  ${l}`, "warn"),
  };
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

/**
 * The agents a Hub delivery or tools note waits for: a held Allow, a
 * permission prompt or an ask_human question. Not an idle one ("input").
 */
function typingHeldIds(): Set<string> {
  return typingHeld(
    attentionWaiting(),
    approvals ? approvals.queue.waitingActors() : [],
    // Issue 278: held after a compaction loop (agent_context.pause_after_loop).
    pausedAgents(),
  );
}

/** Issue 701: the agents Hub deliveries wait for (an asked question isn't one). */
function deliveryHeldIds(): Set<string> {
  return deliveryHeld(
    attentionWaiting(),
    approvals ? approvals.queue.waitingActors() : [],
    pausedAgents(),
  );
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

/**
 * Issue 334: what `agent` waits on for its person (a held Allow, a
 * permission prompt, an ask_human question, a pause after a compaction
 * loop), or null. An idle agent ("input") waits on nobody.
 */
function embedWaitingOf(agent: string): EmbedWaiting | null {
  const why = waitingReasons().get(agent);
  if (why && why !== "input") {
    const d = attentionDetail(agent);
    return { why, ...(d ? { what: d.what, since: d.since } : {}) };
  }
  if (pausedAgents().has(agent)) return { why: "paused" };
  return null;
}

/** A test module's name as a run takes it (SEC-1 §6b.2): never a path out. */
const SAFE_MODULE_RE = /^[A-Za-z0-9_@][A-Za-z0-9._@/-]{0,127}$/;

// ── Server ────────────────────────────────────────────────────────────────────

/** Issue 144: the machine's gate slots, opened on first use. */
let gateStore: GateStore | undefined;
// Issue 1339: the server's store never waits on the gate-slot lock on its
// one thread (lockWaitMs 0); its callers wait by timer, with gateLocked.
// Issue 1349: and its swap and free-memory readings never start a process
// synchronously (read in the background, the last value meanwhile).
const gates = (): GateStore => {
  if (gateStore) return gateStore;
  // Issue 1349: a failed reading's last good value stands for the setting.
  const keepMs = () =>
    (gateStore?.settings().memoryReadingKeepSeconds ?? 30) * 1000;
  gateStore = new GateStore({
    lockWaitMs: 0,
    swap: serverSwapUsedGb({ keepMs }),
    free: serverFreeMemory({ keepMs }),
  });
  return gateStore;
};

/**
 * Issue 163 (b): the Settings row's view of the agents' sign-in token:
 * whether one is configured, when it was set, the store's credential in
 * the keychain. Never the token; nothing is read from the store.
 */
/**
 * Issue 163 (dev.2 gate): the row follows what is STORED. 1Password and
 * Doppler are asked whether the item or field holds a value (never shown);
 * the env backend's truth is Den's record of the set. A store is asked at
 * most once per agents.signin_token_check_seconds (user.yml, 300), and
 * again at once after a Save or a Remove.
 */
let signinViewCache: {
  at: number;
  view: Record<string, unknown> | null;
} | null = null;

function signinCheckMs(): number {
  try {
    const v = Number(
      (readUserConfig().agents as Record<string, unknown> | undefined)
        ?.signin_token_check_seconds,
    );
    return (Number.isFinite(v) && v >= 0 ? v : 300) * 1000;
  } catch {
    return 300_000;
  }
}

async function agentSigninView(
  fresh = false,
): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  if (!fresh && signinViewCache && now - signinViewCache.at < signinCheckMs())
    return signinViewCache.view;
  let view: Record<string, unknown> | null;
  try {
    const st = await agentTokenStatus({
      env: process.env,
      stateDir: getStateDir(),
      probe: true,
    });
    view = {
      configured: st.configured && st.stored !== false,
      set_at: st.setAt,
      age_days: st.ageDays,
      old: st.old,
      store: st.store,
      // The mode in effect: "token" under the always-on service.
      mode: st.mode,
      // The env backend: the value lives in the web server's process only.
      process_local: st.processLocal === true,
      // No secrets store: the field says so and Save is off.
      no_store: st.noStore === true,
      // The store's credential is a keychain: source (1Password).
      cred_keychain: st.credInKeychain === true,
      // Issue 399: where the token comes from (the runtime catalog).
      runtime: TOKEN_RUNTIME,
      docs: TOKEN_DOCS ?? null,
    };
  } catch {
    view = null;
  }
  signinViewCache = { at: now, view };
  return view;
}

/**
 * Issue 339: Settings' sign-in accounts, per vendor (a runtime with
 * sign-in data), in the person's order. Never a token: from the config and
 * the state dir only.
 */
function agentAccountsView(): {
  runtime: string;
  name: string;
  account: string;
  accounts: Record<string, unknown>[];
}[] {
  const out: {
    runtime: string;
    name: string;
    account: string;
    accounts: Record<string, unknown>[];
  }[] = [];
  for (const id of runtimeIds()) {
    const rt = getRuntime(id);
    if (!rt?.signInTokenEnv) continue;
    try {
      out.push({
        runtime: id,
        name: rt.catalog?.name ?? id,
        // Whose account it is, in the vendor's words ("Claude").
        account: rt.catalog ? accountNameOf(rt.catalog) : id,
        accounts: accountsView(getStateDir(), id).map((a) => ({
          id: a.id,
          name: a.name,
          letter: a.letter,
          configured: a.configured,
          set_at: a.setAt,
          first: a.first,
        })),
      });
    } catch {
      /* a bad list: left out, as nothing is guessed */
    }
  }
  return out;
}

/**
 * Issue 163: the mode of this install's launchd web job (login, always),
 * or null when Den isn't installed as a service (or off macOS).
 */
function installedServiceMode(): "login" | "always" | null {
  if (process.platform !== "darwin") return null;
  try {
    const { label } = readWebServiceConfig(
      readDenConfig(),
      getDistRoot(),
      os.homedir(),
    );
    return (
      serviceJobState(label, os.homedir(), process.getuid?.() ?? 0)?.mode ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * MODE-5: the Settings rows that were the command line's, as GET
 * /api/settings shows them. A save answers them too, so the page redraws
 * a saved row with its new value, not the old one (issue 424).
 */
function cliRowSettings(user: ReturnType<typeof readUserConfig>) {
  return {
    log_window_lines: user.log_window_lines ?? 20_000,
    local_dev: user.local_dev !== false,
    cli_tabs: user.cli_tabs === true,
    // den#85: the crash-loop guard's settings (web.crash_loop_*).
    crash_loop: crashLoopSettings(user.web),
    // 0.4.48: Den on the Docker bridge for the edge (Linux).
    web_bridge: (() => {
      const w = (user.web ?? {}) as Record<string, unknown>;
      return {
        listen: w.bridge_listen === "off" ? "off" : "auto",
        probeSeconds:
          typeof w.bridge_probe_seconds === "number"
            ? w.bridge_probe_seconds
            : 10,
      };
    })(),
    // Issue 406: the start's wait for the owner's GitHub name.
    web_github: (() => {
      const w = (user.web ?? {}) as Record<string, unknown>;
      return {
        ownerNameTimeoutSeconds:
          typeof w.owner_name_timeout_seconds === "number"
            ? w.owner_name_timeout_seconds
            : 10,
      };
    })(),
    // Issue 796: agents' read-only page views (web.agent_view*).
    web_agent_view: (() => {
      const c = webAuthNow();
      return { on: c.agentView, minutes: c.agentViewMinutes };
    })(),
    // Issue 1299: how long a sessions write waits for another's lock.
    web_sessions: (() => {
      const c = webAuthNow();
      return { lockWaitMs: c.sessionsLockWaitMs };
    })(),
    // Issue 819: new-device requests and wrong codes.
    web_pairing: (() => {
      const c = webAuthNow();
      return {
        requestsPerMinute: c.pairRequestsPerMinute,
        approveAttempts: c.approveAttempts,
        approveWindowSeconds: c.approveWindowSeconds,
      };
    })(),
    // den#143: how long `web up` waits for the server.
    web_ready: (() => {
      try {
        const c = readWebAuthConfig(getDistRoot(), product().configFile);
        return {
          probeSeconds: c.readyProbeSeconds,
          startSeconds: c.startWaitSeconds,
        };
      } catch {
        return null;
      }
    })(),
    // Issue 278: agents stuck compacting; instruction size (agent_context.*).
    agent_context: (() => {
      const c = contextWatchSettings(user.agent_context);
      return {
        compaction_loop_count: c.loopCount,
        compaction_loop_minutes: c.loopMinutes,
        pause_after_loop: c.pause,
        instruction_share_percent: c.sharePercent,
        context_tokens: c.contextTokens,
      };
    })(),
    // Issue 609: how long Den's process lookups wait (process_lookup.*).
    process_lookup: (() => {
      const [first, retry] = lookupTimeouts({}, () => user);
      return { first_seconds: first / 1000, retry_seconds: retry / 1000 };
    })(),
    // Issue 532: the terminal limits in force (user.yml over den.yml).
    sessions: (() => {
      try {
        const c = readSessionsConfig(undefined, user);
        return {
          max_concurrent: c.maxConcurrent,
          close_grace_seconds: c.closeGraceSeconds,
          pty_close_seconds: c.ptyCloseSeconds,
          pty_warn_above: c.ptyWarnAbove,
          pty_machine_warn_percent: c.ptyMachineWarnPercent,
        };
      } catch {
        return null;
      }
    })(),
    // Issue 1373: the agents' cap in force (user.yml over den.yml).
    agents_limits: (() => {
      try {
        return {
          max_concurrent: readAgentsConfig(undefined, user).maxConcurrent,
        };
      } catch {
        return null;
      }
    })(),
    // Issue 742: how long a held write waits for the person's Allow.
    held_writes: { wait_minutes: heldWriteWaitMinutes(() => user) },
    // Issue 609: how agents' hooks wait for Den, and retry (agent_hooks.*).
    agent_hooks: (() => {
      const c = hookCallSettings(() => user);
      return {
        timeout_seconds: c.timeoutMs / 1000,
        retries: c.retries,
        backoff_seconds: c.backoffMs / 1000,
      };
    })(),
    // The shared GitHub watcher's pace and API budget (github.*).
    github: (() => {
      const g = githubWatchSettings(user);
      return {
        watch_interval_seconds: g.intervalSeconds,
        watch_max_interval_seconds: g.maxIntervalSeconds,
        api_budget_floor: g.budgetFloor,
        watches_max: g.watchesMax,
      };
    })(),
    // den#156: the Agents list's waits (agents_list.*).
    agents_list: (() => {
      try {
        return agentsListWaits(() => user);
      } catch {
        return null;
      }
    })(),
    // Issue 456: how long Den waits for the shell's PATH.
    // issue_write: which roles write GitHub issues, and how many an hour.
    agent_issue_writes: (() => {
      try {
        const c = issueWriteSettings(() => user, readDenConfig);
        return { roles: c.roles, per_hour: c.perHour };
      } catch {
        return null;
      }
    })(),
    agents_shell: (() => {
      try {
        return {
          path_timeout_seconds: agentsShellPathTimeoutSeconds(() => user),
        };
      } catch {
        return null;
      }
    })(),
    // Issue 1311: how long messages wait on a draft before the bell says so.
    agents_draft: (() => {
      try {
        return {
          hold_max_minutes: agentsDraftHoldMaxMinutes(() => user),
        };
      } catch {
        return null;
      }
    })(),
    // Issue 1225: services.restore_on_boot (0.4.46), on unless set false.
    restore_services_on_boot: (() => {
      try {
        return servicesRestoreOnBoot(() => user);
      } catch {
        return null;
      }
    })(),
    // Issue 1129: the restart queue (agents.resume.*).
    agents_resume: (() => {
      try {
        const r = agentsResume(() => user);
        return {
          batch: r.batch,
          gap_seconds: r.gapSeconds,
          load_ceiling: r.loadCeiling,
          max_wait_seconds: r.maxWaitSeconds,
        };
      } catch {
        return null;
      }
    })(),
    // Issue 415: how long Report keeps, and waits for, a repo's
    // visibility (feedback.*), their defaults when unset.
    feedback: (() => {
      const f = feedbackSettings(null, {}, user.feedback);
      return {
        visibility_cache_hours: f.visibilityCacheHours,
        visibility_timeout_seconds: f.visibilityTimeoutSeconds,
        visibility_retry_seconds: f.visibilityRetrySeconds,
      };
    })(),
    // Issue 455: the address check's limits (web.address_check_*).
    address_check: (() => {
      const a = addressCheckSettings(() => user);
      return {
        timeout_seconds: a.timeoutMs / 1000,
        retries: a.retries,
        cache_seconds: a.cacheMs / 1000,
        drop_after: a.dropAfter,
        unknown_keep_seconds: (a.unknownKeepMs ?? 300_000) / 1000,
      };
    })(),
    // Issue 707: the server's warning lines on disk, capped (server_log.*).
    server_log: { max_mb: serverLogMaxBytes(user) / (1024 * 1024) },
    // Issue 403: how long a filed report's screenshot is kept (reports.*).
    reports: (() => {
      const l = shotLimits(user);
      const MB = 1024 * 1024;
      return {
        screenshot_keep_days: shotKeepDays(user),
        screenshot_max_mb: l.keptBytes / MB,
        hub_screenshot_max_mb: l.hubBytes / MB,
        hub_timeout_seconds: l.hubTimeoutMs / 1000,
      };
    })(),
    // 0.4.46: how a terminal pane reconnects on its own (panes.*).
    panes_reconnect: (() => {
      try {
        return panesReconnect(() => user);
      } catch {
        return null;
      }
    })(),
  };
}

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
  // eslint-disable-next-line no-restricted-syntax -- a base to parse the path against, never dialled
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;
  // Issue 1299 review: a request that may write the sessions file (a
  // sign-in, a sign-out, a revoke; session-writes.ts) waits here, on timers, while another
  // process holds its lock; every other request is served meanwhile. Its
  // write then never waits (a lock taken in between: 503 "try again").
  if (mayWriteSessions(req.method, pathname))
    await webSessions.whenFree(sessionsLockWait());
  // R26: one id per request, on every response and on its failure's log line.
  const requestId = requestIdOf(req);
  if (!res.headersSent) res.setHeader("X-Request-Id", requestId);
  // Issue 103: no page is framed by another site; the embedded agent pane
  // only by the origins Settings › Embedding lists. Before any route, so
  // refusals and error pages carry it too.
  if (!res.headersSent)
    for (const [k, v] of Object.entries(
      frameHeaders(pathname, () => embedSettings(readUserConfig()).origins),
    ))
      res.setHeader(k, v);
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

  // Only the six methods Den serves reach the checks and the routes; any
  // other (OPTIONS included: Den serves no cross-origin requests) is 405.
  if (!SERVED_METHODS.has((req.method ?? "GET").toUpperCase()))
    return sendMethodNotAllowed(res);

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
  // Issue 810: the fixture person stays on this install and never acts
  // as the person (approve, let a browser in, Hub).
  // Issue 814: one of the test operator's acts, on an operator install,
  // on loopback, not through a proxy: let through as that act only, and
  // audited as the test operator. Anything else falls to the fixture
  // person's allow-list below.
  const opAct =
    guard.ok &&
    guard.principal?.kind === "person-browser" &&
    guard.principal.fixture
      ? operatorAct(req.method ?? "GET", pathname)
      : null;
  if (
    guard.ok &&
    opAct &&
    !operatorRefusal({
      operatorInstall: operatorInstallNow(),
      via: guard.via,
      beyond: guard.beyond,
      method: req.method ?? "GET",
      pathname,
      forwarded: hasForwardingHeaders(req.headers),
      edgeLocal: guard.edgeLocal,
    })
  ) {
    markOperatorAct(req, opAct);
    recordAction(
      auditActorOf(req),
      { verb: "test-operator", detail: `${opAct} ${pathname.slice(0, 200)}` },
      OPERATOR_PRINCIPAL,
    );
  } else if (
    guard.ok &&
    guard.principal?.kind === "person-browser" &&
    guard.principal.fixture
  ) {
    const why = fixtureScopeRefusal(
      req.method ?? "GET",
      pathname,
      routeClass(req.method ?? "GET", pathname),
    );
    if (why) {
      recordAction(
        null,
        {
          verb: "fixture-scope",
          detail: pathname.slice(0, 200),
          outcome: "refused",
          reason: "fixture_scope",
        },
        FIXTURE_PRINCIPAL,
      );
      return sendJson(
        res,
        { ok: false, code: "fixture_scope", error: why },
        403,
      );
    }
  }
  // Issue 796: an agent's view reads pages and read-only routes, and
  // nothing else; each page it opens and each refusal names the agent.
  if (
    guard.ok &&
    guard.principal?.kind === "person-browser" &&
    guard.principal.view
  ) {
    const v = guard.principal.view;
    const m = req.method ?? "GET";
    const cls = routeClass(m, pathname);
    // And whatever an agent's own token is refused (agentRefusal), as
    // that agent: a view never reaches more than its agent does.
    const why = guard.beyond
      ? agentViewRefusedText(v.agent)
      : (agentViewScopeRefusal(m, pathname, cls, v.agent) ??
        ((m.toUpperCase() === "GET" || m.toUpperCase() === "HEAD") &&
        agentRefusal(
          viewAgent(v),
          m.toUpperCase(),
          pathname,
          cls ?? "readonly",
          url.searchParams,
        )
          ? agentViewRefusedText(v.agent)
          : null));
    if (why) {
      auditAgentView(
        v.agent,
        v.workspace,
        `${m.toUpperCase()} ${routeTemplate(pathname)}`,
        "agent_view",
      );
      serverLog(
        `  ${logTimestamp()}  ${v.agent} (read-only view) refused ${m.toUpperCase()} ${loggedPath(pathname)}`,
        "request",
      );
      return sendJson(
        res,
        { ok: false, code: "agent_view", error: why, requestId },
        403,
      );
    }
    if (
      (m === "GET" || m === "HEAD") &&
      !pathname.startsWith("/api/") &&
      !STATIC_EXTS.has(path.extname(pathname))
    ) {
      auditAgentView(v.agent, v.workspace, `viewed ${routeTemplate(pathname)}`);
      serverLog(
        `  ${logTimestamp()}  ${v.agent} (read-only view) viewed ${loggedPath(pathname)}`,
        "request",
      );
    }
  }
  // 0.4.45: a browser signed in while the cookie was SameSite=Strict still
  // holds it so. Each signed-in page load gets the same cookie again as Lax
  // (the same session, so its CSRF stays; a session never expires here, so
  // this extends nothing). A route's own Set-Cookie (sign-out) replaces it.
  if (
    guard.ok &&
    guard.principal?.kind === "person-browser" &&
    guard.principal.session &&
    req.method === "GET" &&
    req.headers["sec-fetch-dest"] === "document" &&
    !res.headersSent
  ) {
    const https = httpsOf(req, guard.via);
    const id = sessionCookie(req, https);
    if (id) res.setHeader("Set-Cookie", sessionSetCookie(id, https));
  }
  // The edge brought a proven https request for Den's own address: it
  // works now, so the session lives only there (NAMED).
  if (guard.ok && guard.via === "edge" && httpsOf(req, "edge")) {
    NAMED.saw(hostNameOf(req));
    LOCAL_NAMED.saw(hostNameOf(req));
  }
  if (sendToNamedAddress(req, res, url, guard)) return;
  // SEC-1c (R8): an agent's request never passes the lock.
  if (guard.ok && guard.principal?.kind === "agent") closeLockForThisRequest();
  // BUSY-1: the working pop-up's Check again, and its Try again: a write
  // sent again with the same id runs once (request-ledger.ts).
  if (guard.ok) {
    const owner = ledgerOwner(guard.principal);
    // UK-2 Settled 1: { id, state, result?, error?, finishedAt }.
    // /api/requests/<id> is its old name, kept until 0.4.49.
    const requestStatusPath = /^\/(?:api\/)?requests\/([^/]*)$/.exec(pathname);
    if (req.method === "GET" && requestStatusPath) {
      const id = requestStatusPath[1];
      if (!validRequestId(id))
        return send400(res, "a request id is 8 to 64 letters, digits or -");
      return sendJson(res, { id, ...REQUEST_LEDGER.status(owner, id) });
    }
    if (await ledgerGate(REQUEST_LEDGER, req, res, owner)) return;
  }

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
    if (await personCallerRefused(req, res, guard, pathname)) return;
    let body: { nonce?: unknown; code?: unknown; expiresAt?: unknown } = {};
    try {
      body = (JSON.parse((await readBody(req)) || "{}") ?? {}) as typeof body;
    } catch {
      return send400(res, "the body must be JSON: { nonce, expiresAt }");
    }
    const exp = Number(body.expiresAt);
    const id =
      Number.isFinite(exp) &&
      exp > Date.now() &&
      exp - Date.now() <= LOGIN_CODE_MAX_TTL_MS + 5_000
        ? LOGIN_WAITS.register(
            String(body.nonce ?? ""),
            body.code === undefined ? undefined : String(body.code),
            exp,
          )
        : null;
    if (!id) return send400(res, "not a login link's nonce and expiry");
    res.setHeader("Cache-Control", "no-store");
    // Issue 819: on first run, `web login` prints its code for a browser
    // on another computer to type.
    return sendJson(res, { ok: true, id, firstRun: !FIRST_RUN.done() });
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
    // Signed in, it goes on to a same-origin `next`; signed out, here on
    // this machine too (0.4.71), it is the signed-out page (never a form
    // for the secret).
    // D67: `again=1` (the approvals banner's Sign in): the sign-in page
    // even with a session, or on loopback: approving needs a signed-in
    // browser with an approval key, which a browser without one (signed
    // in before 0.4.15, its storage cleared, or never) gets here.
    const again = url.searchParams.get("again") === "1";
    if (
      guard.ok &&
      (guard.session || guard.principal?.kind === "person") &&
      !again
    ) {
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
  // Issue 144: the machine's gate slots (read; a person ends one early).
  if (guard.ok && isGatePath(pathname)) {
    await handleGateRoutes(req, res, pathname, {
      store: gates,
      title: product().title,
      runners: () => RunnerTokens.at(getStateDir()),
    });
    return;
  }
  // Issue 459: an agent reads its own app feeds (app_feed_read).
  if (guard.ok && isAppFeedPath(pathname)) {
    await handleAppFeedRoutes(req, res, pathname, url);
    return;
  }
  // Issue 796: an agent asks for a read-only view of these pages.
  if (guard.ok && pathname === "/api/agents/self/view") {
    if (req.method !== "POST") return sendMethodNotAllowed(res);
    return handleAgentViewRequest(req, res, guard);
  }
  // issue_write: an agent writes a GitHub issue in its own project's repos
  // (direct and audited; the route checks the role, the repo and the limit).
  if (guard.ok && pathname === ISSUE_WRITE_PATH) {
    await handleIssueWriteRoute(req, res, pathname, issueWriteDeps(req));
    return;
  }
  // NT: the bell, and agents saying they wait for their person.
  if (guard.ok && isNotificationPath(pathname)) {
    await handleNotificationRoutes(req, res, pathname, {
      ...notificationDeps(),
      // Issue 746: what waits for the person's Allow leads Needs you.
      held: () => (approvals ? approvals.queue.pending() : []),
      // Issue 993: a gate slot held past the multiple of its estimate.
      // Issue 1339: read without the gate-slot lock, so a gate run that
      // holds it never stalls the bell (or the server with it).
      gateOverruns: () => bellGateOverruns(gates()),
      // Issue 1223: the agents still on older tools, with Restart N agents.
      toolsOld: () =>
        toolsOldRow(agentWebDeps(), () => staleAgents(agentWebDeps())),
    });
    return;
  }
  // The shared GitHub watcher: an agent's own watches (MCP github_watch).
  if (guard.ok && isGithubWatchPath(pathname)) {
    const { githubWatcher } = await import("./github-watch-service.js");
    const { projectRepos } = await import("../../shared/project-repos.js");
    await handleGithubWatchRoutes(req, res, pathname, {
      watcher: githubWatcher,
      reposOf: projectRepos,
      allRepos: () => [
        ...new Set(
          Object.keys(readWorkspacesFile().workspaces ?? {}).flatMap((ws) =>
            projectRepos(ws),
          ),
        ),
      ],
    });
    return;
  }
  // ON-3: an agent's held writes; Allow from the person's browser only.
  if (
    guard.ok &&
    isApprovalPath(pathname) &&
    (await handleApprovalRoutes(req, res, pathname, guard, approvalDeps()))
  )
    return;
  // Issue 214: Verify's schedules; allowing one or running it now is a person's.
  if (
    guard.ok &&
    isSchedulePath(pathname) &&
    (await handleScheduleRoutes(req, res, pathname, guard, scheduleDeps))
  )
    return;
  // 0.4.15: what lets another browser in needs the person, not just
  // loopback (approvals.ts: an agent with a shell is on loopback too).
  if (req.method === "POST" && PERSON_GRANT_ROUTES.includes(pathname)) {
    if (await personCallerRefused(req, res, guard, pathname)) return;
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
      client: (r) => {
        const g = checkRequest(r, GUARD, product().cli, product().title);
        return g.ok ? g.client : undefined;
      },
      https: (r) => {
        const g = checkRequest(r, GUARD, product().cli, product().title);
        return httpsOf(r, g.ok ? g.via : null);
      },
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

  // Issue 810: Settings › Access, the test install and its fixture person.
  if (pathname === "/api/web/fixture-person")
    return handleFixturePersonRoute(req, res);
  // Issue 1018: the same, from the launcher's one-time setup value.
  if (pathname === "/api/web/fixture-person/setup-secret")
    return handleFixtureSetupSecretRoute(req, res);
  // Issue 816: test installs on this computer waiting for their test person.
  if (pathname === "/api/web/test-installs")
    return handleTestInstallsListRoute(req, res);
  // Issue 816: the same, from a grant your own Den sent at your Allow.
  if (pathname === "/api/web/fixture-person/grant")
    return handleFixtureGrantRoute(req, res);
  // Issue 636: a test bed's CLI starts a --test-person command.
  if (pathname === "/api/web/test-person")
    return handleTestPersonRoute(req, res);

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
      clientName: (c) => meshNameOf(c),
      approver: deviceApproverRefusal,
      linkEnded: (link, how, r) => {
        if (how === "denied") return LOGIN_WAITS.denied(link);
        const g = checkRequest(r, GUARD, product().cli, product().title);
        LOGIN_WAITS.used(link, {
          device: deviceName(r.headers["user-agent"]),
          ...(g.ok && g.client ? { client: g.client } : {}),
        });
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
      res.writeHead(302, { Location: "/verify" });
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
      res.writeHead(302, { Location: "/verify" });
      res.end();
      return;
    }
    return serveFile(
      res,
      path.join(PUBLIC_DIR, "local-dev.html"),
      graphPageHtml,
    );
  }

  // Issue 103: a deep link to one agent, its URL in the composer.
  if (
    handleAgentLink(req, res, pathname, url.searchParams, {
      stateDir: () => getStateDir(),
      workspaceExists: (ws) => Boolean(readWorkspacesFile().workspaces[ws]),
      urlMax: () => embedSettings(readUserConfig()).url_max_chars,
      contextProblem: contextUrlProblem,
      serveAgents: (r) => {
        const bad = sectionConfigError("agents");
        if (bad && wantsHtmlPage(req, pathname)) throw bad;
        serveFile(r, path.join(PUBLIC_DIR, "agents.html"));
      },
      sendProblem: (q, r, p) =>
        sendErrorPage(q, r, {
          status: p.status,
          code: "agent_link",
          path: pathname,
          message: p.message,
          link: {
            reason: p.reason,
            project: p.project,
            agent: p.agent,
            ...(p.max !== undefined ? { max: p.max } : {}),
          },
          requestId,
        }),
    })
  )
    return;

  // Issue 103: the embedded agent pane, its pop-up, its key and its Send.
  if (
    await handleEmbedRoutes(req, res, pathname, {
      settings: () => embedSettings(readUserConfig()),
      agents: () => agentWebDeps(),
      stateDir: () => getStateDir(),
      publicDir: PUBLIC_DIR,
      servePage: (r, file, fill) => serveFile(r, file, fill),
      agentCaller: (q) => !!agentPrincipalOf(q),
      actor: (q) => auditActorOf(q),
      principal: (q) => principalOf(q),
      serverKeys: () => ServerKeys.at(getStateDir()),
      inputState: (id) => agentInputState(agentWebDeps(), id),
      waitingOf: (id) => embedWaitingOf(id),
      relay: async (dv) =>
        (await import("./hub-delivery-service.js")).relayMessage(dv),
    })
  )
    return;

  // Issue 482: an older Terminal link goes to the Terminals page.
  {
    const to = terminalLinkRedirect(pathname, url.searchParams);
    if (to) {
      res.writeHead(302, { Location: to });
      res.end();
      return;
    }
  }
  // Issue 482: the Terminals page, agents.html with its own page id.
  if (pathname === "/terminals") {
    const bad = sectionConfigError("agents");
    if (bad && wantsHtmlPage(req, pathname)) throw bad;
    return serveFile(
      res,
      path.join(PUBLIC_DIR, "agents.html"),
      terminalsPageHtml,
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

  // Issue 209: Verify's page. /tests moved here (people bookmarked it);
  // the older test kinds' page is /test-runs while they retire.
  if (pathname === "/verify" || pathname === "/verify.html") {
    return serveFile(res, path.join(PUBLIC_DIR, "verify.html"));
  }
  if (pathname === "/tests") {
    res.writeHead(301, { Location: "/verify" });
    res.end();
    return;
  }
  if (pathname === "/test-runs" || pathname === "/index.html") {
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
  if (
    handleWebUrlRoutes(req, res, pathname, {
      isAgent: (r) => !!(agentPrincipalOf(r) || auditActorOf(r)),
      read: () => readWebUrl(),
      set: (url, how) => saveWebUrl(url, how),
      who: (r) => principalOf(r),
      ping: (url, ms) => pingHttp(url, ms),
      checkMs: () => webUrlCheckSeconds() * 1000,
      readBody,
      sendJson: (r, body, status) => sendJson(r, body, status),
      aliases: addressAliases,
      here: aliasHere,
      works: () => NAMED.works(),
      owner: adoptOwner,
    })
  )
    return;
  // Issue 455: the identity probe's other end, and the address check.
  if (
    await handleAddressRoutes(req, res, pathname, {
      key: () => {
        const s = webSecret.current();
        return s ? identityKey(s) : null;
      },
      check: () => {
        const s = webSecret.current();
        return checkAddress({
          webPort: PORT,
          wanted: readWebUrl()?.url ?? null,
          key: s ? identityKey(s) : null,
          cli: product().cli,
          settings: addressCheckSettings(),
        });
      },
      edge: async () => {
        let cfg: ReturnType<typeof readEdgeConfig>;
        try {
          cfg = readEdgeConfig();
        } catch {
          return null;
        }
        const container = edgeNames(cfg.org).container;
        let state = "absent";
        try {
          state = containerState(container);
        } catch {
          state = "absent"; // no docker here
        }
        return {
          container,
          state,
          publish: !!cfg.ports,
          ports: cfg.ports
            ? await Promise.all([
                portState(cfg.ports.http),
                portState(cfg.ports.https),
              ])
            : null,
        };
      },
      cacheMs: () => addressCheckSettings().cacheMs,
      setPublishOff: () => {
        const user = readUserConfig() as Record<string, unknown>;
        const edge =
          user.edge &&
          typeof user.edge === "object" &&
          !Array.isArray(user.edge)
            ? (user.edge as Record<string, unknown>)
            : {};
        mergeUserConfig({ edge: { ...edge, publish: false } } as never);
      },
      takeOver: async (container) => {
        const r = edgeSh("docker", ["stop", container]);
        if (r.code !== 0)
          throw new Error(r.err || `docker stop ${container} failed`);
        await runEdgeUp({ log: (l) => serverLog(`  ${l}`, "lifecycle") });
      },
      isAgent: (r) => !!(agentPrincipalOf(r) || auditActorOf(r)),
      log: (l) => serverLog(`  ${l}`, "lifecycle"),
      sendJson: (r, body, status) => sendJson(r, body, status),
    })
  )
    return;
  // #299: Settings › Keep agents running after logout › Sign-in token.
  if (
    handleSignInTokenRoute(req, res, pathname, {
      isAgent: (r) => !!(agentPrincipalOf(r) || auditActorOf(r)),
      save: (token) =>
        saveAgentToken(token, { stateDir: getStateDir(), inDen: true }),
      clear: () => clearAgentToken({ stateDir: getStateDir() }),
      status: () => agentSigninView(true),
      log: (l) => serverLog(`  ${l}`, "lifecycle"),
      readBody,
      sendJson: (r, body, status) => sendJson(r, body, status),
    })
  )
    return;
  // Issue 395: Settings › Access › Start the edge: what `edge up` runs.
  if (
    handleEdgeUpRoute(req, res, pathname, {
      isAgent: (r) => !!(agentPrincipalOf(r) || auditActorOf(r)),
      run: async () =>
        (await runEdgeUp({ log: (l) => serverLog(`  ${l}`, "lifecycle") }))
          .outcome,
      log: (l) => serverLog(`  ${l}`, "lifecycle"),
      sendJson: (r, body, status) => sendJson(r, body, status),
    })
  )
    return;
  // Issue 339: Settings › the sign-in accounts, per vendor.
  if (
    handleAccountsRoute(req, res, pathname, {
      isAgent: (r) => !!(agentPrincipalOf(r) || auditActorOf(r)),
      add: (runtime, name) => void addAccount(getStateDir(), runtime, name),
      order: (runtime, ids) =>
        void setAccountOrder(getStateDir(), runtime, ids),
      // Issue 1182: `agents accounts remove`, through the server.
      remove: async (runtime, account) => {
        const r = await removeAccount({
          runtimeId: runtime,
          accountId: account,
          stateDir: getStateDir(),
          inDen: true,
        });
        await agentSigninView(true);
        return {
          label: accountLabel(r.removed, signInRuntime(runtime).account),
          ...(r.cleared.cleared ? { store: r.cleared.store } : {}),
        };
      },
      saveToken: async (runtime, account, token) => {
        const r = await saveAccountToken(token, {
          runtimeId: runtime,
          accountId: account,
          stateDir: getStateDir(),
          inDen: true,
        });
        // Account one of Claude Code is today's row: asked again at once.
        await agentSigninView(true);
        return r;
      },
      view: () => agentAccountsView(),
      log: (l) => serverLog(`  ${l}`, "lifecycle"),
      readBody,
      sendJson: (r, body, status) => sendJson(r, body, status),
    })
  )
    return;
  // Issue 163: Settings › Keep agents running after logout › Apply.
  if (
    handleKeepRunningRoutes(req, res, pathname, {
      isAgent: (r) => !!(agentPrincipalOf(r) || auditActorOf(r)),
      platform: () => process.platform,
      installed: installedServiceMode,
      sudoReady: () => hasSudoPassword() || hasPasswordlessSudo(),
      current: () => {
        try {
          return agentsKeepRunningAfterLogout();
        } catch {
          return undefined;
        }
      },
      save: (on) => {
        const user = readUserConfig() as Record<string, unknown>;
        const r = patchCliRows(user, { keep_running_after_logout: on });
        if (!r.ok) throw new Error(r.error);
        writeUserConfig(user as UserConfig);
      },
      install: (mode) =>
        cmdService(["install", "--mode", mode], {
          handOff: true,
          // install.sh replaces this server's job: detached, with the
          // sudo shim on its PATH (LK-0).
          run: detachedRunner(
            path.join(getStateDir(), "logs", "service-apply.log"),
            () => getSudoEnv(),
          ),
          log: (l) => serverLog(l, "lifecycle"),
        }),
      cli: product().cli,
      readBody,
      sendJson: (r, body, status) => sendJson(r, body, status),
    })
  )
    return;
  // FB (den#81): Report an issue, filed as the person with their `gh`.
  if (
    handleReportRoutes(req, res, pathname, {
      ...reportRouteDeps(),
      // Issue 403: a kept screenshot is the person's (proved, as approvals
      // ask) or this install's own agent's; never an anonymous request.
      shotReader: (r) => shotReaderOf(r, guard),
      filedByFixture: () =>
        guard.ok &&
        guard.principal?.kind === "person-browser" &&
        guard.principal.fixture === true,
    })
  )
    return;

  // The graph's modules (graph.js, panel.js, …) and vendored libraries (ELK).
  if (serveUiAsset(res, pathname, PUBLIC_DIR)) return;

  if (pathname === "/perf-report.js") {
    return serveFile(res, path.join(PUBLIC_DIR, "perf-report.js"));
  }

  // Imported by header.js (the workspace pill's picker models).
  if (pathname === "/workspace-picker.js") {
    return serveFile(res, path.join(PUBLIC_DIR, "workspace-picker.js"));
  }
  // Issue 168: the project colour picker the scope menu opens.
  if (pathname === "/project-colour-picker.js") {
    return serveFile(res, path.join(PUBLIC_DIR, "project-colour-picker.js"));
  }

  // Issue 644: the kit's site files at the root (/favicon.ico,
  // /favicon.svg, /apple-touch-icon.png, the icons, /site.webmanifest).
  // Issue 172 S2: the app manifest, so a phone can add Den to its home
  // screen (an iPhone gets push only from there); /manifest.webmanifest is
  // its older URL.
  if (
    pathname === "/favicon.ico" ||
    pathname === "/favicon.svg" ||
    pathname === "/apple-touch-icon.png" ||
    pathname === "/icon-192.png" ||
    pathname === "/icon-512.png" ||
    pathname === "/icon-maskable-512.png" ||
    pathname === "/site.webmanifest"
  ) {
    serveSiteFile(res, pathname, product().title);
    return;
  }
  if (pathname === "/manifest.webmanifest") {
    serveSiteFile(res, "/site.webmanifest", product().title);
    return;
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
      res.end(body);
      return;
    } catch {
      return send404(res);
    }
  }

  // ── API: an agent's refused call (F2) ─────────────────────────────────────
  // The MCP server's guards refuse some calls before they reach an action
  // route; it reports them here so the activity trail shows failed attempts.
  // Agents only (the audit header), and the entry is all it can write.
  // Issue 1369: a CLI's audit entry, sent over its own authenticated call
  // (the person token, or an agent's actor token). Recorded as that
  // credential says, at this server's time: the body gives the verb,
  // detail, outcome and reason only, never a who or a when.
  if (pathname === "/api/audit/cli" && req.method === "POST") {
    // Issue 1369: at most 8 KB read; the credential says who sent it.
    const r = await cliAuditRequest(req, {
      principal: principalOf(req),
      actor: auditActorOf(req),
      budget: CLI_AUDIT_BUDGET,
      record: recordSentAuditRow,
      remember: rememberSentAuditCopy,
    });
    return sendJson(res, r.body, r.status);
  }

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

  // ── API: Verify's plan, and a run on local (issue 208) ───────────────────
  if (await handleVerifyRoutes(req, res, pathname, verifyDeps)) return;

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
      return sendJson(res, await collectTestSources(pillar));
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
        if (!repoHasRuntime(svc.repoPath)) continue;
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
    }: (typeof sortedEntries)[number]): Promise<HealthResult> => {
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
    // Issue 1022: a hidden page's poll keeps the answer for the slow interval.
    const ttl = healthCacheTtlMs(url.searchParams.get("hidden") === "1");
    if (hit && Date.now() - hit.at < ttl) {
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
    // Issue 1022: a hidden page's poll keeps the answer for the slow interval.
    const ttl = healthCacheTtlMs(url.searchParams.get("hidden") === "1");
    if (hit && Date.now() - hit.at < ttl) {
      // Cached: replay in one go. Nothing to stagger — it's already known.
      for (const r of hit.results)
        send({ type: "result", result: forViewer(r) });
      send({ type: "done", cached: true });
      res.end();
      return;
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
    res.end();
    return;
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
    if (!readMethodOnly(req, res)) return;
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
    if (!readMethodOnly(req, res)) return;
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
    if (!readMethodOnly(req, res)) return;
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
      const source = await resolveHistorySource(
        repoName,
        svcName,
        env,
        url.searchParams.get("workspace"),
      );
      if (source.kind === "unsupported")
        return sendJson(res, {
          unsupported: true,
          reason: source.reason,
          ...(source.t ? { t: source.t } : {}),
        });
      const snapshot = await ensureSnapshot(source);
      if (!snapshot)
        return sendJson(res, {
          unsupported: true,
          reason: "could not snapshot the container log",
          t: { key: "lg.why.noSnapshot" },
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
    if (!readMethodOnly(req, res)) return;
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
    const project = url.searchParams.get("workspace");
    void Promise.all(
      targets.map((t) => searchSystemHistory(t, q, env, project)),
    ).then((results) => sendJson(res, { q, results }));
    return;
  }

  if (pathname === "/api/service/taillog") {
    if (!readMethodOnly(req, res)) return;
    const repoName = url.searchParams.get("repo");
    const svcName = url.searchParams.get("service");
    if (!repoName || !svcName)
      return send400(res, "repo and service are required");
    // The same names the history and search routes take: they reach a
    // log path (a folder is made for it) and the tail's arguments.
    if (!isSafeServiceName(repoName) || !isSafeServiceName(svcName))
      return send400(res, "invalid repo/service name");

    // Resolve manifest log source. The client names an exact service, so
    // when the manifest has that key, use it directly — resolveService's
    // bare-repo correction rewrites the subsystem to the ENTRYPOINT (a
    // shop/db request would otherwise read api's log source).
    // Issue 235: in the named project, else the focused one, else the one
    // project that lists the repo (several is an error, never a guess).
    const tailFound = resolveServiceInProjects(
      [repoName, `${repoName}/${svcName}`],
      url.searchParams.get("workspace"),
    );
    if (tailFound.error) return send400(res, tailFound.error);
    const tailResolved = tailFound.resolved;
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
    const [tailCmd, tailArgs] = tailArgv(daemonLogPath, LIVE_TAIL_LINES);

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
        "docker",
        ["logs", "-f", "--tail", String(LIVE_TAIL_LINES), container],
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
        tailCmd,
        tailArgs,
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
    if (!readMethodOnly(req, res)) return;
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
    let runSources: TestSource[] = [];
    if (
      pillar === "synthetic" ||
      pillar === "smoke" ||
      pillar === "journeys" ||
      pillar === "security"
    ) {
      try {
        const sources = await collectTestSources(pillar);
        runSources = sources;
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
    // The sources read above (once: no second round of git reads).
    for (const s of runSources) {
      serverLog(`  source: ${formatSourceLine(s)} [${runId}]`, "lifecycle");
    }

    const startTime = Date.now();
    let overallExit = 0;
    // 0.4.17: the server's run history (every browser's runs, kept), which
    // Workspaces' Last test run reads per repo.
    // Every run kind that runs a repo's own tests names it, the suites
    // pillar (`tests:`) and a repo's performance modules included.
    const tested = await reposOfRun(String(pillar), String(env), modules, {
      pillarSources: (p) =>
        testSourceRepos(p as SourcePillar).map((x) => x.repoName),
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

    // The seven old kinds still run, and say what replaces them (issue 207).
    const oldKind = oldKindWarning(pillar);
    if (oldKind) emit({ type: "line", text: oldKind });

    const runStep = (i: number): void => {
      if (i >= steps.length) {
        // The one exit-code table for every kind (issue 207).
        const done = getRunDonePayload({
          pillar,
          exitCode: overallExit,
          duration: Date.now() - startTime,
          rootDir: ROOT,
        });
        finishLifecycle(done.exitCode);
        emit(done);
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
        (exitCode, signal) => {
          if (exitCode !== 0 || signal) {
            if (overallExit === 0) {
              overallExit = exitCode;
            }
            const done = getRunDonePayload({
              pillar,
              exitCode,
              duration: Date.now() - startTime,
              rootDir: ROOT,
              signal,
            });
            if (!step.continueOnFailure || done.cancelled) {
              emit({
                type: "error",
                text: `Step "${step.label}" ${done.cancelled ? "was cancelled" : done.nothingRan ? "ran nothing" : "failed"} (exit ${exitCode}) — aborting`,
              });
              finishLifecycle(
                done.exitCode,
                `step "${step.label}" ${done.verdict}`,
              );
              emit(done);
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
    if (!readMethodOnly(req, res)) return;
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
    // Issue 796: an agent's read-only view: the shell shows it, and no
    // live write buttons. Its CSRF token signs it out only.
    if (
      g?.session &&
      g.principal?.kind === "person-browser" &&
      g.principal.view
    ) {
      const rec = webSessions.list().find((x) => x.key === g.session!.key);
      const minutes = webAuthNow().agentViewMinutes;
      return sendJson(res, {
        csrf: g.session.csrf,
        actor: g.principal.view.agent,
        signedIn: true,
        view: {
          agent: g.principal.view.agent,
          readOnly: true,
          ...(rec
            ? {
                endsAt: new Date(
                  rec.createdAt + minutes * 60_000,
                ).toISOString(),
              }
            : {}),
        },
        identity: { kind: "device", via: "agent-view" },
      });
    }
    if (g?.session) {
      const rec = webSessions.list().find((x) => x.key === g.session!.key);
      // Issue 1210: the fixture person, on a bound test install with
      // web.fixture_person set, shows its invented name over its login on
      // the rail. Display only: the audit and the log keep FIXTURE_LABEL.
      const named =
        rec?.via === "fixture" && testInstallNow()
          ? webAuthNow().fixturePerson
          : undefined;
      const github = rec?.via === "github" && !!rec.login;
      const name = github ? githubSessionName(rec) : undefined;
      return sendJson(res, {
        csrf: g.session.csrf,
        actor: "person-browser",
        signedIn: true,
        // 0.4.71: a browser on this machine, signed in with a link or a
        // code, is the local browser it always was (the owner's chip).
        identity: named
          ? {
              kind: "github",
              via: "fixture",
              login: named.login,
              name: named.name,
            }
          : !github && !g.beyond
            ? localIdentity()
            : {
                kind: github ? "github" : "device",
                via: rec?.via ?? "link",
                ...(github ? { login: rec.login } : {}),
                ...(name ? { name } : {}),
                // A link or a code (no GitHub sign-in of its own): no
                // GitHub identity, never the owner's. It may be someone
                // else's device.
              },
        // The welcome is spent only by the shell's own identity request
        // (?welcome=1): any other caller of this route (Settings' signed-in
        // row, a page's own check) only reads, so it can't win the race and
        // lose the person's toast (0.4.87 dry run).
        ...(url.searchParams.get("welcome") === "1" &&
        webSessions.takeWelcome(g.session.key)
          ? {
              justSignedIn: true,
              product: product().title,
              machine: machineName(),
            }
          : {}),
      });
    }
    // 0.4.71: no session, no token, here too: a browser on this machine
    // signs in (`web up` opens the one-time link) before it changes
    // anything. It reads as before.
    return sendJson(res, {
      csrf: null,
      actor: null,
      signedIn: false,
      reason: `Sign in to make changes here: run \`${product().cli} web up\` (it opens a one-time sign-in link), or open /signin.`,
      signin: `/signin?next=${encodeURIComponent("/")}`,
      // SEC-2a-UX: the signed-out page watches this, so Sign in with
      // GitHub appears once an owner is linked, with no reload. The
      // owner's login is what that page shows anyway.
      github: githubSignin(),
    });
  }
  // Sign out: this browser's session ends and its cookie is cleared.
  if (pathname === "/api/session/logout" && req.method === "POST") {
    const g = guard.ok ? guard : null;
    const https = httpsOf(req, g?.via ?? null);
    // Its session, or (one that no longer counts) the one its cookie names,
    // proved by that session's own CSRF token: it ends on the server.
    const named = g?.session ?? g?.ending ?? null;
    const ended = named ? webSessions.end(named.key) : false;
    if (named) closeSessionSockets([named.key]);
    res.setHeader("Set-Cookie", clearSessionCookies(PORT, https));
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
        // Issue 796: an agent's read-only view names its agent.
        ...(x.via === "agent-view" && x.agent ? { agent: x.agent } : {}),
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
    // Issue 227: who asked, when, and from which page action.
    let body: unknown = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      /* no body, or not JSON: the page, unnamed */
    }
    recordPageRestart(body, auditActorOf(req), principalOf(req));
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
      onMcpInit: (agentId, o) => noteHubMcpInit(getStateDir(), agentId, o),
      // Issue 749: a tool listing that failed leaves it without Hub's tools.
      onMcpToolsList: (agentId, o) =>
        noteHubMcpTools(getStateDir(), agentId, o),
      // 0.4.48: Hub turned the token down through an agent's call: let the
      // next call read it again (at most once a minute), as Den's own
      // status check does; and the agent's note says how its calls go.
      onHubAnswer: (agentId, o) => {
        if (o.status === 401) forgetHubToken();
        if (o.sub === "/mcp")
          noteHubMcpCall(getStateDir(), agentId, {
            ok: o.status !== null && o.status >= 200 && o.status < 300,
            ...(o.status === null
              ? { error: o.error ?? "hub didn't answer" }
              : o.status >= 300
                ? {
                    error: `hub (${o.status}): ${http.STATUS_CODES[o.status] ?? "error"}`,
                  }
                : {}),
          });
      },
      whyNotConnected: () => hubTokenProblem(),
    })
  )
    return;
  // ── The server agent (ON-6, server-agent-routes.ts) ──────────────────────
  if (await handleServerAgentRoutes(req, res, pathname)) return;
  // ── Agents on the Workspaces page (AG-4a, agent-routes.ts) ───────────────
  if (
    await handleAgentRoutes(req, res, pathname, {
      // Issue 1223: restart-stale goes through the one restart queue.
      restartQueue: () =>
        restartQueue({
          log: (line) => serverLog(line, "lifecycle"),
          store: () => notificationDeps().store,
        }),
    })
  )
    return;
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
        modeOf: () => modeResolver(agentWebDeps()),
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
    if (req.method === "GET" || req.method === "HEAD") {
      const filePath = url.searchParams.get("path");
      if (!filePath) return send400(res, '"path" query param required');
      // Issue 583: every file it opens is checked where it really is, and
      // read at that same path; a far too broad repo root is no root.
      let repoRoots: string[] = [];
      try {
        repoRoots = allWorkspaceCheckouts().map((c) => c.repoPath);
      } catch {
        repoRoots = [];
      }
      const r = validateAtPath(filePath, {
        repoRoots,
        heldDir: heldManifestsDir(),
        stateDir: getStateDir(),
      });
      return sendJson(res, r.body, r.status);
    }
  }

  // ── API: changelog ────────────────────────────────────────────────────────
  // GET /api/changelog  — parses CHANGELOG.md and returns structured entries
  // ── API: the Coach (issue 52) ─────────────────────────────────────────────
  // GET /api/coach, POST /api/coach/run (Run now): coach-routes.ts.
  if (
    (COACH_ROUTES as readonly string[]).includes(pathname) &&
    (await handleCoachRoute(req, res, pathname, coachRouteDeps()))
  )
    return;

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
    // MODE-5: a person's setting (Settings › Command line); an agent's
    // claim is refused, as on /api/settings.
    if (notAPersonOf(req))
      return sendJson(
        res,
        { ok: false, error: "only a person can change local_dev" },
        403,
      );
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
  //   agents_helpers_shown: 1 | 3 | 5 | 10, the running helpers an open
  //     badge shows (#80, user.yml agents.helpers_shown); null clears it
  //   bell_kinds: {switch: true | false | null}, the bell's kinds (bell
  //     v6, bell-prefs.ts; user.yml notifications.kinds)
  //   bell_fold_days: 3 | 7 | 14 | 30, when an item folds as older; null
  //     clears it (7)
  //   editor_open: vscode | cursor | zed | none, where a path in an agent's
  //     pane opens (AG-4b, editor-open-pref.ts); null clears it (none)
  //   language: the UI's language, en | ja | es (ui-language.ts); null or
  //     "en" clears it (English is the default)
  //   time_zone: an IANA zone for date-times (time-zone-pref.ts, issue
  //     206); null or "" clears it (the browser's)
  //   hub_allow_tools: true | false, hub.allow_tools (HUB-1.5: agents use
  //     Hub's tools without asking); null clears it (on)
  //   hub_delivery_loop: true | false, hub.delivery_loop (issue 158: the
  //     Hub delivery loop in agents' instructions); null clears it (on)
  //   hub_groups: { mode?: auto | on | off, cache_seconds?: 5..3600 },
  //     hub.groups and hub.groups_cache_seconds (issue 750: groups from
  //     Hub on the agents page); null clears one (auto, 30)
  //   hub_url: Hub's address, hub.url (#267, Settings › Hub); null or ""
  //     clears it. The page restarts Den after.
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

  // Issue 1371 Part 2: the bell's Undo of a setting an agent changed
  // without asking. The person's only: never an agent, never the fixture.
  if (pathname === "/api/settings/undo" && req.method === "POST") {
    if (notAPersonOf(req) || fixturePersonOf(req))
      return sendJson(
        res,
        { ok: false, error: "only a person can undo a setting change" },
        403,
      );
    let id = "";
    try {
      // Reviewer C: a small body, capped (null: too big).
      const raw = await readBodyCapped(req, GRANT_BODY_MAX);
      const b = JSON.parse(raw ?? "null") as { approval?: unknown } | null;
      id = typeof b?.approval === "string" ? b.approval.trim() : "";
    } catch {
      id = "";
    }
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
      return send400(res, "approval: the held write's id");
    const a = approvalDeps().queue.get(id);
    if (!a) return sendJson(res, { ok: false, error: "no such change" }, 404);
    const r = undoSettingChange(
      settingChangeDeps({
        userFile: userConfigPath(),
        stateDir: getStateDir(),
        audit: (detail, reason) =>
          auditConfig({
            verb: "config-write",
            detail: `undo: ${detail}`,
            ...(reason ? { reason } : {}),
          }),
      }),
      a,
    );
    if (!r.ok) return sendJson(res, { ok: false, error: r.error }, 409);
    try {
      notificationDeps().store.dropUndo(id);
    } catch {
      /* the bell is best effort: the change is undone */
    }
    return sendJson(res, { ok: true, key: r.key, note: r.note });
  }

  if (pathname === "/api/settings") {
    if (req.method === "GET") {
      const user = readUserConfig();
      // Issue 957: a pin dropped from user.yml leaves the fixture's record.
      prunedFixturePins(
        getStateDir(),
        shellPrefs(user.shell, pinProjects()).pins,
      );
      const editorList = editors.listEditors();
      const terminalList = editors.listTerminals();
      return sendJson(res, {
        editor: user.editor ?? null,
        editors: editorList,
        terminal: user.terminal ?? null,
        terminals: terminalList,
        editor_overrides: user.editor_overrides ?? {},
        languages: SUPPORTED_LANGUAGES,
        // MODE-5: the rows that were the command line's (a save answers them too).
        ...cliRowSettings(user),
        graph: graphPrefs(user.graph),
        appearance: appearancePrefs(user.appearance),
        shell: shellPrefs(user.shell, pinProjects()),
        agents_layout: agentsLayout(user),
        agents_helpers_shown: helpersShown(user),
        bell_kinds: bellKinds(user),
        bell_fold_days: bellFoldDays(user),
        // Issue 172: alerts outside the bell (alerts.ts).
        alerts: alertSettings(user),
        editor_open: editorOpen(user),
        distribution: distributionSettings(getDistRoot()),
        // Set from the command line (`<cli> config`), shown read-only.
        user_web_port: userWebPort(user as Record<string, unknown>),
        // The UI's language (R19), and the ones it has catalogs for.
        language: uiLanguage(user.language),
        ui_languages: UI_LANGUAGES,
        // issue 206: the person's time zone (null: the browser's).
        time_zone: timeZonePref(user.time_zone),
        // 0.4.46 MODE-UI: the install's mode for every agent (null: unset).
        agents_default_mode: user.agents?.default_mode ?? null,
        // Issue 1022: how often the page polls health, visible and hidden.
        health_poll: healthPollSeconds(() => user),
        // Issue 750: groups from Hub (user.yml hub.groups, auto by default).
        hub_groups: (() => {
          const h = (user as Record<string, unknown>).hub as
            | { groups?: unknown; groups_cache_seconds?: unknown }
            | undefined;
          const c = h?.groups_cache_seconds;
          return {
            mode: hubGroupsMode(h?.groups) ?? "auto",
            cache_seconds: typeof c === "number" ? c : 30,
          };
        })(),
        // Issue 158: the Hub delivery loop in agents' instructions.
        hub_delivery_loop:
          (
            (user as Record<string, unknown>).hub as
              | { delivery_loop?: unknown }
              | undefined
          )?.delivery_loop !== false,
        // Issue 268: the projects that override it (Settings › Agents).
        agents_mode_overrides: workspacesOverridingAgentMode(),
        server_agent_self_update: selfUpdateAuto() ? "auto" : "ask",
        // Issue 160: the install's approval policy (user.yml approvals).
        ...approvalsSettings(user.approvals, installModeOf(user)),
        install_mode: installModeOf(user),
        install_mode_from: resolveInstallMode(user, denModeConfig()).from,
        // SRV-P6: where it came from, and the update checks' last and next.
        ...updateCheckSettings(),
        // FB (den#81): Report an issue shows (feedback.enabled: false hides it).
        feedback_enabled: (() => {
          try {
            return readFeedbackSettings(
              getEngineRoot(),
              path.join(getDistRoot(), product().configFile),
              user.feedback,
            ).enabled;
          } catch {
            return true;
          }
        })(),
        // Issue 144: the machine's gate slots, not this install's.
        gate_slots: gates().settings(),
        // Issue 163: the launchd job's mode now (null: not a service).
        service_mode: installedServiceMode(),
        // Issue 163: Keep agents running after logout. Unset: on for a new
        // install (no service yet), off over an existing login install,
        // which the page then offers to turn on (keep_running_unset).
        ...(() => {
          let keep: boolean | undefined;
          try {
            keep = agentsKeepRunningAfterLogout(() => user);
          } catch {
            keep = false;
          }
          const mode = installedServiceMode();
          return {
            keep_running_after_logout:
              keep ?? (mode === null || mode === "always"),
            keep_running_unset: keep === undefined && mode === "login",
          };
        })(),
        // Issue 163 (b): the agents' sign-in token under the always-on
        // service: never the token, only whether one is configured and
        // when it was set (nothing is read from the store on a page view).
        agent_signin: await agentSigninView(),
        // Issue 339: the sign-in accounts per vendor (never a token).
        agent_accounts: agentAccountsView(),
        // Issue 103: Settings › Embedding (embed.*).
        embed: embedSettings(user),
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
          time_zone?: unknown;
          machine_name?: unknown;
          agents_layout?: unknown;
          agents_helpers_shown?: unknown;
          bell_kinds?: unknown;
          bell_fold_days?: unknown;
          alerts?: unknown;
          editor_open?: unknown;
          hub_allow_tools?: unknown;
          hub_delivery_loop?: unknown;
          hub_groups?: unknown;
          hub_url?: unknown;
          agents_default_mode?: unknown;
          server_agent_self_update?: unknown;
          local_dev?: unknown;
          cli_tabs?: unknown;
          log_window_lines?: unknown;
          panes_reconnect?: unknown;
          crash_loop?: unknown;
          web_bridge?: unknown;
          web_github?: unknown;
          web_ready?: unknown;
          web_pairing?: unknown;
          web_agent_view?: unknown;
          web_sessions?: unknown;
          gate_slots?: unknown;
          agents_list?: unknown;
          agents_shell?: unknown;
          agents_draft?: unknown;
          agents_resume?: unknown;
          restore_services_on_boot?: unknown;
          agent_issue_writes?: unknown;
          agent_context?: unknown;
          reports?: unknown;
          server_log?: unknown;
          feedback?: unknown;
          address_check?: unknown;
          process_lookup?: unknown;
          agent_hooks?: unknown;
          sessions?: unknown;
          agents_limits?: unknown;
          held_writes?: unknown;
          health_poll?: unknown;
          github?: unknown;
          embed?: unknown;
          approvals_policy?: unknown;
          approvals_watch?: unknown;
          approvals_critical?: unknown;
          approvals_settings?: unknown;
          install_mode?: unknown;
        };
        // Issue 810: the test-install mark is a person's, by hand, in the
        // distribution config: never written here, by anyone.
        if (
          Object.prototype.hasOwnProperty.call(body, "test_install") ||
          Object.prototype.hasOwnProperty.call(body, "web_test_install")
        )
          return sendJson(
            res,
            {
              ok: false,
              code: "test_install_by_hand",
              error: testInstallByHandRefusal(product().configFile),
            },
            403,
          );
        const user = readUserConfig();
        // MODE-5: settings only a person changes. An agent's claim to any
        // of them is refused before anything is written.
        // Issue 402: the fixture person saves its pages' own view prefs
        // (the rail's pins), as live checks press ☆/★; nothing else here.
        const fixture = fixturePersonOf(req);
        const personOnly = PERSON_ONLY_SETTINGS.filter(
          (k) =>
            (body as Record<string, unknown>)[k] !== undefined &&
            !(fixture && FIXTURE_PAGE_SETTINGS.includes(k)),
        );
        if (personOnly.length && notAPersonOf(req))
          return sendJson(
            res,
            {
              ok: false,
              error: `only a person can change ${personOnly.join(", ")}`,
            },
            403,
          );
        // MODE-5: what only `config` could change before.
        {
          const c = patchCliRows(user as Record<string, unknown>, {
            local_dev: body.local_dev,
            cli_tabs: body.cli_tabs,
            log_window_lines: body.log_window_lines,
            panes_reconnect: body.panes_reconnect,
            crash_loop: body.crash_loop,
            web_bridge: body.web_bridge,
            web_github: body.web_github,
            web_ready: body.web_ready,
            web_pairing: body.web_pairing,
            web_agent_view: body.web_agent_view,
            web_sessions: body.web_sessions,
            agents_list: body.agents_list,
            agents_shell: body.agents_shell,
            agents_draft: body.agents_draft,
            agents_resume: body.agents_resume,
            restore_services_on_boot: body.restore_services_on_boot,
            agent_issue_writes: body.agent_issue_writes,
            agent_context: body.agent_context,
            reports: body.reports,
            server_log: body.server_log,
            feedback: body.feedback,
            address_check: body.address_check,
            process_lookup: body.process_lookup,
            agent_hooks: body.agent_hooks,
            sessions: body.sessions,
            agents_limits: body.agents_limits,
            held_writes: body.held_writes,
            health_poll: body.health_poll,
            github: body.github,
          });
          if (!c.ok) return send400(res, c.error);
        }
        // Issue 144: the machine's gate slots (their own file, not user.yml).
        let gatePatch: GateSettingsPatch | undefined;
        if (body.gate_slots !== undefined) {
          const g = checkGatePatch(body.gate_slots);
          if (!g.ok) return send400(res, g.error);
          gatePatch = g.patch;
        }
        // 0.4.46 MODE-UI: agents.default_mode, the install's mode for every
        // agent; null clears it. A person's only: an agent could widen
        // every agent's mode with it.
        let modesChanged = false;
        if (body.agents_default_mode !== undefined) {
          const v = body.agents_default_mode;
          const agents = { ...(user.agents ?? {}) };
          if (v === null || v === "") delete agents.default_mode;
          else
            try {
              agents.default_mode = checkIntent(v, "agents_default_mode");
            } catch (e) {
              return send400(res, (e as Error).message);
            }
          if (Object.keys(agents).length) user.agents = agents;
          else delete user.agents;
          modesChanged = true;
        }
        // SRV-P6: server_agent.self_update, the person's (user.yml). null
        // is ask, written: an unset value would fall back to the team
        // file's until the migration (den-config.ts). Set here, it no
        // longer came from the team file.
        if (body.server_agent_self_update !== undefined) {
          const v = body.server_agent_self_update ?? "ask";
          if (v !== "ask" && v !== "auto")
            return send400(
              res,
              "server_agent_self_update is ask, auto or null",
            );
          const sa = { ...(user.server_agent ?? {}) };
          delete sa.self_update_from;
          sa.self_update = v;
          user.server_agent = sa;
        }
        // Issue 160: the install's approval policy (user.yml approvals), a
        // person's only (PERSON_ONLY_SETTINGS): an agent asks with
        // approval_policy, a held write that always waits for the Allow.
        if (
          body.approvals_policy !== undefined ||
          body.approvals_watch !== undefined ||
          body.approvals_critical !== undefined ||
          body.approvals_settings !== undefined
        ) {
          const a = patchApprovals(user.approvals, {
            policy: body.approvals_policy,
            watch: body.approvals_watch,
            critical: body.approvals_critical,
            settings: body.approvals_settings,
          });
          if (!a.ok) return send400(res, a.error);
          if (a.value) user.approvals = a.value;
          else delete user.approvals;
        }
        // Issue 1391: the install's mode, personal or strict; null puts the
        // default (personal) back. A person's only (PERSON_ONLY_SETTINGS).
        if (body.install_mode !== undefined) {
          const v = body.install_mode;
          if (v !== null && v !== "" && v !== "personal" && v !== "strict")
            return send400(res, "install_mode is personal, strict or null");
          if (
            v !== "strict" &&
            readInstallMode({}, denModeConfig()) === "strict"
          )
            return sendJson(
              res,
              {
                ok: false,
                error:
                  "The distribution's den.yml sets install_mode: strict, and a person can't loosen it.",
              },
              409,
            );
          if (v === null || v === "") delete user.install_mode;
          else user.install_mode = v;
        }
        // HUB-1.5: hub.allow_tools, Hub's tools without asking (Settings ›
        // Hub); null clears it (the default, on).
        if (body.hub_allow_tools !== undefined) {
          const h = patchHubAllowTools(
            user as Record<string, unknown>,
            body.hub_allow_tools,
          );
          if (!h.ok) return send400(res, h.error);
        }
        // Issue 750: hub.groups and hub.groups_cache_seconds (Settings ›
        // Hub › Groups from Hub); null clears one.
        if (body.hub_groups !== undefined) {
          const h = patchHubGroups(
            user as Record<string, unknown>,
            body.hub_groups,
          );
          if (!h.ok) return send400(res, h.error);
        }
        // Issue 158: hub.delivery_loop, the Hub delivery loop in every
        // agent's instructions (Settings › Hub); null clears it (on).
        if (body.hub_delivery_loop !== undefined) {
          const h = patchHubDeliveryLoop(
            user as Record<string, unknown>,
            body.hub_delivery_loop,
          );
          if (!h.ok) return send400(res, h.error);
        }
        // #267: Hub's address (Settings › Hub); "" or null clears it. The
        // page restarts Den after, so every agent and check reads it anew.
        // Issue 726: the Hub it was on, so the change runs on the server
        // whatever path called (revoke, archive, bell).
        let hubSaved: { before: HubConfig | null; url: string | null } | null =
          null;
        if (body.hub_url !== undefined) {
          let before: HubConfig | null = null;
          try {
            before = readHubConfig();
          } catch {
            before = null;
          }
          const h = patchHubUrl(user as Record<string, unknown>, body.hub_url);
          if (!h.ok) return send400(res, h.error);
          hubSaved = { before, url: h.url };
        }
        // AG-4b: the Agents tab's layout, a view preference only.
        if (body.agents_layout !== undefined) {
          const l = patchAgentsLayout(user, body.agents_layout);
          if (!l.ok) return send400(res, l.error);
        }
        // #80: how many running helpers an open badge shows.
        if (body.agents_helpers_shown !== undefined) {
          const h = patchHelpersShown(user, body.agents_helpers_shown);
          if (!h.ok) return send400(res, h.error);
        }
        // Bell v6: which kinds the bell shows, and when items fold as old.
        if (body.bell_kinds !== undefined) {
          const k = patchBellKinds(user, body.bell_kinds);
          if (!k.ok) return send400(res, k.error);
        }
        if (body.bell_fold_days !== undefined) {
          const f = patchBellFoldDays(user, body.bell_fold_days);
          if (!f.ok) return send400(res, f.error);
        }
        // Issue 172: alerts outside the bell, and quiet hours.
        if (body.alerts !== undefined) {
          const a = patchAlerts(user, body.alerts);
          if (!a.ok) return send400(res, a.error);
        }
        // AG-4b: where a path link in an agent's pane opens.
        if (body.editor_open !== undefined) {
          const e = patchEditorOpen(user, body.editor_open);
          if (!e.ok) return send400(res, e.error);
        }
        // Issue 103: Settings › Embedding, a person's (PERSON_ONLY_SETTINGS).
        if (body.embed !== undefined) {
          const e = patchEmbed(user, body.embed);
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
        // Issue 946: the fixture person's null clears only its own pins.
        const shellBody =
          body.shell === null && fixture ? { pins: [] } : body.shell;
        if (shellBody === null) {
          delete user.shell;
          writeFixturePins(getStateDir(), [], []);
        } else if (shellBody !== undefined) {
          // Issue 402: old id-only pins (stored, or posted by an older
          // page) migrate on the way through.
          const projectsOf = pinProjects();
          const before = shellPrefs(user.shell, projectsOf);
          const sh = mergeShellPrefs(before, shellBody, projectsOf);
          if (!sh.ok) return send400(res, sh.error);
          // Issue 946: a pin makes a held write on it wait for an Allow, so
          // the fixture person adds pins and takes off only its own.
          // Issue 957: only the fixture's pins still stored before this save.
          const added = prunedFixturePins(getStateDir(), before.pins);
          if (fixture) {
            const f = fixtureSave(before.pins, sh.value.pins, added);
            sh.value.pins = f.pins;
            writeFixturePins(getStateDir(), f.added, f.pins);
          } else writeFixturePins(getStateDir(), added, sh.value.pins);
          const stored = storedShell(sh.value);
          if (stored) user.shell = stored as UserConfig["shell"];
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
        // issue 206: the person's time zone; null or "" is the browser's.
        if (body.time_zone !== undefined) {
          const clear = body.time_zone === null || body.time_zone === "";
          if (!clear && !isTimeZone(body.time_zone))
            return send400(res, "time_zone must be an IANA time zone");
          if (clear) delete user.time_zone;
          else user.time_zone = body.time_zone as string;
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
        // Issue 963: who changed it, in the slot log (named as an ask is).
        // Issue 1395: first, under the gate-slot lock (waited for a
        // moment), so a busy lock saves nothing at all: neither file.
        if (gatePatch) {
          const a = auditActorOf(req);
          const patch = gatePatch;
          try {
            await gateLocked(() =>
              gates().writeSettings(
                patch,
                a
                  ? actorLabel(a)
                  : `${product().title} · Settings page · a person`,
              ),
            );
          } catch (e) {
            if (!(e instanceof GateLockBusy)) throw e;
            return sendJson(
              res,
              {
                ok: false,
                error:
                  "the gate's lock stayed busy (a slot decision was being made), so nothing was saved: save again",
              },
              503,
            );
          }
        }
        // Issue 1391: a cap the person moved here takes it as its baseline.
        personSetCaps(readUserConfig(), user, denForCaps());
        writeUserConfig(user);
        if (hubSaved) {
          const saved = hubSaved;
          const m = await import("./hub-change.js");
          await m
            .hubUrlSaved(
              await m.defaultHubChangeDeps(),
              saved.before,
              saved.url,
            )
            .catch((e: unknown) =>
              serverLog(
                `  ⚠ Hub change: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
                "warn",
              ),
            );
        }
        if (modesChanged)
          void import("./agent-routes.js").then((m) => m.applyModesNow());
        return sendJson(res, {
          ok: true,
          ...cliRowSettings(user),
          // Issue 144: the gate slots, as GET shows them (issue 424).
          gate_slots: gates().settings(),
          agents_default_mode: user.agents?.default_mode ?? null,
          hub_delivery_loop:
            (
              (user as Record<string, unknown>).hub as
                | { delivery_loop?: unknown }
                | undefined
            )?.delivery_loop !== false,
          server_agent_self_update: selfUpdateAuto() ? "auto" : "ask",
          ...approvalsSettings(user.approvals, installModeOf(user)),
          install_mode: installModeOf(user),
          install_mode_from: resolveInstallMode(user, denModeConfig()).from,
          editor: user.editor ?? null,
          terminal: user.terminal ?? null,
          editor_overrides: user.editor_overrides ?? {},
          graph: graphPrefs(user.graph),
          appearance: appearancePrefs(user.appearance),
          shell: shellPrefs(user.shell, pinProjects()),
          language: uiLanguage(user.language),
          time_zone: timeZonePref(user.time_zone),
          machine_name: machineNameSetting(user),
          agents_layout: agentsLayout(user),
          agents_helpers_shown: helpersShown(user),
          bell_kinds: bellKinds(user),
          bell_fold_days: bellFoldDays(user),
          alerts: alertSettings(user),
          editor_open: editorOpen(user),
          embed: embedSettings(user),
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

/**
 * The request's id: assigned once (the handler and its catch share it).
 * Through the edge it is the trace id in `traceparent` (#63), the one the
 * edge's access log has, so one id finds both lines; else a short one.
 */
const REQUEST_IDS = new WeakMap<http.IncomingMessage, string>();
function requestIdOf(req: http.IncomingMessage): string {
  let id = REQUEST_IDS.get(req);
  if (!id) {
    id =
      clientRequestId(req) ??
      traceRequestId(req.headers.traceparent) ??
      newRequestId();
    REQUEST_IDS.set(req, id);
  }
  return id;
}

const server = http.createServer((req, res) => {
  // H1: the edge's proof is read once and taken off every request first.
  EDGE_PROVED(req);
  // An async handler with no catch turns any route throw into an unhandled
  // rejection — which CRASHES the whole server on modern Node (freezing every
  // health dot) and leaves the request hanging. Fail the one request instead.
  // Each request in its own lock scope (SEC-1c: an agent's stays shut).
  const wait = agentPeerWaitMs(req);
  const handle = () =>
    inRequestLockScope(() =>
      wait === null
        ? handleRequest(req, res)
        : peerSettled(req, wait).then(() => handleRequest(req, res)),
    );
  // Issue 636: every audit row a test-person call makes says so (the
  // request checks refuse the header anywhere but a test bed).
  (req.headers[TEST_PERSON_HEADER] !== undefined
    ? inTestPersonScope(handle)
    : handle()
  ).catch((err: unknown) => {
    // R26: the log has the stack under the request id; the browser gets the
    // id, never the stack. The route is its template: no query values.
    const requestId = requestIdOf(req);
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routeTemplate(pathname);
    const method = req.method ?? "GET";
    // Issue 1299: the sign-ins file couldn't be read just now, so a sign-in
    // was refused rather than saving over every session: 503, try again.
    if (err instanceof SessionStoreUnreadable) {
      serverLog(
        `  ⚠ ${method} ${route} (req ${requestId}): ${err.message}`,
        "warn",
      );
      try {
        if (res.headersSent) {
          res.end();
          return;
        }
        res.setHeader("Retry-After", "2");
        if (pathname === "/api" || pathname.startsWith("/api/")) {
          sendJson(
            res,
            { ok: false, error: err.message, code: "sessions_unreadable" },
            503,
          );
          return;
        }
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`${err.message} (request id ${requestId})`);
      } catch {
        /* socket already gone */
      }
      return;
    }
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
        res.end(`${err.message} (request id ${requestId})`);
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
      res.end(`Den hit an error (request id ${requestId})`);
    } catch {
      /* socket already gone */
    }
  });
});

// #257: idle connections outlive the page's poll (web.keep_alive_seconds).
try {
  applyKeepAlive(server, readWebKeepAliveSeconds());
} catch (e) {
  applyKeepAlive(server, WEB_KEEP_ALIVE_SECONDS_DEFAULT);
  serverLog(
    `  ⚠ ${(e as Error).message}; using ${WEB_KEEP_ALIVE_SECONDS_DEFAULT} s`,
    "warn",
  );
}

// WebSocket upgrades pass the same checks (SEC-1 §3: Origin on every
// upgrade; CSRF as the `den.csrf.<token>` subprotocol). One route takes
// one: a session's io (AG-4a-term, session-routes.ts); any other passing
// upgrade answers 404.
// Issue 242: find each loopback caller as it connects, not when its
// request is read (a busy loop, or a caller that gave up, outran that).
server.on("connection", (sock: net.Socket) => watchPeer(sock));

server.on(
  "upgrade",
  (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => undefined);
    const wait = agentPeerWaitMs(req);
    if (wait === null) return handleUpgrade(req, socket, head);
    void peerSettled(req, wait)
      .catch(() => undefined)
      .then(() => handleUpgrade(req, socket, head));
  },
);

/**
 * An upgrade refused for want of a sign-in (a terminal that can't attach):
 * an audit row and a WS line on stderr, which is web.log even when `web
 * up` starts this --silent. The route's template, the status and the
 * code only: never a cookie, a header or the session's id.
 */
function traceUpgradeSignin(
  pathname: string,
  g: Extract<GuardResult, { ok: false }>,
): void {
  const route = isSessionIoPath(pathname)
    ? "/api/sessions/:id/io"
    : routeTemplate(pathname);
  try {
    recordAction(null, {
      verb: "request",
      detail: `WS ${route} ${g.status}`,
      outcome: "refused",
      reason: g.code,
    });
  } catch {
    /* the audit is best-effort here */
  }
  const line = `  ⚠ WS ${route} → ${g.status} ${g.code}`;
  if (!SILENT) return; // serverLog's request line is on stdout then
  if (!outputLost()) process.stderr.write(line + "\n");
}

function handleUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): void {
  EDGE_PROVED(req);
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
    if (guard.code === "signin_required") traceUpgradeSignin(pathname, guard);
    return refuse(guard.status, guard.error, guard.code);
  }
  setPrincipal(req, guard.principal);
  // Issue 796: an agent's view never opens a terminal (or any socket).
  if (guard.principal?.kind === "person-browser" && guard.principal.view) {
    const v = guard.principal.view;
    auditAgentView(
      v.agent,
      v.workspace,
      `WS ${routeTemplate(pathname)}`,
      "agent_view",
    );
    return refuse(403, agentViewRefusedText(v.agent), "agent_view");
  }
  // Issue 810: the fixture person never opens a terminal (or any socket);
  // issue 814: except the test operator, its own shells only.
  if (
    guard.principal?.kind === "person-browser" &&
    guard.principal.fixture &&
    !operatorRefusal({
      operatorInstall: operatorInstallNow(),
      via: guard.via,
      beyond: guard.beyond,
      method: "GET",
      pathname,
      forwarded: hasForwardingHeaders(req.headers),
      edgeLocal: guard.edgeLocal,
    })
  ) {
    markOperatorAct(req, "terminal-attach");
    recordAction(
      auditActorOf(req),
      {
        verb: "test-operator",
        detail: `terminal-attach ${pathname.slice(0, 200)}`,
      },
      OPERATOR_PRINCIPAL,
    );
  } else if (
    guard.principal?.kind === "person-browser" &&
    guard.principal.fixture
  ) {
    recordAction(
      null,
      {
        verb: "fixture-scope",
        detail: `WS ${routeTemplate(pathname)}`,
        outcome: "refused",
        reason: "fixture_scope",
      },
      FIXTURE_PRINCIPAL,
    );
    return refuse(
      403,
      "The fixture person can't open a terminal.",
      "fixture_scope",
    );
  }
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
}

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
// 0.4.46 services.restore_on_boot: the record as the last run left it, and
// why the prune drops any of it (restore-on-boot.ts).
const daemonsAtStart = listDaemons();
const prunedAtStart = new Map<string, "unresolved" | "stale" | "dead">();
startupPrune = pruneDeadDaemonsAsync((a, why) => prunedAtStart.set(a, why))
  .then((pruned) => {
    if (pruned.length > 0)
      console.error(
        `Cleared ${pruned.length} stale daemon(s): ${pruned.join(", ")}`,
      );
  })
  .catch((e: unknown) => {
    console.error(`[server] stale-daemon sweep failed: ${String(e)}`);
  });

// 0.4.46 services.restore_on_boot: what was up before the machine (or Den)
// restarted, and isn't now, comes back through Den's own Up, one project at
// a time. A person's down took it off the record, so it stays down.
void (async () => {
  await startupPrune;
  const m = await import("../../shared/environment-manager/restore-on-boot.js");
  let wait: number;
  try {
    if (!m.servicesRestoreOnBoot() || daemonsAtStart.length === 0) return;
    wait = m.servicesRestoreWaitSeconds();
  } catch (e) {
    serverLog(`  ⚠ ${(e as Error).message}`, "warn");
    return;
  }
  // At boot the container runtime may start after Den. Issue 1225: wait
  // for it whenever this machine has one (a service recorded only as a
  // process group may start containers itself), and until it answers (its
  // empty listing at boot is not "ready").
  const listing = m.containerListingOnceReady({
    dockerNames: runningDockerNamesAsync,
    bases: runningContainerBasesAsync,
  });
  const needsDocker = m.shouldWaitForContainers(daemonsAtStart, {
    runtime: await m.containerRuntimeOnPath(),
  });
  const running = needsDocker
    ? await m.waitForContainers(wait, listing)
    : await runningContainerBasesAsync().catch(() => null);
  if (needsDocker && running === null)
    serverLog(
      `  ⚠ services after the restart: the container runtime didn't answer within ${wait} s; restoring anyway`,
      "warn",
    );
  const plan = await m.servicesToRestore(daemonsAtStart, {
    pruned: prunedAtStart,
    running,
  });
  const result = await m.restoreServicesOnBoot(plan, {
    enabled: true,
    isActive: (ws) => isWorkspaceActive(ws),
    forget: unregisterDaemon,
    // Issue 1225: through the restart queue (issue 1129), a few at a time
    // and under its load ceiling, beside the agents.
    exec: m.throughQueue(
      restartQueue({
        log: (line) => serverLog(line, "lifecycle"),
        store: () => notificationDeps().store,
      }),
      upInProcess,
    ),
    // The queue's gap: how long a service has to settle before its check.
    settleMs: queueConfig().gapMs,
    // Issue 1225: a service that dies once started is tried again.
    stillDown: async (_ws, addrs) =>
      m.stillDownOf(addrs, {
        records: listDaemons(),
        running: await listing().catch(() => null),
      }),
    log: (line, level) => serverLog(line, level ?? "lifecycle"),
  });
  // Issue 1225: the bell, and doctor's record of the last restore.
  restoreNote(notificationDeps().store, result);
  m.writeLastRestore(getStateDir(), result);
})().catch((e: unknown) =>
  serverLog(`  ⚠ services after the restart: ${String(e)}`, "warn"),
);

/**
 * Den's own Up for some services of a project, in this process: the same
 * route a person's Up takes (order, dependencies, secrets), its events
 * read here. Resolves with the run's exit code.
 */
function upInProcess(workspace: string, addresses: string[]): Promise<number> {
  const url = new URL(
    `http://den.invalid/api/workspace/exec?cmd=up&workspace=${encodeURIComponent(workspace)}&addresses=${encodeURIComponent(addresses.join(","))}`,
  );
  return new Promise<number>((resolve, reject) => {
    let code = 1;
    let buf = "";
    const req = Object.assign(new EventEmitter(), {
      method: "GET",
      url: url.pathname + url.search,
      headers: {},
    }) as unknown as http.IncomingMessage;
    const res = {
      headersSent: false,
      writableEnded: false,
      setHeader: () => res,
      writeHead: () => res,
      write: (chunk: unknown) => {
        buf += String(chunk);
        let at: number;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (!ev.startsWith("data: ")) continue;
          try {
            const o = JSON.parse(ev.slice(6)) as {
              type?: string;
              exitCode?: number;
              text?: string;
            };
            if (o.type === "done" && typeof o.exitCode === "number")
              code = o.exitCode;
            else if (
              (o.type === "line" || o.type === "error") &&
              typeof o.text === "string"
            )
              serverLog(`  ${workspace}: ${o.text}`, "lifecycle");
          } catch {
            /* not one of ours */
          }
        }
        return true;
      },
      end: () => {
        res.writableEnded = true;
        resolve(code);
        return res;
      },
    } as unknown as http.ServerResponse & { writableEnded: boolean };
    handleWorkspaceRoutes(req, res, url.pathname, url, editors, github).catch(
      reject,
    );
  });
}

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

// #63: the edge's raw access log holds unmasked one-time tokens until Den
// masks it into edge-access.log. Swept first at startup (lines left while
// the server was down), then every second. Also swept when the access log
// was turned off since: a leftover raw file is still masked, never kept.
function sweepEdgeAccess(): void {
  try {
    if (!hasEdgeBlock()) return;
    const cfg = readEdgeConfig();
    const r = sweepAccessLog(
      cfg.stateDir,
      cfg.accessLog ?? readAccessLogConfig(undefined),
    );
    if (r.dropped)
      serverLog(
        `Edge access log: dropped ${r.dropped} line(s) that weren't the edge's`,
      );
  } catch (e) {
    serverLog(`Edge access log sweep failed: ${(e as Error).message}`);
  }
}
sweepEdgeAccess();
setInterval(sweepEdgeAccess, EDGE_ACCESS_SWEEP_MS).unref();

// Issue 163: with the env secrets backend, a sign-in token Settings saved
// lived in the process that just ended; Den's record of it is stale now.
try {
  if (dropStaleEnvTokenRecord({ stateDir: getStateDir() }))
    serverLog(
      "Sign-in token: the env secrets backend's value ended with Den's last run; dropped its record",
    );
} catch (e) {
  serverLog(`Sign-in token record check failed: ${(e as Error).message}`);
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

// Issue 403: a filed report's kept screenshot is deleted after
// reports.screenshot_keep_days (30), on the log sweep's beat.
function sweepReportShots(): void {
  try {
    const n = shotStore(getStateDir()).sweep(shotKeepDays(readUserConfig()));
    if (n) serverLog(`Report screenshots: deleted ${n} past their days`);
  } catch (e) {
    serverLog(`Report screenshot sweep failed: ${(e as Error).message}`);
  }
}
sweepReportShots();
setInterval(() => {
  sweepServiceLogs();
  sweepReportShots();
}, LOG_SWEEP_INTERVAL_MS).unref();

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
try {
  sealNewTestInstall();
} catch (e) {
  serverLog(
    `  ⚠ the new test install couldn't be set up: ${(e as Error).message}`,
  );
}
// Issue 1018: the setup value is kept only on a test install at start.
try {
  if (!testInstallNow()) FIXTURE_SETUP_SECRET.drop();
} catch {
  FIXTURE_SETUP_SECRET.drop();
}
// AG-0.1: the login shell's PATH, once, in the background (at most
// agents.shell_path_timeout_seconds, 10 s unset: issue 456),
// so agents find their CLI as the person's terminal would: a launchd
// service's PATH leaves out ~/.local/bin. Until (or unless) it answers, the
// search is this PATH and the runtimes' install directories.
void initLoginPath({ timeoutMs: shellPathTimeoutMs() });
// D80: the install's address (web.url), the one people are given. An
// install made before it takes its edge route's once, before the server
// answers (so the first `web up` reads it), for doctor to confirm. Never
// localhost (issue 666: migrateWebUrl takes the first alias that isn't,
// and puts it in place of a loopback one). A route edge.routes names is
// taken over the one made from the brand, and corrects an unconfirmed
// brand-route address once: only the named one may reach other machines.
const ADDRESS_BEFORE = readWebUrl();
const ADDRESS = migrateWebUrl(() => {
  try {
    const ports = new Set([readWebPort(), PORT]);
    return webRouteFindings(readEdgeConfig(), ports).map((r) => ({
      url: r.url,
      from: "the edge route to this install",
      named: r.named,
    }));
  } catch {
    return undefined; // no edge config: nothing to take
  }
});
// Issue 869: the migration wrote or corrected it: tell Hub.
if (ADDRESS && ADDRESS.url !== ADDRESS_BEFORE?.url) tellHubAddress(ADDRESS.url);
// Review M4 (0.4.48): server_agent.self_update is the person's (user.yml).
// Once, at the first start without it there, the team file's ask or auto
// is copied (an audit row; doctor says so), so the person's choice carries
// over and is never silently ask.
try {
  migrateSelfUpdate();
} catch (err) {
  console.error(
    `server_agent.self_update was not copied to user.yml (${err instanceof Error ? err.message : String(err)}); doctor says what holds`,
  );
}
// den#85: every start is recorded; a stop with code 0 marks it clean. Run
// by a service manager, a start after too many unclean ones in a short
// time waits before it serves (doubling, capped) and rings the bell.
const CRASH_GATE: Promise<void> = (() => {
  const stateDir = getStateDir();
  let web: unknown;
  try {
    web = readUserConfig().web;
  } catch {
    web = undefined;
  }
  const s = crashLoopSettings(web);
  const boot = recordBoot(stateDir, s);
  process.on("exit", (code) => {
    // Issue 163: when it stopped, for "ran while you were away".
    markStopped(stateDir);
    if (code === 0) markCleanStop(stateDir);
  });
  if (!boot.waitMs || !runByServiceManager()) return Promise.resolve();
  const secs = Math.round(boot.waitMs / 1000);
  const vars = { n: boot.crashes, m: s.minutes, s: secs };
  const text = `Den's web app stopped ${boot.crashes} times in ${s.minutes} minutes without a clean stop`;
  serverLog(`  ⚠ ${text}; it waits ${secs} s before it starts again.`, "warn");
  try {
    notificationDeps().store.add({
      kind: "service",
      subject: "record:den-web-crash-loop",
      scope: "workspace/den-server",
      text: `${text}; it waited ${secs} s before starting again`,
      msg: { key: "bell.m.crashLoop", vars },
      link: "/logs",
    });
  } catch {
    /* the bell is best effort: the wait still happens */
  }
  return new Promise((r) => setTimeout(r, boot.waitMs));
})();
// AG-14: agents interrupted by a restart, and stopped ones to forget
// (after the crash-loop wait: a start that waits resumes nothing yet).
void CRASH_GATE.then(() =>
  startAgentUpkeep((line) => serverLog(line, "lifecycle")),
);
// Sign-in: this server is one of Den's own processes while it runs.
try {
  registerDenProcess(getStateDir(), "server");
} catch (e) {
  serverLog(
    `could not record this server's pid: ${(e as Error).message}`, // words-ok: the server's own log
    "lifecycle",
  );
}
// Issue 163: back from a logout the server ran through: who ran meanwhile.
void CRASH_GATE.then(() =>
  startLogoutWatch((line) => serverLog(line, "lifecycle")),
);
// Issue 1349: the gate store (and its one primed memory reading) is made
// before the server serves, so its first settle is never on an unknown.
try {
  gates();
} catch (e) {
  serverLog(`gate store: ${(e as Error).message}`, "lifecycle");
}
void CRASH_GATE.then(() =>
  server.listen(PORT, BIND_HOST, () => {
    void printBanner(ADDRESS ?? readWebUrl());
    // Issue 816: a waiting test install announces itself (opt-in).
    syncTestAnnouncement();
    // SRV-1a: back from a restart the server agent asked for: tell it.
    void serverBack();
    // SRV-P6: Den keeps itself current (server_agent.update_check_minutes).
    startUpdateCheck();
    // Issue 142: a held write counts in the bell while it waits.
    startHeldWritesBell();
    // Issue 936: Turn on the agent sandbox for agents from before it.
    startSandboxOnAsk();
    // Issue 406: an owner linked before names were kept: GitHub's public
    // profile name, once (the account entry's first line).
    // web.owner_name_timeout_seconds: how long it waits.
    void ownerNameFromGithub({
      api: GITHUB.api,
      fake: GITHUB.fake,
      timeoutMs: WEB_AUTH.ownerNameTimeoutSeconds * 1000,
    }).then((n) => {
      if (n) serverLog("  Owner's GitHub display name kept", "lifecycle");
    });
    // 0.4.48: on Linux, the Docker bridge too, for the edge.
    void startBridgeListener().catch((e: unknown) =>
      serverLog(`  ⚠ Docker bridge listener: ${(e as Error).message}`, "warn"),
    );
    // Issue 728: once agents can't read the edge's state folder, its proof
    // is rotated once (edge.yml rewritten; Traefik reloads it by itself).
    rotateEdgeProofAtStart({
      readConfig: readEdgeConfig,
      ports: new Set([PORT, readWebPortSafe()]),
      onRotated: () => {
        const line =
          "Den rotated the edge's proof once, since agents can no longer read the edge's state folder. People stay signed in";
        serverLog(`  Edge: ${line}`, "lifecycle");
        recordAction(null, { verb: "edge-proof-rotated", detail: line });
      },
      warn: (m) => serverLog(`  ⚠ Edge: ${m}`, "warn"),
    });
    // H1: an edge set up here before 0.4.48 (or rotated) gets the proof.
    try {
      const r = syncEdgeProof(
        readEdgeConfig(),
        new Set([PORT, readWebPortSafe()]),
      );
      if (r === "written")
        serverLog(
          "  Edge: Den's route now carries the edge's proof (dynamic/edge.yml)",
          "lifecycle",
        );
    } catch (e) {
      serverLog(`  ⚠ edge proof not synced: ${(e as Error).message}`, "warn");
    }
    // Issue 278: agents stuck compacting ring the bell (agent_context.*).
    startContextWatch({ log: (l) => serverLog(`  ${l}`, "warn") });
    // Issue 163 (a): an install from before it was on by default is
    // offered Keep agents running after logout once (it needs sudo).
    try {
      noteKeepRunningOffer(notificationDeps().store, getStateDir(), {
        installed: installedServiceMode,
        keep: () => agentsKeepRunningAfterLogout(),
      });
    } catch {
      /* the bell is best effort; doctor and Settings offer it too */
    }
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
    // Issue 726: a hub.url edited to another Hub is a change: the old
    // token revoked, its state archived, before any Hub loop reads it.
    const hubChecked = import("./hub-change.js")
      .then(async (m) => m.hubChangeAtStart(await m.defaultHubChangeDeps()))
      .then((r) => {
        if (r.kind === "change")
          serverLog("  Hub changed: the earlier Hub's state is archived");
      })
      .catch((e: unknown) =>
        serverLog(
          `  ⚠ Hub change check: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
          "warn",
        ),
      );
    // H5: tell Hub this install's projects now, then whenever they change.
    void hubChecked
      .then(() => import("./hub-sync-service.js"))
      .then((m) => {
        let every = 30;
        let names = 300;
        let retry = 30;
        try {
          const c = readHubConfig();
          every = c?.syncCheckSeconds ?? 30;
          names = c?.namesCheckSeconds ?? 300;
          retry = c?.mcpRetrySeconds ?? 30;
        } catch {
          /* a bad hub block: doctor says so; the default here */
        }
        m.startProjectSync(every);
        // 0.4.45: a project renamed in Hub shows its new name here.
        m.startHubNameRefresh(names);
        // 0.4.46: an agent that started while Hub didn't answer gets its tools
        // back once Hub does (hub.mcp_retry_seconds, hub.mcp_retry_attempts).
        m.startMcpReconnect(retry, () => {
          try {
            return readHubConfig()?.mcpRetryAttempts ?? 0;
          } catch {
            return 0;
          }
        });
      });
    // 0.4.40: Hub comments reach this install's agents.
    void hubChecked
      .then(() => import("./hub-delivery-service.js"))
      .then((m) => {
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
          heldNoteSeconds: cfg?.deliveryHeldNoteSeconds ?? 60,
          // Issue 701: one agent's hang holds only itself; a held comment
          // and a typed one with no answer are said in the bell.
          stateTimeoutSeconds: cfg?.deliveryStateTimeoutSeconds ?? 60,
          typeTimeoutSeconds: cfg?.deliveryTypeTimeoutSeconds ?? 120,
          heldBellMinutes: cfg?.deliveryHeldBellMinutes ?? 5,
          answerMinutes: cfg?.deliveryAnswerMinutes ?? 30,
          // Issue 701: an asked question never holds a delivery.
          waiting: deliveryHeldIds,
          waitingWhy: (agent) =>
            pausedAgents().has(agent)
              ? "paused"
              : (waitingReasons().get(agent) ?? null),
          log: (l) => serverLog(`  ${l}`, "warn"),
        });
      });
    // Issue 193: an agent resumed on an older Hub tool list is told what
    // changed (hub.tools_check_seconds).
    void hubChecked
      .then(() => import("./hub-tools-service.js"))
      .then((m) =>
        m.startHubToolsWatch({
          waiting: typingHeldIds,
          log: (l) => serverLog(`  ${l}`, "warn"),
        }),
      );
    // Issue 714: an agent's gate slot held over MCP. Granted while it
    // waited: it is told (typed at its prompt) and claims it; passed on
    // unclaimed: told it is back in line; its lease lapsed: the bell.
    // Issue 214: Verify's schedules run on their own, once a minute.
    void import("./verify-schedule-routes.js").then((m) =>
      m.startVerifySchedules(scheduleDeps()),
    );
    void hubChecked
      .then(() => import("./gate-notices.js"))
      .then((m) =>
        m.startGateNotices({
          store: gates,
          // Issue 1263: throwaway test containers whose run ended (one
          // look at start: containers Docker brought back after a restart).
          docker: realDocker(),
          install: path.resolve(getStateDir()),
          projectOf: (agent) =>
            readAgentRecord(getStateDir(), agent)?.workspace ?? null,
          relay: async (dv) =>
            (await import("./hub-delivery-service.js")).relayMessage(dv),
          bell: (n) => {
            notificationDeps().store.add(n);
          },
          log: (l) => serverLog(`  ${l}`, "warn"),
        }),
      );
    // Issue 459: a project's app event feeds, each to one of its agents,
    // through the same loop as Hub's comments (typed when it is idle).
    void hubChecked
      .then(() =>
        Promise.all([
          import("./app-feed-service.js"),
          import("./hub-delivery-service.js"),
          import("../../shared/secrets/index.js"),
        ]),
      )
      .then(([m, dl, sec]) =>
        m.startAppFeeds({
          projects: () => {
            try {
              return Object.keys(readWorkspacesFile().workspaces ?? {});
            } catch {
              return [];
            }
          },
          feedsOf: (ws) => workspaceEventFeedsRaw(ws),
          agentProject: (agent) =>
            readAgentRecord(getStateDir(), agent)?.workspace ?? null,
          secret: async (ref) => {
            const sref = sec.namedSecretRef(ref);
            if (!sref) return null;
            return sec.getSecretsProvider().get(sref);
          },
          relay: (dv) => dl.relayMessage(dv),
          seen: (id) => dl.relaySeen(id),
          holds: (id) => dl.relayHolds(id),
          limits: () => {
            const e = embedSettings(readUserConfig());
            return {
              maxStreams: e.feed_max_streams,
              eventMaxKb: e.feed_event_max_kb,
              perMinute: e.feed_events_per_minute,
              keepEvents: e.feed_keep_events,
              readMaxKb: e.feed_read_max_kb,
              listTimeoutSeconds: e.feed_list_timeout_seconds,
              listMaxMb: e.feed_list_max_mb,
            };
          },
          bell: (n) => {
            notificationDeps().store.add(n);
          },
          stateDir: getStateDir(),
          log: (l) => serverLog(`  ${l}`, "warn"),
        }),
      );
    // The shared GitHub watcher: one loop for every agent's watches; a
    // finished one is typed at its agent's prompt (the relayed path).
    void hubChecked
      .then(() => import("./github-watch-service.js"))
      .then((m) =>
        m.startGithubWatch({
          relay: async (dv) =>
            (await import("./hub-delivery-service.js")).relayMessage(dv),
          log: (l) => serverLog(`  ${l}`, "warn"),
        }),
      );
  }),
);

/**
 * SRV-1a: the restart marker the last server left. An audit row says the
 * server is back; the agent that asked is told in its session, once it is
 * at its prompt (up to ui.restart_wait_seconds).
 */
async function serverBack(): Promise<void> {
  const m = takeRestartMarker(getStateDir());
  if (!m) return;
  const version = engineVersion() ?? "?";
  // #384: the update's doctor results go in the line itself.
  let update: import("./den-update.js").LastUpdate | null = null;
  try {
    update = (await import("./den-update.js")).lastUpdate(getStateDir());
  } catch {
    /* no update record: the line says none was kept */
  }
  const text = backMessage(m, version, process.pid, update);
  let told = "nobody to tell";
  if (m.agent === SERVER_AGENT_ID) {
    try {
      const ops = await import("../cli/agent-ops.js");
      const { webDeps } = await import("./agent-routes.js");
      const d = webDeps();
      const agentName = serverAgentName(product().title);
      told = await tellBack(text, {
        state: () => ops.serverAgentInputState(d),
        type: (t) => ops.typeIntoAgent(d, SERVER_AGENT_ID, t),
        // Issue 629: never into a dialog for its person; kept until answered.
        dialog: () => ops.serverAgentDialogOpen(d),
        held: () => {
          serverLog(
            `  Back from a restart: the note to ${agentName} waits for its person's dialog`,
            "lifecycle",
          );
          try {
            backNoteHeldNote(
              notificationDeps().store,
              product().title,
              agentName,
            );
          } catch {
            /* the bell is best effort */
          }
        },
        cleared: () => {
          try {
            notificationDeps().store.remove(
              (x) => x.subject === BACK_NOTE_HELD_SUBJECT,
            );
          } catch {
            /* the bell is best effort */
          }
        },
        waitMs: restartWaitSeconds() * 1000,
      });
    } catch (e) {
      told = `not told: ${(e as Error).message}`;
    }
  }
  recordAction(
    null,
    {
      verb: "server-back",
      detail: `on ${version} (pid ${process.pid}), was ${m.fromVersion}${m.fromPid ? ` (pid ${m.fromPid})` : ""}: ${m.reason} [${m.id}]; ${m.agent ? `agent:${m.agent}` : "the asker"} ${told}`,
    },
    m.agent ? `agent:${m.agent}` : undefined,
  );
  serverLog(`  Back from a restart: ${m.reason} (${told})`, "lifecycle");
  // SRV-P6c: a rollback is the person's news too, whoever asked.
  if (m.rolledBack)
    try {
      notificationDeps().store.add({
        kind: "service",
        subject: `record:den-update-${m.fromVersion}`,
        scope: "workspace/den-server",
        text: `Den ${m.fromVersion} didn't come up here and went back to ${version}: ${m.reason}`,
        msg: {
          key: "bell.m.rolledBack",
          vars: { v: m.fromVersion, from: version, why: m.reason },
        },
        link: "/server-agent",
      });
    } catch {
      /* the bell is best effort */
    }
}

/** SRV-P6: GET /api/settings' self_update source and update checks. */
function updateCheckSettings(): {
  server_agent_self_update_from: "user" | "org" | "default";
  update_check: import("./update-check.js").CheckState | null;
} {
  let from: "user" | "org" | "default" = "default";
  try {
    from = readServerAgentConfig().selfUpdateFrom;
  } catch {
    /* unreadable: the default's words; doctor says why */
  }
  return {
    server_agent_self_update_from: from,
    update_check: readCheckStateSync(getStateDir()),
  };
}

/**
 * SRV-P6: how long Den's own "update to X" waits in Needs you: a day, or
 * the held-write window when that is longer (issue 742).
 */
function updateAskTtlMs(): number {
  return Math.max(24 * 60 * 60_000, heldWriteWaitMinutes() * 60_000);
}
/** The update states that mean an update is under way. */
const UPDATE_UNDER_WAY = new Set(["installing", "watching", "rolling_back"]);

/**
 * Issue 562 review: set by the update check while its auto update runs:
 * den_update awaits it after the install, before the watch and restart
 * (holdRestart). A den_update the person or an agent asked for has none.
 */
let autoRestartHold: ((keepAlive: () => void) => Promise<void>) | null = null;

/**
 * SRV-P6 (0.4.48): every server_agent.update_check_minutes (0: never),
 * one updateCheck tick (update-check.ts). Read once at start: a changed
 * interval takes effect at the next restart; self_update is read per tick.
 */
function startUpdateCheck(): void {
  let every: number;
  try {
    every = readServerAgentConfig().updateCheckMs;
  } catch (e) {
    serverLog(`  ⚠ update check off: ${(e as Error).message}`, "warn");
    return;
  }
  const everyMinutes = Math.round(every / 60_000);
  // SRV-P6: doctor and Settings say the last pass and the next.
  const noteState = (last?: import("./update-check.js").CheckState["last"]) =>
    void import("./update-check.js")
      .then((m) => {
        // At a start, the pass before the restart stays the last one.
        const was = last ?? m.readCheckState(getStateDir())?.last;
        m.writeCheckState(getStateDir(), {
          everyMinutes,
          next: every ? new Date(Date.now() + every).toISOString() : null,
          ...(was ? { last: was } : {}),
        });
      })
      .catch(() => {
        /* best effort: doctor says "no check yet" */
      });
  noteState();
  // #142: an update ask for a version this Den already runs (or passed)
  // is done with.
  try {
    const have = engineVersion();
    if (have) notificationDeps().store.remove((n) => staleUpdateAsk(n, have));
  } catch {
    /* the bell is best effort */
  }
  if (!every) return;
  let busy = false;
  let updating = false;
  /**
   * Issue 562 review: the wait again once the install is done, leaving
   * out "updating" (this update is the one under way).
   */
  const agentWaitWhy = async (
    pastPerson: boolean,
  ): Promise<UpdateWait | null> => {
    const w = attentionWaiting().get(SERVER_AGENT_ID);
    const onPerson = w === "permission" || w === "asked";
    if (onPerson && !pastPerson) return w;
    if (approvals?.queue.pending().length) return "approval";
    if (onPerson) return null;
    const ops = await import("../cli/agent-ops.js");
    const { webDeps } = await import("./agent-routes.js");
    return (await ops.serverAgentInputState(webDeps())) === "busy"
      ? "busy"
      : null;
  };
  /**
   * #251: why an auto update would wait now; null: a quiet moment.
   * Issue 562: `pastPerson` leaves out the server agent's own question or
   * permission prompt (a security release): a pending Allow still holds
   * it, and so does a turn that is working. A turn paused on its person
   * isn't working (its transcript's open tool call reads busy): it
   * resumes after the restart.
   */
  const updateWaitWhy = async (
    pastPerson = false,
  ): Promise<UpdateWait | null> => {
    if (updating) return "updating";
    const u = await import("./den-update.js");
    const last = u.readUpdateState(getStateDir());
    if (
      last &&
      UPDATE_UNDER_WAY.has(last.state) &&
      Date.now() - Date.parse(last.at) < 60 * 60_000
    )
      return "updating";
    // The server agent's own wait first: it is what the person can end.
    return agentWaitWhy(pastPerson);
  };
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const u = await import("./den-update.js");
      const { updateCheck } = await import("./update-check.js");
      check ??= updateCheck({
        running: () => engineVersion() ?? null,
        latest: () =>
          u.npmViewVersion(
            u.npmCommand(),
            `${ENGINE_PACKAGE}@latest`,
            getDistRoot(),
          ),
        pinned: () => {
          try {
            const pkg = JSON.parse(
              fs.readFileSync(path.join(getDistRoot(), "package.json"), "utf8"),
            ) as { dependencies?: Record<string, string> };
            const pin = pkg.dependencies?.[ENGINE_PACKAGE];
            if (!pin) return null;
            return semver.valid(pin) ?? semver.minVersion(pin)?.version ?? null;
          } catch {
            return null;
          }
        },
        role: () => readServerAgentConfig().role,
        mode: () => (selfUpdateAuto() ? "auto" : "ask"),
        cantUpdate: () =>
          u.updateProblem(getDistRoot(), getEngineRoot(), ENGINE_PACKAGE),
        last: () => u.readUpdateState(getStateDir()),
        idle: async () => (await updateWaitWhy()) === null,
        // #251: why it waits, so the log and the bell can say so.
        waitWhy: () => updateWaitWhy(),
        // Issue 562: a security release: npm's version data marks it.
        waitPast: () => updateWaitWhy(true),
        security: (version) =>
          u.npmViewSecurity(
            u.npmCommand(),
            ENGINE_PACKAGE,
            version,
            getDistRoot(),
          ),
        securitySkipsQuestions: () => {
          try {
            return readServerAgentConfig().securityUpdateSkipsQuestions;
          } catch {
            return true;
          }
        },
        // Issue 603: past a working turn too; the restart holds for it.
        securitySkipsBusy: () => {
          try {
            return readServerAgentConfig().securityUpdateSkipsBusy;
          } catch {
            return true;
          }
        },
        securityNote: (version) => {
          try {
            securityUpdateNote(
              notificationDeps().store,
              product().title,
              serverAgentName(product().title),
              version,
            );
          } catch {
            /* the bell is best effort */
          }
        },
        waitChecks: () => {
          try {
            return readServerAgentConfig().updateWaitChecks;
          } catch {
            return 2;
          }
        },
        log: (line) => {
          serverLog(`  ${line}`, "lifecycle");
          recordAction(null, { verb: "den-update-check", detail: line });
        },
        // Issue 327: what the server agent waits on, since when.
        waitWhat: () => attentionDetail(SERVER_AGENT_ID),
        waitNote: (version, why, needs, at) => {
          try {
            updateWaitNotes(notificationDeps().store, product().title).note(
              version,
              why,
              needs,
              at,
            );
          } catch {
            /* the bell is best effort */
          }
        },
        waitDone: () => {
          try {
            updateWaitNotes(notificationDeps().store, product().title).done();
          } catch {
            /* best effort */
          }
        },
        pinState: () =>
          new Promise((resolve) =>
            execFile(
              "git",
              [
                "-C",
                getDistRoot(),
                "status",
                "--porcelain",
                "--",
                "package.json",
                "package-lock.json",
              ],
              { timeout: 10_000 },
              (err, out) =>
                resolve(
                  err ? null : String(out).trim() ? "uncommitted" : "committed",
                ),
            ),
          ),
        pinNote: (version, why) => {
          try {
            const allow = why === "permission" || why === "approval";
            notificationDeps().store.add({
              kind: "service",
              subject: "record:den-pin",
              scope: "workspace/den-server",
              text: allow
                ? `${product().title} ${version} runs here, but its new pin isn't committed: the ${product().title} agent is waiting on your Allow`
                : `${product().title} ${version} runs here, but its new pin isn't committed in the distribution's folder`,
              msg: {
                key: allow
                  ? "bell.m.pinNotCommittedAllow"
                  : "bell.m.pinNotCommitted",
                vars: { v: version },
              },
              link: "/server-agent",
            });
          } catch {
            /* best effort */
          }
        },
        pinDone: () => {
          try {
            notificationDeps().store.withdraw("record:den-pin", "service");
          } catch {
            /* best effort */
          }
        },
        // #176: Den commits and pushes the lead install's pin itself; the
        // approval policy (issue 160) may hold it for the person.
        pinCommit: (version) => runPinCommit(version, true),
        pinNotice: (s) => void pinBellNotice(s),
        update: async (version, reason, opts) => {
          const ap = approvalDeps();
          const a = ap.actions.den_update;
          const ok = await a.check({ version, reason });
          if (!ok.ok) return { ok: false, error: ok.error };
          updating = true;
          // Issue 562 review: read the wait again after the install.
          autoRestartHold = async (keepAlive) => {
            const { holdRestart, restartedWhileWorkingNote } =
              await import("./update-check.js");
            let maxMs = 900_000;
            try {
              maxMs = readServerAgentConfig().updateRestartWaitMs;
            } catch {
              /* the default */
            }
            await holdRestart({
              waitWhy: () => agentWaitWhy(!!opts?.security),
              maxMs,
              keepAlive,
              log: (line) => {
                serverLog(`  ${line}`, "lifecycle");
                recordAction(null, { verb: "den-update-check", detail: line });
              },
              timedOut: () => {
                try {
                  restartedWhileWorkingNote(
                    notificationDeps().store,
                    product().title,
                    serverAgentName(product().title),
                    version,
                  );
                } catch {
                  /* the bell is best effort */
                }
              },
            });
          };
          try {
            const r = (await a.run(ok.args, {
              id: "update-check",
              decidedBy: "auto:server_agent.self_update: auto",
            })) as { ok?: boolean; error?: unknown };
            return r.ok
              ? { ok: true }
              : { ok: false, error: String(r.error ?? "not updated") };
          } finally {
            updating = false;
            autoRestartHold = null;
          }
        },
        ask: async (version, reason) => {
          const ap = approvalDeps();
          try {
            if (!ap.enabled()) return false;
          } catch {
            return false;
          }
          const ok = await ap.actions.den_update.check({ version, reason });
          if (!ok.ok) return false;
          try {
            const a = ap.queue.request({
              actor: "den:update-check",
              action: "den_update",
              args: ok.args,
              summary: ok.summary,
              params: ok.params,
              details: ok.details,
              ttlMs: updateAskTtlMs(),
            });
            recordAction(null, {
              verb: "approval-ask",
              detail: `den_update: ${a.summary} [${a.id}]`,
            });
            return true;
          } catch {
            return false;
          }
        },
        notice: (version, text, msg) => {
          try {
            const store = notificationDeps().store;
            // #142: "Den X is out, Allow the update" waits on the person:
            // it needs them. One at a time: a newer one replaces the older.
            const ask = msg.key === "bell.m.updateOut";
            if (ask) store.remove(isUpdateAsk);
            store.add({
              kind: ask ? "decision" : "service",
              subject: `record:den-update-${version}`,
              scope: "workspace/den-server",
              text,
              msg,
              link: "/server-agent",
            });
          } catch {
            /* the bell is best effort */
          }
        },
      });
      const r = await check.tick();
      noteState({ at: new Date().toISOString(), ...r });
      if (r.did !== "current" && r.did !== "skipped")
        serverLog(
          `  update check: ${r.did} ${r.version}${r.did === "failed" ? `: ${r.why}` : ""}`,
          "lifecycle",
        );
    } catch (e) {
      serverLog(`  ⚠ update check: ${(e as Error).message}`, "warn");
    } finally {
      busy = false;
    }
  };
  let check: import("./update-check.js").UpdateCheck | undefined;
  setInterval(() => void tick(), every).unref();
  // #176: just after an update to this version, one pass as soon as the
  // watch says it is verified ("good"), so the pin is committed and pushed
  // then, not a whole interval later. Bounded by the watch's own wait.
  void import("./den-update.js").then((u) => {
    const have = engineVersion();
    const first = u.readUpdateState(getStateDir());
    if (!have || !first || first.to !== have) return;
    if (first.state !== "watching" && first.state !== "good") return;
    let waitMs = UPDATE_WAIT_SECONDS_DEFAULT * 1000;
    try {
      waitMs = readServerAgentConfig().updateWaitMs;
    } catch {
      /* the default */
    }
    const until = Date.now() + waitMs + 60_000;
    const poll = () => {
      const s = u.readUpdateState(getStateDir());
      if (s?.to === have && s.state === "good") return void tick();
      if (s?.to === have && s.state === "watching" && Date.now() < until)
        setTimeout(poll, 5_000).unref();
    };
    poll();
  });
}

/**
 * The start line's address (issue 455, after 0.4.68: no address is shown
 * before it is checked). web.url (D80), once it answers as this Den. When
 * it is the edge address and it doesn't yet, the address that was checked
 * (Den's own port), and a line that says the edge one isn't checked yet.
 * An address that isn't the edge's is given as it is (D80).
 */
async function bannerAddressLines(
  address: { url: string } | null,
): Promise<string[]> {
  if (!address) return [`  Web UI  →  ${notSetLine(product().cli)}`];
  let domains: string[] = [];
  try {
    domains = hasEdgeBlock() ? edgeDomains(readEdgeConfig()) : [];
  } catch {
    domains = [];
  }
  if (!isEdgeAddress(address.url, domains))
    return [`  Web UI  →  ${address.url}`];
  const words = {
    lang: cliLanguage(),
    title: readBrand().name,
    cli: product().cli,
  };
  let said: ReturnType<typeof statedAddress> = {
    address: null,
    unchecked: address.url,
  };
  try {
    const secret = webSecret.current();
    said = statedAddress(
      await checkAddress({
        webPort: PORT,
        wanted: address.url,
        key: secret ? identityKey(secret) : null,
        cli: product().cli,
        settings: addressCheckSettings(),
      }),
      true,
    );
  } catch {
    /* not checked: said so below */
  }
  if (!said.unchecked) return [`  Web UI  →  ${said.address ?? address.url}`];
  const why = edgeUncheckedLine(said.unchecked, words);
  return said.address
    ? [`  Web UI  →  ${said.address}`, `  ${why}`]
    : [`  Web UI  →  ${why}`];
}

/** The start banner: the install's address (D80), never localhost. */
async function printBanner(address: { url: string } | null): Promise<void> {
  const pkgVersion = engineVersion() ?? "?";

  console.log();
  for (const line of DEN_BANNER_LINES) {
    console.log(`\x1b[36m${line}\x1b[0m`); // cyan without chalk dependency
  }
  console.log();
  console.log(`  ${DEN_SUBTITLE.trim()}`);
  console.log(`  v${pkgVersion}`);
  console.log();
  for (const line of await bannerAddressLines(address)) console.log(line);
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

/**
 * UK-2: the request ledger's settings, from user.yml `requests:`.
 * keep_minutes (default 15): how long Den remembers how a write sent with
 * the working pop-up's id ended. Until 0.4.49 the old
 * ui.request_memory_seconds still counts when keep_minutes is unset.
 * max_entries (default 2000) and max_answer_kb (default 256): how many it
 * keeps and the largest answer it keeps to replay.
 */
function requestSettings(): {
  keepMs: number;
  maxEntries: number;
  maxAnswerBytes: number;
} {
  const pos = (v: unknown): number | undefined => {
    const n = Number(v);
    return v !== undefined && v !== null && Number.isFinite(n) && n > 0
      ? n
      : undefined;
  };
  try {
    const u = readUserConfig();
    const old = pos(u.ui?.request_memory_seconds);
    return {
      keepMs: (pos(u.requests?.keep_minutes) ?? (old ? old / 60 : 15)) * 60_000,
      maxEntries: pos(u.requests?.max_entries) ?? 2000,
      maxAnswerBytes: (pos(u.requests?.max_answer_kb) ?? 256) * 1024,
    };
  } catch {
    return {
      keepMs: 15 * 60_000,
      maxEntries: 2000,
      maxAnswerBytes: 256 * 1024,
    };
  }
}
const REQUEST_LEDGER = createRequestLedger({
  ttlMs: () => requestSettings().keepMs,
  maxEntries: () => requestSettings().maxEntries,
  maxAnswerBytes: () => requestSettings().maxAnswerBytes,
  // Settled 3: on disk, so a restart keeps them (0600; never a secret).
  file: path.join(getStateDir(), "requests.json"),
  // Settled 10: one line per write, found by its id. Never the body.
  log: (line) => serverLog(`  ${logTimestamp()}  ${line}`, "request"),
});

/** D64: ui.restart_wait_seconds, a positive number, else 90. */
function restartWaitSeconds(): number {
  return uiRestartWaitSeconds();
}
