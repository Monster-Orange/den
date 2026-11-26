/**
 * What an agent operation does (AG-2a, AG spec §5c), once, for both of its
 * fronts: `<cli> agents` (agents-command.ts) and the Workspaces page's
 * Agents section (server/agent-routes.ts, AG-4a). Neither front keeps state
 * of its own: the agent record (shared/agents/records.ts) and the session
 * host are the whole of it. Nothing here prints: each operation returns
 * what happened, or throws an AgentError saying why it didn't.
 *
 *   start   resolves the persona (Den's default pack, then
 *           agents.persona_packs) and the runtime (its CLI from
 *           agents.runtimes.<id>.bin in user.yml, else the search:
 *           runtime-search.ts, AG-0.1; unavailable, it is refused with the
 *           fix), asks the runtime for argv,
 *           env and files (its MCP config: `<cli> mcp --workspace <ws>
 *           --actor agent:<id>`, plus a `--grant` per agents.<id>.grants),
 *           starts `<dist>-<ws>:<id>` in the workspace's dir, and writes the
 *           agent record (<stateDir>/agents/<id>.json, 0600; no env, no argv).
 *           SEC-1c: it mints the agent's actor token (den_at_…, its hash in
 *           <stateDir>/actor-tokens.json) and hands it to the session as
 *           DEN_ACTOR_TOKEN; any earlier token of the agent stops working.
 *           The agent's env is an allowlist plus what its runtime declares,
 *           less every runtime's scrubEnv (sessions/env.ts), never the
 *           caller's whole environment; no --keep-env. A session that exits
 *           non-zero in its first moments (exitWatchMs) is returned as an
 *           early exit with its last lines.
 *   list    the workspace's agents (sessions with an agent record), with
 *           persona, runtime and model; a record whose session is gone is
 *           listed as stopped or ended. A plain session is not an agent.
 *   stop    ends its session (TERM), marks the record stopped and revokes
 *           its actor token.
 *   resume  only when its runtime declares resume, the record has its
 *           resume token, and its session is not running: a new session,
 *           in the same cwd and workspace with the grants it had (never
 *           more than the config still gives), continuing the last run with
 *           the runtime's own resume (den-claude: `--resume <token>`);
 *           when that session was never prompted, a fresh start under the
 *           same conversation id (there is nothing to continue). A fresh
 *           actor token; the old one stops working.
 *   fresh   (AG-14) a new conversation with the same persona, runtime,
 *           model and workspace, under the same id.
 *   remove  (AG-14.1b) forgets a stopped, interrupted or exited agent: its
 *           record moves aside for Undo (restore). Never a running one.
 *           The runtime's own history stays.
 *   interrupted (AG-14.3) an agent whose session is gone though nobody
 *           stopped it and it never exited: Den or the machine went down.
 *           markInterrupted stamps them when the web server starts, and
 *           resumes the standing personas and those with
 *           `resume_on_restart: true`.
 *
 * Nothing here takes a grant: grants come from user.yml only. The
 * host enforces agents.max_concurrent on every start, counting agents only.
 */
import type { RestartQueue } from "../../shared/agents/restart-queue.js";
import {
  AUDIT_SET_ASIDE_DIR,
  AUDIT_SET_ASIDE_MARK,
} from "../../shared/audit-file.js";
import { readActivity } from "../../shared/agents/activity.js";
import {
  denToolsOld,
  type DenToolsOld,
} from "../../shared/agents/den-tools-version.js";
import { auditVia } from "../../shared/test-person.js";
import {
  addressBriefLine,
  addressNotSetNote,
  agentLinks,
  peopleAddress,
  peopleWebUrl,
  type AgentLinks,
} from "../../shared/agent-links.js";
import {
  line as rl,
  reviewLines as review,
  type DetailKey,
  type ReviewLine,
} from "../../shared/review-lines.js";
import {
  agentOrderOf,
  inAgentOrder,
  moveInOrder,
  setAgentOrder,
  type AgentMove,
} from "../../shared/agents/order.js";
import {
  psCommandLine,
  runningIntent,
  type CommandLineOf,
} from "../../shared/agents/running-mode.js";
import {
  inputLineEmpty,
  plainTerminalText,
  trustAnswerKey,
  promptOnScreen,
  trustPromptIn,
  typingCheck,
  type TypingCheck,
} from "../../shared/agents/trust-prompt.js";
import {
  clearDraft,
  clearDraftSeenEmpty,
  draftPending,
} from "../../shared/agents/draft-input.js";
import {
  resolveMode,
  type EffectiveMode,
  type ModeSource,
} from "../../shared/agents/effective-mode.js";
import {
  hubProjectOf,
  type HubProjectLink,
} from "../../shared/hub-project-link.js";
import { resolveWorkspaceInput } from "../../shared/environment-manager/workspaces.js";
import { readEdgeConfig, readWebPort } from "../../shared/edge/config.js";
import { edgeDomains } from "../../shared/edge/render.js";
import {
  feedAddressLocal,
  feedSelfProblem,
  type FeedLookup,
  type FeedOwnAddresses,
} from "../../shared/agents/feed-address.js";
import { edgeKeyDirs, narrowEdgeDirs } from "../../shared/edge/key-dirs.js";
import {
  PLAYWRIGHT_AUTH_DIR,
  REPO_SECRETS_FILE,
} from "../../shared/credential-paths.js";
import { projectRepoDirs } from "../../shared/project-repo-dirs.js";
import {
  listOtherInstalls,
  registerInstall,
  registryDir,
} from "../../shared/install-registry.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { writeApiOnlyRules } from "../../shared/agents/api-only.js";
import { hookCallSettings } from "../../shared/agents/guardrails/hook-call.js";
import {
  INHERIT,
  SUBAGENT_DEFAULTS,
  effectiveSubagentModel,
  orgModelFrom,
  type SubagentModelFrom,
} from "../../shared/agents/subagents.js";
import {
  HELPER_DEFAULTS,
  HELPERS_READ_ONLY_NOTE,
  type Helper,
  type HelperSettings,
  type HelperTranscript,
} from "../../shared/agents/helpers.js";
import {
  isEnded,
  readClearedAt,
  splitCleared,
  writeClearedAt,
} from "../../shared/agents/helpers-cleared.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  AGENTS_RESERVED_KEYS,
  configuredRuntimeBin,
  shellPathTimeoutMs,
  configuredRuntimeCatalog,
  readAgentsConfig,
  readMcpConfig,
  readDenConfig,
  readServerAgentConfig,
  RESTART_WAIT_MINUTES_DEFAULT,
  ROTATION_WAIT_MINUTES_DEFAULT,
  UNASKED_EXIT_WINDOW_MINUTES_DEFAULT,
  readUserConfig,
  clearUserAgentSandbox,
  setUserRuntimeBin,
  userConfigPath,
  type ResolvedAgentsConfig,
} from "../../shared/den-config.js";
import {
  newAgentSandboxOff,
  personalNoSandbox,
  SANDBOX_OFF_SINCE_ASK,
  writeSandboxNote,
} from "../../shared/agents/sandbox-set.js";
import {
  contextTokensFor,
  contextWatchSettings,
  type ContextWatchSettings,
  instructionCheck,
  instructionWarning,
  writeInstructionCheck,
} from "../../shared/agents/context-watch.js";
import {
  setWorkspaceRuntimeBin,
  workspaceBinKey,
  workspaceRuntimeBin,
  workspaceAgentPermission,
  setWorkspaceAgentPermission,
  workspacePermissionKey,
  workspaceMcpServersRaw,
  workspaceEntryRaw,
  setWorkspaceMcpServers,
  setWorkspaceEventFeeds,
  workspaceEventFeedsRaw,
} from "../../shared/environment-manager/workspaces.js";
import {
  checkAppFeed,
  type AppFeedConfig,
} from "../../shared/agents/app-feeds.js";
import { hubLoopPrompt, projectHubLoop } from "../../shared/hub-loop.js";
import { namedSecretRef } from "../../shared/secrets/index.js";
import {
  checkProjectMcpServer,
  parseProjectMcpServers,
  projectMcpHeadersHelper,
  type ProjectMcpServer,
} from "../../shared/agents/project-mcp.js";
import {
  BUILTIN_CATALOG,
  type CatalogEntry,
} from "../../shared/agents/catalog.js";
import { checkRuntimeBin } from "../../shared/agents/catalog-runtime.js";
import {
  agentSessionName,
  peerSessionName,
} from "../../shared/agents/session-name.js";
import { cliEntrypoint } from "../../shared/engine.js";
import { engineVersion, getDistRoot } from "../../shared/paths.js";
import {
  operatorStubArgv,
  operatorStubEnv,
} from "../../shared/test-operator.js";
import { NotificationStore } from "../../shared/notifications.js";
import { auditConfig } from "../../shared/config-audit.js";
import { checkHandoff } from "../../shared/agents/handoff.js";
import { envKey, installLocationEnv, product } from "../../shared/product.js";
import {
  isFromBefore,
  LEGACY_SANDBOX_REASON,
  sandboxSetByPerson,
} from "../../shared/agents/sandbox-rollout.js";
import * as os from "os";
import {
  agentSkillPacks,
  readSkillPacksConfig,
} from "../../shared/skill-packs/launch.js";
import { announceDir, listAnnounced } from "../../shared/test-install-grant.js";
import { redactSecrets } from "../../shared/redact.js";
import {
  loadPersonas,
  serverPersona,
  resolvePackDirs,
  type Persona,
} from "../../shared/agents/personas.js";
import {
  checkModelChoice,
  checkPersonaInput,
  deleteLocalPersona,
  localPersonaExists,
  localPersonasDir,
  newPersonaId,
  PERSONA_KEYS,
  projectPersonaFile,
  writeProjectPersona,
  PersonaInputError,
  writeLocalPersona,
  type PersonaInput,
} from "../../shared/agents/persona-store.js";
import {
  categoryRegistry,
  roleRegistry,
  rolePreset,
  type Category,
  type RoleTemplate,
} from "../../shared/agents/roles.js";
import {
  checkCommands,
  checkIntent,
  DEFAULT_INTENT,
  intentOf,
  type PermissionIntent,
} from "../../shared/agents/permissions.js";
import { softNewlineSeq } from "../../shared/agents/catalog.js";
import {
  AGENT_ID_RE,
  agentFilesDir,
  listRecords,
  listRemovedRecords,
  purgeRemoved,
  readRecord,
  removeRecord,
  restoreRecord,
  writeRecord,
  checkDisplayName,
  nameSlug,
  writeRuntimeFiles,
  type AgentRecord,
  type Override,
} from "../../shared/agents/records.js";
import {
  agentSessionEnv,
  DEFAULT_RUNTIME_ID,
  getRuntime,
  LaunchError,
  runtimeIds,
  syncConfiguredRuntimes,
  type AgentMcp,
  type LaunchInput,
  type LaunchOutput,
  type Runtime,
} from "../../shared/agents/runtimes.js";
import {
  agentGitEnv,
  resolveAgentSigning,
  signingKeyAddLine,
  signingReadFiles,
  type AgentSigning,
} from "../../shared/agents/git-signing.js";
import {
  mcpLoadFailures,
  noteHubMcpInit,
  type McpLoadFailure,
} from "../../shared/agents/hub-mcp-connect.js";
import type {
  RuntimeDetect,
  RuntimeModel,
  RuntimePermissions,
} from "../../shared/agents/runtime.js";
import {
  inScope,
  OPEN_ELSEWHERE_MESSAGE,
  openElsewhere,
  type RuntimeConversation,
} from "../../shared/agents/conversations.js";
import { openInMessage } from "../../shared/agents/open-check.js";
import {
  OVERRIDE_SCOPES,
  readRotateFile,
  resolveRotate,
  ROTATE_DEFAULTS,
  setRotateValue,
  sourceText,
  type OrgRotate,
  type OverrideScope,
  type RotateFile,
  type RotateValues,
} from "../../shared/agents/rotate-settings.js";
import {
  archiveHandoff,
  clearWaiting,
  keepConversation,
  noteAsked,
  noteLeftAsked,
  noteLeftRunning,
  noteWaiting,
  type LeftRunning,
  noteFellBack,
  rotationInstruction,
  syncAfter,
  handoffFile,
  handoffPrompt,
  keptHandoffOf,
  launchRotation,
  newestHandoff,
  readHandoff,
  readRotation,
  resumeHandoffPrompt,
  writeRotation,
  reasonText,
  rotationInfo,
  type RelaunchReason,
  type RotationEntry,
  type RotationInfo,
  type RotationPolicy,
} from "../../shared/agents/rotation.js";
import {
  binSettingKey,
  ensureInteractivePath,
  installVersion,
  interactivePathAsked,
  runtimeVersion,
  type BinSetting,
  type BinSource,
  type RuntimeCopy,
} from "../../shared/agents/runtime-search.js";
import { WORKSPACE_NAME_RE } from "../../shared/agent-actor.js";
import {
  SERVER_AGENT_ID,
  SERVER_PERSONA_ID,
  isServerScope,
} from "../../shared/agents/server-agent.js";
import {
  bindActorSession,
  mintActorToken,
  ACTOR_TOKEN_FILE_ENV,
  removeActorTokenFile,
  revokeActorToken,
  revokeAgentTokens,
  writeActorTokenFile,
} from "../../shared/actor-token.js";
import { HostError, type HostClient } from "../../shared/sessions/client.js";
import {
  AgentLockBusy,
  LOCK_WAIT_MINUTES_DEFAULT,
  withAgentLock,
} from "../../shared/agents/agent-lock.js";
import { DEN_PTY_ID } from "../../shared/sessions/den-pty.js";
import { inWorkspace, sessionName } from "../../shared/sessions/names.js";
import type { SessionInfo } from "../../shared/sessions/types.js";
import { serverSpec } from "../mcp/connect.js";
import { HUB_SERVER, hubTokenProblem } from "../../shared/hub.js";
import {
  noteHubUnbindFailed,
  unbindAgentHubToken,
} from "../../shared/hub-agent-tokens.js";
import {
  jobCommandOf,
  jobsUnder,
  readProcesses,
  type ProcessRow,
} from "../../shared/process/jobs.js";
import {
  contractInfo,
  loadWorkspaces,
  resolveDeps,
  state,
  withClient,
  type Resolved,
  type SessionsDeps,
} from "./sessions-command.js";
import { denWebBase } from "../../shared/web-dial.js";
import { personServerFor, type PersonServer } from "./person-server.js";
import type { SecretRef, SecretsProvider } from "../../shared/secrets/types.js";
import {
  type AgentSandboxInput,
  localProofDirs,
  defaultSessionTmpBase,
  makeSessionTmp,
  removeSessionTmp,
  sandboxFor,
  sandboxRequired,
  sandboxSetting,
  type SandboxWrap,
} from "../../shared/agents/sandbox.js";
import { gateDir } from "../../shared/gates/store.js";
import {
  AGENT_TOKEN_REF_NAME,
  agentSignInMode,
  agentTokenRef,
  readAgentToken,
  tokenStatusLine,
} from "../../shared/agents/signin-token.js";
import {
  accountRefName,
  firstAccount,
  pickAccount,
  type AccountSource,
  type PickDeps,
} from "../../shared/agents/signin-accounts.js";

export interface AgentsDeps extends SessionsDeps {
  /**
   * Issue 989: this install's server, called with the person token. A
   * test gives one that answers null (no server) unless it asks for one.
   */
  server?: PersonServer;
  agentsConfig?: () => ResolvedAgentsConfig;
  /**
   * Issue 1328: drops a removed agent's agents.<id>.sandbox from user.yml
   * and its note, so the setting goes with the agent. Default: the
   * person's user.yml and this install's notes.
   */
  forgetSandbox?: (id: string) => void;
  /**
   * Issue 936: wraps an agent's argv in the OS sandbox (Den's state
   * read-only to it). Default: sandboxFor with the person's setting.
   */
  agentSandbox?: AgentSandboxFn;
  /**
   * Issue 1325: makes a sandboxed session's own temp folder (default
   * makeSessionTmp under /tmp); undefined: none (the system's TMPDIR).
   */
  sessionTmp?: () => string | undefined;
  /**
   * Issue 1325: the folder session temp folders are made in (default
   * /tmp); Den removes one only right inside it.
   */
  sessionTmpBase?: string;
  /** Issue 1316: the key an agent working in `cwd` signs commits with. */
  agentSigning?: (cwd: string) => AgentSigning | undefined;
  /** Issue 1072: mcp.actions in the distribution's config, not read. */
  mcpNotReadFromOrg?: () => string[];
  distRoot?: () => string;
  /** SRV-1b: the server agent's folder (server_agent.folder, resolved). */
  serverAgentFolder?: () => string;
  /** A workspace's checkout directory: where its agents run. */
  workspaceDir?: (ws: string) => string;
  /**
   * AG-17.1: the folders a workspace's conversations may have run in: its
   * own folder, and each repo's path, a repo added by path outside it too.
   */
  workspaceFolders?: (ws: string) => { under: string[]; exact?: string[] };
  /** D56: every workspace's name (whose folders are "inside a project"). */
  workspaceNames?: () => string[];
  /** The MCP server binary and its env; Den adds the scoped args. */
  mcpServer?: () => { command: string[] | string; env: Record<string, string> };
  /**
   * How long start and resume watch a new session for an early non-zero
   * exit (default 3000 ms; 0: not at all).
   */
  exitWatchMs?: number;
  /**
   * How long stop waits for the session to end after TERM (default
   * 5000 ms; 0: it doesn't wait, as `--no-wait`).
   */
  stopWaitMs?: number;
  /**
   * Issue 456: agents.shell_path_timeout_seconds, how long the shell is
   * given to say its PATH (default: user.yml's, 10 when unset).
   */
  shellPathTimeoutSeconds?: () => number;
  /** `agents.runtimes.<id>.bin` (default: user.yml's; undefined: unset). */
  runtimeBin?: (id: string) => unknown;
  /**
   * Workspace `ws`'s `agents.runtimes.<id>.bin` (default: workspaces.yml's;
   * undefined: unset). It wins over runtimeBin (AG-0.5).
   */
  workspaceRuntimeBin?: (ws: string, id: string) => unknown;
  /**
   * den#48: workspace `ws`'s `agents.permission` (default: workspaces.yml's;
   * undefined: unset), as written.
   */
  workspacePermission?: (ws: string) => unknown;
  /**
   * 0.4.46 MODE-UI: the install's mode for every agent (default: user.yml's
   * agents.default_mode; undefined: unset), as written.
   */
  installPermission?: () => unknown;
  /** Issue 278: user.yml agent_context.* with its defaults. */
  contextWatch?: () => ContextWatchSettings;
  /** den#48: save a checked intent as workspace `ws`'s (null clears it). */
  saveWorkspacePermission?: (
    ws: string,
    intent: PermissionIntent | null,
  ) => void;
  /** user.yml's runtime catalog entries, checked (default: user.yml's). */
  userCatalog?: (taken: readonly string[]) => CatalogEntry[];
  /** Save a checked path (null clears it): global or the workspace's. */
  saveRuntimeBin?: (
    scope: "global" | "workspace",
    ws: string | undefined,
    id: string,
    bin: string | null,
  ) => void;
  /** The user.yml a person edits to set it (default: config/local/user.yml). */
  userConfigFile?: () => string;
  /**
   * Issue 1016: the install's address for people (web.url, D80), or null
   * when it isn't set (default: user.yml's). Never a loopback address.
   */
  webUrl?: () => string | null;
  /** D28: workspace `ws`'s services and their folders (the service scope). */
  workspaceServices?: (ws: string) => { address: string; path: string }[];
  /**
   * HUB-1.5: Den Hub's URL and this install's token (from its own store),
   * or null when hub.url isn't set or the token can't be read (default:
   * hub.* and the install's secrets backend).
   */
  hub?: () => Promise<{
    url: string;
    token: string;
    allowTools?: boolean;
    /** HUB-1.7: Hub's MCP endpoint (default <url>/mcp). */
    mcpUrl?: string;
    /** D41: hub.inbox_on_stop (default nudge). */
    inboxOnStop?: "nudge" | "off";
    /** Issue 158: hub.delivery_loop (default on). */
    deliveryLoop?: boolean;
  } | null>;
  /** 0.4.48: why the Hub token can't be read now, or null (hubTokenProblem). */
  hubProblem?: () => string | null;
  hubAgentToken?: (
    hub: { url: string; token: string },
    a: { id: string; name: string; workspace: string },
  ) => Promise<string | null>;
  hubAgentUnbind?: (id: string) => Promise<void>;
  /**
   * Issue 163 (b): the secrets store and ref the agents' sign-in token is
   * read from under the always-on service (default: the install's
   * configured backend and secrets.refs.agent_signin_token). Issue 338:
   * asked with the runtime's ref name (agentTokenRefName).
   */
  signInStore?: (refName: string) => {
    provider: SecretsProvider;
    ref: SecretRef | null;
  };
  /**
   * Issue 340: the sign-in source (slice 6) that maps a folder to a
   * sign-in and reports the active one (default: none is set).
   */
  signInSource?: () => AccountSource | null;
  /** Issue 340: a sign-in that hit its usage cap (slice 4; default: none). */
  signInCapped?: (runtimeId: string, accountId: string) => boolean;
  /** 0.4.48: this machine's processes (default: ps), for jobs an agent left running. */
  processes?: () => ProcessRow[];
  /** HUB-1.5: workspace `ws`'s repos as owner/repo (X-Den-Repos). */
  workspaceRepos?: (ws: string) => string[];
  /**
   * Issue 335: project `ws`'s `agents.mcp_servers` as written (default:
   * workspaces.yml's; undefined: unset). Checked where it is used.
   */
  workspaceMcpServers?: (ws: string) => unknown;
  /**
   * Issue 158: project `ws`'s workspaces.yml entry, for its Hub delivery
   * loop setting (hub_delivery_loop, hub_delivery_loop_extra); undefined
   * when it has none.
   */
  workspaceHubLoop?: (ws: string) => unknown;
  /** Issue 335: save project `ws`'s `agents.mcp_servers` (checked). */
  saveWorkspaceMcpServers?: (ws: string, servers: ProjectMcpServer[]) => void;
  /** Issue 1480: project `ws`'s `agents.event_feeds` as written. */
  workspaceEventFeeds?: (ws: string) => unknown;
  /** Issue 1480: save project `ws`'s `agents.event_feeds` (as written). */
  saveWorkspaceEventFeeds?: (
    ws: string,
    feeds: Record<string, unknown>[],
  ) => void;
  /** Issue 1480: resolves a feed's host name (default: the system's). */
  feedLookup?: FeedLookup;
  /** Issue 1480: Den's own addresses and its Hub's, which a feed may not name. */
  feedOwnAddresses?: () => Promise<FeedOwnAddresses>;
  /** Issue 335: whether secrets.refs.<name> is set (default: the install's). */
  secretRefSet?: (name: string) => boolean;
  /** H5: the Hub project the person linked project `ws` to (X-Den-Project). */
  workspaceHubProject?: (ws: string) => HubProjectLink | null;
  /**
   * D52: Den's web server as an agent reaches it (http://localhost:<port>):
   * its Hub calls go through Den's proxy there.
   */
  denBase?: () => string;
}

/** Issue 936: an agent's argv, wrapped (or not, and why). */
export type AgentSandboxFn = (
  argv: string[],
  agentId: string,
  /** Issue 1325: the session's own temp folder (makeSessionTmp). */
  sessionTmp?: string,
) => SandboxWrap;

export interface AgentsResolved extends Resolved {
  /** Issue 989: this install's server, for person-only verbs. */
  server: PersonServer;
  agentsConfig: () => ResolvedAgentsConfig;
  forgetSandbox: (id: string) => void;
  agentSandbox: AgentSandboxFn;
  sessionTmp: () => string | undefined;
  sessionTmpBase: string;
  /** Issue 1316: the key an agent working in `cwd` signs commits with. */
  agentSigning: (cwd: string) => AgentSigning | undefined;
  mcpNotReadFromOrg: () => string[];
  distRoot: () => string;
  serverAgentFolder: () => string;
  workspaceDir: (ws: string) => string;
  workspaceFolders: (ws: string) => { under: string[]; exact?: string[] };
  workspaceNames: () => string[];
  mcpServer: () => { command: string[] | string; env: Record<string, string> };
  exitWatchMs: number;
  stopWaitMs: number;
  shellPathTimeoutSeconds: () => number;
  runtimeBin: (id: string) => unknown;
  workspaceRuntimeBin: (ws: string, id: string) => unknown;
  workspacePermission: (ws: string) => unknown;
  installPermission: () => unknown;
  contextWatch: () => ContextWatchSettings;
  saveWorkspacePermission: (
    ws: string,
    intent: PermissionIntent | null,
  ) => void;
  userCatalog: (taken: readonly string[]) => CatalogEntry[];
  saveRuntimeBin: NonNullable<AgentsDeps["saveRuntimeBin"]>;
  userConfigFile: () => string;
  webUrl: () => string | null;
  workspaceServices: (ws: string) => { address: string; path: string }[];
  hub: () => Promise<{
    url: string;
    token: string;
    allowTools?: boolean;
    mcpUrl?: string;
    inboxOnStop?: "nudge" | "off";
    deliveryLoop?: boolean;
  } | null>;
  workspaceRepos: (ws: string) => string[];
  workspaceHubLoop: (ws: string) => unknown;
  workspaceMcpServers: (ws: string) => unknown;
  saveWorkspaceMcpServers: (ws: string, servers: ProjectMcpServer[]) => void;
  workspaceEventFeeds: (ws: string) => unknown;
  saveWorkspaceEventFeeds: (
    ws: string,
    feeds: Record<string, unknown>[],
  ) => void;
  feedLookup?: FeedLookup;
  feedOwnAddresses?: () => Promise<FeedOwnAddresses>;
  secretRefSet: (name: string) => boolean;
  workspaceHubProject: (ws: string) => HubProjectLink | null;
  denBase: () => string;
  /**
   * 0.4.48: why Hub isn't there when its token can't be read now (the
   * store refused it), in plain words; null otherwise.
   */
  hubProblem: () => string | null;
  hubAgentToken: NonNullable<AgentsDeps["hubAgentToken"]>;
  hubAgentUnbind: NonNullable<AgentsDeps["hubAgentUnbind"]>;
  processes: () => ProcessRow[];
  /** Issue 163 (b): the env a start signs in with, and what to say. */
  agentSignIn: (
    tokenEnv: string | undefined,
    /** Issue 338: whose token (the runtime's id; unset: Claude Code's). */
    runtimeId?: string,
    /** Issue 340: the agent's folder, for the sign-in source's mapping. */
    folder?: string,
  ) => Promise<AgentSignIn>;
}

/** Issue 163 (b): a start's sign-in env, and a warning when it has none. */
export interface AgentSignIn {
  env: Record<string, string>;
  warning?: string;
  /** Issue 340: the sign-in picked (its label; never an email). */
  account?: { id: string; label: string };
}

/** The early-exit watch: at most this long, polling the host. */
export const EXIT_WATCH_MS = 3000;
const EXIT_POLL_MS = 100;
/** Stop waits at most this long for the session to end (0.4.8). */
export const STOP_WAIT_MS = 5000;
/** The most lines of an early exit's scrollback returned. */
const EXIT_TAIL_LINES = 10;

/**
 * Why an operation didn't happen. `usage` marks a request that was wrong
 * as asked (the CLI exits 2 with its usage line; others exit 1); `status`
 * is the HTTP answer the page gets, `code` its R26 code when the status's
 * own is not specific enough.
 */
export class AgentError extends Error {
  readonly status: number;
  readonly usage: boolean;
  readonly code?: string;
  readonly hints: string[];
  /** AG-10.10: the running agent a start collided with, so a page can open it. */
  readonly running?: { id: string; sessionId: string };
  /**
   * 0.4.48: job_running: how long the job it left running has run; issue
   * 1407: what it runs, when known.
   */
  readonly job?: { minutes: number; command?: string };
  /**
   * Issue 479: runtime_quarantined: the copy it would run, and the
   * choices, so a page can offer them.
   */
  readonly quarantined?: QuarantinedRuntime;
  constructor(
    message: string,
    o: {
      status?: number;
      usage?: boolean;
      code?: string;
      hints?: string[];
      running?: { id: string; sessionId: string };
      job?: { minutes: number; command?: string };
      quarantined?: QuarantinedRuntime;
    } = {},
  ) {
    super(message);
    this.name = "AgentError";
    this.status = o.status ?? (o.usage ? 400 : 409);
    this.usage = o.usage ?? false;
    this.code = o.code;
    this.hints = o.hints ?? [];
    if (o.running) this.running = o.running;
    if (o.job) this.job = o.job;
    if (o.quarantined) this.quarantined = o.quarantined;
  }
}

/**
 * Issue 479: a runtime whose CLI copy carries com.apple.quarantine, as a
 * start refuses it: the copy, the folder it is in, the scope a pin of
 * another copy goes to (where the setting that chose it lives), and the
 * other copies found that are not quarantined (never run here).
 */
export interface QuarantinedRuntime {
  runtime: string;
  name: string;
  path: string;
  dir: string;
  scope: "global" | "workspace";
  setting: string;
  others: RuntimeCopy[];
}

/** Issue 479: a start refused because its CLI copy is quarantined. */
export const RUNTIME_QUARANTINED = "runtime_quarantined";

/** A request that was wrong as asked (CLI exit 2; HTTP 400 unless given). */
const usage = (message: string, status = 400) =>
  new AgentError(message, { usage: true, status });
/** A refusal (CLI exit 1; HTTP 409 unless given). */
const refused = (message: string, hints: string[] = [], status = 409) =>
  new AgentError(message, { status, hints });
/** 0.4.48: "after its turn" ran out of time; nothing was stopped. */
const stillBusy = (message: string) =>
  new AgentError(message, { status: 409, code: "still_busy" });

let workspaceDirFn: ((ws: string) => string) | null = null;
let servicesFn: ((ws: string) => { address: string; path: string }[]) | null =
  null;
let foldersFn: ((ws: string) => { under: string[]; exact?: string[] }) | null =
  null;
let reposFn: ((ws: string) => string[]) | null = null;
let namesFn: (() => string[]) | null = null;
/** The workspaces config, for start and resume (loaded on first use). */
export async function loadAgentWorkspaces(d: AgentsDeps): Promise<void> {
  await loadWorkspaces(d);
  if (d.workspaceDir || workspaceDirFn) return;
  const ws = await import("../../shared/environment-manager/workspaces.js");
  const { getReposRoot } = await import("../../shared/den-config.js");
  workspaceDirFn = (name) => {
    const cfg = ws.readWorkspacesFile().workspaces[name];
    if (!cfg) throw usage(`project "${name}" does not exist`, 404);
    return ws.resolveWorkspaceDir(name, cfg, getReposRoot());
  };
  namesFn = () => Object.keys(ws.readWorkspacesFile().workspaces ?? {});
  // A by-path repo's own folder (repo add <path>), wherever it is.
  foldersFn = (name) => {
    const cfg = ws.readWorkspacesFile().workspaces[name];
    if (!cfg) throw usage(`project "${name}" does not exist`, 404);
    return ws.conversationFolders(name, cfg, getReposRoot());
  };
  const { readCatalog } =
    await import("../../shared/environment-manager/catalog.js");
  servicesFn = (name) => {
    const cfg = ws.readWorkspacesFile().workspaces[name];
    if (!cfg) return [];
    return ws
      .listWorkspaceServices(cfg, readCatalog(), name)
      .map((r) => ({ address: r.address, path: r.repoPath }));
  };
  const { projectRepos } = await import("../../shared/project-repos.js");
  reposFn = projectRepos;
}

/**
 * HUB-1.5: Den Hub's MCP server for an agent, when hub.url is set and its
 * token is readable. D52: through Den's proxy, with the agent's own Den
 * token; the proxy says who calls (its name and id, its session, the
 * workspace and its repos) from Den's records (hubUpstream).
 */
export async function agentHub(
  d: AgentsResolved,
  ws?: string,
): Promise<AgentMcp["hub"] | undefined> {
  const h = await d.hub().catch(() => null);
  if (!h) return undefined;
  const proxy = denHubProxy(d);
  // Issue 158: the Hub delivery loop, on unless the project or the
  // install turned it off.
  let project = projectHubLoop(undefined);
  try {
    if (ws) project = projectHubLoop(d.workspaceHubLoop(ws));
  } catch {
    // Unreadable workspaces.yml: as the install. So a project a person
    // turned off gets the loop back until it reads again (the next start).
  }
  const loop = hubLoopPrompt(h.deliveryLoop !== false, project);
  return {
    name: HUB_SERVER,
    url: `${proxy}/mcp`,
    ...(loop ? { loop } : {}),
    allowTools: h.allowTools !== false,
    // D41: the Stop hook's inbox check, through Den's proxy too.
    ...(h.inboxOnStop !== "off" ? { inboxBase: proxy } : {}),
    // D52: the agent's own Den token. Den's proxy swaps it for the
    // install's Hub token and says who is calling; the Hub token is never
    // in the agent's files. #70: read from its file at each connect.
    headersHelper: HUB_HEADERS_HELPER,
  };
}

/**
 * #70: Claude Code's headersHelper for Den's Hub proxy: the agent's token,
 * from the file its session names (base64url: no JSON escaping needed).
 */
export const HUB_HEADERS_HELPER = `printf '{"Authorization":"Bearer %s"}' "$(cat "$${ACTOR_TOKEN_FILE_ENV}")"`;

/** D52: Den's proxy to Hub, as an agent reaches it. */
export function denHubProxy(d: Pick<AgentsResolved, "denBase">): string {
  return `${d.denBase().replace(/\/+$/, "")}/hub`;
}

/** Den's web server on this machine (the MCP server's own rule). */
function defaultDenBase(): string {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  return denWebBase(port);
}

/**
 * D52: Hub as Den's proxy calls it for agent `agentId` (its actor token
 * proved it): Hub's base URL, its MCP endpoint, and the headers Den sets
 */
export async function hubUpstream(
  d: AgentsResolved,
  who: { agentId: string; workspace: string; session: string },
): Promise<{
  base: string;
  mcpUrl: string;
  headers: Record<string, string>;
} | null> {
  const h = await d.hub().catch(() => null);
  if (!h) return null;
  const { hubHeaders } = await import("../../shared/hub.js");
  let repos: string[] = [];
  try {
    repos = d.workspaceRepos(who.workspace);
  } catch {
    repos = [];
  }
  let name = who.agentId;
  let linked: string | undefined;
  try {
    const rec = readRecord(d.stateDir(), who.agentId);
    name = rec?.displayName || name;
    linked = rec?.project;
  } catch {
    /* the id names it */
  }
  // Which project's Hub link files its work: the agent's own project link
  // (D65 v2) first, then its session's project. The server scope is never
  // a project: with no link of its own, none (Hub's Unfiled).
  const projectWs = [linked, who.workspace].find(
    (w): w is string => !!w && !isServerScope(w),
  );
  const own = await d
    .hubAgentToken(
      { url: h.url, token: h.token },
      { id: who.agentId, name, workspace: who.workspace },
    )
    .catch(() => null);
  return {
    base: h.url,
    mcpUrl: h.mcpUrl || `${h.url}/mcp`,
    headers: hubHeaders(own ?? h.token, {
      agent: name,
      agentId: who.agentId,
      session: who.session,
      workspace: who.workspace,
      repos,
      project: (() => {
        try {
          return projectWs
            ? (d.workspaceHubProject(projectWs)?.id ?? null)
            : null;
        } catch {
          return null;
        }
      })(),
    }),
  };
}

/** The distribution's bin shim (as `mcp connect` registers), else Den's CLI. */
function defaultMcpServer(cli: string): {
  command: string[];
  env: Record<string, string>;
} {
  const s = serverSpec({
    cli,
    distRoot: getDistRoot(),
    nodeBinDir: path.dirname(process.execPath),
    platform: process.platform,
  });
  if (fs.existsSync(s.command)) return { command: [s.command], env: s.env };
  const e = cliEntrypoint();
  return { command: [e.command, ...e.args], env: s.env };
}

/**
 * Issue 936: what an agent's sandbox is built from on this machine: Den's
 * state, the distribution, the gate store, the socket folders allowed, and
 * the folders no session reads (the machine's local proof).
 */
/**
 * Issue 1316: where a signing key agents read may never be: what issue 728
 * denies outside the state folder (this install's edge key folders, the
 * other installs' state folders and their edges').
 */
function signingKeyRefusedDirs(
  stateDir: string,
  distRoot: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const out = [...edgeKeyDirs(distRoot)];
  try {
    for (const o of listOtherInstalls(registryDir({ ...process.env, ...env }), {
      ownStateDir: stateDir,
      home: { ...process.env, ...env }.HOME,
    }))
      out.push(o.stateDir, ...o.edgeKeyDirs);
  } catch {
    /* no registry: nothing more to refuse */
  }
  return [...new Set(out)];
}

/**
 * Issue 1391: whether this install's agents may read its activity trail:
 * a personal install's, once the trail written before redaction is set
 * aside (setAsideOldTrail's marker). Should that step fail, they don't.
 */
export function agentsMayReadTrail(
  cfg: { mode?: "personal" | "strict" },
  stateDir: string,
): boolean {
  return (
    cfg.mode === "personal" &&
    !!fs.lstatSync(
      path.join(stateDir, AUDIT_SET_ASIDE_DIR, AUDIT_SET_ASIDE_MARK),
      { throwIfNoEntry: false },
    )
  );
}

export function agentSandboxInput(o: {
  stateDir: string;
  distRoot: string;
  env: NodeJS.ProcessEnv;
  agentId: string;
  sockets?: string[];
  platform?: NodeJS.Platform;
  home?: string;
  /** Issue 1316: agents.git.signing_key's files, read wherever they are. */
  readableFiles?: string[];
  /** Issue 1325: the session's own temp folder. */
  sessionTmp?: string;
  /** Issue 1391: a personal install's trail is read back. */
  trailReadable?: boolean;
  /** Repos' stack secrets files (hidden by path where no name rule exists). */
  repoSecretFiles?: string[];
}): AgentSandboxInput {
  return {
    ...(o.sessionTmp ? { sessionTmp: o.sessionTmp } : {}),
    ...(o.trailReadable === true ? { trailReadable: true } : {}),
    stateDir: o.stateDir,
    distRoot: o.distRoot,
    gateDir: gateDir(o.env),
    agentId: o.agentId,
    env: o.env,
    socketsAllowed: o.sockets ?? [],
    ...(o.readableFiles?.length
      ? {
          readableFiles: o.readableFiles,
          keyRefusedDirs: signingKeyRefusedDirs(o.stateDir, o.distRoot, o.env),
        }
      : {}),
    ...(o.repoSecretFiles?.length
      ? { repoSecretFiles: o.repoSecretFiles }
      : {}),
    deniedDirs: [
      ...localProofDirs(
        o.env,
        o.platform ?? process.platform,
        o.home ?? os.homedir(),
        envKey("LOCAL_PROOF_DIR"),
      ),
      path.join(o.distRoot, PLAYWRIGHT_AUTH_DIR),
    ],
  };
}

export function resolveAgentsDeps(d: AgentsDeps): AgentsResolved {
  const base = resolveDeps(d);
  return withServerScope({
    ...base,
    server: d.server ?? personServerFor(base.stateDir()),
    agentsConfig: d.agentsConfig ?? (() => readAgentsConfig()),
    forgetSandbox:
      d.forgetSandbox ??
      ((id) => {
        clearUserAgentSandbox(id);
        writeSandboxNote(base.stateDir(), id, null);
      }),
    mcpNotReadFromOrg:
      d.mcpNotReadFromOrg ?? (() => readMcpConfig().notReadFromOrg ?? []),
    agentSigning:
      d.agentSigning ??
      ((cwd) =>
        resolveAgentSigning({
          git: (d.agentsConfig ?? (() => readAgentsConfig()))().git,
          stateDir: base.stateDir(),
          cwd,
          env: base.env,
        })),
    agentSandbox:
      d.agentSandbox ??
      ((argv, agentId, sessionTmp) =>
        sandboxFor(
          argv,
          agentSandboxInput({
            sessionTmp,
            stateDir: base.stateDir(),
            distRoot: (d.distRoot ?? getDistRoot)(),
            env: base.env,
            agentId,
            sockets: (d.agentsConfig ?? (() => readAgentsConfig()))()
              .sandboxSockets,
            readableFiles: signingReadFiles(
              (d.agentsConfig ?? (() => readAgentsConfig()))().git,
            ),
            // Issue 1391: read at this start, as the deny rules are.
            trailReadable: agentsMayReadTrail(
              (d.agentsConfig ?? (() => readAgentsConfig()))(),
              base.stateDir(),
            ),
            repoSecretFiles: projectRepoDirs()
              .map((r) => path.join(r, REPO_SECRETS_FILE))
              .filter((f) => fs.existsSync(f)),
          }),
          {
            on: sandboxSetting(
              (d.agentsConfig ?? (() => readAgentsConfig()))(),
              agentId,
            ),
          },
        )),
    // Issue 1331: on every platform, in a base no other session reaches.
    sessionTmp:
      d.sessionTmp ??
      (() =>
        makeSessionTmp(
          d.sessionTmpBase ?? defaultSessionTmpBase(base.stateDir()),
        )),
    sessionTmpBase: d.sessionTmpBase ?? defaultSessionTmpBase(base.stateDir()),
    distRoot: d.distRoot ?? getDistRoot,
    serverAgentFolder:
      d.serverAgentFolder ??
      (() =>
        readServerAgentConfig(readDenConfig(), (d.distRoot ?? getDistRoot)())
          .folder),
    workspaceDir:
      d.workspaceDir ??
      ((ws) => {
        if (!workspaceDirFn) throw new Error("projects not loaded");
        return workspaceDirFn(ws);
      }),
    workspaceFolders:
      d.workspaceFolders ??
      ((ws) => {
        // A caller that gives its own folder (a test) gives just it.
        if (d.workspaceDir) return { under: [d.workspaceDir(ws)] };
        if (!foldersFn) throw new Error("projects not loaded");
        return foldersFn(ws);
      }),
    workspaceNames: d.workspaceNames ?? (() => (namesFn ? namesFn() : [])),
    mcpServer: d.mcpServer ?? (() => defaultMcpServer(base.cli)),
    exitWatchMs: d.exitWatchMs ?? EXIT_WATCH_MS,
    stopWaitMs: d.stopWaitMs ?? STOP_WAIT_MS,
    shellPathTimeoutSeconds:
      d.shellPathTimeoutSeconds ?? (() => shellPathTimeoutMs() / 1000),
    runtimeBin: d.runtimeBin ?? ((id) => configuredRuntimeBin(id)),
    workspaceRuntimeBin:
      d.workspaceRuntimeBin ?? ((ws, id) => workspaceRuntimeBin(ws, id)),
    workspacePermission:
      d.workspacePermission ?? ((ws) => workspaceAgentPermission(ws)),
    installPermission:
      d.installPermission ?? (() => readUserConfig().agents?.default_mode),
    contextWatch:
      d.contextWatch ??
      (() => contextWatchSettings(readUserConfig().agent_context)),
    saveWorkspacePermission:
      d.saveWorkspacePermission ??
      ((ws, intent) => setWorkspaceAgentPermission(ws, intent)),
    userCatalog: d.userCatalog ?? ((taken) => configuredRuntimeCatalog(taken)),
    saveRuntimeBin:
      d.saveRuntimeBin ??
      ((scope, ws, id, bin) =>
        scope === "workspace" && ws
          ? setWorkspaceRuntimeBin(ws, id, bin)
          : setUserRuntimeBin(id, bin)),
    userConfigFile: d.userConfigFile ?? userConfigPath,
    webUrl: d.webUrl ?? (() => peopleWebUrl()),
    workspaceServices:
      d.workspaceServices ?? ((ws) => (servicesFn ? servicesFn(ws) : [])),
    hub: d.hub ?? defaultHub,
    workspaceRepos: d.workspaceRepos ?? ((ws) => (reposFn ? reposFn(ws) : [])),
    workspaceHubLoop: d.workspaceHubLoop ?? workspaceEntryRaw,
    workspaceMcpServers:
      d.workspaceMcpServers ?? ((ws) => workspaceMcpServersRaw(ws)),
    saveWorkspaceMcpServers:
      d.saveWorkspaceMcpServers ??
      ((ws, servers) => setWorkspaceMcpServers(ws, servers)),
    workspaceEventFeeds:
      d.workspaceEventFeeds ?? ((ws) => workspaceEventFeedsRaw(ws)),
    saveWorkspaceEventFeeds:
      d.saveWorkspaceEventFeeds ??
      ((ws, feeds) => setWorkspaceEventFeeds(ws, feeds)),
    ...(d.feedLookup ? { feedLookup: d.feedLookup } : {}),
    ...(d.feedOwnAddresses ? { feedOwnAddresses: d.feedOwnAddresses } : {}),
    secretRefSet: d.secretRefSet ?? ((name) => namedSecretRef(name) !== null),
    workspaceHubProject: d.workspaceHubProject ?? ((ws) => hubProjectOf(ws)),
    denBase: d.denBase ?? defaultDenBase,
    hubProblem: d.hubProblem ?? (() => hubTokenProblem()),
    hubAgentToken: d.hubAgentToken ?? (async () => null),
    hubAgentUnbind:
      d.hubAgentUnbind ??
      ((id) => unbindAgentHubToken(base.stateDir, d.hub ?? defaultHub, id)),
    processes: d.processes ?? readProcesses,
    agentSignIn: (tokenEnv, runtimeId, folder) =>
      agentSignInEnv(
        tokenEnv,
        base.env,
        base.stateDir(),
        base.cli,
        d.signInStore,
        runtimeId,
        {
          ...(folder !== undefined ? { folder } : {}),
          source: d.signInSource?.() ?? null,
          ...(d.signInCapped ? { capped: d.signInCapped } : {}),
        },
      ),
  });
}

/**
 * Issue 163 (b): under the always-on service (agentSignInMode), the
 * runtime's sign-in token from the install's secrets store, as env only.
 * Desktop sign-in: nothing read, nothing set. A token that can't be read
 * is a warning (the start goes on): never the token, in any text.
 */
export async function agentSignInEnv(
  tokenEnv: string | undefined,
  env: NodeJS.ProcessEnv,
  stateDir: string,
  cli: string,
  store?: (refName: string) => {
    provider: SecretsProvider;
    ref: SecretRef | null;
  },
  /**
   * Issue 338: the runtime whose token it is, each under its own ref
   * (agentTokenRefName), so a vendor's token reaches its agents only.
   */
  runtimeId = "den-claude",
  /**
   * Issue 340: the agent's folder, the sign-in source (slice 6) and the
   * cap (slice 4), for pickAccount. None: Den's order, as before.
   */
  pick: Pick<PickDeps, "folder" | "source" | "capped"> = {},
): Promise<AgentSignIn> {
  if (!tokenEnv || agentSignInMode(env, stateDir) !== "token")
    return { env: {} };
  // Issue 340: the folder's sign-in, else the active one, else the first
  // in the person's order that is not capped (account one, the token that
  // exists today, unless they changed it).
  const { picked, misses } = await pickAccount({
    ...pick,
    stateDir,
    runtimeId,
    read: (name) => {
      const s = store?.(name);
      return readAgentToken(
        s
          ? { provider: () => s.provider, ref: () => s.ref }
          : { ref: () => agentTokenRef(undefined, undefined, name) },
      );
    },
  });
  if (picked)
    return {
      env: { [tokenEnv]: picked.token },
      account: { id: picked.account.id, label: picked.label },
    };
  // None: what the start says is about the first in the order, as before.
  const acct = firstAccount(stateDir, runtimeId);
  const refName = accountRefName(runtimeId, acct.id);
  const reason = misses.find((m) => m.id === acct.id)?.reason;
  const r = { reason: reason ?? "not set" };
  // Not Claude Code's: made with its own command, kept under its own ref.
  const how =
    refName === AGENT_TOKEN_REF_NAME
      ? undefined
      : acct.id !== "1"
        ? {
            make:
              getRuntime(runtimeId)?.catalog?.signIn?.command ??
              "its sign-in command",
            // One string, so the command reads as code (inline backticks).
            set: "`{cli} agents accounts set-token {id}`"
              .replace("{cli}", cli)
              .replace(
                "{id}",
                acct.id +
                  (runtimeId === "den-claude" ? "" : ` --runtime ${runtimeId}`),
              ),
          }
        : {
            make:
              getRuntime(runtimeId)?.catalog?.signIn?.command ??
              "its sign-in command",
            set: `set secrets.refs.${refName} in your user.yml`,
          };
  return {
    env: {},
    warning: `⚠ ${tokenStatusLine({ mode: "token", configured: r.reason !== "not set", stored: false, setAt: null, ageDays: null, old: false, warnDays: 0, store: "", ...(r.reason ? { reason: r.reason } : {}) }, cli, undefined, how).text}`,
  };
}

/** HUB-1.5: hub.* and the token from this install's store; null without. */
async function defaultHub(): Promise<{
  url: string;
  token: string;
  allowTools: boolean;
  mcpUrl: string;
  inboxOnStop: "nudge" | "off";
  deliveryLoop: boolean;
} | null> {
  const { readHubConfig, readHubToken } = await import("../../shared/hub.js");
  let cfg;
  try {
    cfg = readHubConfig();
  } catch {
    return null; // a bad hub.* is doctor's and Settings' to say
  }
  if (!cfg) return null;
  const token = await readHubToken(cfg);
  return token
    ? {
        url: cfg.url,
        token,
        allowTools: cfg.allowTools,
        mcpUrl: cfg.mcpUrl,
        inboxOnStop: cfg.inboxOnStop,
        deliveryLoop: cfg.deliveryLoop,
      }
    : null;
}

/**
 * ON-6: the server agent's scope is no workspace, but its agent is a
 * normal one: it "exists", with no workspace runtime paths. SRV-1b: its
 * folder is `server_agent.folder`, the distribution's own repo by default
 * (a bad value refuses the start, naming the key). One started before
 * keeps the folder in its record (its conversation lives there) until a
 * fresh start.
 */
function withServerScope(r: AgentsResolved): AgentsResolved {
  return {
    ...r,
    workspaceExists: (ws) => isServerScope(ws) || r.workspaceExists(ws),
    workspaceDir: (ws) =>
      isServerScope(ws) ? r.serverAgentFolder() : r.workspaceDir(ws),
    workspaceFolders: (ws) =>
      isServerScope(ws)
        ? { under: [r.serverAgentFolder()] }
        : r.workspaceFolders(ws),
    workspaceRuntimeBin: (ws, id) =>
      isServerScope(ws) ? undefined : r.workspaceRuntimeBin(ws, id),
  };
}

// ── the agent's MCP ─────────────────────────────────────────────────────────

/** `<cli> mcp --workspace <ws> --actor agent:<id> [--grant <g>…]`. */
export function agentMcp(
  d: AgentsResolved,
  ws: string,
  id: string,
  grants: string[],
): AgentMcp {
  const server = d.mcpServer();
  const bin = Array.isArray(server.command) ? server.command : [server.command];
  return {
    name: d.cli,
    command: [
      ...bin,
      "mcp",
      "--workspace",
      ws,
      "--actor",
      `agent:${id}`,
      ...grants.flatMap((g) => ["--grant", g]),
    ],
    env: { ...installLocationEnv(d.env), ...server.env },
    scope: ws,
    ...(() => {
      // Issue 335: the project's own HTTP servers; a bearer is read at
      // each connect by `<cli> mcp headers <name>`, never written here.
      const extra = projectMcpServers(d, ws).map((s) => ({
        name: s.name,
        url: s.url,
        ...(s.bearer
          ? {
              headersHelper: projectMcpHeadersHelper(
                bin,
                { ...installLocationEnv(d.env), ...server.env },
                s.name,
              ),
            }
          : {}),
      }));
      return extra.length ? { extra } : {};
    })(),
  };
}

/**
 * Issue 335: project `ws`'s extra MCP servers, checked (a bad entry is
 * left out; doctor names it). Never Den's own server's name nor Hub's.
 */
export function projectMcpServers(
  d: Pick<AgentsResolved, "workspaceMcpServers" | "cli">,
  ws: string,
): ProjectMcpServer[] {
  if (isServerScope(ws)) return [];
  let raw: unknown;
  try {
    raw = d.workspaceMcpServers(ws);
  } catch {
    return [];
  }
  return parseProjectMcpServers(raw, [d.cli, HUB_SERVER]).servers;
}

// ── rows ────────────────────────────────────────────────────────────────────

/**
 * One row per agent of a workspace: each session joined to the agent record
 * that started it (by session id), and each record whose session is gone,
 * as stopped (after `agents stop`) or ended. A session without a record is
 * a plain one (`sessions start`), not an agent: `sessions list` shows it.
 */
export interface AgentRow {
  agent: string;
  /**
   * PSN-4 (issue 137): its persona changed since it started: the new
   * version's readable name (persona_version, else its hash's first 7)
   * and its hash.
   */
  personaNewer?: { version: string; hash: string };
  /** The name a person gave it (AG-4b), when one did. */
  displayName?: string;
  /**
   * den#3: the model its subagents run on ("inherit": the runtime
   * decides), and where that came from; for a runtime that takes one.
   */
  subagentModel?: string;
  subagentModelFrom?: SubagentModelFrom;
  /**
   * The name its session shows (AG-4b): the latest of Den's rename and the
   * runtime's own (Claude Code's /rename), when there is one. 0.4.12 called
   * this sessionName; sessionName is the record's session handle
   * (`<dist>-<ws>:<id>`), as it has been since 0.4.0.
   */
  sessionTitle?: string;
  persona?: string;
  runtime?: string;
  model?: string;
  /** Its model version: "latest" or pinned (AG-12.3). */
  version?: string;
  /** The permission intent it started with (AG-13). */
  permission?: PermissionIntent;
  /** Its extra allowed commands, when set for it (AG-13.4). */
  allow?: string[];
  /** What it overrides of its persona (AG-10.9). */
  overrides?: Override[];
  /** A newer version of its pinned model (AG-12.4). */
  newer?: string;
  workspace?: string;
  cwd?: string;
  /** running, stopping (stopped, its session not yet gone), exited
   * (<code>), stopped or interrupted. */
  state: string;
  /** When its current (or last) session started (ISO 8601). */
  startedAt?: string;
  /**
   * Resume applies: its runtime declares resume, its record has the
   * runtime's resume token, and it isn't running.
   */
  resumable: boolean;
  /**
   * AG-18: Change persona… applies: its runtime can resume and its record
   * has a conversation to continue (running or not), not rotated.
   */
  personaChange?: boolean;
  /**
   * Why Resume doesn't apply to a stopped agent (AG-14.2), e.g. "codex
   * can't resume a conversation": only Start fresh is offered.
   */
  noResume?: string;
  /** When `agents stop` stopped it. */
  stoppedAt?: string;
  /** When its session was seen to end on its own. */
  endedAt?: string;
  /** When Den found it interrupted by a restart. */
  interruptedAt?: string;
  /**
   * Issues 124, 631: Den restarted it (or its terminal host) and it
   * didn't come back: when, and why. Issue 923: `relaunchTried`, the
   * rotation sweep tried to relaunch it from its handoff once and failed.
   */
  restartFailed?: { at: string; why: string; relaunchTried?: boolean };
  /**
   * Issue 658: a handoff is on file (handoff.md, or one kept from a
   * relaunch) while no rotation is ready: Relaunch from its last handoff.
   */
  handoffOnFile?: boolean;
  /** Issue 659: its runtime asks whether to trust its folder, now. */
  trustWait?: boolean;
  /** Issue 659: it ended because its folder-trust question was declined. */
  trustDeclined?: boolean;
  /** Its persona resumes on its own after a restart (AG-14.3). */
  autoResume?: boolean;
  /** D59: this agent's own "Resume after a restart" (unset: its persona's). */
  resumeOnRestart?: boolean;
  /** D59: whether it resumes on its own after a restart, all told. */
  resumesOnRestart?: boolean;
  /** Issue 340: the label of the vendor account it runs on (never an email). */
  signIn?: string;
  outcome?: AgentRecord["outcome"];
  usage?: AgentRecord["usage"];
  /**
   * Session rotation (den#4): its compactions, whether a rotation is due
   * and why, and its handoff.md. `ready`: Relaunch from handoff, not Resume.
   */
  rotation?: RotationInfo;
  /** How many times Den relaunched it from a handoff. */
  rotations?: number;
  /** D28: the last one (when, why, the old conversation, by itself or not). */
  lastRotation?: RotationEntry;
  session?: SessionInfo;
  /**
   * D44: a running agent whose MCP servers differ from what it would get
   * now (Hub connected or disconnected since it launched). A restart that
   * keeps its conversation brings them in line.
   */
  mcpStale?: McpStale;
  /**
   * Issue 749: MCP servers whose tools failed to load in its running
   * session (Hub's, as Den sees it through its proxy), with the error.
   */
  mcpFailed?: McpLoadFailure[];
  /** D56: started outside its project (rec.cwd is that folder). */
  outside?: boolean;
  /**
   * D32/D34: the helpers it started in its own session, less those its
   * last "Clear done" hid: counts by state, and its active ones (running
   * or idle; running first, nested) for the row, at most row_max.
   */
  helpers?: {
    running: number;
    idle: number;
    /** Done, failed or stopped (what "Clear done" would hide). */
    ended: number;
    total: number;
    /** Hidden by its last "Clear done". */
    cleared: number;
    /** Running or idle: how many, and the first row_max of them. */
    activeCount: number;
    active: Helper[];
  };
}

/** Its state as a row shows it (AG-14.1: stopped, exited or interrupted). */
export function rowState(
  rec: AgentRecord | undefined,
  s?: SessionInfo,
): string {
  // Stopped (TERM sent) while its session still runs: on its way out.
  if (s && !s.exited)
    return rec?.stoppedAt && rec.stoppedAt >= s.startedAt
      ? "stopping"
      : "running";
  if (rec?.stoppedAt) return "stopped";
  // Issue 124: Den stopped it for a restart that didn't bring it back.
  if (rec?.restartFailed) return "interrupted";
  if (rec?.endedAt)
    return rec.exitCode === undefined ? "exited" : `exited (${rec.exitCode})`;
  // A host sees every exit of its own sessions, with its code. A session
  // listed as ended with no code ended with an earlier host (the host
  // loads them so: AG-3a); one not listed at all, the same. Nobody stopped
  // it and it never exited: the host (Den, or the machine) went down.
  if (s && s.exitCode !== undefined) return state(s);
  return "interrupted";
}

/** A state an agent can be removed or resumed in: not running. */
export function isStoppedState(st: string): boolean {
  return st !== "running" && st !== "stopping";
}

/**
 * Why `rec` can't be resumed (AG-14.2), or null when it can be: its
 * runtime can't resume a conversation, or has no token to resume with.
 */
export function resumeRefusal(rec: AgentRecord): string | null {
  const rt = getRuntime(rec.runtime);
  if (!rt?.resume) return `${rec.runtime} can't resume a conversation`;
  if (!rec.resumeToken) return `${rec.id} has no conversation to resume`;
  return null;
}

/** Whether `rec` may be resumed now, in `rowState`. */
function canResume(rec: AgentRecord, st: string): boolean {
  return isStoppedState(st) && resumeRefusal(rec) === null;
}

/** Why a rotated agent isn't resumed: its conversation ended there (den#4). */
export function rotatedRefusal(rec: AgentRecord, r: RotationInfo): string {
  return `${rec.id} rotated (${reasonText(r.due!, r.compactions)}): relaunch it from its handoff`;
}

export function agentRows(
  sessions: SessionInfo[],
  records: AgentRecord[] = [],
  /** Den's state dir: each agent's rotation is read there (den#4). */
  stateDir?: string,
  /** D28: each agent's effective rotation settings (policyResolver). */
  policyOf?: (rec: AgentRecord) => RotationPolicy | undefined,
): AgentRow[] {
  const bySession = new Map(records.map((r) => [r.session.id, r]));
  const rows: AgentRow[] = [];
  const shown = new Set<string>();
  const row = (rec: AgentRecord, s?: SessionInfo): AgentRow => {
    const st = rowState(rec, s);
    const rot = stateDir ? rotationInfo(stateDir, rec, policyOf?.(rec)) : null;
    // A rotated conversation is not resumed: it relaunches from its handoff.
    // D28: under on_due off, its conversation goes on: Resume stays.
    const resumable =
      canResume(rec, st) && !(rot?.ready && rot.onDue !== "off");
    const why =
      isStoppedState(st) && !resumable
        ? (resumeRefusal(rec) ?? (rot?.ready ? rotatedRefusal(rec, rot) : null))
        : null;
    const named = stateDir ? agentSessionName(rec, stateDir) : undefined;
    return {
      agent: rec.id,
      ...recordFields(rec),
      ...(named ? { sessionTitle: named } : {}),
      state: st,
      startedAt: s?.startedAt ?? rec.startedAt,
      resumable,
      ...(!(rot?.ready && rot.onDue !== "off") && !personaChangeRefusal(rec)
        ? { personaChange: true }
        : {}),
      ...(why ? { noResume: why } : {}),
      ...(rec.stoppedAt ? { stoppedAt: rec.stoppedAt } : {}),
      ...(rec.endedAt ? { endedAt: rec.endedAt } : {}),
      ...(rec.interruptedAt ? { interruptedAt: rec.interruptedAt } : {}),
      // Issue 631: why it didn't come back, while it hasn't since.
      ...(rec.restartFailed && isStoppedState(st)
        ? { restartFailed: { ...rec.restartFailed } }
        : {}),
      // Issue 659: its folder-trust question, waiting or declined.
      ...(rec.trustAsked && !isStoppedState(st) ? { trustWait: true } : {}),
      ...(rec.trustDeclined && isStoppedState(st)
        ? { trustDeclined: true }
        : {}),
      // Issue 658: Relaunch from its last handoff, while none is ready.
      ...(stateDir &&
      isStoppedState(st) &&
      !rot?.ready &&
      getRuntime(rec.runtime)?.firstPrompt &&
      newestHandoff(agentFilesDir(stateDir, rec.id))
        ? { handoffOnFile: true }
        : {}),
      ...(rec.outcome ? { outcome: rec.outcome } : {}),
      ...(rec.usage ? { usage: rec.usage } : {}),
      ...(rot ? { rotation: rot } : {}),
      ...(rec.rotations?.length
        ? {
            rotations: rec.rotations.length,
            lastRotation: rec.rotations[rec.rotations.length - 1],
          }
        : {}),
      ...(s ? { session: contractInfo(s) } : {}),
    };
  };
  for (const s of sessions) {
    const rec = bySession.get(s.ref.id);
    if (!rec) continue;
    shown.add(rec.id);
    rows.push(row(rec, s));
  }
  for (const rec of records) if (!shown.has(rec.id)) rows.push(row(rec));
  return rows;
}

function recordFields(rec: AgentRecord): Partial<AgentRow> {
  return {
    ...(rec.displayName ? { displayName: rec.displayName } : {}),
    persona: rec.persona,
    runtime: rec.runtime,
    ...(rec.model ? { model: rec.model } : {}),
    ...(rec.subagents
      ? {
          subagentModel: rec.subagents.model ?? INHERIT,
          subagentModelFrom: rec.subagents.from,
        }
      : {}),
    ...(rec.version ? { version: rec.version } : {}),
    ...(rec.permission ? { permission: rec.permission } : {}),
    ...(rec.allow ? { allow: [...rec.allow] } : {}),
    ...(rec.overrides?.length ? { overrides: [...rec.overrides] } : {}),
    ...(rec.resumeOnRestart !== undefined
      ? { resumeOnRestart: rec.resumeOnRestart }
      : {}),
    ...(rec.signIn ? { signIn: rec.signIn.label } : {}),
    ...newerOf(rec),
    workspace: rec.workspace,
    cwd: rec.cwd,
    // D56: it runs in the folder outside the project it started in.
    ...(rec.outside ? { outside: true } : {}),
  };
}

/**
 * AG-12.4: a pinned version older than its model's newest, as
 * `{ newer: <latest> }`; nothing otherwise.
 */
export function newerOf(
  rec: Pick<AgentRecord, "runtime" | "model" | "version">,
): {
  newer?: string;
} {
  if (!rec.version || rec.version === "latest" || !rec.model) return {};
  const m = getRuntime(rec.runtime)
    ?.models?.()
    .find((x) => x.id === rec.model);
  return m && m.latest !== rec.version ? { newer: m.latest } : {};
}

/**
 * Note in each record whose session the host lists as exited that it
 * ended, with its code (AG-14.1: "Exited (code n)"), so it still says so
 * once the host forgets the session (a restart). Only what the host says.
 */
export function noteEnded(
  stateDir: string,
  sessions: SessionInfo[],
  records: AgentRecord[],
  /** Issue 1325: where session temp folders are made (AgentsDeps). */
  sessionTmpBase = defaultSessionTmpBase(stateDir),
): void {
  const byId = new Map(sessions.map((s) => [s.ref.id, s]));
  for (const rec of records) {
    const s = byId.get(rec.session.id);
    // Issue 1325: an exited session's temp folder goes, however it ended
    // (never for one the host doesn't list: the host may just be away).
    if (s?.exited && rec.sessionTmp) {
      removeSessionTmp(rec.sessionTmp, sessionTmpBase);
      delete rec.sessionTmp;
      writeRecord(stateDir, rec);
    }
    // An exit with no code is a host that went down: interrupted, not ended.
    if (!s?.exited || s.exitCode === undefined) continue;
    if (rec.endedAt || rec.stoppedAt || rec.restartFailed) continue;
    rec.endedAt = new Date().toISOString();
    rec.exitCode = s.exitCode;
    writeRecord(stateDir, rec);
  }
}

/** A workspace name as given, checked (a usage error otherwise). */
export function checkWorkspaceName(where: string, ws: unknown): string {
  // D70: a workspace's name ("back office") or its slug.
  const k = typeof ws === "string" ? resolveWorkspaceInput(ws) : ws;
  if (typeof k !== "string" || !WORKSPACE_NAME_RE.test(k))
    throw usage(`${where}: "${String(ws)}" is not a project`);
  return k;
}

/**
 * The workspace's agents, and only its own: its records joined to its
 * sessions. `startHost: false` (the page) never starts a host to ask:
 * with none running, every agent's session is gone.
 */
export async function listAgents(
  d: AgentsResolved,
  ws: string,
  opts: { startHost?: boolean; stopped?: boolean } = {},
): Promise<AgentRow[]> {
  checkWorkspaceName("agents list", ws);
  agentsConfigValid(d);
  let all: SessionInfo[];
  if (opts.startHost === false) {
    const c = await d.connectExisting();
    try {
      all = c ? await c.list() : [];
    } finally {
      c?.close();
    }
  } else all = await withClient(d, (c) => c.list());
  const sessions = all.filter((s) => inWorkspace(s, d.dist, ws));
  const records = listRecords(d.stateDir()).filter((r) => r.workspace === ws);
  noteEnded(d.stateDir(), sessions, records, d.sessionTmpBase);
  const rows = agentRows(sessions, records, d.stateDir(), policyResolver(d));
  addHelperCounts(d, rows, records);
  addRestartResume(d, rows, records);
  await addMcpStale(d, rows);
  addPersonaNewer(d, rows, records, ws);
  // Issue 96: the person's order, as every list of the project's agents shows.
  const ordered = inAgentOrder(
    rows,
    (r) => ({ ws, id: r.agent, startedAt: r.startedAt }),
    (w) => agentOrderOf(w),
  );
  return opts.stopped
    ? ordered.filter((r) => isStoppedState(r.state))
    : ordered;
}

/**
 * Issue 96: move agent `id` in project `ws`'s order (up, down, top,
 * bottom, or a 1-based place) and store the whole order. Stopped agents
 * are in the list too: they keep their place (the page shows them in
 * Stopped). Returns the order and where `id` is now.
 */
export async function orderAgent(
  d: AgentsResolved,
  ws: string,
  id: string,
  to: AgentMove,
): Promise<{ order: string[]; position: number; of: number }> {
  agentRecord(d, id, ws);
  const shown = (await listAgents(d, ws, { startHost: false })).map(
    (r) => r.agent,
  );
  let next: string[];
  try {
    next = moveInOrder(shown, id, to);
  } catch (err) {
    throw new AgentError((err as Error).message, { usage: true });
  }
  const order = setAgentOrder(ws, next);
  return { order, position: order.indexOf(id) + 1, of: order.length };
}

/** D59: whether each agent resumes on its own after a restart. */
function addRestartResume(
  d: AgentsResolved,
  rows: AgentRow[],
  records: AgentRecord[],
): void {
  const of = restartResolver(d);
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const row of rows) {
    const rec = byId.get(row.agent);
    if (rec) row.resumesOnRestart = of(rec);
  }
}

/**
 * D59: whether an agent resumes on its own after a restart, the personas
 * read once (one resolver per list).
 */
export function restartResolver(
  d: AgentsResolved,
): (rec: AgentRecord) => boolean {
  const find = personaLookup(d);
  return (rec) => resumesOnRestart(rec, find(rec));
}

/**
 * An agent record's persona, read once per project (PSN-1: a project's
 * own personas are its agents' only); undefined when it is gone or the
 * personas can't be read.
 */
export function personaLookup(
  d: AgentsResolved,
): (rec: AgentRecord) => Persona | undefined {
  const byWs = new Map<string, Map<string, Persona> | null>();
  return (rec) => {
    if (isServerScope(rec.workspace)) return serverPersona();
    if (!byWs.has(rec.workspace)) {
      try {
        byWs.set(rec.workspace, personas(d, agentsConfig(d), rec.workspace));
      } catch {
        byWs.set(rec.workspace, null);
      }
    }
    return byWs.get(rec.workspace)?.get(rec.persona);
  };
}

/**
 * D59: the agent's own setting, over its persona's (`resume_on_restart`,
 * or a standing persona's). Off by default.
 */
export function resumesOnRestart(rec: AgentRecord, p?: Persona): boolean {
  return rec.resumeOnRestart ?? Boolean(p && (p.standing || p.resumeOnRestart));
}

// ── D44: an agent's MCP servers, as launched and as now ────────────────────

/** Servers a restart would add to a running agent, or take away. */
export interface McpStale {
  adds: string[];
  drops: string[];
  /** Issue 1223: its Den tools are an older Den's. */
  den?: DenToolsOld;
}

/** Issue 1223: Hub's change and its Den tools' age, in one; or none. */
export function withDenTools(
  st: McpStale | undefined,
  den: DenToolsOld | undefined,
): McpStale | undefined {
  if (!den) return st;
  return { ...(st ?? { adds: [], drops: [] }), den };
}

/** How long what Hub gives agents now is trusted (the token read is slow). */
export const HUB_NOW_TTL_MS = 30_000;
const hubNowCache = new WeakMap<
  AgentsResolved["hub"],
  { at: number; v: Promise<string | null> }
>();

/**
 * The URL of the Hub server an agent would get if it launched now, or null
 * (no Hub, or its token can't be read: agentHub's rule). Cached briefly
 * per Hub source; `fresh` asks again (after Connect or Disconnect).
 */
export function hubNow(
  d: Pick<AgentsResolved, "hub" | "denBase">,
  fresh = false,
): Promise<string | null> {
  const had = hubNowCache.get(d.hub);
  if (!fresh && had && Date.now() - had.at < HUB_NOW_TTL_MS) return had.v;
  // D52: an agent's Hub server is Den's proxy (one launched before it,
  // straight to Hub, is out of date and gets it on restart).
  const v = d
    .hub()
    .then((h) => (h ? `${denHubProxy(d)}/mcp` : null))
    .catch(() => null);
  hubNowCache.set(d.hub, { at: Date.now(), v });
  return v;
}

/** hubNow from this install's own config (the web server's lists). */
export const defaultHubNow = (fresh = false): Promise<string | null> =>
  hubNow({ hub: defaultHub, denBase: defaultDenBase }, fresh);

/** This machine's own names: one server whichever an agent was given. */
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|::1)$/;

/**
 * Two MCP server addresses that reach the same server: the same text, or
 * this machine spelled two ways (localhost, 127.0.0.1, ::1) with the same
 * scheme, port and path (one trailing slash aside). An agent launched with
 * one, when Den now hands out the other, is in line (Hub tools loaded).
 */
export function sameMcpUrl(had: unknown, now: string): boolean {
  if (had === now) return true;
  if (typeof had !== "string") return false;
  let a: URL, b: URL;
  try {
    a = new URL(had);
    b = new URL(now);
  } catch {
    return false;
  }
  const host = (u: URL) => u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loop = (u: URL) => LOOPBACK_HOST.test(host(u));
  const trail = (p: string) => p.replace(/\/+$/, "") || "/";
  return (
    (host(a) === host(b) || (loop(a) && loop(b))) &&
    a.protocol === b.protocol &&
    a.port === b.port &&
    trail(a.pathname) === trail(b.pathname) &&
    a.search === b.search
  );
}

/**
 * What agent `id`'s MCP config (as it launched) lacks or has extra against
 * Hub now (`hubUrl`, null: none). Undefined: in line, or no config file
 * (a runtime that writes none).
 */
export function mcpStaleOf(
  filesDir: string,
  hubUrl: string | null,
  /**
   * 0.4.48: Hub is set up but Den can't read its token now (hubProblem):
   * a wait, not a disconnect, so an agent with Hub's tools keeps them and
   * no restart is offered for them.
   */
  o: { waiting?: boolean } = {},
): McpStale | undefined {
  let servers: Record<string, { url?: unknown }>;
  try {
    servers =
      (
        JSON.parse(
          fs.readFileSync(path.join(filesDir, "mcp.json"), "utf-8"),
        ) as { mcpServers?: Record<string, { url?: unknown }> }
      ).mcpServers ?? {};
  } catch {
    return undefined;
  }
  const had = servers[HUB_SERVER];
  const adds: string[] = [];
  const drops: string[] = [];
  if (hubUrl && (!had || !sameMcpUrl(had.url, hubUrl))) adds.push(HUB_SERVER);
  if (!hubUrl && had && !o.waiting) drops.push(HUB_SERVER);
  return adds.length || drops.length ? { adds, drops } : undefined;
}

/** D44: each running row whose MCP servers are out of date says so. */
async function addMcpStale(d: AgentsResolved, rows: AgentRow[]): Promise<void> {
  const running = rows.filter((r) => r.state === "running");
  if (!running.length) return;
  const url = await hubNow(d);
  const waiting = d.hubProblem() !== null;
  for (const r of running) {
    const st = withDenTools(
      mcpStaleOf(agentFilesDir(d.stateDir(), r.agent), url, { waiting }),
      (() => {
        const rec = readRecord(d.stateDir(), r.agent);
        return rec ? denToolsOld(rec, r.startedAt, d.stateDir()) : undefined;
      })(),
    );
    if (st) r.mcpStale = st;
    const rec = r.startedAt ? { id: r.agent, startedAt: r.startedAt } : null;
    const failed = rec ? mcpLoadFailures(d.stateDir(), rec) : [];
    if (failed.length) r.mcpFailed = failed;
  }
}

/** D44: every running agent whose MCP servers are out of date. */
export async function staleAgents(
  d: AgentsResolved,
  opts: { fresh?: boolean } = {},
): Promise<{ id: string; workspace: string; stale: McpStale }[]> {
  const url = await hubNow(d, opts.fresh);
  let live: SessionInfo[] = [];
  const c = await d.connectExisting();
  try {
    live = c ? (await c.list()).filter((s) => !s.exited) : [];
  } finally {
    c?.close();
  }
  const out: { id: string; workspace: string; stale: McpStale }[] = [];
  for (const rec of listRecords(d.stateDir())) {
    const s = sessionOf(live, rec);
    if (!s) continue;
    const st = withDenTools(
      mcpStaleOf(agentFilesDir(d.stateDir(), rec.id), url, {
        waiting: d.hubProblem() !== null,
      }),
      denToolsOld(rec, s.startedAt ?? rec.startedAt, d.stateDir()),
    );
    if (st) out.push({ id: rec.id, workspace: rec.workspace, stale: st });
  }
  return out;
}

/** D44: what agent `id` is told of its own tools (MCP whoami, the pane). */
export interface AgentTools {
  agent: string;
  workspace: string;
  hub: {
    /** It would get Hub's tools if it launched now. */
    connected: boolean;
    /** Its running session has them (as it launched). */
    loaded: boolean;
    /** A restart (same conversation) brings them in line. */
    restart: boolean;
  };
  /** One plain line saying so, for the agent to tell the person. */
  note: string;
  /**
   * Issue 1016: the install's address for people (web.url), or null when
   * it isn't set. Never a loopback address.
   */
  webUrl: string | null;
  /** Issue 1016: full links on webUrl; absent when it isn't set. */
  links?: AgentLinks;
  /** Issue 1016: one line on the address: set, or where a person sets it. */
  address: string;
}

export async function agentTools(
  d: AgentsResolved,
  id: string,
  ws: string,
): Promise<AgentTools> {
  const rec = agentRecord(d, id, ws);
  const url = await hubNow(d);
  const files = agentFilesDir(d.stateDir(), rec.id);
  const problem = url === null ? d.hubProblem() : null;
  const st = mcpStaleOf(files, url, { waiting: problem !== null });
  const connected = url !== null;
  let loaded = connected
    ? !st?.adds.includes(HUB_SERVER)
    : Boolean(mcpStaleOf(files, url)?.drops.includes(HUB_SERVER));
  let restart = Boolean(st);
  // What its session actually got: a connect that failed in this session
  // (the proxy's note) means no hub_* tools until it connects again.
  // 0.4.48: or it launched with none because Den couldn't read its token.
  // Issue 749: or its connect worked but listing Hub's tools failed.
  const failed =
    loaded || connected
      ? (mcpLoadFailures(d.stateDir(), rec).find((f) => f.server === HUB_SERVER)
          ?.error ?? null)
      : null;
  if (failed) {
    loaded = false;
    restart = true;
  }
  // 0.4.48: Hub is set up but Den can't read its token now (problem): a
  // wait, not a reconnect; nobody needs to do anything.
  const note = problem
    ? `${problem}. Nothing for the person to do: Hub isn't disconnected. Once Den reads the token again, it restarts you to load Hub's tools if you need them (this conversation stays).`
    : failed
      ? `${connected ? "Hub is connected, but" : "Hub was disconnected, and"} you couldn't load its tools when you started (${failed}). Den restarts you to load them once Hub answers (this conversation stays); a person can also restart you from Den now. No token step is needed.`
      : !connected
        ? loaded
          ? "Hub was disconnected; its tools go when the person restarts you from Den."
          : "This Den is not connected to Hub. A person connects it in Settings › Hub."
        : restart
          ? "Hub is connected, but you started without its tools. Ask the person to restart you from Den (Restart keeps this conversation); no token step is needed."
          : "Hub is connected and its tools (hub_*) are yours.";
  // Issue 1016: the address people open, and full links on it; never
  // guessed when it isn't set.
  const webUrl = safeWebUrl(d);
  const links = agentLinks(webUrl, rec.workspace, rec.id);
  return {
    agent: rec.id,
    workspace: rec.workspace,
    hub: { connected, loaded, restart },
    note,
    webUrl,
    ...(links ? { links } : {}),
    address: webUrl ? addressBriefLine(webUrl) : addressNotSetNote(),
  };
}

/**
 * Issue 1016: web.url as an address people open, or null when it isn't
 * set, can't be read, or is loopback (peopleAddress).
 */
function safeWebUrl(d: AgentsResolved): string | null {
  try {
    return peopleAddress(d.webUrl());
  } catch {
    return null;
  }
}

/** D32: agents.helpers, or its defaults when the config can't be read. */
/**
 * A bad `agents:` key (a ConfigError naming it) stops listing agents and
 * reading their helpers, on the CLI as on the web (422), never with
 * defaults. Stopping an agent doesn't read it, so it is never stranded.
 */
function agentsConfigValid(d: AgentsResolved): void {
  d.agentsConfig();
}

function helperSettings(d: AgentsResolved): HelperSettings {
  try {
    return d.agentsConfig().helpers ?? HELPER_DEFAULTS;
  } catch {
    return HELPER_DEFAULTS;
  }
}

/** D32: each row's helper counts and recent helpers (never fails a list). */
function addHelperCounts(
  d: AgentsResolved,
  rows: AgentRow[],
  records: AgentRecord[],
): void {
  const settings = helperSettings(d);
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const row of rows) {
    const rec = byId.get(row.agent);
    if (!rec) continue;
    const h = rowHelpers(
      rec,
      !isStoppedState(row.state),
      settings,
      d.env,
      Date.now(),
      readClearedAt(agentFilesDir(d.stateDir(), rec.id)),
      row.startedAt,
    );
    if (h) row.helpers = h;
  }
}

/** #80: the most running helpers a row is sent (agents.helpers_shown's top). */
export const ROW_HELPERS_SENT = 10;

/**
 * D32/D34: what an agent's row shows of its helpers: its counts by state
 * and its active ones (running or idle; at most row_max, running kept),
 * less those its last "Clear done" hid (`clearedAt`). Done ones are only
 * counted: the Helpers list has them. Undefined: nothing to show (none,
 * or all cleared), or its runtime can't tell. Never throws.
 */
export function rowHelpers(
  rec: AgentRecord,
  live: boolean,
  settings: HelperSettings = HELPER_DEFAULTS,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  clearedAt?: number,
  /** When its running session started (ISO), when it runs. */
  liveSince?: string,
): AgentRow["helpers"] {
  const rt = getRuntime(rec.runtime);
  if (!rt?.helpers) return undefined;
  let all: Helper[] = [];
  try {
    all = rt.helpers(rec, {
      env,
      now,
      settings,
      agentLive: live,
      ...(live && liveSince ? { liveSince: Date.parse(liveSince) } : {}),
    });
  } catch {
    return undefined;
  }
  const { shown: hs, cleared } = splitCleared(all, clearedAt);
  if (!hs.length) return undefined;
  const active = hs.filter((h) => !isEnded(h));
  return {
    running: hs.filter((h) => h.status === "running").length,
    idle: hs.filter((h) => h.status === "idle").length,
    ended: hs.filter((h) => isEnded(h)).length,
    total: hs.length,
    cleared: cleared.length,
    activeCount: active.length,
    // #80: the running ones in start order, oldest first, as many as an
    // open badge can show (agents.helpers_shown, at most 10): the rows a
    // person sees never move when another starts.
    active: active
      .filter((h) => h.status === "running")
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      .slice(0, ROW_HELPERS_SENT),
  };
}

/** D32: an agent's helpers, read-only, and whether its runtime can tell. */
export async function agentHelpers(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<{
  rec: AgentRecord;
  supported: boolean;
  live: boolean;
  /** D34: without those its last "Clear done" hid. */
  helpers: Helper[];
  /** D34: the ones it hid (read-only, as the rest), and when. */
  cleared: Helper[];
  clearedAt?: number;
  note: string;
}> {
  agentsConfigValid(d);
  const rec = agentRecord(d, id, ws);
  const rt = getRuntime(rec.runtime);
  const state = await agentLive(d, rec);
  const live = state.agentLive;
  const all =
    rt?.helpers?.(rec, {
      env: d.env,
      settings: helperSettings(d),
      ...state,
    }) ?? [];
  const clearedAt = readClearedAt(agentFilesDir(d.stateDir(), rec.id));
  const { shown, cleared } = splitCleared(all, clearedAt);
  return {
    rec,
    supported: !!rt?.helpers,
    live,
    helpers: shown,
    cleared,
    ...(clearedAt !== undefined ? { clearedAt } : {}),
    note: HELPERS_READ_ONLY_NOTE,
  };
}

export async function runningSubagents(
  d: AgentsResolved,
): Promise<{ agent: string; startedAt?: number }[]> {
  const out: { agent: string; startedAt?: number }[] = [];
  for (const rec of listRecords(d.stateDir())) {
    const rt = getRuntime(rec.runtime);
    if (!rt?.helpers) continue;
    const state = await agentLive(d, rec);
    if (!state.agentLive) continue;
    for (const h of rt.helpers(rec, {
      env: d.env,
      settings: helperSettings(d),
      ...state,
    }))
      if (h.status === "running" && !h.earlier)
        out.push({ agent: rec.id, startedAt: h.startedAt });
  }
  return out;
}

/** D45: how many characters of a session's last line the details show. */
const LAST_LINE_MAX = 300;

/** D45: a stopped agent's details beyond its row (read-only). */
export interface AgentDetails {
  agent: string;
  workspace: string;
  /** What a person last asked it, one line, and when. */
  lastPrompt: { text: string; at?: string } | null;
  /** Its session ended on its own: the code and its last line (redacted). */
  exitCode?: number;
  lastLine?: string;
}

/**
 * D45: what the stopped agent's details pop-over shows beyond its row:
 * what it was last asked (its runtime's transcript, D39's turn rules) and,
 * when its session ended on its own, the exit code and the last line it
 * printed, secrets redacted. Nothing here starts, stops or sends anything.
 */
export async function agentDetails(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<AgentDetails> {
  const rec = agentRecord(d, id, ws);
  const rt = getRuntime(rec.runtime);
  let readMaxBytes: number | undefined;
  try {
    readMaxBytes = d.agentsConfig().turnReadMaxBytes;
  } catch {
    /* unreadable config: the default */
  }
  const prompt = rec.resumeToken
    ? (rt?.lastPrompt?.(rec.resumeToken, d.env, { readMaxBytes }) ?? null)
    : null;
  const out: AgentDetails = {
    agent: rec.id,
    workspace: rec.workspace,
    lastPrompt: prompt,
  };
  let c: HostClient | null = null;
  try {
    c = await d.connectExisting();
    const s = c ? sessionOf(await c.list(), rec) : undefined;
    if (c && s?.exited) {
      if (s.exitCode !== undefined) out.exitCode = s.exitCode;
      const lines = plainLines(
        (await c.scrollback(s.ref.id, 64 * 1024)).toString("utf-8"),
      ).filter((l) => l.trim());
      const last = lines[lines.length - 1];
      if (last)
        out.lastLine = [...redactSecrets(last.trim())]
          .slice(0, LAST_LINE_MAX)
          .join("");
    }
  } catch {
    /* no session host: no session facts */
  } finally {
    c?.close();
  }
  return out;
}

/**
 * D34 "Clear done": hides every helper of agent `id` that has ended (done,
 * failed, stopped), in this conversation and earlier ones, by setting its
 * cleared-at mark to now. Running and idle ones stay; Claude Code's files
 * are never touched. A person's only (the route refuses an agent).
 */
export function clearAgentHelpers(
  d: AgentsResolved,
  id: string,
  ws?: string,
  now = Date.now(),
): { rec: AgentRecord; clearedAt: number } {
  const rec = agentRecord(d, id, ws);
  writeClearedAt(agentFilesDir(d.stateDir(), rec.id), now);
  return { rec, clearedAt: now };
}

/** D32: one of agent `id`'s helpers' transcript; a 404 when there's none. */
export async function agentHelperTranscript(
  d: AgentsResolved,
  id: string,
  helperId: string,
  ws?: string,
  limit?: number,
): Promise<HelperTranscript & { note: string }> {
  agentsConfigValid(d);
  const rec = agentRecord(d, id, ws);
  const rt = getRuntime(rec.runtime);
  const t = rt?.helperTranscript?.(rec, helperId, {
    env: d.env,
    settings: helperSettings(d),
    ...(await agentLive(d, rec)),
    ...(limit ? { limit } : {}),
  });
  if (!t) throw refused(`agent ${id} has no helper "${helperId}"`, [], 404);
  return { ...t, note: HELPERS_READ_ONLY_NOTE };
}

/**
 * Whether agent `rec`'s session runs now (an unreachable host: no), and
 * since when (ms), for its helpers' states.
 */
async function agentLive(
  d: AgentsResolved,
  rec: AgentRecord,
): Promise<{ agentLive: boolean; liveSince?: number }> {
  try {
    const c = await d.connectExisting();
    if (!c) return { agentLive: false };
    try {
      const s = sessionOf(await c.list(), rec);
      if (!s || s.exited) return { agentLive: false };
      const since = Date.parse(s.startedAt);
      return Number.isFinite(since)
        ? { agentLive: true, liveSince: since }
        : { agentLive: true };
    } finally {
      c.close();
    }
  } catch {
    return { agentLive: false };
  }
}

// ── personas, runtimes ──────────────────────────────────────────────────────

/** The agents config; an invalid one is a refusal naming the key. */
function agentsConfig(d: AgentsResolved): ResolvedAgentsConfig {
  try {
    return d.agentsConfig();
  } catch (e) {
    throw refused((e as Error).message, [], 422);
  }
}

/**
 * PSN-1: project `ws`'s persona folders, `.den/personas` in each of its
 * repos as checked out, in its repo order. None outside a project.
 */
export function projectPersonaDirs(
  d: AgentsResolved,
  ws: string | undefined,
): string[] {
  if (!ws || isServerScope(ws)) return [];
  try {
    if (!d.workspaceExists(ws)) return [];
  } catch {
    return [];
  }
  return [...workspaceRepoFolders(d, ws).values()].map((dir) =>
    path.join(dir, ".den", "personas"),
  );
}

/**
 * PSN-4 (issue 137): mark each row whose persona's file changed since the
 * agent started (its recorded hash). A persona gone, unreadable personas,
 * or no hash recorded: no mark. Never throws.
 */
function addPersonaNewer(
  d: AgentsResolved,
  rows: AgentRow[],
  records: AgentRecord[],
  ws: string,
): void {
  let all: Map<string, Persona>;
  try {
    all = personas(d, d.agentsConfig(), ws);
  } catch {
    return;
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const row of rows) {
    const rec = byId.get(row.agent);
    const p = rec?.personaHash ? all.get(rec.persona) : undefined;
    const now = p ? personaHashOf(p) : undefined;
    if (!p || !now || now === rec!.personaHash) continue;
    row.personaNewer = {
      version: p.personaVersion ?? now.slice(0, 7),
      hash: now,
    };
  }
}

/** PSN-3: the sha256 of persona `p`'s file, or undefined if unreadable. */
export function personaHashOf(p: Persona): string | undefined {
  try {
    return createHash("sha256").update(fs.readFileSync(p.source)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Every persona; a bad pack or persona file is a refusal naming it. */
function personas(
  d: AgentsResolved,
  cfg: ResolvedAgentsConfig,
  /** ON-6: the server scope adds Den's own server persona (only there). */
  ws?: string,
): Map<string, Persona> {
  try {
    const all = loadPersonas(
      resolvePackDirs(cfg.personaPacks, d.distRoot()),
      undefined,
      { defaultPack: cfg.defaultPackGuardrails, packs: cfg.packGuardrails },
      localPersonasDir(d.stateDir()),
      projectPersonaDirs(d, ws),
    );
    if (isServerScope(ws)) all.set(SERVER_PERSONA_ID, serverPersona());
    return all;
  } catch (e) {
    throw refused((e as Error).message, [], 422);
  }
}

/**
 * D28: the workspace service whose folder holds `cwd` (the deepest), for
 * the service scope; undefined outside every service or on any error.
 */
function serviceAt(
  d: AgentsResolved,
  ws: string,
  cwd: string | undefined,
): string | undefined {
  if (!cwd) return undefined;
  try {
    let best: { address: string; path: string } | undefined;
    for (const svc of d.workspaceServices(ws)) {
      const rel = path.relative(svc.path, cwd);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (!best || svc.path.length > best.path.length) best = svc;
    }
    return best?.address;
  } catch {
    return undefined;
  }
}

/**
 * D28: a resolver of each agent's rotation settings, the config and the
 * personas read once. A config or persona that can't be read: undefined
 * (den#4's own rules), never an error in a list.
 */
export function policyResolver(
  d: AgentsResolved,
): (rec: AgentRecord) => RotationPolicy | undefined {
  let cfg: ResolvedAgentsConfig | null | undefined;
  const byWs = new Map<string, Map<string, Persona> | null>();
  return (rec) => {
    if (cfg === undefined) {
      try {
        cfg = d.agentsConfig();
      } catch {
        cfg = null;
      }
    }
    if (!cfg) return undefined;
    // PSN-1: per project, its own personas among them.
    const key = rec.workspace;
    if (!byWs.has(key)) {
      try {
        byWs.set(key, personas(d, cfg, rec.workspace));
      } catch {
        byWs.set(key, null);
      }
    }
    const all = byWs.get(key);
    if (!all) return undefined;
    return effectiveRotation(d, cfg, rec, all.get(rec.persona));
  };
}

/** D28: agent `rec`'s rotation under its effective settings. */
export function rotationOf(
  d: AgentsResolved,
  rec: AgentRecord,
): RotationInfo | null {
  return rotationInfo(d.stateDir(), rec, policyResolver(d)(rec));
}

/**
 * D28: agent `id`'s effective rotation settings and where each comes
 * from. `persona` is its persona (standing, and whether Den's hooks count
 * compactions: without them it never rotates).
 */
export function effectiveRotation(
  d: AgentsResolved,
  cfg: ResolvedAgentsConfig,
  who: { id: string; persona: string; workspace: string; cwd?: string },
  persona: Persona | undefined,
): RotationPolicy {
  const r = resolveRotate(
    {
      agent: who.id,
      persona: who.persona,
      workspace: who.workspace,
      ...(serviceAt(d, who.workspace, who.cwd)
        ? { service: serviceAt(d, who.workspace, who.cwd) }
        : {}),
      ...(persona?.standing ? { standing: true } : {}),
    },
    readRotateFile(d.stateDir()),
    cfg.rotateOrg ??
      (cfg.rotate
        ? {
            after_compactions: cfg.rotate.afterCompactions || "never",
            ...(cfg.rotate.standing === false ? { standing: false } : {}),
          }
        : undefined),
  );
  return {
    afterCompactions:
      persona && !persona.guardrails?.hooks ? 0 : r.afterCompactions,
    onDue: r.onDue,
    onPrMerged: r.onPrMerged,
    from: {
      after_compactions: sourceText(r.source.after_compactions),
      on_due: sourceText(r.source.on_due),
      on_pr_merged: sourceText(r.source.on_pr_merged),
    },
  };
}

/** A persona as listed: everything but its role prompt. */
export type ListedPersona = Omit<Persona, "prompt" | "guardrailsSet"> & {
  /** Its permission mode as Den's intent (AG-13), when it is one. */
  permission?: PermissionIntent;
};

function listed(p: Persona): ListedPersona {
  const { prompt: _p, guardrailsSet: _g, ...rest } = p;
  const permission = intentOf(p.permissionMode);
  return { ...rest, ...(permission ? { permission } : {}) };
}

/**
 * Den's default pack, then agents.persona_packs, then (PSN-1) project
 * `ws`'s, then local ones, by id.
 */
export function listPersonas(d: AgentsResolved, ws?: string): ListedPersona[] {
  return [
    ...personas(
      d,
      agentsConfig(d),
      isServerScope(ws) ? undefined : ws,
    ).values(),
  ]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(listed);
}

/** den#3: what agents' subagents run on, for `agents doctor`. */
export interface SubagentsReport {
  /** The org's: a model, or "inherit". */
  model: string;
  from: "org" | "default";
  claudeAiConnectors: boolean;
  /** Personas whose subagent_model overrides it. */
  personas: Array<{ id: string; model: string }>;
  /** Each agent, as it last started (a runtime that takes one). */
  agents: Array<{ id: string; model: string; from: SubagentModelFrom }>;
  /** The personas couldn't be read: why. */
  personasError?: string;
}

export function subagentsReport(d: AgentsResolved): SubagentsReport {
  const s = agentsConfig(d).subagents ?? SUBAGENT_DEFAULTS;
  let personas: SubagentsReport["personas"] = [];
  let personasError: string | undefined;
  try {
    personas = listPersonas(d).flatMap((p) =>
      p.subagentModel ? [{ id: p.id, model: p.subagentModel }] : [],
    );
  } catch (e) {
    personasError = (e as Error).message;
  }
  const agents = listRecords(d.stateDir())
    .flatMap((r) =>
      r.subagents
        ? [
            {
              id: r.id,
              model: r.subagents.model ?? INHERIT,
              from: r.subagents.from,
            },
          ]
        : [],
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    model: s.model,
    from: orgModelFrom(s),
    claudeAiConnectors: s.claudeAiConnectors,
    personas,
    agents,
    ...(personasError ? { personasError } : {}),
  };
}

/** A persona with its instructions (Details, Edit: AG-10.6). */
export function personaDetail(
  d: AgentsResolved,
  id: string,
  /** PSN-1: with a project, its own personas too. */
  ws?: string,
): ListedPersona & { instructions: string } {
  const p = personas(
    d,
    agentsConfig(d),
    isServerScope(ws) ? undefined : ws,
  ).get(id);
  if (!p) throw refused(`no persona "${id}"`, [], 404);
  return { ...listed(p), instructions: p.prompt };
}

/** The role and category registries (AG-10.5, AG-11.1). */
export function registries(d: AgentsResolved): {
  roles: RoleTemplate[];
  categories: Category[];
} {
  const cfg = agentsConfig(d);
  return {
    roles: roleRegistry(cfg.roles),
    categories: categoryRegistry(cfg.categories),
  };
}

/** What a persona's fields may name (persona-store.ts checks them). */
function personaChoices(d: AgentsResolved) {
  syncCatalog(d);
  const reg = registries(d);
  return {
    roles: reg.roles.map((r) => r.id),
    categories: reg.categories.map((c) => c.id),
    runtimes: runtimeIds()
      .filter((id) => getRuntime(id)?.catalog || id === DEFAULT_RUNTIME_ID)
      .map((id) => ({ id, models: getRuntime(id)?.models?.() ?? [] })),
  };
}

function checkedInput(d: AgentsResolved, body: unknown): PersonaInput {
  try {
    return checkPersonaInput(body, personaChoices(d));
  } catch (e) {
    if (e instanceof PersonaInputError) throw usage(e.message);
    throw e;
  }
}

/**
 * New persona (AG-10.7): a local one, its id from its name (or role),
 * never one any persona has. Returns it as listed.
 */
export function createPersona(d: AgentsResolved, body: unknown): ListedPersona {
  const input = checkedInput(d, body);
  const all = personas(d, agentsConfig(d));
  const id = newPersonaId(input, new Set(all.keys()));
  writeLocalPersona(d.stateDir(), id, input);
  return personaDetail(d, id);
}

/**
 * Edit persona `id` (AG-10.7): only a local one is written. A built-in or
 * a distribution's persona is read-only: 409, and the page duplicates it.
 */
export function updatePersona(
  d: AgentsResolved,
  id: string,
  body: unknown,
): ListedPersona {
  const p = personas(d, agentsConfig(d)).get(id);
  if (!p) throw refused(`no persona "${id}"`, [], 404);
  if (p.origin !== "local" || !localPersonaExists(d.stateDir(), id))
    throw new AgentError(
      `${id} is ${p.origin === "builtin" ? "built in" : `the ${p.origin}'s`}: duplicate it to edit a copy of your own`,
      { status: 409, code: "read_only" },
    );
  writeLocalPersona(d.stateDir(), id, checkedInput(d, body));
  return personaDetail(d, id);
}

/** SRV-P2: what a held persona write says it will do (HeldCheck's shape). */
export type PersonaHeldCheck =
  | {
      ok: true;
      summary: string;
      params: Record<string, string>;
      details: string[];
      /** Issue 205: one message key per details line. */
      detailKeys: DetailKey[];
      args: Record<string, unknown>;
      /** Issue 1403: the person's own Allow (see personaPersonOnly). */
      personOnly?: true;
    }
  | { ok: false; error: string };

/**
 * Issue 1403 (Den Builder): a persona's mode and commands are new tool
 * access, the person's, unless the install is personal with the sandbox
 * off and no agent in it (as agent_create, issue 1391). A config that
 * can't be read keeps it the person's.
 */
function personaPersonOnly(
  d: AgentsResolved,
  c: PersonaHeldCheck,
): PersonaHeldCheck {
  if (!c.ok) return c;
  let routine = false;
  try {
    routine = personalNoSandbox(d.agentsConfig());
  } catch {
    routine = false;
  }
  return routine ? c : { ...c, personOnly: true };
}

/** Who asked (HeldAsker): an agent's id and the project its token is for. */
export interface PersonaAsker {
  agent?: string;
  project?: string;
}

/** The Review's lines for a persona: its fields, then its instructions in full. */
function personaReview(input: PersonaInput): ReviewLine[] {
  const cmds = input.allowedCommands.join(", ");
  return [
    ...(input.displayName
      ? [
          rl(`Name: ${input.displayName}`, "ap.det.persona.name", {
            v: input.displayName,
          }),
        ]
      : []),
    rl(`Role: ${input.role}`, "ap.det.persona.role", { v: input.role }),
    rl(`Category: ${input.category}`, "ap.det.persona.category", {
      v: input.category,
    }),
    rl(`Description: ${input.description}`, "ap.det.persona.description", {
      v: input.description,
    }),
    input.model
      ? rl(
          `Runtime: ${input.runtime}, model ${input.model} (${input.version})`,
          "ap.det.persona.runtimeModel",
          {
            v: input.runtime,
            model: input.model,
            version: String(input.version ?? ""),
          },
        )
      : rl(`Runtime: ${input.runtime}`, "ap.det.persona.runtime", {
          v: input.runtime,
        }),
    rl(`Mode: ${input.permission}`, "ap.det.persona.mode", {
      v: input.permission,
    }),
    cmds
      ? rl(`Allowed commands: ${cmds}`, "ap.det.persona.commands", { v: cmds })
      : rl("Allowed commands: none", "ap.det.persona.commandsNone"),
    rl("Instructions:", "ap.det.persona.instructions"),
    // The persona's own words: shown as written, in any language.
    rl(input.instructions, "ap.det.asWritten", { v: input.instructions }),
  ];
}

const heldError = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error: (e as Error).message,
});

const LOCAL_FILE_LINE: ReviewLine = rl(
  "File: this machine's own personas (not shared with the project)",
  "ap.det.persona.local",
);

/** A project's agent: the project it works in (never Den's own scope). */
const projectOfAsker = (who: PersonaAsker): string | undefined =>
  who.project && !isServerScope(who.project) ? who.project : undefined;

/**
 * SRV-P2 + PSN-1: where a persona write goes. A project's agent writes
 * its own project's personas only (a repo's .den/personas); Den's own
 * agent or a person writes this machine's own, or a project's when they
 * name one. `repo`: one of the project's (default: its first).
 */
function personaHome(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: PersonaAsker,
  verb: "add" | "change",
):
  | { ok: true; ws?: string; repo?: string; dir?: string }
  | { ok: false; error: string } {
  const mine = projectOfAsker(who);
  const asked =
    typeof raw.project === "string" && raw.project.trim()
      ? raw.project.trim()
      : undefined;
  if (mine && asked && asked !== mine)
    return {
      ok: false,
      error: `${who.agent ?? "this agent"} works in project ${mine}: it can ${verb} personas there only, not to project ${asked}`,
    };
  const ws = mine ?? asked;
  if (!ws) return { ok: true };
  checkWorkspaceName("persona", ws);
  if (!d.workspaceExists(ws)) return { ok: false, error: `no project "${ws}"` };
  const repos = workspaceRepoFolders(d, ws);
  const want =
    typeof raw.repo === "string" && raw.repo.trim()
      ? raw.repo.trim()
      : undefined;
  const repo = want ?? [...repos.keys()][0];
  if (!repo)
    return {
      ok: false,
      error: `project ${ws} has no repo to keep personas in: add one first`,
    };
  const folder = repos.get(repo);
  if (!folder)
    return {
      ok: false,
      error: `project ${ws} has no repo "${repo}" (its repos: ${[...repos.keys()].sort().join(", ")})`,
    };
  return { ok: true, ws, repo, dir: path.join(folder, ".den", "personas") };
}

/** The persona fields only (a held ask's `project` and `repo` set aside). */
function personaFields(raw: unknown): Record<string, unknown> {
  const {
    project: _p,
    repo: _r,
    ...rest
  } = (raw ?? {}) as Record<string, unknown>;
  return rest;
}

/**
 * SRV-P2: checks a persona_create ask, writing nothing: the persona the
 * Personas page's New persona would write, the id it would get, and
 * (PSN-1) where: a project's repo, or this machine's own.
 */
export function checkPersonaCreate(
  d: AgentsResolved,
  raw: unknown,
  who: PersonaAsker = {},
): PersonaHeldCheck {
  return personaPersonOnly(d, personaCreateCheck(d, raw, who));
}

function personaCreateCheck(
  d: AgentsResolved,
  raw: unknown,
  who: PersonaAsker,
): PersonaHeldCheck {
  try {
    const r = (raw ?? {}) as Record<string, unknown>;
    const home = personaHome(d, r, who, "add");
    if (!home.ok) return home;
    const input = checkedInput(d, personaFields(r));
    const id = newPersonaId(
      input,
      new Set(personas(d, agentsConfig(d), home.ws).keys()),
    );
    const name = input.displayName ?? id;
    if (!home.ws)
      return {
        ok: true,
        summary: `add persona ${name} (${id})`,
        params: { name, id },
        details: [LOCAL_FILE_LINE, ...personaReview(input)].map((l) => l[0]),
        detailKeys: [LOCAL_FILE_LINE, ...personaReview(input)].map((l) => l[1]),
        args: { ...input },
      };
    const where = `${home.ws} › ${home.repo}`;
    const file = projectPersonaFile(home.dir!, id);
    return {
      ok: true,
      summary: `add persona ${name} (${id}) to project ${where}`,
      params: { name, id, where, inProject: "1" },
      ...review([
        rl(
          `File: ${file} (new; commit it so the project's other Dens get it)`,
          "ap.det.persona.newFile",
          { file },
        ),
        ...personaReview(input),
      ]),
      args: { ...input, project: home.ws, repo: home.repo! },
    };
  } catch (e) {
    return heldError(e);
  }
}

/** SRV-P2: on Allow, persona_create's write: a project's file, or local. */
export async function runPersonaCreate(
  d: AgentsResolved,
  args: Record<string, unknown>,
): Promise<ListedPersona> {
  if (typeof args.project !== "string") return createPersona(d, args);
  const home = personaHome(d, args, {}, "add");
  if (!home.ok || !home.dir) throw usage(home.ok ? "no project" : home.error);
  const input = checkedInput(d, personaFields(args));
  const id = newPersonaId(
    input,
    new Set(personas(d, agentsConfig(d), home.ws).keys()),
  );
  writeProjectPersona(home.dir, id, input);
  return personaDetail(d, id, home.ws);
}

/** Persona `p` as the page's form holds it (PersonaInput's fields). */
function personaInputOf(p: Persona): Record<string, unknown> {
  return {
    ...(p.displayName ? { displayName: p.displayName } : {}),
    role: p.role,
    category: p.category,
    description: p.description,
    instructions: p.prompt,
    runtime: p.runtime ?? DEFAULT_RUNTIME_ID,
    ...(p.model ? { model: p.model } : {}),
    version: p.version ?? "latest",
    permission: intentOf(p.permissionMode) ?? "ask",
    allowedCommands: [...p.allowedCommands],
    ...(p.subagentModel ? { subagentModel: p.subagentModel } : {}),
  };
}

/**
 * SRV-P2: checks a persona_update ask: `id` and only the fields that
 * change, laid over the persona as it is. A built-in or a distribution's
 * persona is read-only, as on the page. PSN-1: a project's agent changes
 * its project's personas only (its repos' files); Den's own agent or a
 * person changes this machine's own, or a project's when they name one.
 */
export function checkPersonaUpdate(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: PersonaAsker = {},
): PersonaHeldCheck {
  return personaPersonOnly(d, personaUpdateCheck(d, raw, who));
}

function personaUpdateCheck(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: PersonaAsker,
): PersonaHeldCheck {
  try {
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) return { ok: false, error: "id is required (a persona's id)" };
    const mine = projectOfAsker(who);
    const asked =
      typeof raw.project === "string" && raw.project.trim()
        ? raw.project.trim()
        : undefined;
    if (mine && asked && asked !== mine)
      return {
        ok: false,
        error: `${who.agent ?? "this agent"} works in project ${mine}: it can change personas there only, not in project ${asked}`,
      };
    const ws = mine ?? asked;
    if (ws && !d.workspaceExists(ws))
      return { ok: false, error: `no project "${ws}"` };
    const p = personas(d, agentsConfig(d), ws).get(id);
    if (!p) return { ok: false, error: `no persona "${id}"` };
    if (mine && p.origin !== "project")
      return {
        ok: false,
        error: `${id} is ${p.origin === "local" ? "this machine's own persona" : p.origin === "builtin" ? "built in" : `the ${p.origin}'s`}: a project's agent changes only its project's personas (its repos' .den/personas)`,
      };
    if (p.origin === "local" && !localPersonaExists(d.stateDir(), id))
      return { ok: false, error: `no persona "${id}"` };
    if (p.origin !== "local" && p.origin !== "project")
      return {
        ok: false,
        error: `${id} is ${p.origin === "builtin" ? "built in" : `the ${p.origin}'s`}: duplicate it (persona_create) to change a copy of your own`,
      };
    const was = personaInputOf(p);
    const given = Object.fromEntries(
      Object.entries(personaFields(raw)).filter(
        ([k, v]) => k !== "id" && v !== undefined,
      ),
    );
    for (const k of Object.keys(given))
      if (!(PERSONA_KEYS as readonly string[]).includes(k))
        return {
          ok: false,
          error: `${k}: unknown field (a persona takes ${PERSONA_KEYS.join(", ")})`,
        };
    const input = checkedInput(d, { ...was, ...given });
    const changed = PERSONA_KEYS.filter(
      (k) =>
        JSON.stringify((input as unknown as Record<string, unknown>)[k]) !==
        JSON.stringify(was[k]),
    );
    if (!changed.length)
      return { ok: false, error: `nothing to change in persona ${id}` };
    const fields = changed.join(", ");
    const inProject = p.origin === "project" && ws;
    const repo = inProject
      ? [...workspaceRepoFolders(d, ws).entries()].find(
          ([, dir]) =>
            path.resolve(path.join(dir, ".den", "personas", `${id}.md`)) ===
            path.resolve(p.source),
        )?.[0]
      : undefined;
    const where = inProject ? `${ws} › ${repo ?? "?"}` : undefined;
    return {
      ok: true,
      summary: `change persona ${id}: ${fields}${where ? ` in project ${where}` : ""}`,
      params: { id, fields, ...(where ? { where, inProject: "1" } : {}) },
      ...review([
        inProject
          ? rl(
              `File: ${p.source} (changed; commit it so the project's other Dens get it)`,
              "ap.det.persona.changedFile",
              { file: String(p.source) },
            )
          : LOCAL_FILE_LINE,
        ...changed.map((k): ReviewLine => {
          const v = (input as unknown as Record<string, unknown>)[k];
          const said = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          return said || !Array.isArray(v)
            ? rl(`${k}: ${said}`, "ap.det.persona.field", { field: k, v: said })
            : rl(`${k}: none`, "ap.det.persona.fieldNone", { field: k });
        }),
        rl("As it will read:", "ap.det.persona.asItWillRead"),
        ...personaReview(input),
      ]),
      args: { id, ...input, ...(inProject ? { project: ws } : {}) },
    };
  } catch (e) {
    return heldError(e);
  }
}

/** SRV-P2: on Allow, persona_update's write: the project's file, or local. */
export async function runPersonaUpdate(
  d: AgentsResolved,
  args: Record<string, unknown>,
): Promise<ListedPersona> {
  const { id, project, repo: _r, ...input } = args;
  if (typeof project !== "string") return updatePersona(d, String(id), input);
  const p = personas(d, agentsConfig(d), project).get(String(id));
  if (!p || p.origin !== "project")
    throw refused(`no persona "${String(id)}" in project ${project}`, [], 404);
  writeProjectPersona(
    path.dirname(p.source),
    String(id),
    checkedInput(d, input),
  );
  return personaDetail(d, String(id), project);
}

/** Delete local persona `id` (never a built-in or a distribution's). */
export function deletePersona(d: AgentsResolved, id: string): void {
  const p = personas(d, agentsConfig(d)).get(id);
  if (!p) throw refused(`no persona "${id}"`, [], 404);
  if (p.origin !== "local" || !deleteLocalPersona(d.stateDir(), id))
    throw new AgentError(
      `${id} isn't yours to delete: only local personas are`,
      {
        status: 409,
        code: "read_only",
      },
    );
}

export interface RuntimeChoice {
  id: string;
  /** Its name for people ("Claude Code"). */
  label?: string;
  /** Who makes it ("Anthropic"): a catalog runtime (AG-0.5). */
  vendor?: string;
  /**
   * false: it runs as its own CLI, without Den's tools yet ("Den tools:
   * coming"). Absent for a runtime that isn't from the catalog.
   */
  denTools?: boolean;
  available: boolean;
  /** Why it is unavailable. */
  why?: string;
  version?: string;
  /** The CLI it runs (AG-0.2). */
  path?: string;
  /**
   * Where that path came from: workspace (its workspaces.yml entry),
   * setting (user.yml), login-shell, PATH, well-known, interactive-shell.
   */
  source?: BinSource;
  /** The directories searched, in order (a runtime with a CLI to find). */
  searched?: string[];
  /**
   * Issue 456: the CLI it runs carries com.apple.quarantine, so Den runs
   * nothing of it ("quarantined, not run"; no version asked).
   */
  quarantined?: true;
  /**
   * Issue 456: the other copies found, with what their installs say of
   * their version (never run); one is pinned with `setting`.
   */
  others?: RuntimeCopy[];
  /** The user.yml key that sets its path (a runtime with a CLI to find). */
  setting?: string;
  /** The workspace's key for it, when listed for a workspace. */
  workspaceSetting?: string;
  /** It declares resume. */
  resume: boolean;
  default: boolean;
  /** Its models (AG-12.3); [] when it takes no model choice from Den. */
  models: RuntimeModel[];
  /** How it expresses permission intents (AG-13.2), when it can. */
  permissions?: RuntimePermissions;
  /** Its Shift+Enter bytes: also how a first instruction's newlines go. */
  softNewline?: string;
}

/**
 * The path set for runtime `id` (AG-0.5): the workspace's (when `ws` is
 * given and it sets one), else user.yml's; null when neither does.
 */
export function runtimeSetting(
  d: AgentsResolved,
  id: string,
  ws?: string,
): BinSetting | null {
  if (ws) {
    const v = d.workspaceRuntimeBin(ws, id);
    if (v !== undefined && v !== null)
      return { value: v, source: "workspace", key: workspaceBinKey(ws, id) };
  }
  const g = d.runtimeBin(id);
  return g === undefined || g === null ? null : { value: g, source: "setting" };
}

/**
 * Whether runtime `rt` can run here (AG-0.1, AG-0.5): a path set for the
 * workspace, else user.yml's (`agents.runtimes.<id>.bin`), else the
 * search. Runs nothing.
 */
export function detectRuntime(
  d: AgentsResolved,
  rt: Runtime,
  ws?: string,
): RuntimeDetect {
  return rt.detect(d.env, { bin: runtimeSetting(d, rt.id, ws) });
}

/**
 * The catalog entries the distribution and user.yml add, registered as
 * runtimes (AG-0.5). A malformed entry is a refusal naming its key.
 */
export function syncCatalog(d: AgentsResolved): void {
  const cfg = agentsConfig(d);
  let extra: CatalogEntry[];
  try {
    extra = [
      ...cfg.runtimeCatalog,
      ...d.userCatalog([
        ...BUILTIN_CATALOG.map((e) => e.id),
        ...cfg.runtimeCatalog.map((e) => e.id),
      ]),
    ];
  } catch (e) {
    throw refused((e as Error).message, [], 422);
  }
  syncConfiguredRuntimes(extra);
}

/**
 * Issue 456: before a catalog runtime is searched for (nothing set at this
 * scope), ask the interactive shell for its PATH, the first place looked:
 * the PATH the person's terminal has. Once per process, then kept.
 */
async function interactiveSearch(
  d: AgentsResolved,
  rts: Runtime[],
  ws?: string,
): Promise<void> {
  if (interactivePathAsked()) return;
  const searched = rts.some(
    (rt) => rt.catalog && !runtimeSetting(d, rt.id, ws),
  );
  if (searched)
    await ensureInteractivePath({
      env: d.env,
      timeoutMs: d.shellPathTimeoutSeconds() * 1000,
    });
}

/**
 * The catalog's installed runtimes first, then the ones not found, then
 * the rest (generic: no CLI of its own to find).
 */
function rank(r: RuntimeChoice): number {
  if (r.denTools === undefined) return 2;
  return r.available ? 0 : 1;
}

/**
 * Every registered runtime, and whether it can run here (for an agent of
 * `ws`, when given: its workspace's path wins), with the path it runs and
 * its version: its version command (`claude --version`), run once under a
 * timeout and kept, else what its install says. Installed ones first.
 */
export async function listRuntimes(
  d: AgentsResolved,
  ws?: string,
): Promise<RuntimeChoice[]> {
  syncCatalog(d);
  const ids = runtimeIds();
  await interactiveSearch(
    d,
    ids.map((id) => getRuntime(id)!),
    ws,
  );
  const rows = await Promise.all(
    ids.map(async (id) => {
      const rt = getRuntime(id)!;
      const det = detectRuntime(d, rt, ws);
      // Issue 456: only the chosen copy is asked, and never a quarantined
      // one (its install's files say its version instead).
      const asked =
        det.available && det.path && rt.find?.versionArgs && !det.quarantined
          ? await runtimeVersion(det.path, rt.find.versionArgs, d.env)
          : undefined;
      const version =
        asked ??
        det.version ??
        (det.quarantined && det.path ? installVersion(det.path) : undefined);
      return {
        id,
        ...(rt.label ? { label: rt.label } : {}),
        ...(rt.vendor ? { vendor: rt.vendor } : {}),
        ...(rt.catalog ? { denTools: rt.denTools === true } : {}),
        available: det.available,
        ...(det.available ? {} : { why: det.why ?? "unavailable" }),
        ...(version ? { version } : {}),
        ...(det.path ? { path: det.path } : {}),
        ...(det.source ? { source: det.source } : {}),
        ...(det.quarantined ? { quarantined: true as const } : {}),
        ...(det.others?.length ? { others: det.others } : {}),
        ...(rt.find
          ? {
              searched: det.searched ?? [],
              setting: binSettingKey(id),
              ...(ws ? { workspaceSetting: workspaceBinKey(ws, id) } : {}),
            }
          : {}),
        resume: Boolean(rt.resume),
        default: id === DEFAULT_RUNTIME_ID,
        models: rt.models?.() ?? [],
        ...(rt.permissions ? { permissions: rt.permissions } : {}),
      };
    }),
  );
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

/**
 * Set (or, with null, clear) runtime `id`'s path, global or for workspace
 * `ws` (AG-0.5): its version command runs first, and a path that isn't
 * that runtime is refused. Returns its row as listed after.
 */
export async function setRuntimePath(
  d: AgentsResolved,
  req: {
    id: string;
    scope: "global" | "workspace";
    workspace?: string;
    bin: string | null;
  },
): Promise<RuntimeChoice> {
  syncCatalog(d);
  const rt = runtimeFor(req.id);
  if (!rt.catalog)
    throw usage(`${req.id} has no CLI to find: its path can't be set`);
  let ws: string | undefined;
  if (req.scope === "workspace") {
    ws = checkWorkspaceName("runtime path", req.workspace);
    if (!d.workspaceExists(ws))
      throw usage(`project "${ws}" does not exist`, 404);
  }
  if (req.bin !== null) {
    const c = await checkRuntimeBin(rt.catalog, req.bin, d.env);
    if (!c.ok) throw refused(c.why, [], 422);
    d.saveRuntimeBin(req.scope, ws, rt.id, c.path);
  } else d.saveRuntimeBin(req.scope, ws, rt.id, null);
  const rows = await listRuntimes(d, ws);
  return rows.find((r) => r.id === rt.id)!;
}

/** Refused unless `rt` can run here; its detect result when it can. */
async function availableOrRefuse(
  d: AgentsResolved,
  rt: Runtime,
  ws?: string,
): Promise<RuntimeDetect> {
  await interactiveSearch(d, [rt], ws);
  const det = detectRuntime(d, rt, ws);
  if (!det.available)
    throw refused(
      `${rt.id} is unavailable: ${det.why ?? "unknown"}`,
      rt.find
        ? [
            `Install it, or set ${binSettingKey(rt.id)} to its absolute path in ${d.userConfigFile()}.`,
            `\`${d.cli} agents doctor\` shows where it looked.`,
          ]
        : [],
      503,
    );
  quarantineOrRefuse(d, rt, det);
  return det;
}

/**
 * Issue 479: refused, before anything is spawned, when the CLI copy `rt`
 * would run carries com.apple.quarantine: running it would make macOS
 * show its warning. Says why, the path and the choices (another copy
 * found, or clear this one yourself). Den never clears the attribute.
 */
function quarantineOrRefuse(
  d: AgentsResolved,
  rt: Runtime,
  det: RuntimeDetect,
): void {
  if (!det.available || !det.quarantined || !det.path) return;
  const name = rt.label || rt.id;
  const key = binSettingKey(rt.id);
  const others = (det.others ?? []).filter((o) => !o.quarantined);
  const dir = path.dirname(det.path);
  throw new AgentError(
    `${rt.id} can't start: macOS has quarantined ${det.path} (com.apple.quarantine), so Den did not run it and macOS showed no warning. ` +
      (others.length
        ? `A person can use another copy found (${others.map((o) => o.path).join(", ")}) or clear this one.`
        : "A person can clear it, or install another copy."),
    {
      status: 409,
      code: RUNTIME_QUARANTINED,
      hints: [
        ...others.map(
          (o) =>
            `Use another copy: set ${key} to ${o.path} in ${d.userConfigFile()} (or Settings › Runtimes › Use this).`,
        ),
        `Or clear it yourself: in ${dir}, run ${path.basename(det.path)} once from a terminal and allow it when macOS asks. Den never removes the quarantine.`,
      ],
      quarantined: {
        runtime: rt.id,
        name,
        path: det.path,
        dir,
        scope: det.source === "workspace" ? "workspace" : "global",
        setting: key,
        others,
      },
    },
  );
}

/**
 * Issue 479: before an agent is stopped to be started again (restart,
 * move, persona change, relaunch): refused while its runtime's copy is
 * quarantined, so it is never left stopped by a start that can't run.
 */
async function notQuarantined(
  d: AgentsResolved,
  runtime: string,
  ws?: string,
): Promise<void> {
  syncCatalog(d);
  const rt = getRuntime(runtime);
  if (!rt) return;
  await interactiveSearch(d, [rt], ws);
  quarantineOrRefuse(d, rt, detectRuntime(d, rt, ws));
}

function runtimeFor(id: string): Runtime {
  const rt = getRuntime(id);
  if (!rt)
    throw usage(`no runtime "${id}" (runtimes: ${runtimeIds().join(", ")})`);
  return rt;
}

/** The running session of `rec`, if any; else its exited one, if listed. */
function sessionOf(
  sessions: SessionInfo[],
  rec: AgentRecord,
): SessionInfo | undefined {
  return sessions.find((s) => s.ref.id === rec.session.id);
}

/**
 * Issue 631: the session `rec` runs in now: its record's, else a live one
 * under its own session name (the name is the agent's alone), when its
 * record still names an earlier session of its own.
 */
function liveSessionOf(
  sessions: SessionInfo[],
  rec: AgentRecord,
): SessionInfo | undefined {
  const own = sessionOf(sessions, rec);
  if (own && !own.exited) return own;
  return sessions.find((s) => !s.exited && s.name === rec.sessionName) ?? own;
}

/**
 * Issue 631: whether `rec`'s conversation was launched with a first prompt
 * (a relaunch from its handoff, den#4): it began then, so it is always
 * resumed, never started afresh under its id. The record keeps the
 * conversation each relaunch ended; the current one is none of them.
 */
export function launchedFromHandoff(rec: AgentRecord): boolean {
  const token = rec.resumeToken;
  if (!token || !rec.launched || !rec.rotations?.length) return false;
  return rec.rotations.every((x) => x.conversation !== token);
}

/**
 * The id a new start gets without --id (AG-10.10): the persona's id while
 * no agent has it; `<persona>-<ws>` when another workspace's agent has it;
 * else the first of `<base>-2`, `<base>-3`… no agent has. A stopped agent's
 * id is never reused by a new start: only its Resume or Start fresh.
 */
/**
 * AG-10.10b: the id a Name gives: its slug while no agent has it; a
 * running agent in the workspace with that id or that title is refused
 * (open it instead); a stopped one, or another workspace's, makes it the
 * next free `<slug>-2`… (Resume continues the stopped one). Null when the
 * Name has no id characters: the persona's default then.
 */
async function namedId(
  d: AgentsResolved,
  name: string,
  ws: string,
): Promise<string | null> {
  const slug = nameSlug(name);
  const sessions = await withClient(d, (c) => c.list());
  const live = (rec: AgentRecord) => {
    const s = sessionOf(sessions, rec);
    return s && !s.exited ? s : undefined;
  };
  // No two live agents in one workspace share a title, or this id.
  for (const rec of listRecords(d.stateDir())) {
    if (rec.workspace !== ws) continue;
    const same =
      rec.id === slug ||
      (rec.displayName ?? "").toLowerCase() === name.toLowerCase();
    const s = same ? live(rec) : undefined;
    if (s)
      throw new AgentError(`agent ${rec.id} is running (${s.name})`, {
        status: 409,
        hints: [`Attach: ${d.cli} sessions attach ${s.name}`],
        running: { id: rec.id, sessionId: s.ref.id },
      });
  }
  return namedIdChoice(d.stateDir(), name);
}

/**
 * The id a start with display name `name` gets (namedId, without its
 * live-session check): the name's slug, or slug-2, slug-3 … when taken;
 * null when the name has no slug. Issue 1328: agent_create's sandbox check
 * calls this too, so it checks the id the start picks.
 */
function namedIdChoice(stateDir: string, name: string): string | null {
  const slug = nameSlug(name);
  if (!slug) return null;
  if (!readRecord(stateDir, slug)) return slug;
  const stem = slug.slice(0, 58);
  for (let n = 2; n < 1000; n++) {
    const id = `${stem}-${n}`;
    if (!readRecord(stateDir, id)) return id;
  }
  throw refused(`no free agent id for ${slug}: give one with --id`);
}

export function defaultId(
  stateDir: string,
  persona: string,
  ws: string,
): string {
  const rec = readRecord(stateDir, persona);
  if (!rec) return persona;
  const base = rec.workspace === ws ? persona : `${persona}-${ws}`.slice(0, 64);
  if (base !== persona && !readRecord(stateDir, base)) return base;
  const stem = base.slice(0, 58);
  for (let n = 2; n < 1000; n++) {
    const id = `${stem}-${n}`;
    if (!readRecord(stateDir, id)) return id;
  }
  throw refused(`no free agent id for ${persona}: give one with --id`);
}

function checkId(where: string, id: string): void {
  if (!AGENT_ID_RE.test(id) || AGENTS_RESERVED_KEYS.includes(id))
    throw usage(
      `${where}: --id "${id}" must be letters, digits, ".", "_" or "-" (1-64), ` +
        `and not ${AGENTS_RESERVED_KEYS.join(" or ")}`,
    );
}

interface Launch {
  rec: Omit<AgentRecord, "session" | "startedAt">;
  /** Issue 936: an agent that has a record already (resume, relaunch). */
  existing?: boolean;
  argv: string[];
  env: Record<string, string>;
  /** The runtime's envPassthrough. */
  passthrough?: readonly string[];
  /** den#3: Runtime.launchEnv, names its launch env sets past the scrub. */
  launchEnv?: readonly string[];
  /** Issue 163 (b): Runtime.signInTokenEnv. */
  tokenEnv?: string;
  /** agents.<id>.grants, recorded with its actor token. */
  grants: readonly string[];
  /** Added to the session's PATH: a configured CLI's own directory. */
  binDir?: string;
}

/**
 * A CLI's directory when the session's PATH wouldn't have it (a path set
 * for it, or found by the interactive shell), for its own tools.
 */
function binDirOf(det: RuntimeDetect): { binDir?: string } {
  return (det.source === "setting" ||
    det.source === "workspace" ||
    det.source === "interactive-shell") &&
    det.path
    ? { binDir: path.dirname(det.path) }
    : {};
}

/** The host's cap refusal as an AgentError (its hint says what to do). */
function capOrThrow(d: AgentsResolved, e: unknown): never {
  if (e instanceof HostError && e.code === "cap")
    throw new AgentError(e.message, {
      status: 429,
      code: "cap",
      hints: [
        `Stop one first (\`${d.cli} agents stop <id>\`), or raise agents.max_concurrent.`,
      ],
    });
  throw e;
}

/**
 * Start `launch` as the agent's session (replacing an exited one) and record
 * it. SEC-1c: a fresh actor token for the session (every earlier one of the
 * agent revoked), bound to the session id once the host has started it, and
 * revoked again when the start fails.
 */
async function startSession(
  d: AgentsResolved,
  c: HostClient,
  launch: Launch,
  old: SessionInfo | undefined,
  extra: Partial<AgentRecord>,
): Promise<{
  rec: AgentRecord;
  info: SessionInfo;
  signInWarning?: string;
  sandboxWarning?: string;
  signingWarning?: string;
}> {
  if (old?.exited) await c.forget(old.ref.id);
  // Issue 163 (b): read before the token is minted (nothing to revoke).
  const signIn = await d.agentSignIn(
    launch.tokenEnv,
    launch.rec.runtime,
    launch.rec.cwd,
  );
  const tty = d.stdout.isTTY;
  const minted = mintActorToken(d.stateDir(), {
    agentId: launch.rec.id,
    workspace: launch.rec.workspace,
    grants: launch.grants,
    sessionName: launch.rec.sessionName,
  });
  let info: SessionInfo;
  let box: SandboxWrap;
  let legacy = false;
  // Issue 1325: a sandboxed session's own temp folder (its sockets work).
  let sessionTmp: string | undefined;
  let signing: AgentSigning | undefined;
  let signingWarning: string | undefined;
  try {
    // #70: the token in a file of the agent's own; the env names the file.
    const tokenFile = writeActorTokenFile(
      d.stateDir(),
      launch.rec.id,
      minted.token,
    );
    // Issue 1316: its commits signed with the agents' own SSH key, never
    // the person's GPG (the sandbox refuses gpg's agent socket). Before
    // the sandbox: bwrap binds only the folders that exist.
    try {
      signing = d.agentSigning(launch.rec.cwd);
      if (signing?.made)
        signingWarning = `${launch.rec.id} signs its commits with the agents' new SSH key. GitHub shows them Verified once you add it: ${signingKeyAddLine(signing)}`;
    } catch (e) {
      signingWarning = `${launch.rec.id}'s commits can't be signed with the agents' key: ${e instanceof Error ? e.message : String(e)}`;
    }
    // Issue 936: Den's state read-only to the session (the OS sandbox).
    // An agent from before the sandbox starts outside it until the person
    // turns it on (the rollout, sandbox-rollout.ts).
    legacy =
      launch.existing === true &&
      isFromBefore(launch.rec as AgentRecord) &&
      !sandboxSetByPerson(d.agentsConfig(), launch.rec.id);
    box = legacy
      ? {
          applied: false,
          argv: launch.argv,
          env: {},
          reason: LEGACY_SANDBOX_REASON,
        }
      : (() => {
          // The last session's folder, if it outlived it, goes first.
          removeSessionTmp(launch.rec.sessionTmp, d.sessionTmpBase);
          if (sandboxSetting(d.agentsConfig(), launch.rec.id)) {
            try {
              sessionTmp = d.sessionTmp();
            } catch {
              sessionTmp = undefined; // the system's TMPDIR, as before
            }
          }
          const w = d.agentSandbox(launch.argv, launch.rec.id, sessionTmp);
          if (!w.applied) {
            removeSessionTmp(sessionTmp, d.sessionTmpBase);
            sessionTmp = undefined;
          }
          return w;
        })();
    if (!box.applied && sandboxRequired(d.agentsConfig(), launch.rec.id))
      throw refused(
        `agents start: ${launch.rec.id} needs the agent sandbox (agents.sandbox: required), and it can't apply here: ${box.reason ?? "no sandbox"}`,
        [`\`${d.cli} agents doctor\` shows why.`],
        409,
      );
    info = await c
      .start(
        {
          name: launch.rec.sessionName,
          cwd: launch.rec.cwd,
          argv: box.argv,
          // Never the caller's whole env: the allowlist, then the runtime's.
          env: agentSessionEnv(
            d.env,
            { envPassthrough: launch.passthrough, launchEnv: launch.launchEnv },
            launch.env,
            launch.rec.id,
            tokenFile,
            launch.binDir ? [launch.binDir] : [],
            // agents.git (issue 1316): its commits signed with its key.
            { ...agentGitEnv(signing), ...box.env },
            signIn.env,
          ),
          cols: (tty && d.stdout.columns) || 80,
          rows: (tty && d.stdout.rows) || 24,
        },
        { limit: d.maxConcurrent(), pool: "agents" },
      )
      .catch((e: unknown) => capOrThrow(d, e));
  } catch (e) {
    revokeActorToken(d.stateDir(), minted.key);
    removeActorTokenFile(d.stateDir(), launch.rec.id);
    removeSessionTmp(sessionTmp, d.sessionTmpBase);
    throw e;
  }
  bindActorSession(d.stateDir(), minted.key, info.ref.id);
  const rec: AgentRecord = {
    ...launch.rec,
    session: { backend: info.ref.backend, id: info.ref.id },
    startedAt: info.startedAt,
    grants: [...launch.grants],
    ...extra,
  };
  // Issue 1223: the Den its tools start on (they keep its code).
  const denV = engineVersion();
  if (denV) rec.denVersion = denV;
  else delete rec.denVersion;
  if (sessionTmp) rec.sessionTmp = sessionTmp;
  else delete rec.sessionTmp;
  // A new session: whatever ended the last one no longer applies.
  delete rec.stoppedAt;
  delete rec.endedAt;
  delete rec.exitCode;
  delete rec.interruptedAt;
  delete rec.restartFailed;
  // Issue 659: a new session hasn't been asked to trust its folder yet.
  delete rec.trustAsked;
  delete rec.trustDeclined;
  // Issue 252: it runs in `permission` now.
  delete rec.startedIn;
  // Issue 340: the sign-in this session runs on (its label only).
  if (signIn.account) rec.signIn = { ...signIn.account };
  else delete rec.signIn;
  // Issue 936: whether its session is sandboxed, and why not.
  rec.sandbox = box.applied
    ? { applied: true, ...(box.tool ? { tool: box.tool } : {}) }
    : {
        applied: false,
        ...(legacy ? { legacy: true as const } : {}),
        ...(box.reason ? { reason: box.reason } : {}),
      };
  writeRecord(d.stateDir(), rec);
  return {
    rec,
    info,
    ...(signIn.warning ? { signInWarning: signIn.warning } : {}),
    // Issue 936: the start line names an agent that runs unsandboxed.
    ...(box.applied
      ? {}
      : {
          sandboxWarning: `${rec.id} runs outside the agent sandbox (Den's state is writable to it): ${box.reason ?? "no sandbox here"}`,
        }),
    ...(signingWarning ? { signingWarning } : {}),
  };
}

/**
 * CSI, OSC (BEL or ST ended), charset designations (`ESC ( B`), and other
 * two-byte escapes, save and restore (`ESC 7`, `ESC 8`) and keypad modes
 * included: Claude Code ends with `ESC ( B ESC 7 ESC 8`.
 */
/* eslint-disable no-control-regex */
const TERMINAL_ESCAPE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+\-./][ -~]|\x1b[0-9:;<=>?@-Z\\-_]/g;
/* eslint-enable no-control-regex */

/** Printable lines of terminal output: escapes and control bytes removed. */
export function plainLines(text: string): string[] {
  return (
    text
      .replace(TERMINAL_ESCAPE, "")
      .split(/\r?\n/)
      // A carriage return redraws the line: what stays is after the last.
      .map((l) => l.slice(l.lastIndexOf("\r") + 1))
      // eslint-disable-next-line no-control-regex
      .map((l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd())
      .filter((l) => l.trim())
  );
}

/** A new session that exited non-zero at once. */
export interface EarlyExit {
  exitCode?: number;
  /** Its last printed lines, secret-shaped values redacted. */
  tail: string[];
  /** All it printed (the last 64 KB), as plain text, to match against. */
  said: string;
  sessionName: string;
}

/**
 * Watch a new session for an early exit (d.exitWatchMs, polling the host):
 * a non-zero one, with its code and the last lines it printed.
 */
async function exitedAtOnce(
  d: AgentsResolved,
  c: HostClient,
  info: SessionInfo,
): Promise<EarlyExit | null> {
  const deadline = Date.now() + d.exitWatchMs;
  while (Date.now() < deadline) {
    await new Promise((r) =>
      setTimeout(r, Math.min(EXIT_POLL_MS, Math.max(0, deadline - Date.now()))),
    );
    const s = (await c.list()).find((x) => x.ref.id === info.ref.id);
    if (!s) return null;
    if (!s.exited) continue;
    if (s.exitCode === 0) return null;
    const lines = plainLines(
      (await c.scrollback(s.ref.id, 64 * 1024)).toString("utf-8"),
    );
    const tail = lines.slice(-EXIT_TAIL_LINES).map((l) => redactSecrets(l));
    return {
      ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }),
      tail,
      said: lines.join("\n"),
      sessionName: s.name,
    };
  }
  return null;
}

/**
 * den#3: what an agent's record says its subagents run on, for a runtime
 * that takes a subagent model; nothing for one that doesn't.
 */
function subagentsField(
  rt: Runtime,
  persona: Persona,
  cfg: ResolvedAgentsConfig,
): Pick<AgentRecord, "subagents"> {
  if (!rt.subagentModel) return {};
  const e = effectiveSubagentModel(persona, cfg.subagents);
  return {
    subagents: { ...(e.model ? { model: e.model } : {}), from: e.from },
  };
}

function launchInput(
  d: AgentsResolved,
  cfg: ResolvedAgentsConfig,
  persona: Persona,
  ws: string,
  id: string,
  model: string | undefined,
  bin?: string,
  /** The grants to serve (a resume's, narrowed); default the config's. */
  only?: readonly string[],
  /** AG-13: the intent and the allowed commands (preset and extras). */
  perms: { permission?: PermissionIntent; allow?: string[] } = {},
  runtimeId?: string,
): LaunchInput {
  const grants = only ? [...only] : (cfg.agents[id]?.grants ?? []);
  for (const g of grants)
    if (!d.workspaceExists(g))
      throw refused(
        `agents.${id}.grants: project "${g}" does not exist`,
        [],
        422,
      );
  const dir = d.workspaceDir(ws);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw refused(`project ${ws}'s directory ${dir} does not exist`);
  // den#4: only Den's hooks count compactions; without them, no rotation.
  const after = effectiveRotation(
    d,
    cfg,
    { id, persona: persona.id, workspace: ws, cwd: dir },
    persona,
  ).afterCompactions;
  // Issue 728: this install registers itself (its server does at start too),
  // then reads the others.
  const ownEdgeKeys = edgeKeyDirs(d.distRoot());
  // ...narrowed where the edge folder holds this install's own folders.
  const ownEdgeDeny = narrowEdgeDirs(ownEdgeKeys, [
    path.resolve(d.stateDir()),
    path.resolve(d.distRoot()),
    path.resolve(dir),
  ]);
  const reg = registryDir({ ...process.env, ...d.env });
  const others = (() => {
    try {
      registerInstall(reg, {
        stateDir: d.stateDir(),
        edgeKeyDirs: ownEdgeKeys,
      });
    } catch {
      /* listed at its server's next start */
    }
    return listOtherInstalls(reg, {
      ownStateDir: d.stateDir(),
      home: { ...process.env, ...d.env }.HOME,
      // No entry may deny this install's own checkout or workspace.
      protect: [d.distRoot(), dir],
    });
  })();
  return {
    persona,
    workspace: { name: ws, dir },
    agentId: id,
    worktree: dir,
    ...(model ? { model } : {}),
    mcp: agentMcp(d, ws, id, grants),
    filesDir: agentFilesDir(d.stateDir(), id),
    stateDir: d.stateDir(),
    // Issue 1391: read at this start; a change of mode waits for the next.
    ...(agentsMayReadTrail(cfg, d.stateDir()) ? { trailReadable: true } : {}),
    // Issue 816: test installs announced on this computer; issue 728: the
    // other installs registered for this OS user, any distribution's.
    otherStateDirs: [
      ...new Set([
        ...listAnnounced(announceDir(), { ownStateDir: d.stateDir() }).map(
          (a) => a.stateDir,
        ),
        ...others.map((o) => o.stateDir),
      ]),
    ],
    repoDirs: [
      ...new Set(
        [ws, ...grants].flatMap((w) => {
          try {
            return d
              .workspaceServices(w)
              .map((s) => s.path)
              .filter((p) => !!p && path.isAbsolute(p));
          } catch {
            return [];
          }
        }),
      ),
    ],
    playwrightAuthDir: path.join(d.distRoot(), PLAYWRIGHT_AUTH_DIR),
    // ...and where they announce, for those announced after this launch.
    testAnnounceDir: announceDir(),
    installRegistryDir: reg,
    personConfigDir: path.join(d.distRoot(), "config", "local"),
    // Issue 728: the edge's key folders, wherever its config puts them, and
    // the other installs' edges'.
    edgeKeyDirs: [
      ...new Set([...ownEdgeDeny, ...others.flatMap((o) => o.edgeKeyDirs)]),
    ],
    // Issue 810: the distribution config (the test-install mark).
    distConfigFile: path.join(d.distRoot(), product().configFile),
    env: d.env,
    ...(bin ? { bin } : {}),
    // den#3: its subagents' model (the persona's, else the org's), and
    // whether it loads the account's claude.ai connectors.
    ...(() => {
      const sub = effectiveSubagentModel(persona, cfg.subagents);
      return sub.model ? { subagentModel: sub.model } : {};
    })(),
    ...(cfg.subagents?.claudeAiConnectors ? { claudeAiConnectors: true } : {}),
    // D47: services it may reach only through their API.
    ...(() => {
      try {
        const a = writeApiOnlyRules(d.stateDir());
        return a ? { apiOnly: a } : {};
      } catch {
        return {};
      }
    })(),
    rotateAfter: after,
    ...skillPacksFor(d, cfg, persona, id, runtimeId),
    ...(perms.permission ? { permission: perms.permission } : {}),
    ...(perms.allow?.length ? { allow: [...perms.allow] } : {}),
    // ON-6: the server agent runs Den's own tools without the runtime's
    // prompt; its writes wait for the person's Allow in the browser.
    ...(isServerScope(ws) ? { denToolsAllowed: true } : {}),
    // Issue 1016: the address line of its start brief.
    webUrl: safeWebUrl(d),
    // NT-1: it tells Den when it waits for its person (the bell).
    // Issue 609: its hooks' wait and retries (user.yml agent_hooks.*).
    attention: {
      base: d.denBase(),
      call: hookCallSettings(readUserConfig),
    },
  };
}

function skillPacksFor(
  d: AgentsResolved,
  cfg: ResolvedAgentsConfig,
  persona: Persona,
  id: string,
  runtimeId: string | undefined,
): Pick<LaunchInput, "skillPacks"> {
  if (!runtimeId) return {};
  const env = { ...process.env, ...d.env };
  try {
    const got = agentSkillPacks({
      stateDir: d.stateDir(),
      runtimeId,
      install: readSkillPacksConfig(cfg.skillPacks?.den, cfg.skillPacks?.user),
      persona: persona.skillPacks,
      agent: cfg.agents[id]?.skillPacks,
      claudeConfigDir:
        env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? os.homedir(), ".claude"),
    });
    return got.packs.length ? { skillPacks: got.packs } : {};
  } catch (e) {
    throw refused(`agent ${id}: ${(e as Error).message}`, [], 422);
  }
}

/** The model a runtime is given: a pinned version, else the model. */
export function launchModel(
  model: string | undefined,
  version: string | undefined,
): string | undefined {
  return version && version !== "latest" ? version : model;
}

/**
 * A stored model as runtime `runtimeId`'s catalog names it: a full model
 * name that is one of its versions becomes that alias, pinned to it
 * ("claude-opus-5-5" → opus, claude-opus-5-5). Null when it is already in
 * that form, or isn't one Den can name (kept as given).
 */
export function catalogModel(
  runtimeId: string,
  model: string | undefined,
  version: string | undefined,
): { model: string; version: string } | null {
  if (!model) return null;
  const rt = getRuntime(runtimeId);
  const models = rt?.models?.() ?? [];
  if (!rt?.fullModel || models.some((m) => m.id === model)) return null;
  try {
    const c = checkModelChoice(
      { id: rt.id, models, fullModel: rt.fullModel },
      model,
      version ?? "latest",
    );
    return c.model && c.model !== model
      ? { model: c.model, version: c.version }
      : null;
  } catch {
    return null;
  }
}

/**
 * A record written before 0.4.38 with a full model name where its runtime
 * has an alias (Bring in kept the transcript's): stored again in the
 * catalog's form, so Relaunch and Start fresh take it. The launch is the
 * same model either way.
 */
function healModel(d: AgentsResolved, rec: AgentRecord): AgentRecord {
  const c = catalogModel(rec.runtime, rec.model, rec.version);
  if (!c) return rec;
  const next = { ...rec, ...c };
  try {
    writeRecord(d.stateDir(), next);
  } catch {
    // Read-only state: the healed record is still used for this call.
  }
  return next;
}

/**
 * The commands an agent may run without asking (AG-13.3, 13.4): its
 * persona role's preset, then its extra commands.
 */
function allowedFor(
  d: AgentsResolved,
  persona: Persona,
  extras: readonly string[],
): string[] {
  const preset = rolePreset(registries(d).roles, persona.role);
  return [...new Set([...preset, ...extras])];
}

/** The rotation limit a launch counts against: 0 when its runtime can't relaunch. */
function launchAfter(rt: Runtime, input: LaunchInput): number {
  return rt.firstPrompt ? (input.rotateAfter ?? 0) : 0;
}

function ptyOrRefuse(d: AgentsResolved): void {
  const pty = d.pty();
  if (!pty.available)
    throw refused(
      `${DEN_PTY_ID} is unavailable: ${pty.reason}`,
      [`\`${d.cli} doctor\` shows the session backend's state.`],
      503,
    );
}

/** A runtime's refusal of a launch (a bad persona key) as an AgentError. */
function launchOrThrow<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LaunchError) throw refused(e.message, [], 422);
    throw e;
  }
}

/**
 * Issue 278: at each start, the instruction files the runtime loads for
 * the agent's folder, measured (stat only) against a share of its model's
 * context; kept beside its files for its row; the warning when over, else
 * nothing. Never throws: a measure that fails is no warning.
 */
function measureInstructions(
  d: AgentsResolved,
  rt: Runtime,
  at: { cwd: string; filesDir: string; model?: string; version?: string },
): string[] {
  if (!rt.instructionFiles) return [];
  const env = d.env;
  try {
    const s = d.contextWatch();
    const c = instructionCheck(rt.instructionFiles(at.cwd, env), at.cwd, {
      sharePercent: s.sharePercent,
      contextTokens: contextTokensFor(at.model, at.version, s.contextTokens),
      home: env.HOME,
    });
    writeInstructionCheck(at.filesDir, c);
    return c.over ? [instructionWarning(c)] : [];
  } catch {
    return [];
  }
}

/** A started (or resumed) agent. */
export interface Started {
  rec: AgentRecord;
  info: SessionInfo;
  warnings: string[];
  /** Set when its session exited non-zero at once. */
  early: EarlyExit | null;
}

export interface StartRequest {
  workspace: string;
  persona: string;
  runtime?: string;
  model?: string;
  id?: string;
  /** "latest" or a pinned version of the model (AG-12.3). */
  version?: string;
  /** The permission intent for this launch (AG-13.6). */
  permission?: string;
  /** Extra allowed commands for this launch, instead of the persona's. */
  allow?: unknown;
  /** AG-10.10: a display name for this agent (AG-4b's), to tell two apart. */
  name?: unknown;
  /**
   * 0.4.18, Start agent here: the folder it runs in, the workspace's own
   * or one inside it (a repo's), relative to the workspace's folder or
   * absolute. Default: the workspace's folder.
   */
  folder?: string;
  /**
   * The page's start (AG-10.1): a model must be one the runtime offers,
   * never a free string (the CLI's --model for generic stays free).
   */
  strict?: boolean;
  /**
   * D65 v2: the repo it works on; null: none. Unset: the last record's
   * (a relaunch, Start fresh), else proposed from its folder.
   */
  repo?: string | null;
}

/**
 * den#48: workspace `ws`'s default permission mode, checked; undefined when
 * unset. A bad value is refused, naming the key: never quietly "ask".
 */
export function workspacePermissionOf(
  d: AgentsResolved,
  ws: string,
): PermissionIntent | undefined {
  const v = d.workspacePermission(ws);
  if (v === undefined || v === null) return undefined;
  try {
    return checkIntent(v, workspacePermissionKey(ws));
  } catch (e) {
    throw usage(`agents start: ${(e as Error).message}`);
  }
}

/**
 * 0.4.46 MODE-UI: the install's mode (agents.default_mode), checked;
 * undefined when unset.
 */
export function installPermissionOf(
  d: AgentsResolved,
): PermissionIntent | undefined {
  const v = d.installPermission();
  if (v === undefined || v === null) return undefined;
  try {
    return checkIntent(v, "agents.default_mode");
  } catch (e) {
    throw usage(`agents start: ${(e as Error).message}`);
  }
}

/**
 * The mode an agent follows when nobody chose one for it: its project's,
 * else the install's (then, by the caller, its persona's).
 */
export function followedPermissionOf(
  d: AgentsResolved,
  ws: string,
): PermissionIntent | undefined {
  return workspacePermissionOf(d, ws) ?? installPermissionOf(d);
}

/** What a start resolved, checked, before it launches. */
interface Choices {
  model?: string;
  version: string;
  permission?: PermissionIntent;
  extras: string[];
  overrides: Override[];
}

/**
 * The model, version, permission and extra commands a start runs with
 * (AG-10.9, 12.3, 13.6): the request's, else the persona's; each checked
 * against what the runtime offers. What differs from the persona is an
 * override, and the list tags it.
 */
function startChoices(
  req: StartRequest,
  persona: Persona,
  rt: Runtime,
  /** den#48: the workspace's default mode, for a start that names none. */
  wsPermission?: PermissionIntent,
): Choices {
  const where = "agents start";
  const models = rt.models?.() ?? [];
  const overrides: Override[] = [];
  const personaRt = persona.runtime ?? DEFAULT_RUNTIME_ID;
  if (req.runtime && req.runtime !== personaRt) overrides.push("runtime");
  // The persona's model is for its own runtime only.
  const sameRt = rt.id === personaRt;
  const personaModel = sameRt ? persona.model : undefined;
  const personaVersion = (sameRt && persona.version) || "latest";
  let model = req.model ?? personaModel;
  let version =
    req.version ??
    (req.model === undefined || req.model === personaModel
      ? personaVersion
      : "latest");
  if (req.model !== undefined && req.strict && !models.length)
    throw usage(`${where}: ${rt.id} takes no model choice from Den`);
  if (req.version !== undefined && req.version !== "latest" && !models.length)
    throw usage(`${where}: ${rt.id} takes no model version from Den`);
  // The page's choices are checked against the catalog; the CLI's --model
  // stays as given (a full model name), unless a version comes with it.
  if (
    models.length &&
    (req.strict || req.version !== undefined) &&
    (req.model !== undefined || req.version !== undefined)
  )
    try {
      const c = checkModelChoice(
        { id: rt.id, models, fullModel: rt.fullModel },
        model,
        version,
      );
      model = c.model;
      version = c.version;
    } catch (e) {
      throw usage(`${where}: ${(e as Error).message}`);
    }
  // A full model name its catalog knows (a transcript's, `--model`'s) is
  // stored as the alias, pinned: Relaunch and Start fresh then take it.
  const named = catalogModel(rt.id, model, version);
  if (named) {
    model = named.model;
    version = named.version;
  }
  if (req.model !== undefined && req.model !== personaModel)
    overrides.push("model");
  if (version !== personaVersion) overrides.push("version");
  let permission: PermissionIntent | undefined;
  if (req.permission !== undefined) {
    try {
      permission = checkIntent(req.permission, "permission");
    } catch (e) {
      throw usage(`${where}: ${(e as Error).message}`);
    }
    if (!rt.permissions)
      throw usage(
        `${where}: ${rt.id} can't take a permission mode from Den yet`,
      );
    if (permission !== intentOf(persona.permissionMode))
      overrides.push("permission");
  } else if (rt.permissions) {
    // den#48: the project's mode (else the install's), over the persona's.
    // Not an override: nobody chose it for this agent, so it follows them
    // later. Recorded to show it; every resume and restart reads them
    // again (issue 225: resolveMode, the one rule).
    permission = resolveMode({
      project: wsPermission,
      persona: persona.permissionMode,
    }).mode;
  }
  let extras = persona.allowedCommands;
  if (req.allow !== undefined) {
    try {
      extras = checkCommands(req.allow, "allow");
    } catch (e) {
      throw usage(`${where}: ${(e as Error).message}`);
    }
    if (extras.length && !rt.permissions)
      throw usage(
        `${where}: ${rt.id} can't take allowed commands from Den yet`,
      );
    const same =
      extras.length === persona.allowedCommands.length &&
      extras.every((c) => persona.allowedCommands.includes(c));
    if (!same) overrides.push("allow");
  }
  return {
    ...(model ? { model } : {}),
    version,
    ...(permission ? { permission } : {}),
    extras: [...extras],
    overrides,
  };
}

/** What a relaunch from handoff adds to a start (den#4). */
interface StartMore {
  firstPrompt?: string;
  rotations?: AgentRecord["rotations"];
  /** Called once the old session is known ended, before the launch. */
  beforeLaunch?: () => void;
  /**
   * AG-17.1, bring in a conversation: launch the runtime's resume of this
   * one (its id, in the folder it ran in) instead of a new conversation.
   */
  bringIn?: { token: string; cwd: string; outside?: boolean };
}

/**
 * 0.4.18: the folder a start runs in. Relative to the workspace's folder,
 * or absolute; it must be a directory inside the workspace's scope (its
 * folder, or a by-path repo's), never outside it.
 */
export function startFolder(
  d: AgentsResolved,
  ws: string,
  folder: string,
): string {
  const where = "agents start";
  if (typeof folder !== "string" || !folder.trim() || folder.length > 4096)
    throw usage(`${where}: folder must be a path`);
  const dir = path.resolve(d.workspaceDir(ws), folder.trim());
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    throw usage(`${where}: folder ${dir} does not exist`, 404);
  }
  if (!fs.statSync(real).isDirectory())
    throw usage(`${where}: folder ${dir} is not a directory`);
  // The real folder only: a link inside the workspace that points out of
  // it is outside it (the scope's own folders are compared real, too).
  if (!inScope(real, d.workspaceFolders(ws)))
    throw refused(
      `${where}: folder ${dir} is not inside project ${ws}`,
      [],
      403,
    );
  return real;
}

export async function startAgent(
  d: AgentsResolved,
  req: StartRequest,
  more: StartMore = {},
): Promise<Started> {
  const where = "agents start";
  const ws = checkWorkspaceName(where, req.workspace);
  if (!d.workspaceExists(ws))
    throw usage(`${where}: project "${ws}" does not exist`, 404);
  const cfg = agentsConfig(d);
  const all = personas(d, cfg, ws);
  const persona = all.get(req.persona);
  if (!persona)
    throw usage(
      `${where}: no persona "${req.persona}" (personas: ${[...all.keys()].sort().join(", ")})`,
    );
  let given: string | null = null;
  if (req.name !== undefined)
    try {
      given = checkDisplayName(req.name);
    } catch (e) {
      throw usage(`${where}: ${(e as Error).message}`);
    }
  const id =
    req.id ??
    (given ? await namedId(d, given, ws) : null) ??
    defaultId(d.stateDir(), persona.id, ws);
  checkId(where, id);
  // Den's own agent's id is never a project's agent's: what trusts it
  // (server_agent.self_update: auto) also checks the scope.
  if (id === SERVER_AGENT_ID && !isServerScope(ws))
    throw refused(
      `${where}: "${SERVER_AGENT_ID}" is Den's own agent's id; give this one another --id`,
    );
  // Review M1: the rest under this agent's lock (agent-lock.ts).
  return lockAgent(d, id, async () => {
    syncCatalog(d);
    const rt = runtimeFor(req.runtime ?? persona.runtime ?? DEFAULT_RUNTIME_ID);
    const det = await availableOrRefuse(d, rt, ws);
    const ch = startChoices(req, persona, rt, followedPermissionOf(d, ws));
    const model = launchModel(ch.model, ch.version);

    const prev = readRecord(d.stateDir(), id);
    if (prev && prev.workspace !== ws)
      throw refused(
        `agent ${id} belongs to project ${prev.workspace}; give this one another --id`,
      );
    // Gap 7: with no folder, the project's own repo, never the folder above.
    // The server agent's folder is server_agent.folder's, always.
    const home =
      req.folder === undefined && !more.bringIn && !isServerScope(ws)
        ? defaultAgentFolder(d, ws, req.repo, prev)
        : undefined;
    ptyOrRefuse(d);
    const allow = allowedFor(d, persona, ch.extras);
    // D24: the name peers see it by, from the name it will have (below).
    const peerName = peerSessionName(d.cli, ws, {
      id,
      displayName: given ?? prev?.displayName ?? persona.displayName,
    });
    const base = launchInput(
      d,
      cfg,
      persona,
      ws,
      id,
      model,
      det.path,
      undefined,
      {
        ...(ch.permission ? { permission: ch.permission } : {}),
        ...(rt.permissions ? { allow } : {}),
      },
      rt.id,
    );
    // HUB-1.5: Den Hub's MCP server, when hub.url is set.
    const hub = await agentHub(d, ws);
    const input = {
      ...base,
      ...(hub ? { mcp: { ...base.mcp, hub } } : {}),
      sessionLabel: peerName,
      ...(more.firstPrompt ? { firstPrompt: more.firstPrompt } : {}),
      // 0.4.18: Start agent here: in a folder of the workspace's.
      ...(req.folder !== undefined && !more.bringIn
        ? { worktree: startFolder(d, ws, req.folder) }
        : home
          ? { worktree: startFolder(d, ws, home) }
          : {}),
      // AG-17.1: the runtime's resume, in the folder the conversation ran in.
      ...(more.bringIn
        ? { worktree: more.bringIn.cwd, resumeToken: more.bringIn.token }
        : {}),
    };
    // AG-13.4: a command a runtime can't express is said, never dropped.
    const unexpressed =
      !rt.permissions && allow.length
        ? [
            `${rt.id} can't take allowed commands from Den yet: ${allow.join(", ")} not applied (it asks as usual)`,
          ]
        : [];

    return withClient(d, async (c) => {
      const sessions = await c.list();
      const old = prev ? sessionOf(sessions, prev) : undefined;
      if (old && !old.exited)
        throw new AgentError(`agent ${id} is running (${old.name})`, {
          status: 409,
          hints: [`Attach: ${d.cli} sessions attach ${old.name}`],
          running: { id, sessionId: old.ref.id },
        });
      const out = more.bringIn
        ? { ...broughtIn(rt, input), resumeToken: more.bringIn.token }
        : launchOrThrow(() => rt.launch(input));
      more.beforeLaunch?.();
      // A new conversation: a handoff left from the last one is kept aside,
      // so the next rotation needs its own (den#4).
      if (fs.existsSync(handoffFile(input.filesDir)))
        archiveHandoff(
          input.filesDir,
          `${new Date().toISOString().replace(/[:.]/g, "-")}-unused`,
        );
      writeRuntimeFiles(input.filesDir, out.files);
      // den#4: a new conversation's compactions count from 0.
      launchRotation(input.filesDir, out.resumeToken, launchAfter(rt, input));
      const sized = measureInstructions(d, rt, {
        cwd: input.worktree,
        filesDir: input.filesDir,
        model: ch.model,
        version: ch.version,
      });
      const { rec, info, signInWarning, sandboxWarning, signingWarning } =
        await startSession(
          d,
          c,
          {
            rec: {
              id,
              persona: persona.id,
              // PSN-3: the persona as it started.
              personaOrigin: persona.origin,
              ...(personaHashOf(persona)
                ? { personaHash: personaHashOf(persona) }
                : {}),
              runtime: rt.id,
              ...(ch.model ? { model: ch.model } : {}),
              ...(ch.model ? { version: ch.version } : {}),
              ...(ch.permission ? { permission: ch.permission } : {}),
              ...(req.allow !== undefined ? { allow: ch.extras } : {}),
              ...(ch.overrides.length ? { overrides: ch.overrides } : {}),
              ...subagentsField(rt, persona, cfg),
              workspace: ws,
              cwd: input.worktree,
              // D65 v2: its project and repo outlive every new conversation.
              ...linkFields(d, ws, input.worktree, req.repo, prev),
              sessionName: sessionName(d.dist, ws, id),
              peerName,
              // AG-4b: a name given to the agent is the agent's, not its
              // conversation's: Start fresh and Relaunch keep it. AG-10.8:
              // else its persona's name ("Rita").
              // AG-10.10: a name given at start wins.
              ...(given
                ? {
                    displayName: given,
                    displayNameAt: new Date().toISOString(),
                  }
                : prev?.displayName
                  ? {
                      displayName: prev.displayName,
                      ...(prev.displayNameAt
                        ? { displayNameAt: prev.displayNameAt }
                        : {}),
                    }
                  : persona.displayName
                    ? { displayName: persona.displayName }
                    : {}),
              // 0.4.8: launched on this token, so a resume continues it.
              ...(out.resumeToken
                ? { resumeToken: out.resumeToken, launched: true }
                : {}),
              ...(more.bringIn
                ? { broughtInAt: new Date().toISOString() }
                : {}),
              // Issue 943: started on the test-person path, never brought in.
              ...(auditVia() === "test-person" && !more.bringIn
                ? { testBed: true as const }
                : {}),
              // D56: started outside its project, brought in by an ask naming
              // that folder.
              ...(more.bringIn?.outside ? { outside: true } : {}),
            },
            argv: out.argv,
            env: out.env,
            passthrough: rt.envPassthrough,
            launchEnv: rt.launchEnv,
            tokenEnv: rt.signInTokenEnv,
            grants: cfg.agents[id]?.grants ?? [],
            ...binDirOf(det),
          },
          old,
          more.rotations?.length ? { rotations: more.rotations } : {},
        );
      // 0.4.48: launched with no Hub because its token couldn't be read:
      // noted as a failed connect, so once Den reads it again the agent is
      // restarted to load Hub's tools, as after a Hub outage (mcp-reconnect).
      if (!hub) {
        const why = d.hubProblem();
        if (why)
          noteHubMcpInit(d.stateDir(), rec.id, {
            ok: false,
            error: "Den couldn't read its Hub token",
          });
      }
      const early = await exitedAtOnce(d, c, info);
      return {
        rec,
        info,
        warnings: [
          ...(out.warnings ?? []),
          ...unexpressed,
          ...sized,
          ...(signInWarning ? [signInWarning] : []),
          ...(sandboxWarning ? [sandboxWarning] : []),
          ...(signingWarning ? [signingWarning] : []),
        ],
        early,
      };
    });
  });
}

/** A bring-in's launch: the runtime's resume (AG-17.1), never a new one. */
function broughtIn(
  rt: Runtime,
  input: LaunchInput,
): Omit<LaunchOutput, "resumeToken"> {
  const out = launchOrThrow(() => rt.resume?.(input) ?? null);
  if (!out) throw refused(`${rt.id} can't continue a conversation`);
  return out;
}

// ── AG-17.1: bring in a conversation ────────────────────────────────────────

/** A runtime's conversation as Bring in lists it. */
export interface ListedConversation extends RuntimeConversation {
  runtime: string;
  /**
   * Open in another process: a live one holds it (the runtime's own
   * records, D56), or it was written in the last minute.
   */
  open: boolean;
  /** The Den agent already continuing it, if one is. */
  agent?: string;
  /**
   * AG-17.1c: the persona Bring in preselects: the one of the latest Den
   * agent that worked in its folder (or one inside it), else the
   * workspace's latest agent's. The person confirms; never submitted.
   */
  suggest?: string;
  /**
   * AG-17.1c: the MCP servers its tools came from that Den won't load (an
   * agent runs with Den's tools only).
   */
  lost?: string[];
}

/** Each runtime, and whether it can bring a conversation in. */
export interface BringInRuntime {
  id: string;
  label: string;
  bringIn: boolean;
  /** Why it can't, for the page. */
  why?: string;
}

function bringInRuntimes(): BringInRuntime[] {
  return runtimeIds().map((id) => {
    const rt = getRuntime(id)!;
    const label = rt.label ?? id;
    return rt.listSessions
      ? { id, label, bringIn: true }
      : {
          id,
          label,
          bringIn: false,
          why: `${label} can't bring in a conversation yet`,
        };
  });
}

/** The conversation id each agent of this state dir continues. */
/**
 * D72: how close a conversation's last write may be to Den's own stop of
 * it and still be that stop's (the runtime writes as it exits).
 */
export const DEN_STOP_WRITE_MS = 15_000;

/**
 * D72: when Den last stopped each conversation of an agent since removed
 * (runtime + token → stoppedAt). A removed agent never runs, so a write
 * that close to its stop is the stop's, not another terminal's.
 */
function stoppedByDen(d: AgentsResolved): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of listRemovedRecords(d.stateDir())) {
    const at = r.stoppedAt ? Date.parse(r.stoppedAt) : NaN;
    if (r.resumeToken && Number.isFinite(at))
      m.set(`${r.runtime} ${r.resumeToken}`, at);
  }
  return m;
}

/** Still open in another terminal: written lately, and not by Den's stop. */
export function openOutsideDen(
  lastAt: string,
  stoppedAt: number | undefined,
  now = Date.now(),
): boolean {
  if (!openElsewhere(lastAt, now)) return false;
  if (stoppedAt === undefined) return true;
  const t = Date.parse(lastAt);
  return !(Number.isFinite(t) && Math.abs(t - stoppedAt) <= DEN_STOP_WRITE_MS);
}

function agentByToken(d: AgentsResolved): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of listRecords(d.stateDir()))
    if (r.resumeToken) m.set(`${r.runtime} ${r.resumeToken}`, r.id);
  return m;
}

/** D56: the project whose folders `cwd` is in, or null (outside them all). */
function projectOf(d: AgentsResolved, cwd: string): string | null {
  for (const ws of d.workspaceNames()) {
    try {
      if (inScope(cwd, d.workspaceFolders(ws))) return ws;
    } catch {
      /* a workspace that can't say: not this one */
    }
  }
  return null;
}

/**
 * D56 item 3: folders that are never an agent's: the root, a system
 * folder (unless inside the home folder: macOS keeps temp folders under
 * /private), Den's own state, or inside them.
 */
const SYSTEM_FOLDERS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/var",
  "/private",
  "/Library",
  "/Applications",
  "/opt",
  "/dev",
];

const insideOf = (p: string, dir: string) => {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const realOr = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Why `cwd` can't be an agent's folder (D56 item 3), or null. */
export function folderRefusal(d: AgentsResolved, cwd: string): string | null {
  const forms = [...new Set([path.resolve(cwd), realOr(cwd)])];
  const state = realOr(d.stateDir());
  if (forms.some((f) => insideOf(f, state) || insideOf(f, d.stateDir())))
    return `${cwd} can't be an agent's folder: it is Den's own state`;
  if (forms.some((f) => f === path.parse(f).root))
    return `${cwd} can't be an agent's folder: it is the root folder`;
  const home = d.env.HOME ? realOr(d.env.HOME) : null;
  if (home && forms.some((f) => insideOf(f, home))) return null;
  if (
    forms.some((f) =>
      SYSTEM_FOLDERS.some((s) => insideOf(f, s) || insideOf(f, realOr(s))),
    )
  )
    return `${cwd} can't be an agent's folder: it is a system folder`;
  return null;
}

/** D56: a folder outside every project that may be an agent's. */
function outsideTest(d: AgentsResolved): (cwd: string) => boolean {
  return (cwd) => projectOf(d, cwd) === null && folderRefusal(d, cwd) === null;
}

/**
 * The conversations Bring in offers for workspace `ws` (AG-17.1): each
 * runtime's own (only those with listSessions), that ran in the
 * workspace's folder or inside it, newest first. Reading never starts
 * anything; a runtime's history is read only at the ends of each file.
 */
export function listConversations(
  d: AgentsResolved,
  ws: string,
  runtime?: string,
): {
  runtimes: BringInRuntime[];
  conversations: ListedConversation[];
  /** D56: started outside every project (one ask each, naming its folder). */
  outside: ListedConversation[];
} {
  const where = "agents import";
  checkWorkspaceName(where, ws);
  if (!d.workspaceExists(ws))
    throw usage(`${where}: project "${ws}" does not exist`, 404);
  syncCatalog(d);
  if (runtime !== undefined) runtimeFor(runtime);
  // Its folder and every repo's; a shared root only exactly (AG-17.1).
  const scope = d.workspaceFolders(ws);
  const taken = agentByToken(d);
  const denStops = stoppedByDen(d);
  const suggestFor = personaSuggester(d, ws);
  const now = Date.now();
  // D56: who holds each conversation now, one read per runtime.
  const holders = new Map<string, Map<string, number>>();
  const heldBy = (id: string): Map<string, number> => {
    let m = holders.get(id);
    if (!m) {
      m = getRuntime(id)?.openPids?.(d.env) ?? new Map<string, number>();
      holders.set(id, m);
    }
    return m;
  };
  const conversations: ListedConversation[] = [];
  const outside: ListedConversation[] = [];
  const seen = new Set<string>();
  const listed = (id: string, c: RuntimeConversation): ListedConversation => {
    const agent = taken.get(`${id} ${c.id}`);
    const lost = (c.mcp ?? []).filter((m) => m !== d.cli);
    const suggest = suggestFor(c.cwd);
    return {
      ...c,
      runtime: id,
      open:
        heldBy(id).has(c.id) ||
        openOutsideDen(c.lastAt, denStops.get(`${id} ${c.id}`), now),
      ...(agent ? { agent } : {}),
      ...(suggest ? { suggest } : {}),
      ...(lost.length ? { lost } : {}),
    };
  };
  const away = outsideTest(d);
  for (const id of runtimeIds()) {
    if (runtime !== undefined && id !== runtime) continue;
    const rt = getRuntime(id);
    if (!rt?.listSessions) continue;
    for (const c of rt.listSessions(scope, d.env)) {
      if (seen.has(`${id} ${c.id}`)) continue;
      seen.add(`${id} ${c.id}`);
      conversations.push(listed(id, c));
    }
    for (const c of rt.listSessionsWhere?.(away, d.env) ?? []) {
      if (seen.has(`${id} ${c.id}`)) continue;
      seen.add(`${id} ${c.id}`);
      outside.push(listed(id, c));
    }
  }
  conversations.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  outside.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return { runtimes: bringInRuntimes(), conversations, outside };
}

/**
 * AG-17.1c: the persona to preselect for a conversation that ran in a
 * folder: the latest agent's of this workspace that worked there (or in a
 * folder inside it), else the workspace's latest agent's; only a persona
 * that still exists. Undefined: none to suggest (the page's first).
 */
function personaSuggester(
  d: AgentsResolved,
  ws: string,
): (cwd: string) => string | undefined {
  let known: Set<string>;
  try {
    known = new Set(personas(d, agentsConfig(d), ws).keys());
  } catch {
    return () => undefined;
  }
  const recs = listRecords(d.stateDir())
    .filter((r) => r.workspace === ws && known.has(r.persona))
    .sort((a, b) =>
      (b.resumedAt ?? b.startedAt).localeCompare(a.resumedAt ?? a.startedAt),
    );
  const inside = (p: string, dir: string) => {
    const rel = path.relative(dir, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  return (cwd) =>
    (recs.find((r) => inside(r.cwd, cwd) || inside(cwd, r.cwd)) ?? recs[0])
      ?.persona;
}

export interface ImportRequest {
  workspace: string;
  /** The runtime's conversation id. */
  session: string;
  persona: string;
  runtime?: string;
  id?: string;
  /**
   * AG-17.1c: a model for it (Advanced). Absent: the conversation's own
   * (its last answer's), else the persona's.
   */
  model?: string;
  /** With model: "latest" or a pinned version (AG-12.3). */
  version?: string;
  /** D65 v2: its repo (null: none); unset: proposed from its folder. */
  repo?: string | null;
  /**
   * D56: one started outside every project comes in only with this, the
   * folder it started in (the person's explicit ask).
   */
  outside?: string;
}

/** The persona's id, else the first `<persona>-<n>` no agent has. */
function freeId(d: AgentsResolved, persona: string): string {
  if (!readRecord(d.stateDir(), persona)) return persona;
  for (let n = 2; n < 1000; n++) {
    const id = `${persona.slice(0, 58)}-${n}`;
    if (!readRecord(d.stateDir(), id)) return id;
  }
  throw refused(`no free agent id for ${persona}: give one with --id`);
}

/**
 * Issue 160: agent_import as a held write runs it (after the person's
 * Allow, or the approval policy's): importAgent, answered like the CLI's
 * --json ({ ok, … }), never thrown.
 */
export async function runAgentImport(
  d: AgentsResolved,
  a: {
    project: string;
    session: string;
    persona: string;
    runtime?: string;
    /** Issue 1328: asked for knowing it starts outside the sandbox. */
    sandboxOff?: boolean;
  },
): Promise<
  | { ok: true; id: string; project: string; persona: string }
  | { ok: false; error: string }
> {
  try {
    if (importSandboxOff(d, a.persona) && a.sandboxOff !== true)
      return { ok: false, error: SANDBOX_OFF_SINCE_ASK };
    const s = await importAgent(d, {
      workspace: a.project,
      session: a.session,
      persona: a.persona,
      ...(a.runtime ? { runtime: a.runtime } : {}),
    });
    if (s.early)
      return { ok: false, error: `agent ${s.rec.id} exited at once` };
    return {
      ok: true,
      id: s.rec.id,
      project: a.project,
      persona: s.rec.persona,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Bring a conversation in (AG-17.1): the runtime's resume of it, under Den
 * (its token, hooks, guards, the folder it ran in, the audit trail), as a
 * new agent with the persona given. Afterwards it is an agent like any
 * other: stop, resume, rename. Refused while the conversation is open in
 * another terminal (written in the last minute), when an agent already
 * continues it, or when it isn't one of the workspace's.
 */
export async function importAgent(
  d: AgentsResolved,
  req: ImportRequest,
): Promise<Started> {
  const where = "agents import";
  const runtime = req.runtime ?? DEFAULT_RUNTIME_ID;
  const { runtimes, conversations, outside } = listConversations(
    d,
    req.workspace,
    runtime,
  );
  const rt = runtimes.find((r) => r.id === runtime);
  if (!rt?.bringIn)
    throw refused(
      rt?.why ?? `${runtime} can't bring in a conversation`,
      [],
      422,
    );
  let c = conversations.find((x) => x.id === req.session);
  const elsewhere = c
    ? null
    : (getRuntime(runtime)?.conversationCwd?.(req.session, d.env) ?? null);
  let away = false;
  if (
    !c &&
    elsewhere &&
    !inScope(elsewhere, d.workspaceFolders(req.workspace))
  ) {
    // Another project's: say whose, never bring it in.
    if (projectOf(d, elsewhere) !== null)
      throw refused(
        `This conversation belongs to ${elsewhere}, not to project ${req.workspace}`,
        [`List this project's: ${d.cli} agents import -w ${req.workspace}`],
        409,
      );
    // D56: outside every project. Never a folder that can't be an agent's.
    const no = folderRefusal(d, elsewhere);
    if (no) throw refused(`${where}: ${no}`, [], 403);
    // One explicit ask, naming the folder it started in.
    if (req.outside === undefined)
      throw refused(
        `${where}: this conversation started outside project ${req.workspace}, in ${elsewhere}`,
        [
          `Bring it in from there: ${d.cli} agents import -w ${req.workspace} --session ${req.session} --persona ${req.persona} --outside ${elsewhere}`,
        ],
        409,
      );
    if (realOr(req.outside) !== realOr(elsewhere))
      throw refused(
        `${where}: --outside ${req.outside} isn't the folder this conversation started in (${elsewhere})`,
        [],
        409,
      );
    c = outside.find((x) => x.id === req.session);
    away = true;
  }
  if (!c)
    throw refused(
      `${where}: no ${rt.label} conversation "${req.session}" in project ${req.workspace}'s folder`,
      [`List them: ${d.cli} agents import -w ${req.workspace}`],
      404,
    );
  if (c.agent)
    throw new AgentError(
      `${where}: agent ${c.agent} already continues this conversation`,
      {
        code: "already_agent",
        hints: [
          `Resume it: ${d.cli} agents resume ${c.agent} -w ${req.workspace}`,
        ],
      },
    );
  // D56 item 8: never two writers on one conversation; the holder, by
  // pid, when the runtime's records name one.
  const holder = getRuntime(runtime)?.openPid?.(c.id, d.env) ?? null;
  if (holder !== null)
    throw new AgentError(openInMessage(holder), {
      code: "open_elsewhere",
      status: 409,
    });
  if (c.open)
    throw new AgentError(OPEN_ELSEWHERE_MESSAGE, { code: "open_elsewhere" });
  if (!fs.statSync(c.cwd, { throwIfNoEntry: false })?.isDirectory())
    throw refused(`${where}: the folder it ran in, ${c.cwd}, is gone`);
  const id = req.id ?? freeId(d, req.persona);
  if (readRecord(d.stateDir(), id))
    throw refused(`${where}: agent ${id} exists; give this one another --id`);
  // AG-17.1c: the conversation keeps its own model unless one is picked.
  const model = req.model ?? c.model;
  // D65 v2: bringing back a conversation Den removed keeps its link.
  const was = listRemovedRecords(d.stateDir()).find(
    (r) => r.resumeToken === c.id && r.workspace === req.workspace,
  );
  return startAgent(
    d,
    {
      workspace: req.workspace,
      persona: req.persona,
      runtime,
      id,
      ...(model ? { model } : {}),
      ...(req.model !== undefined && req.version !== undefined
        ? { version: req.version }
        : {}),
      // A model picked on the page is checked against the catalog; the
      // conversation's own is taken as it ran.
      ...(req.model !== undefined ? { strict: true } : {}),
      ...(req.repo !== undefined
        ? { repo: req.repo }
        : was?.project !== undefined
          ? { repo: was.repo ?? null }
          : {}),
    },
    {
      bringIn: { token: c.id, cwd: c.cwd, ...(away ? { outside: true } : {}) },
    },
  );
}

// ── stop, resume ────────────────────────────────────────────────────────────

/** The code of a refusal naming another workspace's agent. */
export const NOT_IN_WORKSPACE = "not_in_workspace";

/** Agent `id`'s record; with `ws`, only when it is that workspace's. */
export function agentRecord(
  d: AgentsResolved,
  id: string,
  ws?: string,
): AgentRecord {
  const found = readRecord(d.stateDir(), id);
  // Another workspace's agent is, from this one, no agent at all.
  if (!found) throw refused(`no agent "${id}"`, [], 404);
  const rec = healModel(d, found);
  if (ws && ws !== rec.workspace)
    throw new AgentError(
      `agent ${id} is in project ${rec.workspace}, not ${ws}`,
      { status: 404, code: NOT_IN_WORKSPACE },
    );
  return rec;
}

/**
 * Name agent `id` (AG-4b: a person double-clicked its tab): `name` as
 * checkDisplayName takes it; null or blank clears it. The id never
 * changes. A usage error (400) when the name isn't one.
 */
export function renameAgent(
  d: AgentsResolved,
  id: string,
  ws: string,
  name: unknown,
): AgentRecord {
  const rec = agentRecord(d, id, ws);
  let checked: string | null;
  try {
    checked = checkDisplayName(name);
  } catch (e) {
    throw usage((e as Error).message);
  }
  const next: AgentRecord = { ...rec };
  if (checked) {
    next.displayName = checked;
    // AG-4b: the latest rename wins, Den's or the runtime's.
    next.displayNameAt = new Date().toISOString();
  } else {
    delete next.displayName;
    delete next.displayNameAt;
  }
  writeRecord(d.stateDir(), next);
  return next;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** D65 v2: a repo name (as Den's services list it), checked. */
export function checkRepoName(v: unknown): string {
  if (typeof v !== "string" || !REPO_RE.test(v.trim()))
    throw usage("repo must be a repo's name (as the Services page shows it)");
  return v.trim();
}

/**
 * Gap 7 (0.4.48): where an agent started with no folder works: the repo
 * it is started for (refused when the project hasn't it), else the folder
 * its record has (`agents folder`, a stop and start), else the repo it is
 * linked to, else the project's first repo. A project with no repos, or
 * `repo: null` (None): undefined, the project's own folder.
 */
export function defaultAgentFolder(
  d: AgentsResolved,
  ws: string,
  repo: string | null | undefined,
  prev: AgentRecord | null | undefined,
): string | undefined {
  const repos = workspaceRepoFolders(d, ws);
  const isDir = (p: string | undefined): p is string =>
    !!p && !!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory();
  if (typeof repo === "string") {
    const dir = repos.get(repo);
    if (!dir)
      throw usage(
        `agents start: project ${ws} has no repo "${repo}" (its repos: ${[...repos.keys()].sort().join(", ") || "none"})`,
        404,
      );
    return dir;
  }
  if (repo === null) return undefined;
  // The folder its record has, while it is one of this project's (a move
  // keeps the old project's). One left in the project's top folder (gap
  // 7's bug) moves to a repo.
  const top = path.resolve(d.workspaceDir(ws));
  if (
    prev?.workspace === ws &&
    isDir(prev.cwd) &&
    !(repos.size && path.resolve(prev.cwd) === top) &&
    inProject(d, ws, prev.cwd)
  )
    return prev.cwd;
  const linked = prev?.repo ? repos.get(prev.repo) : undefined;
  if (isDir(linked)) return linked;
  for (const dir of repos.values()) if (isDir(dir)) return dir;
  return undefined;
}

/**
 * SRV-P1 (0.4.48, den#135): what an agent's agent_create asks. Any agent
 * may ask (the person's Allow is the gate): a project's agent for its own
 * project, the server agent for any.
 * The check says exactly what the Allow starts; the args it returns are
 * the ones the run takes, checked again then.
 */
export type AgentCreateCheck =
  | {
      ok: true;
      summary: string;
      /** The summary's parts, for the Allow dialog to word in its language. */
      params: Record<string, string>;
      details: string[];
      /** Issue 205: one message key per details line. */
      detailKeys: DetailKey[];
      /** Issue 1328: it starts outside the sandbox: the person's own Allow. */
      personOnly?: boolean;
      args: AgentCreateArgs;
    }
  | { ok: false; error: string };

export interface AgentCreateArgs {
  project: string;
  persona: string;
  name?: string;
  runtime?: string;
  mode: PermissionIntent;
  repo?: string;
  folder?: string;
  /** Issue 1328: asked for knowing it starts outside the sandbox. */
  sandboxOff?: boolean;
}

const INTENT_RANK: Record<PermissionIntent, number> = {
  ask: 0,
  edits: 1,
  auto: 2,
  all: 3,
};

/**
 * SRV-P1: checks an agent_create ask. The mode is the project's (its
 * own, else the install's) or stricter; with none set, only ask. A repo
 * or a folder, not both; with neither, gap 7's folder (agents start's).
 */
export function checkAgentCreate(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  /** Who asked: a project's agent asks for its own project only. */
  who: { agent?: string; project?: string } = {},
): AgentCreateCheck {
  const no = (error: string): AgentCreateCheck => ({ ok: false, error });
  const str = (k: string): string | undefined => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw usage(`${k} must be text`);
    return v.trim();
  };
  try {
    const ws = checkWorkspaceName("agent_create", str("project"));
    if (!d.workspaceExists(ws)) return no(`no project "${ws}"`);
    if (who.project && !isServerScope(who.project) && who.project !== ws)
      return no(
        `${who.agent ?? "this agent"} works in project ${who.project}: it can add agents there only, not to project ${ws}`,
      );
    const want = str("persona");
    if (!want) return no("persona is required (a persona's id)");
    const persona = personas(d, agentsConfig(d), ws).get(want);
    if (!persona) return no(`no persona "${want}"`);
    const name = str("name");
    if (name !== undefined) checkDisplayName(name);
    const runtime = str("runtime");
    if (runtime !== undefined) runtimeFor(runtime);
    const repo = str("repo");
    const folder = str("folder");
    if (repo !== undefined && folder !== undefined)
      return no("give a repo or folder, not both");
    const cap = followedPermissionOf(d, ws) ?? DEFAULT_INTENT;
    const m = str("mode");
    const mode = m === undefined ? cap : checkIntent(m, "mode");
    if (INTENT_RANK[mode] > INTENT_RANK[cap])
      return no(
        `mode ${mode} is wider than project ${ws}'s (${cap}); ask for ${cap} or stricter`,
      );
    const dir =
      folder !== undefined
        ? startFolder(d, ws, folder)
        : defaultAgentFolder(d, ws, repo, null);
    const repoName =
      repo ??
      (dir
        ? [...workspaceRepoFolders(d, ws)].find(
            ([, f]) => path.resolve(f) === path.resolve(dir),
          )?.[0]
        : undefined);
    const where = repoName
      ? `${ws} › ${repoName}`
      : dir
        ? `${ws} › ${path.relative(d.workspaceDir(ws), dir) || "."}`
        : ws;
    const shown = name ?? persona.displayName ?? persona.id;
    const rt = runtime ?? persona.runtime ?? DEFAULT_RUNTIME_ID;
    const off = createSandboxOff(d, ws, persona.id, name);
    return {
      ok: true,
      ...(off ? { personOnly: true } : {}),
      summary: `start agent ${shown} (${persona.id}) in ${where}, mode ${mode}${runtime ? `, runtime ${runtime}` : ""}`,
      params: { name: shown, persona: persona.id, where, mode },
      ...review([
        rl(`Persona: ${persona.id}`, "ap.det.agent_create.persona", {
          v: persona.id,
        }),
        rl(`Project: ${ws}`, "ap.det.agent_create.project", { v: ws }),
        rl(
          `Folder: ${dir ?? d.workspaceDir(ws)}`,
          "ap.det.agent_create.folder",
          { v: dir ?? d.workspaceDir(ws) },
        ),
        rl(`Runtime: ${rt}`, "ap.det.agent_create.runtime", { v: rt }),
        rl(
          `Mode: ${mode} (the project's: ${cap})`,
          "ap.det.agent_create.mode",
          { mode, cap: String(cap) },
        ),
        ...(off ? [off] : []),
      ]),
      args: {
        project: ws,
        persona: persona.id,
        ...(name !== undefined ? { name } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
        mode,
        ...(repo !== undefined ? { repo } : {}),
        ...(folder !== undefined ? { folder: dir ?? folder } : {}),
        ...(off ? { sandboxOff: true } : {}),
      },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/**
 * Issue 1328: whether the agent agent_create starts would be outside the
 * sandbox, for the id startAgent picks, the same way: the name's
 * (namedIdChoice), else the persona's (defaultId). The run checks again,
 * so an id that changes between ask and Allow is caught there.
 */
function createSandboxOff(
  d: AgentsResolved,
  ws: string,
  persona: string,
  name: string | undefined,
): ReviewLine | null {
  const given = name !== undefined ? checkDisplayName(name) : null;
  const id =
    (given ? namedIdChoice(d.stateDir(), given) : null) ??
    defaultId(d.stateDir(), persona, ws);
  return newAgentSandboxOff(d.agentsConfig(), [id]);
}

/**
 * Issue 1328: whether the agent agent_import makes of `persona` would start
 * outside the sandbox (the id it gets, as importAgent picks it).
 */
export function importSandboxOff(
  d: AgentsResolved,
  persona: string,
): ReviewLine | null {
  return newAgentSandboxOff(d.agentsConfig(), [freeId(d, persona)]);
}

/** SRV-P1: on Allow, starts it as `agents start` does. */
export async function createAgent(
  d: AgentsResolved,
  raw: Record<string, unknown>,
): Promise<
  | { ok: true; id: string; project: string; repo?: string; cwd?: string }
  | { ok: false; error: string }
> {
  const c = checkAgentCreate(d, raw);
  if (!c.ok) return c;
  // Issue 1328: asked for in the sandbox, it now starts outside it.
  if (c.personOnly && raw.sandboxOff !== true)
    return { ok: false, error: SANDBOX_OFF_SINCE_ASK };
  const a = c.args;
  const s = await startAgent(d, {
    workspace: a.project,
    persona: a.persona,
    permission: a.mode,
    ...(a.name !== undefined ? { name: a.name } : {}),
    ...(a.runtime !== undefined ? { runtime: a.runtime } : {}),
    ...(a.repo !== undefined ? { repo: a.repo } : {}),
    ...(a.folder !== undefined ? { folder: a.folder } : {}),
  });
  return {
    ok: true,
    id: s.rec.id,
    project: a.project,
    ...(s.rec.repo ? { repo: s.rec.repo } : {}),
    ...(s.rec.cwd ? { cwd: s.rec.cwd } : {}),
  };
}

/** Whether `dir` is a folder of project `ws`'s (startFolder's check). */
function inProject(d: AgentsResolved, ws: string, dir: string): boolean {
  try {
    startFolder(d, ws, dir);
    return true;
  } catch {
    return false;
  }
}

/** D65 v2: workspace `ws`'s repos, by name, with their folders. */
export function workspaceRepoFolders(
  d: AgentsResolved,
  ws: string,
): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const s of d.workspaceServices(ws)) {
      const repo = s.address.split("/")[0];
      if (!out.has(repo)) out.set(repo, s.path);
    }
  } catch {
    /* a workspace whose services can't be read: none */
  }
  return out;
}

/**
 * D65 v2: the repo a folder proposes: the repo whose folder holds it (the
 * deepest), else a repo of the workspace whose name is one of its folder
 * names (a worktree, a clone elsewhere). Only a proposal, made once at
 * start, bring-in or the one-time migration: display never asks it.
 */
export function proposeRepo(
  d: AgentsResolved,
  ws: string,
  cwd: string | undefined,
): string | undefined {
  if (!cwd) return undefined;
  const repos = workspaceRepoFolders(d, ws);
  let best: { repo: string; len: number } | undefined;
  for (const [repo, dir] of repos) {
    const rel = path.relative(dir, cwd);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!best || dir.length > best.len) best = { repo, len: dir.length };
  }
  if (best) return best.repo;
  const parts = new Set(cwd.split(path.sep));
  return [...repos.keys()].find((r) => parts.has(r));
}

/** D65 v2: a new record's project and repo (see StartRequest.repo). */
function linkFields(
  d: AgentsResolved,
  ws: string,
  cwd: string,
  asked: string | null | undefined,
  prev: AgentRecord | null | undefined,
): Pick<AgentRecord, "project" | "repo" | "subpath"> {
  const repo =
    asked === null
      ? undefined
      : asked !== undefined
        ? asked
        : prev?.project !== undefined
          ? prev.repo
          : proposeRepo(d, ws, cwd);
  return {
    project: ws,
    ...(repo ? { repo } : {}),
    ...(repo && asked === undefined && prev?.repo === repo && prev.subpath
      ? { subpath: prev.subpath }
      : {}),
  };
}

/**
 * Gap 7 (0.4.48): a stopped agent's folder: a repo of its project, or a
 * folder in it (startFolder's checks). Its conversation stays behind (it
 * belongs to the old folder): the next start is a new one there.
 */
export function setAgentFolder(
  d: AgentsResolved,
  id: string,
  ws: string | undefined,
  to: { repo?: string; folder?: string },
): AgentRecord {
  const rec = agentRecord(
    d,
    id,
    ws ?? readRecord(d.stateDir(), id)?.workspace ?? "",
  );
  if (!rec.stoppedAt)
    throw refused(
      `agent ${id} is running: stop it first (\`${d.cli} agents stop ${id}\`), then change its folder`,
    );
  const { dir, repo } = folderTarget(d, rec.workspace, to);
  const next: AgentRecord = { ...rec, cwd: dir, project: rec.workspace };
  if (repo) next.repo = repo;
  else delete next.repo;
  delete next.subpath;
  delete next.resumeToken;
  writeRecord(d.stateDir(), next);
  return next;
}

/** Gap 7: the folder `to` names in project `ws`, and the repo it is. */
function folderTarget(
  d: AgentsResolved,
  ws: string,
  to: { repo?: string; folder?: string },
): { dir: string; repo?: string } {
  let dir: string;
  if (to.repo !== undefined) {
    const repos = workspaceRepoFolders(d, ws);
    const r = repos.get(to.repo);
    if (!r)
      throw usage(
        `agents folder: project ${ws} has no repo "${to.repo}" (its repos: ${[...repos.keys()].sort().join(", ") || "none"})`,
        404,
      );
    dir = startFolder(d, ws, r);
  } else dir = startFolder(d, ws, to.folder ?? "");
  const repo = to.repo ?? proposeRepo(d, ws, dir);
  return { dir, ...(repo ? { repo } : {}) };
}

/** A details line as a message key with its words (the page's t()). */
export type { DetailKey };

/** Issue 205: "Agent: name (id), project p", as a Review line. */
function agentLine(shown: string, id: string, project: string): ReviewLine {
  return shown !== id
    ? rl(`Agent: ${shown} (${id}), project ${project}`, "ap.det.agent.whoId", {
        agent: shown,
        id,
        project,
      })
    : rl(`Agent: ${shown}, project ${project}`, "ap.det.agent.who", {
        agent: shown,
        project,
      });
}

/** SRV-P4: a held write's check (project_mode, agent_folder). */
export type HeldOpCheck<A> =
  | {
      ok: true;
      /**
       * Only the person's own Allow runs it: no auto-allow setting (Vision
       * 11-14: a project_mode that loosens).
       */
      personOnly?: boolean;
      summary: string;
      /** The summary's parts, for the Allow dialog to word in its language. */
      params: Record<string, string>;
      details: string[];
      /**
       * One per details line: its message key and words, for the Allow
       * dialog to show in the person's language (the line itself when null).
       */
      detailKeys?: (DetailKey | null)[];
      args: A;
      /**
       * Issue 199: the project's agents with a mode of their own, which
       * won't follow it (the Allow dialog names them).
       */
      ownMode?: OwnModeAgent[];
      /**
       * Issue 199: what the person may turn on as they Allow (off by
       * default; an agent's ask never sets one): "follow".
       */
      choices?: string[];
    }
  | { ok: false; error: string };

export interface ProjectModeArgs {
  project: string;
  mode: PermissionIntent | null;
  /** Issue 199: also clear its agents' own mode (the person's choice). */
  follow?: true;
}

/** Issue 199: an agent with a mode of its own (an override). */
export interface OwnModeAgent {
  agent: string;
  mode: PermissionIntent;
}

/**
 * Issue 199: project `ws`'s agents that take a mode from Den, split into
 * those that follow its mode and those with their own (an override), by id.
 */
export function projectAgentModes(
  d: AgentsResolved,
  ws: string,
): { following: string[]; ownMode: OwnModeAgent[] } {
  const following: string[] = [];
  const ownMode: OwnModeAgent[] = [];
  for (const rec of listRecords(d.stateDir())) {
    if (rec.workspace !== ws || !getRuntime(rec.runtime)?.permissions) continue;
    const own = ownModeOf(rec);
    if (own) ownMode.push({ agent: rec.id, mode: own });
    else following.push(rec.id);
  }
  following.sort();
  ownMode.sort((a, b) => a.agent.localeCompare(b.agent));
  return { following, ownMode };
}

/**
 * Issue 225: every agent of project `ws` with a mode of its own follows
 * the project again (its own setting is cleared). The agents cleared, with
 * the mode each had. A running one moves at Den's next mode check.
 */
export function followProjectMode(
  d: AgentsResolved,
  ws: string,
): OwnModeAgent[] {
  const { ownMode } = projectAgentModes(d, ws);
  for (const o of ownMode) setAgentPermission(d, o.agent, ws, null);
  return ownMode;
}

/** Issue 225: one agent's mode on the project's settings. */
export interface ProjectAgentMode {
  agent: string;
  name?: string;
  /** The mode it runs in now (or at its next start), and from where. */
  mode: PermissionIntent;
  source: ModeSource;
  /** Running in another mode until it restarts (its process's flag). */
  running?: PermissionIntent;
  stopped?: true;
}

/**
 * Issue 225: project `ws`'s mode, the install's, and each of its agents'
 * mode with where it comes from: what Settings › Project shows. The same
 * resolver as every start (effectiveMode), and the running process's own
 * flag (running-mode.ts) when it differs.
 */
export async function projectModeView(
  d: AgentsResolved,
  ws: string,
  commandLineOf: CommandLineOf = psCommandLine,
): Promise<{
  project: string;
  mode: PermissionIntent | null;
  install: PermissionIntent | null;
  agents: ProjectAgentMode[];
  /** How many have a mode of their own. */
  own: number;
}> {
  const mode = workspacePermissionOf(d, ws) ?? null;
  const install = installPermissionOf(d) ?? null;
  const c = await d.connectExisting();
  let live: { ref: { id: string }; pid?: number; exited?: unknown }[] = [];
  try {
    live = c ? (await c.list()).filter((x) => !x.exited) : [];
  } finally {
    c?.close();
  }
  const resolve = modeResolver(d, commandLineOf);
  const agents: ProjectAgentMode[] = [];
  for (const rec of listRecords(d.stateDir())) {
    if (rec.workspace !== ws) continue;
    const session = live.find((x) => x.ref.id === rec.session.id);
    const m = resolve(rec, session?.pid);
    if (!m) continue;
    agents.push({
      agent: rec.id,
      ...(rec.displayName ? { name: rec.displayName } : {}),
      mode: m.want,
      source: m.source,
      ...(session && m.running && m.running !== m.want
        ? { running: m.running }
        : {}),
      ...(session ? {} : { stopped: true as const }),
    });
  }
  agents.sort((a, b) => a.agent.localeCompare(b.agent));
  return {
    project: ws,
    mode,
    install,
    agents,
    own: agents.filter((a) => a.source === "own").length,
  };
}

/**
 * SRV-P4 (0.4.48): checks a project_mode ask: a project's mode, or none
 * (null). A project's agent asks for its own project; Den's agent for any.
 * Running agents switch after their current turn, in the same conversation
 * (Den's mode check).
 */
export function checkProjectMode(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): HeldOpCheck<ProjectModeArgs> {
  const no = (error: string): HeldOpCheck<ProjectModeArgs> => ({
    ok: false,
    error,
  });
  try {
    const p = raw.project;
    if (p !== undefined && p !== null && typeof p !== "string")
      return no("project must be text");
    const ws = typeof p === "string" ? p.trim() : "";
    if (isServerScope(ws))
      return no(
        `${ws} is Den's own agent's place, not a project: a person sets its mode in Settings`,
      );
    checkWorkspaceName("project_mode", ws);
    if (!d.workspaceExists(ws)) return no(`no project "${ws}"`);
    if (who.project && !isServerScope(who.project) && who.project !== ws)
      return no(
        `${who.agent ?? "this agent"} works in project ${who.project}: it can set that project's mode only, not project ${ws}'s`,
      );
    const m = raw.mode;
    if (m !== null && typeof m !== "string")
      return no("mode is ask, edits, auto or all, or null for none");
    const mode = m === null ? null : checkIntent(m.trim(), "mode");
    const now = workspacePermissionOf(d, ws) ?? null;
    if (now === mode)
      return no(`project ${ws}'s mode is already ${mode ?? "none"}`);
    const from = now ?? "none";
    const to = mode ?? "none";
    // What agents start in before and after. With none, the install's;
    // before, else ask; after, else their persona's (any: count it wide).
    const install = installPermissionOf(d);
    const before = INTENT_RANK[now ?? install ?? DEFAULT_INTENT];
    const after = mode ?? install;
    const loosens =
      (after === undefined ? INTENT_RANK.all + 1 : INTENT_RANK[after]) > before;
    const warn = `This lets agents in ${ws} act without asking you.`;
    const line = `set project ${ws}'s mode: ${from} → ${to}`;
    // Issue 199: the agents with their own mode keep it, unless the
    // person also makes them follow.
    const { ownMode } = projectAgentModes(d, ws);
    const follow = ownMode.length > 0 && raw.follow === true;
    // Issue 225: the Allow offers to make them follow; for one whose own
    // mode is stricter than the project's, that widens what it may do, so
    // the ask is the person's own Allow (issue 160), never run unseen.
    const rankAfter =
      after === undefined ? INTENT_RANK.all + 1 : INTENT_RANK[after];
    const widensOwn = ownMode.some((o) => rankAfter > INTENT_RANK[o.mode]);
    // One list for the line and its key: the same in every language.
    const ownList = ownMode.map((o) => `${o.agent} (${o.mode})`).join(", ");
    // Each line in English, with its key for the Allow dialog's language.
    const lines: [string, DetailKey][] = [
      ...(loosens
        ? [
            [warn, { key: "ap.pm.warn", vars: { project: ws } }] as [
              string,
              DetailKey,
            ],
          ]
        : []),
      [`Project: ${ws}`, { key: "ap.pm.project", vars: { project: ws } }],
      [`Now: ${from}`, { key: "ap.pm.now", vars: { mode: from } }],
      mode === null
        ? [
            "Then: none (agents start in the install's mode, else their persona's)",
            { key: "ap.pm.thenNone" },
          ]
        : [`Then: ${to}`, { key: "ap.pm.then", vars: { mode: to } }],
      [
        "New agents start in it; running agents switch after their current turn, in the same conversation.",
        { key: "ap.pm.switch" },
      ],
      ...(ownMode.length
        ? [
            [
              `These keep their own mode and won't follow the project: ${ownList}`,
              {
                key: "ap.pm.own",
                vars: { list: ownList },
              },
            ] as [string, DetailKey],
          ]
        : []),
      ...(follow
        ? [
            [
              "And makes them follow the project: their own mode is cleared.",
              { key: "ap.pm.follow" },
            ] as [string, DetailKey],
          ]
        : []),
    ];
    return {
      ok: true,
      ...(loosens || widensOwn ? { personOnly: true } : {}),
      ...(ownMode.length ? { ownMode, choices: ["follow"] } : {}),
      summary: loosens
        ? `${warn} ${line.charAt(0).toUpperCase()}${line.slice(1)}`
        : line,
      params: { project: ws, from, to, ...(loosens ? { loosens: "1" } : {}) },
      details: lines.map((l) => l[0]),
      detailKeys: lines.map((l) => l[1]),
      args: { project: ws, mode, ...(follow ? { follow: true as const } : {}) },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/**
 * SRV-P4: on Allow, saves it. Issue 199: with "follow", its agents' own
 * mode is cleared too; the answer names who follows the project now and
 * who keeps a mode of their own (when it has agents).
 */
export async function runProjectMode(
  d: AgentsResolved,
  raw: Record<string, unknown>,
): Promise<
  | {
      ok: true;
      project: string;
      mode: PermissionIntent | null;
      following?: string[];
      ownMode?: OwnModeAgent[];
    }
  | { ok: false; error: string }
> {
  const c = checkProjectMode(d, raw);
  if (!c.ok) return c;
  const ws = c.args.project;
  d.saveWorkspacePermission(ws, c.args.mode);
  if (c.args.follow) followProjectMode(d, ws);
  const now = projectAgentModes(d, ws);
  return {
    ok: true,
    project: ws,
    mode: c.args.mode,
    ...(now.following.length || now.ownMode.length ? now : {}),
  };
}

/**
 * Issue 335: project `ws`'s extra MCP servers as Settings shows them:
 * names and urls only, never a bearer or its ref.
 */
export function projectMcpView(
  d: AgentsResolved,
  ws: string,
): { project: string; servers: { name: string; url: string }[] } {
  return {
    project: ws,
    servers: projectMcpServers(d, ws).map((s) => ({
      name: s.name,
      url: s.url,
    })),
  };
}

/**
 * Issues 335, 352: the project a project_mcp_* ask is for, checked: a
 * project (never Den's own agent's place) that exists, and, when a
 * project's agent asks, its own.
 */
function projectMcpTarget(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string },
  action: string,
  verb: string,
): { ok: true; ws: string } | { ok: false; error: string } {
  const p = raw.project;
  if (p !== undefined && p !== null && typeof p !== "string")
    return { ok: false, error: "project must be text" };
  const ws = typeof p === "string" ? p.trim() : "";
  if (isServerScope(ws))
    return {
      ok: false,
      error: `${ws} is Den's own agent's place, not a project`,
    };
  checkWorkspaceName(action, ws);
  if (!d.workspaceExists(ws)) return { ok: false, error: `no project "${ws}"` };
  if (who.project && !isServerScope(who.project) && who.project !== ws)
    return {
      ok: false,
      error: `${who.agent ?? "this agent"} works in project ${who.project}: it can ${verb} that project only, not project ${ws}`,
    };
  return { ok: true, ws };
}

/**
 * Issue 352: a project_mcp_add or _update ask as its check reads it. The
 * queue checks a request again on Allow with the args the first check
 * gave (`{ project, server }`); an agent asks with them flat.
 */
function flatMcpArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const sv = raw.server;
  if (!sv || typeof sv !== "object" || Array.isArray(sv)) return raw;
  const s = sv as Record<string, unknown>;
  return {
    project: raw.project,
    name: s.name,
    url: s.url,
    bearer: s.bearer ? s.bearer : null,
  };
}

/** Issue 352: project `ws`'s server `name`, or why not. */
function projectMcpServerOf(
  d: AgentsResolved,
  ws: string,
  rawName: unknown,
): { ok: true; server: ProjectMcpServer } | { ok: false; error: string } {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) return { ok: false, error: "name: give the MCP's name" };
  const server = projectMcpServers(d, ws).find((s) => s.name === name);
  return server
    ? { ok: true, server }
    : { ok: false, error: `project ${ws} has no MCP server "${name}"` };
}

export interface ProjectMcpAddArgs {
  project: string;
  server: ProjectMcpServer;
}

/**
 * Issue 335: checks a project_mcp_add ask: one more HTTP MCP server for a
 * project's agents, its bearer the name of a secrets.refs entry that is
 * set. Always the person's own Allow: it gives agents new tools and sends
 * a bearer somewhere new. A project's agent asks for its own project;
 * Den's agent for any.
 */
export function checkProjectMcpAdd(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): HeldOpCheck<ProjectMcpAddArgs> {
  const no = (error: string): HeldOpCheck<ProjectMcpAddArgs> => ({
    ok: false,
    error,
  });
  try {
    const a = flatMcpArgs(raw);
    const t = projectMcpTarget(d, a, who, "project_mcp_add", "add to");
    if (!t.ok) return t;
    const ws = t.ws;
    const c = checkProjectMcpServer(
      { name: a.name, url: a.url, bearer: a.bearer },
      [d.cli, HUB_SERVER],
    );
    if (!c.ok) return no(c.error);
    const server = c.server;
    if (projectMcpServers(d, ws).some((s) => s.name === server.name))
      return no(`project ${ws} already has an MCP server "${server.name}"`);
    if (server.bearer && !d.secretRefSet(server.bearer))
      return no(
        `secrets.refs.${server.bearer} is not set: a person adds it to the install's config first`,
      );
    const lines: [string, DetailKey][] = [
      [
        `This gives agents in ${ws} new tools, and sends their calls to ${server.url}.`,
        { key: "ap.mcp.warn", vars: { project: ws, url: server.url } },
      ],
      [`Project: ${ws}`, { key: "ap.pm.project", vars: { project: ws } }],
      [
        `MCP: ${server.name} at ${server.url}`,
        { key: "ap.mcp.server", vars: { name: server.name, url: server.url } },
      ],
      server.bearer
        ? [
            `Bearer: read from secrets.refs.${server.bearer} at each call; never written to the agent's files or env.`,
            { key: "ap.mcp.bearer", vars: { ref: server.bearer } },
          ]
        : [
            "No bearer: its calls carry no Authorization header.",
            { key: "ap.mcp.noBearer" },
          ],
      [
        `Agents in ${ws} get it at their next start or resume.`,
        { key: "ap.mcp.next", vars: { project: ws } },
      ],
    ];
    return {
      ok: true,
      personOnly: true,
      summary: `add MCP ${server.name} (${server.url}) to project ${ws}'s agents`,
      params: { project: ws, name: server.name, url: server.url },
      details: lines.map((l) => l[0]),
      detailKeys: lines.map((l) => l[1]),
      args: { project: ws, server },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/** Issue 335: on Allow, adds it (checked again); names and urls back. */
export async function runProjectMcpAdd(
  d: AgentsResolved,
  raw: Record<string, unknown>,
): Promise<
  | { ok: true; project: string; servers: { name: string; url: string }[] }
  | { ok: false; error: string }
> {
  const c = checkProjectMcpAdd(d, raw);
  if (!c.ok) return c;
  const ws = c.args.project;
  d.saveWorkspaceMcpServers(ws, [...projectMcpServers(d, ws), c.args.server]);
  return { ok: true, ...projectMcpView(d, ws) };
}

/** Issue 1480: project `ws`'s `agents.event_feeds` as written (a list). */
function feedEntries(d: AgentsResolved, ws: string): Record<string, unknown>[] {
  const raw = d.workspaceEventFeeds(ws);
  return Array.isArray(raw)
    ? raw.filter(
        (e): e is Record<string, unknown> =>
          !!e && typeof e === "object" && !Array.isArray(e),
      )
    : [];
}

const feedNameOf = (e: Record<string, unknown>) =>
  typeof e.name === "string" ? e.name.trim() : "";

/** Issue 1480: a checked feed as workspaces.yml spells it. */
function feedEntry(f: AppFeedConfig): Record<string, unknown> {
  return {
    name: f.name,
    agent: f.agent,
    url: f.url,
    ...(f.listUrl ? { list_url: f.listUrl } : {}),
    ...(f.bearer ? { bearer: f.bearer } : {}),
    ...(f.publicOnly ? { public_only: true } : {}),
  };
}

/** Issue 1480: the ids of project `ws`'s agents. */
export function projectAgentIds(d: AgentsResolved, ws: string): string[] {
  return listRecords(d.stateDir())
    .filter((r) => r.workspace === ws)
    .map((r) => r.id)
    .sort();
}

/**
 * Issue 1480 (Reviewer C): Den's own addresses and its Hub's: web.url,
 * the address Den's own tools dial, the edge's domains, and Hub's
 * addresses. Each part best effort: one that can't be read is left out.
 */
async function ownFeedAddresses(d: AgentsResolved): Promise<FeedOwnAddresses> {
  const hosts: string[] = [];
  const ports: number[] = [];
  const add = (u: string | null | undefined, port = false) => {
    if (!u) return;
    try {
      const x = new URL(u);
      hosts.push(x.hostname.replace(/^\[|\]$/g, ""));
      if (port)
        ports.push(Number(x.port || (x.protocol === "https:" ? 443 : 80)));
    } catch {
      /* not an address */
    }
  };
  try {
    add(d.webUrl());
  } catch {
    /* unset */
  }
  try {
    // Den's own dial: its port on this machine.
    const base = new URL(d.denBase());
    ports.push(Number(base.port || 80));
  } catch {
    /* unset */
  }
  try {
    const hub = await d.hub();
    add(hub?.url);
    add(hub?.mcpUrl);
  } catch {
    /* no Hub */
  }
  let domains: string[] = [];
  try {
    domains = edgeDomains(readEdgeConfig()).filter(Boolean);
  } catch {
    domains = [];
  }
  // The dial's host is this machine: only its port is refused there.
  return {
    hosts: hosts.filter((h) => !/^(localhost|127\.|::1$)/.test(h)),
    domains,
    ports,
  };
}

export interface EventFeedAddArgs {
  project: string;
  feed: AppFeedConfig;
}

/**
 * Issue 1480: checks a project_event_feed_add ask: one more app event
 * feed for one of the project's agents (agents.event_feeds), its bearer
 * the name of a secrets.refs entry, never a value (a refusal never echoes
 * it). The approval policy places it (issue 1391): routine on a personal
 * install, the person's Allow on a strict one. A project's agent asks for
 * its own project; Den's agent for any.
 */
export async function checkEventFeedAdd(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): Promise<HeldOpCheck<EventFeedAddArgs>> {
  const no = (error: string): HeldOpCheck<EventFeedAddArgs> => ({
    ok: false,
    error,
  });
  try {
    const t = projectMcpTarget(d, raw, who, "project_event_feed_add", "add to");
    if (!t.ok) return t;
    const ws = t.ws;
    // The queue's check on Allow gets the args the first check gave.
    const fv = raw.feed;
    const src =
      fv && typeof fv === "object" && !Array.isArray(fv)
        ? (fv as Record<string, unknown>)
        : raw;
    const c = checkAppFeed({
      name: src.name,
      agent: src.agent,
      url: src.url,
      bearer: src.bearer,
      list_url: src.list_url ?? src.listUrl,
    });
    if (!c.ok) return no(c.error);
    const feed = c.feed;
    if (!projectAgentIds(d, ws).includes(feed.agent))
      return no(`agent: "${feed.agent}" is not one of project ${ws}'s agents`);
    if (feedEntries(d, ws).some((e) => feedNameOf(e) === feed.name))
      return no(`project ${ws} already has an event feed "${feed.name}"`);
    // Reviewer C: never Den itself or its Hub.
    const own = await (d.feedOwnAddresses ?? (() => ownFeedAddresses(d)))();
    const self =
      feedSelfProblem(feed.url, "url", own) ??
      (feed.listUrl ? feedSelfProblem(feed.listUrl, "list_url", own) : null);
    if (self) return no(self);
    // Lane 1: this machine or a private network is the person's own Allow
    // (app_feed_read would read local services); one checked public is
    // written public_only, and resolved again at each connect.
    const urls = [feed.url, ...(feed.listUrl ? [feed.listUrl] : [])];
    const local = (
      await Promise.all(urls.map((u) => feedAddressLocal(u, d.feedLookup)))
    ).some(Boolean);
    if (local) delete feed.publicOnly;
    else feed.publicOnly = true;
    const lines: [string, DetailKey][] = [
      [
        `Den opens ${feed.url} and types ${feed.agent} a short line when its events are unread.`,
        {
          key: "ap.feed.warn",
          vars: { url: feed.url, agent: feed.agent },
        },
      ],
      [`Project: ${ws}`, { key: "ap.pm.project", vars: { project: ws } }],
      [
        `Feed: ${feed.name}, for ${feed.agent}`,
        { key: "ap.feed.feed", vars: { name: feed.name, agent: feed.agent } },
      ],
      feed.bearer
        ? [
            `Bearer: read from secrets.refs.${feed.bearer} at each connect; never shown or written to the agent's files.`,
            { key: "ap.feed.bearer", vars: { ref: feed.bearer } },
          ]
        : [
            "No bearer: the stream is opened with no Authorization header.",
            { key: "ap.feed.noBearer" },
          ],
    ];
    return {
      ok: true,
      // Lane 1: Den sends that stored secret to the feed's url, so an add
      // with a bearer widens: the person's own Allow on every install.
      ...(feed.bearer || local ? { personOnly: true } : {}),
      summary: `add event feed ${feed.name} (${feed.url}) for ${feed.agent} in project ${ws}`,
      params: {
        project: ws,
        name: feed.name,
        agent: feed.agent,
        url: feed.url,
      },
      details: lines.map((l) => l[0]),
      detailKeys: lines.map((l) => l[1]),
      args: { project: ws, feed },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/** Issue 1480: on Allow (or at once), adds it, checked again. */
export async function runEventFeedAdd(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  asked?: { decidedBy?: string },
): Promise<
  | {
      ok: true;
      project: string;
      name: string;
      /** What was written: Undo takes out only this. */
      added: Record<string, unknown>;
    }
  | { ok: false; error: string }
> {
  const c = await checkEventFeedAdd(d, raw);
  if (!c.ok) return c;
  // As gate_settings_set: one that needs the person's own Allow never
  // runs by the policy.
  if (c.personOnly && asked?.decidedBy?.startsWith("auto:") === true)
    return {
      ok: false,
      error:
        "a feed with a bearer needs the person's own Allow: nothing was written; ask again",
    };
  const ws = c.args.project;
  const added = feedEntry(c.args.feed);
  d.saveWorkspaceEventFeeds(ws, [...feedEntries(d, ws), added]);
  return { ok: true, project: ws, name: c.args.feed.name, added };
}

export interface EventFeedRemoveArgs {
  project: string;
  name: string;
}

/**
 * Issue 1480: checks a project_event_feed_remove ask: take one of a
 * project's app event feeds out (its agent gets no more lines from it).
 * Placed as the add is.
 */
export function checkEventFeedRemove(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): HeldOpCheck<EventFeedRemoveArgs> {
  try {
    const t = projectMcpTarget(
      d,
      raw,
      who,
      "project_event_feed_remove",
      "remove from",
    );
    if (!t.ok) return t;
    const ws = t.ws;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) return { ok: false, error: "name: give the feed's name" };
    const e = feedEntries(d, ws).find((x) => feedNameOf(x) === name);
    if (!e)
      return { ok: false, error: `project ${ws} has no event feed "${name}"` };
    const lines: [string, DetailKey][] = [
      [
        `Den closes feed ${name}; its agent gets no more lines from it.`,
        { key: "ap.feed.removeWarn", vars: { name } },
      ],
      [`Project: ${ws}`, { key: "ap.pm.project", vars: { project: ws } }],
    ];
    return {
      ok: true,
      summary: `remove event feed ${name} from project ${ws}`,
      params: { project: ws, name },
      details: lines.map((l) => l[0]),
      detailKeys: lines.map((l) => l[1]),
      args: { project: ws, name },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Issue 1480: on Allow (or at once), removes it, checked again. */
export async function runEventFeedRemove(
  d: AgentsResolved,
  raw: Record<string, unknown>,
): Promise<
  | {
      ok: true;
      project: string;
      name: string;
      /** What was taken out, when Den could read it: Undo puts it back. */
      removed: Record<string, unknown> | null;
    }
  | { ok: false; error: string }
> {
  const c = checkEventFeedRemove(d, raw);
  if (!c.ok) return c;
  const ws = c.args.project;
  const all = feedEntries(d, ws);
  const gone = all.find((e) => feedNameOf(e) === c.args.name);
  d.saveWorkspaceEventFeeds(
    ws,
    all.filter((e) => feedNameOf(e) !== c.args.name),
  );
  // Only a feed Den can read comes back by Undo: an entry it couldn't
  // read may hold anything, so none of it is kept in the result.
  const ok = gone ? checkAppFeed(gone) : null;
  return {
    ok: true,
    project: ws,
    name: c.args.name,
    removed: ok?.ok ? feedEntry(ok.feed) : null,
  };
}

/**
 * Issue 1480: the bell's Undo of a feed added or removed without asking
 * (a personal install, issue 1391). Only what ran by the policy; only
 * while the feed is as it left it: an added one still the same, a
 * removed one's name still free.
 */
export function undoEventFeed(
  d: AgentsResolved,
  approval: {
    action: string;
    result?: unknown;
    decidedBy?: string;
  },
): { ok: true; note: string } | { ok: false; error: string } {
  if (
    approval.action !== "project_event_feed_add" &&
    approval.action !== "project_event_feed_remove"
  )
    return { ok: false, error: "only an event feed change can be undone here" };
  if (!approval.decidedBy?.startsWith("auto:"))
    return {
      ok: false,
      error:
        "only a change that ran without asking can be undone here: change it in Settings",
    };
  const r = approval.result as
    | {
        ok?: unknown;
        project?: unknown;
        name?: unknown;
        added?: unknown;
        removed?: unknown;
      }
    | undefined;
  const ws = typeof r?.project === "string" ? r.project : "";
  const name = typeof r?.name === "string" ? r.name : "";
  if (r?.ok !== true || !ws || !name || !d.workspaceExists(ws))
    return {
      ok: false,
      error: "that change didn't run, so there is nothing to undo",
    };
  const all = feedEntries(d, ws);
  if (approval.action === "project_event_feed_add") {
    const now = all.find((e) => feedNameOf(e) === name);
    if (!now || JSON.stringify(now) !== JSON.stringify(r.added))
      return {
        ok: false,
        error: `feed ${name} changed since: nothing was undone; change it in Settings`,
      };
    d.saveWorkspaceEventFeeds(
      ws,
      all.filter((e) => e !== now),
    );
    return { ok: true, note: `feed ${name} was taken out of project ${ws}` };
  }
  const back = checkAppFeed(r.removed);
  if (!back.ok)
    return {
      ok: false,
      error: `feed ${name} can't be put back here: add it in Settings`,
    };
  if (all.some((e) => feedNameOf(e) === name))
    return {
      ok: false,
      error: `project ${ws} has a feed "${name}" again: nothing was undone`,
    };
  d.saveWorkspaceEventFeeds(ws, [...all, feedEntry(back.feed)]);
  return { ok: true, note: `feed ${name} is back in project ${ws}` };
}

export interface ProjectMcpRemoveArgs {
  project: string;
  name: string;
}

/**
 * Issue 352: checks a project_mcp_remove ask: take one of a project's
 * extra MCP servers away from its agents. Always the person's own Allow,
 * as adding one is. A project's agent asks for its own project; Den's
 * agent for any.
 */
export function checkProjectMcpRemove(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): HeldOpCheck<ProjectMcpRemoveArgs> {
  try {
    const t = projectMcpTarget(
      d,
      raw,
      who,
      "project_mcp_remove",
      "remove from",
    );
    if (!t.ok) return t;
    const ws = t.ws;
    const f = projectMcpServerOf(d, ws, raw.name);
    if (!f.ok) return f;
    const { name, url } = f.server;
    const lines: [string, DetailKey][] = [
      [
        `Agents in ${ws} lose the tools of ${name} at their next start or resume.`,
        { key: "ap.mcp.removeWarn", vars: { project: ws, name } },
      ],
      [`Project: ${ws}`, { key: "ap.pm.project", vars: { project: ws } }],
      [`MCP: ${name} at ${url}`, { key: "ap.mcp.server", vars: { name, url } }],
    ];
    return {
      ok: true,
      personOnly: true,
      summary: `remove MCP ${name} (${url}) from project ${ws}'s agents`,
      params: { project: ws, name, url },
      details: lines.map((l) => l[0]),
      detailKeys: lines.map((l) => l[1]),
      args: { project: ws, name },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Issue 352: on Allow, removes it (checked again); names and urls back. */
export async function runProjectMcpRemove(
  d: AgentsResolved,
  raw: Record<string, unknown>,
): Promise<
  | { ok: true; project: string; servers: { name: string; url: string }[] }
  | { ok: false; error: string }
> {
  const c = checkProjectMcpRemove(d, raw);
  if (!c.ok) return c;
  const ws = c.args.project;
  d.saveWorkspaceMcpServers(
    ws,
    projectMcpServers(d, ws).filter((s) => s.name !== c.args.name),
  );
  return { ok: true, ...projectMcpView(d, ws) };
}

export interface ProjectMcpUpdateArgs {
  project: string;
  /** The server as it will be: same name, its new url and bearer. */
  server: ProjectMcpServer;
}

/**
 * Issue 352: checks a project_mcp_update ask: a new url, a new bearer
 * reference (a secrets.refs name that is set, never a value), or no
 * bearer (`bearer: null`) for one of a project's extra MCP servers.
 * Always the person's own Allow: it sends the agents' calls, and maybe a
 * bearer, somewhere else.
 */
export function checkProjectMcpUpdate(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): HeldOpCheck<ProjectMcpUpdateArgs> {
  const no = (error: string): HeldOpCheck<ProjectMcpUpdateArgs> => ({
    ok: false,
    error,
  });
  try {
    const a = flatMcpArgs(raw);
    const t = projectMcpTarget(d, a, who, "project_mcp_update", "change");
    if (!t.ok) return t;
    const ws = t.ws;
    const f = projectMcpServerOf(d, ws, a.name);
    if (!f.ok) return f;
    const cur = f.server;
    // `bearer: null` drops it; a name sets it; left out, it stays.
    const noBearer = a.bearer === null;
    const hasUrl = a.url !== undefined && a.url !== null && a.url !== "";
    const hasBearer = a.bearer !== undefined && !noBearer && a.bearer !== "";
    if (!hasUrl && !hasBearer && !noBearer)
      return no("nothing to change: give url, or bearer (null for none)");
    const c = checkProjectMcpServer(
      {
        name: cur.name,
        url: hasUrl ? a.url : cur.url,
        bearer: noBearer ? undefined : hasBearer ? a.bearer : cur.bearer,
      },
      [d.cli, HUB_SERVER],
    );
    if (!c.ok) return no(c.error);
    const next = c.server;
    const urlChanged = next.url !== cur.url;
    const bearerChanged = next.bearer !== cur.bearer;
    if (!urlChanged && !bearerChanged)
      return no(`project ${ws}'s MCP server "${cur.name}" is already so`);
    if (bearerChanged && next.bearer && !d.secretRefSet(next.bearer))
      return no(
        `secrets.refs.${next.bearer} is not set: a person adds it to the install's config first`,
      );
    const lines: [string, DetailKey][] = [];
    if (urlChanged)
      lines.push([
        `This gives agents in ${ws} new tools, and sends their calls to ${next.url}.`,
        { key: "ap.mcp.warn", vars: { project: ws, url: next.url } },
      ]);
    lines.push([
      `Project: ${ws}`,
      { key: "ap.pm.project", vars: { project: ws } },
    ]);
    if (urlChanged)
      lines.push([
        `MCP ${cur.name}: ${cur.url} → ${next.url}`,
        {
          key: "ap.mcp.urlChange",
          vars: { name: cur.name, from: cur.url, to: next.url },
        },
      ]);
    if (bearerChanged)
      lines.push(
        next.bearer
          ? [
              `Bearer: read from secrets.refs.${next.bearer} at each call; never written to the agent's files or env.`,
              { key: "ap.mcp.bearer", vars: { ref: next.bearer } },
            ]
          : [
              "No bearer: its calls carry no Authorization header.",
              { key: "ap.mcp.noBearer" },
            ],
      );
    lines.push([
      `Agents in ${ws} get it at their next start or resume.`,
      { key: "ap.mcp.next", vars: { project: ws } },
    ]);
    const what = [
      urlChanged ? `url ${cur.url} → ${next.url}` : "",
      bearerChanged
        ? next.bearer
          ? `bearer secrets.refs.${next.bearer}`
          : "no bearer"
        : "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      ok: true,
      personOnly: true,
      summary: `change MCP ${cur.name} in project ${ws}'s agents: ${what}`,
      params: { project: ws, name: cur.name, url: next.url },
      details: lines.map((l) => l[0]),
      detailKeys: lines.map((l) => l[1]),
      args: { project: ws, server: next },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/**
 * Issue 352: on Allow, saves the server as checked (checked again), in
 * its place in the list; names and urls back.
 */
export async function runProjectMcpUpdate(
  d: AgentsResolved,
  raw: Record<string, unknown>,
): Promise<
  | { ok: true; project: string; servers: { name: string; url: string }[] }
  | { ok: false; error: string }
> {
  const c = checkProjectMcpUpdate(d, raw);
  if (!c.ok) return c;
  const ws = c.args.project;
  const next = c.args.server;
  d.saveWorkspaceMcpServers(
    ws,
    projectMcpServers(d, ws).map((s) => (s.name === next.name ? next : s)),
  );
  return { ok: true, ...projectMcpView(d, ws) };
}

export interface AgentFolderArgs {
  agent: string;
  project: string;
  repo?: string;
  folder?: string;
}

/**
 * SRV-P4 (0.4.48): checks an agent_folder ask: an agent's folder, a repo
 * of its project or a folder in it (gap 7's). A project's agent asks for
 * its own project's agents (itself too: the Allow warns it stops); Den's
 * agent for any. Den's own agent's folder is never moved.
 */
export function checkAgentFolder(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): HeldOpCheck<AgentFolderArgs> {
  const no = (error: string): HeldOpCheck<AgentFolderArgs> => ({
    ok: false,
    error,
  });
  const str = (k: string): string | undefined => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw usage(`${k} must be text`);
    return v.trim();
  };
  try {
    const id = str("agent");
    if (!id) return no("agent is required (the agent's id)");
    if (id === SERVER_AGENT_ID)
      return no("Den's own agent works in its own folder: it never moves");
    const repo = str("repo");
    const folder = str("folder");
    if (repo !== undefined && folder !== undefined)
      return no("give a repo or folder, not both");
    if (repo === undefined && folder === undefined)
      return no("give a repo of its project, or a folder in it");
    const rec = agentRecord(d, id, str("project"));
    if (isServerScope(rec.workspace))
      return no("Den's own agent works in its own folder: it never moves");
    if (
      who.project &&
      !isServerScope(who.project) &&
      who.project !== rec.workspace
    )
      return no(
        `${who.agent ?? "this agent"} works in project ${who.project}: it can move that project's agents only, not ${id} in project ${rec.workspace}`,
      );
    const t = folderTarget(d, rec.workspace, {
      ...(repo !== undefined ? { repo: checkRepoName(repo) } : {}),
      ...(folder !== undefined ? { folder } : {}),
    });
    if (rec.cwd && path.resolve(rec.cwd) === path.resolve(t.dir))
      return no(`agent ${id} already works in ${t.dir}`);
    const where = t.repo
      ? `${rec.workspace} › ${t.repo}`
      : `${rec.workspace} › ${path.relative(d.workspaceDir(rec.workspace), t.dir) || "."}`;
    const running = !rec.stoppedAt;
    const shown = rec.displayName ?? id;
    return {
      ok: true,
      summary: `move agent ${shown} to ${where}`,
      params: { agent: shown, where },
      ...review([
        agentLine(shown, id, rec.workspace),
        rl(
          `From: ${rec.cwd ?? d.workspaceDir(rec.workspace)}`,
          "ap.det.agent_folder.from",
          { v: rec.cwd ?? d.workspaceDir(rec.workspace) },
        ),
        rl(`To: ${t.dir}`, "ap.det.agent_folder.to", { v: t.dir }),
        running
          ? rl(
              "It is running: Den stops it, moves it, and starts it fresh there (a new conversation; the old one stays in its history).",
              "ap.det.agent_folder.running",
            )
          : rl(
              "It is stopped and stays so: its next start is a new conversation there.",
              "ap.det.agent_folder.stopped",
            ),
        ...(who.agent === id
          ? [
              rl(
                "This is the agent that asked: it stops when you Allow, and its answer to you ends there.",
                "ap.det.agent_folder.self",
              ),
            ]
          : []),
      ]),
      args: {
        agent: id,
        project: rec.workspace,
        ...(t.repo && repo !== undefined ? { repo: t.repo } : {}),
        ...(repo === undefined ? { folder: t.dir } : {}),
      },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/** SRV-P4: on Allow, moves it; a running agent is stopped, moved and started fresh. */
export async function runAgentFolder(
  d: AgentsResolved,
  raw: Record<string, unknown>,
): Promise<
  | {
      ok: true;
      id: string;
      cwd: string;
      repo?: string;
      restarted: boolean;
    }
  | { ok: false; error: string }
> {
  const c = checkAgentFolder(d, raw);
  if (!c.ok) return c;
  const a = c.args;
  const running = !agentRecord(d, a.agent, a.project).stoppedAt;
  if (running) {
    const stopped = await stopAgent(d, a.agent, a.project, { wait: true });
    if (stopped.stillStopping)
      return {
        ok: false,
        error: `agent ${a.agent} is still stopping: its folder is unchanged; ask again in a moment`,
      };
  }
  const rec = setAgentFolder(d, a.agent, a.project, {
    ...(a.repo !== undefined ? { repo: a.repo } : {}),
    ...(a.folder !== undefined ? { folder: a.folder } : {}),
  });
  if (running) await startFresh(d, a.agent, a.project);
  return {
    ok: true,
    id: a.agent,
    cwd: rec.cwd ?? "",
    ...(rec.repo ? { repo: rec.repo } : {}),
    restarted: running,
  };
}

export interface AgentModeArgs {
  agent: string;
  project: string;
}

/**
 * Issue 199: checks an agent_mode ask: clear agent `agent`'s own mode, so
 * it follows its project's again (else the install's, else its
 * persona's). Only ever cleared: a mode of its own is a person's to set.
 * A project's agent asks for its own project's agents; Den's agent for
 * any. One that loosens is the person's own Allow (issue 160: it widens
 * what the agent may do); one that narrows follows the approval policy.
 */
export function checkAgentMode(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  who: { agent?: string; project?: string } = {},
): HeldOpCheck<AgentModeArgs> {
  const no = (error: string): HeldOpCheck<AgentModeArgs> => ({
    ok: false,
    error,
  });
  const str = (k: string): string | undefined => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw usage(`${k} must be text`);
    return v.trim();
  };
  try {
    const m = raw.mode;
    if (m !== undefined && m !== null && m !== "follow")
      return no(
        "agent_mode clears an agent's own mode only, so it follows its project's; a person sets a mode of its own",
      );
    const id = str("agent");
    if (!id) return no("agent is required (the agent's id)");
    const rec = agentRecord(d, id, str("project"));
    if (isServerScope(rec.workspace))
      return no(
        "Den's own agent has no project to follow: a person sets its mode in Settings",
      );
    if (
      who.project &&
      !isServerScope(who.project) &&
      who.project !== rec.workspace
    )
      return no(
        `${who.agent ?? "this agent"} works in project ${who.project}: it can ask for that project's agents only, not ${id} in project ${rec.workspace}`,
      );
    const rt = getRuntime(rec.runtime);
    if (!rt?.permissions)
      return no(`${rec.runtime} can't take a permission mode from Den yet`);
    const own = ownModeOf(rec);
    if (!own)
      return no(`${id} has no own mode: it follows its project's already`);
    const p = personaLookup(d)(rec);
    const to =
      effectiveMode(d, rec, p, rt, { ignoreOwn: true })?.mode ?? DEFAULT_INTENT;
    const shown = rec.displayName ?? id;
    const loosens = INTENT_RANK[to] > INTENT_RANK[own];
    const change = `${own} → follow project (${to})`;
    const running = !rec.stoppedAt;
    return {
      ok: true,
      ...(loosens ? { personOnly: true } : {}),
      summary: loosens
        ? `This lets ${shown} act without asking you: ${change}`
        : `${shown}: ${change}`,
      params: {
        agent: shown,
        from: own,
        to,
        ...(loosens ? { loosens: "1" } : {}),
      },
      ...review([
        ...(loosens
          ? [
              rl(
                `This lets ${shown} act without asking you.`,
                "ap.det.agent_mode.loosens",
                { agent: shown },
              ),
            ]
          : []),
        agentLine(shown, id, rec.workspace),
        rl(`Now: its own mode, ${own}`, "ap.det.agent_mode.now", {
          mode: own,
        }),
        rl(`Then: it follows the project, ${to}`, "ap.det.agent_mode.then", {
          mode: to,
        }),
        running
          ? rl(
              `It is running: Den restarts it after its turn, on the same conversation, in ${to}.`,
              "ap.det.agent_mode.running",
              { mode: to },
            )
          : rl(
              `It is stopped: its next start is in ${to}.`,
              "ap.det.agent_mode.stopped",
              { mode: to },
            ),
      ]),
      args: { agent: id, project: rec.workspace },
    };
  } catch (e) {
    return no((e as Error).message);
  }
}

/**
 * Issue 199: on Allow, clears its own mode. A running agent is restarted
 * after its turn, on the same conversation, by Den's mode check (`apply`:
 * the web server's applyModesNow), as any mode change is.
 */
export async function runAgentMode(
  d: AgentsResolved,
  raw: Record<string, unknown>,
  opts: { apply?: () => Promise<unknown> } = {},
): Promise<
  | {
      ok: true;
      agent: string;
      project: string;
      from: string;
      mode: string;
      restarts: boolean;
    }
  | { ok: false; error: string }
> {
  const c = checkAgentMode(d, raw);
  if (!c.ok) return c;
  const { agent, project } = c.args;
  const rec = setAgentPermission(d, agent, project, null);
  const restarts = !rec.stoppedAt;
  if (restarts && opts.apply) await opts.apply();
  return {
    ok: true,
    agent,
    project,
    from: c.params.from,
    mode: c.params.to,
    restarts,
  };
}

/**
 * D65 v2: link the agent to a repo of its project, or to none (null).
 * Its own record, so every restart path keeps it.
 */
export function setAgentRepo(
  d: AgentsResolved,
  id: string,
  ws: string,
  repo: string | null,
): AgentRecord {
  const rec = agentRecord(d, id, ws);
  const next: AgentRecord = { ...rec, project: rec.workspace };
  if (repo) next.repo = repo;
  else delete next.repo;
  delete next.subpath;
  writeRecord(d.stateDir(), next);
  return next;
}

/**
 * den#48 (Vision 11-13): `agents permission <id> <mode>`, a mode a person
 * chose for one agent. It is an override, so it stays through every
 * restart, whatever its project or persona says later; null clears it,
 * and the agent follows its project's mode, else its persona's, again.
 * A running agent takes it at its next start, resume or restart.
 */
export function setAgentPermission(
  d: AgentsResolved,
  id: string,
  ws: string,
  intent: PermissionIntent | null,
): AgentRecord {
  const rec = agentRecord(d, id, ws);
  if (!runtimeFor(rec.runtime).permissions)
    throw usage(
      `agents permission: ${rec.runtime} can't take a permission mode from Den yet`,
    );
  const rest = (rec.overrides ?? []).filter((o) => o !== "permission");
  const next: AgentRecord = { ...rec };
  if (intent) {
    next.permission = intent;
    next.overrides = [...rest, "permission"];
  } else if (rest.length) next.overrides = rest;
  else delete next.overrides;
  // Issue 252: `permission` is also the mode its session was started in.
  // A running agent keeps that one in startedIn until its next launch, so
  // Den's mode check sees the change and restarts it at its next idle.
  const ran = rec.startedIn ?? rec.permission;
  if (!rec.stoppedAt && ran && ran !== next.permission) next.startedIn = ran;
  else delete next.startedIn;
  writeRecord(d.stateDir(), next);
  return next;
}

/** D65 v2, `agents doctor`: agents on no repo, and those whose repo is gone. */
export function agentLinkReport(d: AgentsResolved): {
  migrated: string[];
  noRepo: { id: string; project: string }[];
  missing: { id: string; project: string; repo: string }[];
} {
  const m = migrateAgentLinks(d);
  const noRepo: { id: string; project: string }[] = [];
  const missing: { id: string; project: string; repo: string }[] = [];
  const repos = new Map<string, Map<string, string>>();
  for (const rec of listRecords(d.stateDir())) {
    if (isServerScope(rec.workspace)) continue;
    const project = rec.project ?? rec.workspace;
    if (!rec.repo) {
      noRepo.push({ id: rec.id, project });
      continue;
    }
    if (!repos.has(rec.workspace))
      repos.set(rec.workspace, workspaceRepoFolders(d, rec.workspace));
    if (!repos.get(rec.workspace)!.has(rec.repo))
      missing.push({ id: rec.id, project, repo: rec.repo });
  }
  return { migrated: m.linked, noRepo, missing };
}

/**
 * D65 v2's one-time migration: every agent with no project gets its
 * workspace, and the repo its folder proposes. Those it couldn't give a
 * repo are listed (`agents doctor`). Writes only records that change.
 */
export function migrateAgentLinks(d: AgentsResolved): {
  linked: string[];
  unlinked: string[];
} {
  const linked: string[] = [];
  const unlinked: string[] = [];
  for (const rec of listRecords(d.stateDir())) {
    if (rec.project !== undefined || isServerScope(rec.workspace)) continue;
    const repo = proposeRepo(d, rec.workspace, rec.cwd);
    writeRecord(d.stateDir(), {
      ...rec,
      project: rec.workspace,
      ...(repo ? { repo } : {}),
    });
    (repo ? linked : unlinked).push(rec.id);
  }
  return { linked, unlinked };
}

export interface Stopped {
  rec: AgentRecord;
  /** The session it sent TERM to; undefined when it wasn't running. */
  session?: SessionInfo;
  /** Its session was still running when the wait ran out. */
  stillStopping?: boolean;
}

/**
 * Stop: TERM to the agent's session, then wait (up to d.stopWaitMs) until
 * the session has ended, so a resume right after it never finds the agent
 * still running. Still running at the bound: `stillStopping`. With
 * `wait: false` (or d.stopWaitMs 0) it returns once TERM is sent.
 */
export async function stopAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
  opts: {
    wait?: boolean;
    /**
     * Issue 218: stop only this session. Another one running instead (a
     * restart from elsewhere replaced it) is left alone, its token too,
     * and the stop throws the host's not-found.
     */
    only?: string;
  } = {},
): Promise<Stopped> {
  return lockAgent(d, id, async () => {
    const rec = agentRecord(d, id, ws);
    return withClient(d, async (c) => {
      const s = sessionOf(await c.list(), rec);
      if (opts.only && s && !s.exited && s.ref.id !== opts.only)
        throw new HostError(
          "not-found",
          `agent ${rec.id} changed while this waited; nothing stopped`,
        );
      // Its token stops working before the session is asked to end.
      revokeAgentTokens(d.stateDir(), rec.id);
      let live = Boolean(s && !s.exited);
      // Review M2 (0.4.46): it may end on its own between the list and the
      // kill. The host then refuses ("exited"): stopped is what was asked
      // for, so that is a success, with nothing to wait for.
      if (live)
        try {
          await c.kill(s!.ref.id, "TERM");
        } catch (e) {
          if (!(e instanceof HostError && e.code === "exited")) throw e;
          live = false;
        }
      const next = { ...rec, stoppedAt: new Date().toISOString() };
      writeRecord(d.stateDir(), next);
      let stillStopping = false;
      if (live && opts.wait !== false && d.stopWaitMs > 0) {
        const deadline = Date.now() + d.stopWaitMs;
        for (;;) {
          const now = (await c.list()).find((x) => x.ref.id === s!.ref.id);
          if (!now || now.exited) break;
          if (Date.now() >= deadline) {
            stillStopping = true;
            break;
          }
          await new Promise((r) => setTimeout(r, EXIT_POLL_MS));
        }
      }
      // Issue 1325: its temp folder goes once its session has (one still
      // stopping: noteEnded takes it when the host lists it exited).
      if (!stillStopping && next.sessionTmp) {
        removeSessionTmp(next.sessionTmp, d.sessionTmpBase);
        delete next.sessionTmp;
        writeRecord(d.stateDir(), next);
      }
      return {
        rec: next,
        ...(live ? { session: s! } : {}),
        ...(stillStopping ? { stillStopping } : {}),
      };
    });
  });
}

export interface Resumed extends Started {
  /** Never prompted: started afresh under the same conversation id. */
  fresh: boolean;
  /**
   * Issue 658: started fresh with its last handoff as the first prompt
   * (its conversation was never written): the handoff's file.
   */
  fromHandoff?: string;
  /**
   * Issue 658: its runtime refused the same conversation id both ways
   * and none was ever written, so it started a new conversation.
   */
  newConversation?: boolean;
  /**
   * Issue 216: another request restarted it while this one waited, so
   * this one didn't restart it again. `at`: when that session started.
   */
  already?: { at: string; note: string };
  /**
   * Issue 923: its rotation was ready, so the restart relaunched it from
   * its handoff in a new conversation (why it rotated, where it was kept).
   */
  relaunched?: { why: string; handoff: string };
}

/**
 * Issue 923: relaunch agent `id` from its handoff when its rotation is
 * ready (due, the handoff passes) and Den may relaunch it (on_due auto,
 * or a person asked for Relaunch now), as resumeOrRelaunch does.
 * Undefined otherwise: on ask the resume is refused and the person is
 * told (notBackAfterRestart); not ready, it resumes as before.
 */
async function relaunchIfReady(
  d: AgentsResolved,
  id: string,
  ws: string,
): Promise<Resumed | undefined> {
  const rot = rotationOf(d, agentRecord(d, id, ws));
  if (!rot?.ready || (rot.onDue !== "auto" && !rot.relaunchWanted))
    return undefined;
  const r = await relaunchAgent(d, id, ws, {
    ...(rot.onDue === "auto" ? { auto: true } : {}),
  });
  const { why, handoff, reason: _reason, ...started } = r;
  return {
    ...started,
    fresh: true,
    newConversation: true,
    relaunched: { why, handoff },
  };
}

/** Issue 216: what a restart says when another request already did it. */
export function alreadyRestartedNote(at: string): string {
  return `restarted by another request at ${new Date(at).toLocaleString()}; same conversation`;
}

/**
 * The grants a resume serves (AG-14): the ones the agent had, never more
 * than agents.<id>.grants gives now (a grant taken out of the config is
 * gone). A record from before 0.4.8 has none noted: the config's.
 */
export function resumeGrants(
  rec: AgentRecord,
  cfg: ResolvedAgentsConfig,
): string[] {
  const now = cfg.agents[rec.id]?.grants ?? [];
  if (!rec.grants) return [...now];
  return rec.grants.filter((g) => now.includes(g));
}

/**
 * D56 item 5: why agent `rec` can't resume now, or null. Its folder must
 * still be there and be the one its conversation ran in (when the runtime
 * can tell); and no other live process may have that conversation open
 * (Den's own sessions, `denPids`, aside).
 */
function resumeWhereRefusal(
  d: AgentsResolved,
  rt: ReturnType<typeof runtimeFor>,
  rec: AgentRecord,
  denPids: number[],
): { message: string; status: number } | null {
  const where = `agents resume ${rec.id}`;
  if (!fs.statSync(rec.cwd, { throwIfNoEntry: false })?.isDirectory())
    return { message: `${where}: its folder ${rec.cwd} is gone`, status: 409 };
  const token = rec.resumeToken;
  if (!token) return null;
  const ran = rt.conversationCwd?.(token, d.env) ?? null;
  if (ran && realOr(ran) !== realOr(rec.cwd))
    return {
      message: `${where}: the conversation ran in ${ran}, not in ${rec.cwd}`,
      status: 409,
    };
  const holder = rt.openPid?.(token, d.env, denPids) ?? null;
  if (holder !== null) return { message: openInMessage(holder), status: 409 };
  return null;
}

export async function resumeAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<Resumed> {
  return lockAgent(d, id, async () => {
    const rec = agentRecord(d, id, ws);
    syncCatalog(d);
    const rt = runtimeFor(rec.runtime);
    // AG-14.2: never a resume that would start a new conversation instead.
    const why = resumeRefusal(rec);
    if (why)
      throw refused(why, [
        `Start fresh: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id}`,
      ]);
    // den#4: a rotated conversation ends there; its role relaunches from
    // the handoff, in a fresh one.
    const rot = rotationOf(d, rec);
    // D28: on_due off: nothing happens, its conversation goes on.
    if (rot?.ready && rot.onDue !== "off")
      throw new AgentError(
        `agent ${rec.id} rotated after ${reasonText(rot.due!, rot.compactions)}: its conversation is not resumed`,
        {
          code: "rotated",
          hints: [
            `Relaunch from handoff: ${d.cli} agents relaunch ${rec.id}`,
            `Start fresh: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id}`,
          ],
        },
      );
    const cfg = agentsConfig(d);
    const grants = resumeGrants(rec, cfg);
    const persona = personas(d, cfg, rec.workspace).get(rec.persona);
    if (!persona)
      throw refused(`agent ${rec.id}'s persona "${rec.persona}" is gone`);
    const det = await availableOrRefuse(d, rt, rec.workspace);
    ptyOrRefuse(d);
    return withClient(d, async (c) => {
      const sessions = await c.list();
      const old = sessionOf(sessions, rec);
      if (old && !old.exited)
        throw refused(`agent ${rec.id} is running (${old.name})`, [
          `Attach: ${d.cli} sessions attach ${old.name}`,
        ]);
      // D56 item 5: only where it started, and only with no other writer.
      const no = resumeWhereRefusal(
        d,
        rt,
        rec,
        sessions.filter((s) => !s.exited).map((s) => s.pid),
      );
      if (no) throw refused(no.message, [], no.status);
      const permission = permissionNow(d, rec, persona, rt);
      const input = launchInput(
        d,
        cfg,
        persona,
        rec.workspace,
        rec.id,
        launchModel(rec.model, rec.version),
        det.path,
        grants,
        {
          ...(permission ? { permission } : {}),
          ...(rt.permissions
            ? {
                allow: allowedFor(
                  d,
                  persona,
                  rec.allow ?? persona.allowedCommands,
                ),
              }
            : {}),
        },
        rt.id,
      );
      // Resume in the cwd the agent had, wherever the workspace points now.
      // D24 (and D25: a rename since) the name peers see it by.
      const peerName = peerSessionName(d.cli, rec.workspace, rec);
      const hub = await agentHub(d, rec.workspace);
      const at = {
        ...input,
        ...(hub ? { mcp: { ...input.mcp, hub } } : {}),
        sessionLabel: peerName,
        worktree: rec.cwd,
        ...(rec.resumeToken ? { resumeToken: rec.resumeToken } : {}),
      };
      // 0.4.8: the runtime's own resume first, whenever this token was
      // launched (the record says so), its conversation is on disk, the last
      // session was prompted, or the host no longer lists it. Only a record
      // from before 0.4.8 whose session nobody prompted starts afresh under
      // the same id.
      const token = rec.resumeToken;
      // A runtime that can tell (den-claude: its transcript) decides first:
      // a conversation on disk resumes. Else a last session someone typed
      // into resumes, unless what was typed was the answer to its folder-
      // trust question (issue 659 noted it): nothing was written then.
      // Issue 658: a relaunch from a handoff the runtime never wrote is no
      // conversation (issue 631's rule holds only where the runtime can't
      // tell). Without that, the record decides: launched on this token, a
      // relaunch from a handoff, or a session the host lost. Whatever is
      // chosen, the runtime's own answer ("no conversation found") is the
      // backstop below, and a conversation never written is never a 502.
      const onDisk =
        rt.conversationExists && token
          ? rt.conversationExists(token, d.env)
          : undefined;
      const known =
        onDisk === undefined
          ? launchedFromHandoff(rec) ||
            Boolean(rec.launched) ||
            !old ||
            Boolean(old.prompted)
          : onDisk ||
            (Boolean(old?.prompted) && !rec.trustAsked && !rec.trustDeclined);
      // Issue 658: a fresh start carries the agent's last handoff, when one
      // is on file, as its first prompt.
      const handoff = rt.firstPrompt ? newestHandoff(input.filesDir) : null;
      let usedHandoff: string | undefined;
      const launchAs = (asFresh: boolean, newId = false) => {
        const { resumeToken: _same, ...withoutId } = at;
        const fresh = {
          ...(newId ? withoutId : at),
          ...(handoff
            ? { firstPrompt: resumeHandoffPrompt(handoff.text) }
            : {}),
        };
        // A fresh launch says its conversation id (resumeToken); a resume
        // keeps the one it had.
        const out = launchOrThrow<
          (Omit<LaunchOutput, "resumeToken"> & { resumeToken?: string }) | null
        >(() => (asFresh ? rt.launch(fresh) : rt.resume!(at)));
        if (!out) throw refused(`agent ${rec.id} has nothing to resume`);
        usedHandoff = asFresh && handoff ? handoff.file : undefined;
        writeRuntimeFiles(input.filesDir, out.files);
        // den#4: the same conversation keeps its count.
        launchRotation(
          input.filesDir,
          newId ? (out.resumeToken ?? token) : token,
          launchAfter(rt, input),
        );
        const sized = measureInstructions(d, rt, {
          cwd: rec.cwd,
          filesDir: input.filesDir,
          model: rec.model,
          version: rec.version,
        });
        return sized.length
          ? { ...out, warnings: [...(out.warnings ?? []), ...sized] }
          : out;
      };
      const { session: _s, startedAt: _t, resumedAt: _r, ...base } = rec;
      const run = async (
        asFresh: boolean,
        prior: SessionInfo | undefined,
        newId = false,
      ) => {
        const out = launchAs(asFresh, newId);
        const {
          rec: next,
          info,
          signInWarning,
          sandboxWarning,
          signingWarning,
        } = await startSession(
          d,
          c,
          {
            rec: {
              ...base,
              ...(permission ? { permission } : {}),
              ...subagentsField(rt, persona, cfg),
              cwd: rec.cwd,
              peerName,
              ...(token ? { launched: true } : {}),
              // Issue 658: a new conversation, when the id was refused.
              ...(newId && out.resumeToken
                ? { resumeToken: out.resumeToken }
                : {}),
            },
            argv: out.argv,
            env: out.env,
            passthrough: rt.envPassthrough,
            launchEnv: rt.launchEnv,
            tokenEnv: rt.signInTokenEnv,
            grants,
            ...binDirOf(det),
            existing: true,
          },
          prior,
          asFresh ? {} : { resumedAt: new Date().toISOString() },
        );
        const early = await exitedAtOnce(d, c, info);
        return {
          out,
          next,
          info,
          early,
          signInWarning,
          sandboxWarning,
          signingWarning,
        };
      };
      let fresh = !known && Boolean(token);
      let newConversation = false;
      let r = await run(fresh, old);
      // It exited at once saying the other way was the right one: try that,
      // once. A resume with nothing to continue starts fresh under the same
      // id; a fresh start whose id is taken resumes it.
      const said = r.early?.said ?? "";
      const other = fresh
        ? rt.launchFailures?.idInUse?.test(said)
        : rt.launchFailures?.noConversation?.test(said);
      if (r.early && other && token) {
        const first = r;
        fresh = !fresh;
        // The first try's token goes with its session.
        revokeAgentTokens(d.stateDir(), rec.id);
        r = await run(
          fresh,
          (await c.list()).find((x) => x.ref.id === first.info.ref.id),
        );
        // Issue 658: refused both ways, and its runtime never wrote the
        // conversation: there is nothing to lose. A new conversation (a
        // new id), with its handoff when one is on file. Never a 502 for
        // a conversation that doesn't exist.
        if (r.early && onDisk === false) {
          const second = r;
          fresh = true;
          revokeAgentTokens(d.stateDir(), rec.id);
          r = await run(
            true,
            (await c.list()).find((x) => x.ref.id === second.info.ref.id),
            true,
          );
          if (!r.early) newConversation = true;
        }
        if (r.early)
          throw new AgentError(
            `agent ${rec.id}: conversation ${token} could not be continued or started (${rt.id} exited at once both ways: ${[...first.early!.tail, ...r.early.tail].slice(-4).join(" / ") || "no output"})`,
            {
              status: 502,
              code: "resume_failed",
              hints: [
                `Start fresh: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id} (a new conversation)`,
              ],
            },
          );
      }
      // Issue 658: handoff.md, once a fresh start began from it, is kept
      // aside (as a relaunch does), so the next rotation needs a new one.
      const from = fresh && !r.early ? usedHandoff : undefined;
      if (from && from === handoffFile(input.filesDir))
        try {
          archiveHandoff(
            input.filesDir,
            `${new Date().toISOString().replace(/[:.]/g, "-")}-${token ?? "conversation"}`,
          );
        } catch {
          /* it stays: the next relaunch reads it again */
        }
      return {
        rec: r.next,
        info: r.info,
        warnings: [
          ...(r.out.warnings ?? []),
          ...(r.signInWarning ? [r.signInWarning] : []),
          ...(r.sandboxWarning ? [r.sandboxWarning] : []),
          ...(r.signingWarning ? [r.signingWarning] : []),
        ],
        early: r.early,
        fresh,
        ...(from ? { fromHandoff: from } : {}),
        ...(newConversation ? { newConversation: true } : {}),
      };
    });
  });
}

// ── AG-18: change a running agent's persona ─────────────────────────────────

/** The refusal code while its turn is going and no `when` was given. */
export const PERSONA_BUSY = "busy";

export interface PersonaRequest {
  persona: string;
  /** Advanced: another model. Absent: the one it runs (the conversation's). */
  model?: string;
  /** With model: "latest" or a pinned version. */
  version?: string;
  /**
   * Mid-turn: "after-turn" waits until its turn ends, "now" stops it. None:
   * refused (PERSONA_BUSY) while it works, so a turn is never cut silently.
   */
  when?: "now" | "after-turn";
  /** Who asked (a person's sign-in, "cli"), for its record. */
  by?: string;
}

export interface PersonaChanged extends Resumed {
  from: string;
}

/**
 * What a resume with nothing to continue yet says (AG-14, AG-18): the
 * runtime started fresh under the same conversation id.
 */
export const FRESH_NOTE =
  "nothing to resume yet; started fresh (same conversation id, folder and scope)";

/**
 * Issue 658: what a Resume that started fresh says: FRESH_NOTE, or that
 * it began from its last handoff, or (its id refused) in a new
 * conversation.
 */
export function freshNote(s: {
  fromHandoff?: string;
  newConversation?: boolean;
}): string {
  const where = s.newConversation
    ? "started fresh in a new conversation (its runtime refused the old id)"
    : "started fresh (same conversation id, folder and scope)";
  return s.fromHandoff
    ? `its conversation was never written; ${where}, with its last handoff as the first prompt`
    : s.newConversation
      ? `nothing to resume yet; ${where}`
      : FRESH_NOTE;
}

/**
 * How often "after this turn" checks its turn (AG-18). How long: the
 * setting agents.restart_wait_minutes (0.4.48; restartWaitOf).
 */
export const TURN_POLL_MS = 1_000;

/**
 * Whether agent `rec` is mid-turn: true or false from its runtime (den-
 * claude: its transcript), null when it can't tell. Not running: false.
 * Issue 607: busy comes from the live session, not the transcript alone:
 * a turn last written before that session started was cut with the one
 * that ran it (a terminal host restart), and reads idle.
 * Issue 732: the turn alone. What Den types (Hub comments, notes, the
 * bell's "busy") goes by this: an agent takes typed input while a
 * background shell it started runs. Restarts use agentBusy.
 */
async function agentTurnBusy(
  d: AgentsResolved,
  rec: AgentRecord,
  live?: SessionInfo | null,
): Promise<boolean | null> {
  const s =
    live !== undefined
      ? live
      : await withClient(d, async (c) => {
          const x = sessionOf(await c.list(), rec);
          return x && !x.exited ? x : null;
        });
  if (s === null) return false;
  const rt = getRuntime(rec.runtime);
  if (!rt?.turnBusy || !rec.resumeToken) return null;
  let readMaxBytes: number | undefined;
  try {
    readMaxBytes = d.agentsConfig().turnReadMaxBytes;
  } catch {
    /* unreadable config: the default */
  }
  return rt.turnBusy(rec.resumeToken, d.env, {
    readMaxBytes,
    since: liveSince(s, rec),
  });
}

/**
 * Its turn, or a job it left running: for what stops its session (a
 * restart, a persona change, a move, a relaunch). 0.4.48: a turn that
 * ended with a job it started still running under it (a gate in the
 * background) is busy too, so "after its turn" never kills a running
 * gate. Issue 732: never for typing (agentTurnBusy).
 */
async function agentBusy(
  d: AgentsResolved,
  rec: AgentRecord,
): Promise<boolean | null> {
  const live = await withClient(d, async (c) => {
    const s = sessionOf(await c.list(), rec);
    return s && !s.exited ? s : null;
  });
  if (live === null) return false;
  const busy = await agentTurnBusy(d, rec, live);
  if (busy !== false) return busy;
  return (await agentJob(d, rec, live.pid)) !== null;
}

/**
 * Issue 732: why a wait for agent `rec`'s turn (and jobs) ran out, in
 * honest words: a background job it started, when its turn has ended
 * and a job still runs; else "still working".
 */
async function stillBusyWhy(
  d: AgentsResolved,
  rec: AgentRecord,
  where: string,
  waitedMs: number,
  outcome: string,
): Promise<AgentError> {
  const min = Math.round(waitedMs / 60_000);
  if ((await agentTurnBusy(d, rec).catch(() => null)) === false) {
    const job = await agentJob(d, rec).catch(() => null);
    if (job)
      return stillBusy(
        `${where}: agent ${rec.id}: a background job it started is still running (${job.minutes} min) after a wait of ${min} min; ${outcome}`,
      );
  }
  return stillBusy(
    `${where}: agent ${rec.id} was still working after ${min} min; ${outcome}`,
  );
}

/**
 * Issue 607: when agent `rec`'s live session started (ms): its session
 * host's own start for it, else the record's (its resume's, else its
 * start's). Undefined when none reads.
 */
function liveSince(s: SessionInfo, rec: AgentRecord): number | undefined {
  for (const t of [s.startedAt, rec.resumedAt, rec.startedAt]) {
    const ms = t ? Date.parse(t) : Number.NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/**
 * 0.4.48: the job agent `rec` left running under its session (the longest
 * running one), or null: none, or its runtime can't tell.
 */
export async function agentJob(
  d: AgentsResolved,
  rec: AgentRecord,
  pid?: number | null,
): Promise<{ minutes: number } | null> {
  const rt = getRuntime(rec.runtime);
  if (!rt?.jobPattern) return null;
  const root =
    pid ??
    (await withClient(d, async (c) => {
      const s = sessionOf(await c.list(), rec);
      return s && !s.exited ? s.pid : null;
    }));
  if (root === null || root === undefined) return null;
  const jobs = jobsUnder(root, rt.jobPattern, d.processes());
  if (!jobs.length) return null;
  const secs = Math.max(...jobs.map((j) => j.secs ?? 0));
  return { minutes: Math.round(secs / 60) };
}

/**
 * Issue 1407: the job agent `rec` left running (the longest running one),
 * with what it runs, for a person; null: none, or its runtime can't tell.
 */
export async function agentJobDetail(
  d: AgentsResolved,
  rec: AgentRecord,
  pid?: number | null,
): Promise<{ minutes: number; command: string } | null> {
  const rt = getRuntime(rec.runtime);
  if (!rt?.jobPattern) return null;
  const root =
    pid ??
    (await withClient(d, async (c) => {
      const s = sessionOf(await c.list(), rec);
      return s && !s.exited ? s.pid : null;
    }));
  if (root === null || root === undefined) return null;
  const jobs = jobsUnder(root, rt.jobPattern, d.processes());
  if (!jobs.length) return null;
  const top = jobs.reduce((a, b) => ((b.secs ?? 0) > (a.secs ?? 0) ? b : a));
  return {
    minutes: Math.round((top.secs ?? 0) / 60),
    command: jobCommandOf(top.command),
  };
}

/** Issue 1407: where one agent of a bulk restart stands, before it waits. */
export type RestartState = "now" | "turn" | "job" | "unknown";
export interface RestartPlan {
  id: string;
  workspace: string;
  state: RestartState;
  job?: { command: string; minutes: number };
}
/** Issue 1407: how one agent's restart ended (onDone). */
export interface RestartOutcome {
  id: string;
  workspace: string;
  outcome: "restarted" | "job" | "timedOut" | "failed";
  job?: { command: string; minutes: number };
  /** timedOut: the minutes it waited for the turn to end. */
  minutes?: number;
  error?: string;
}

/**
 * Issue 1407: where agent `id` stands for a restart: idle (now), mid-turn
 * (turn), its turn ended with a job it started still running (job, with
 * what and how long), or Den can't tell when its turn ends (unknown). A
 * stopped agent just resumes: now.
 */
export async function restartStateOf(
  d: AgentsResolved,
  id: string,
  ws: string,
): Promise<RestartPlan> {
  const rec = agentRecord(d, id, ws);
  const base = { id: rec.id, workspace: rec.workspace };
  const live = await withClient(d, async (c) => {
    const s = sessionOf(await c.list(), rec);
    return s && !s.exited ? s : null;
  });
  if (!live) return { ...base, state: "now" };
  const turn = await agentTurnBusy(d, rec, live).catch(() => null);
  if (turn === null) return { ...base, state: "unknown" };
  if (turn) return { ...base, state: "turn" };
  const job = await agentJobDetail(d, rec, live.pid).catch(() => null);
  if (job) return { ...base, state: "job", job };
  return { ...base, state: "now" };
}

/**
 * How a restart at the agent's next idle that did not happen
 * ended: a job found when its turn ended (job), a wait of `waitedMs` that
 * ran out (timedOut), or anything else (failed, with why).
 */
export function restartOutcomeOf(
  id: string,
  workspace: string,
  e: unknown,
  waitedMs: number,
): RestartOutcome {
  const err = e as AgentError;
  if (err?.code === "job_running" && err.job)
    return {
      id,
      workspace,
      outcome: "job",
      job: { command: err.job.command ?? "", minutes: err.job.minutes },
    };
  if (err?.code === "still_busy")
    return {
      id,
      workspace,
      outcome: "timedOut",
      minutes: Math.round(waitedMs / 60_000),
    };
  return {
    id,
    workspace,
    outcome: "failed",
    error: e instanceof Error ? e.message : String(e),
  };
}

/**
 * Issue 1407: a bulk restart (restart-stale). Each agent is checked first
 * and the answer is per agent (restartStateOf). Those idle or mid-turn
 * restart at their next idle, on the same conversation; a job found when
 * the turn ends is reported (onDone, outcome "job"), never waited out
 * silently. One with a job, or whose turn Den can't read, is not
 * restarted: the person decides (Restart now). Resolves with the plan
 * before anything waits; onDone says how each restart ended.
 */
export async function restartMany(
  d: AgentsResolved,
  agents: readonly { id: string; workspace: string }[],
  o: {
    pollMs?: number;
    maxMs?: number;
    onDone?: (r: RestartOutcome) => void;
  } = {},
): Promise<RestartPlan[]> {
  const plan: RestartPlan[] = [];
  const waited = o.maxMs ?? restartWaitOf(d);
  for (const a of agents) {
    let p: RestartPlan;
    try {
      p = await restartStateOf(d, a.id, a.workspace);
    } catch {
      p = { id: a.id, workspace: a.workspace, state: "unknown" };
    }
    plan.push(p);
    if (p.state !== "now" && p.state !== "turn") continue;
    const base = { id: p.id, workspace: p.workspace };
    void restartAgent(d, p.id, p.workspace, "after-turn", {
      ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
      ...(o.maxMs !== undefined ? { maxMs: o.maxMs } : {}),
      jobStops: true,
    }).then(
      () => o.onDone?.({ ...base, outcome: "restarted" }),
      (e: unknown) =>
        o.onDone?.(restartOutcomeOf(p.id, p.workspace, e, waited)),
    );
  }
  return plan;
}

/**
 * 0.4.48: a person's Restart at the agent's next idle, while a job it left
 * running still runs: asked first (job_running, with its minutes), never
 * waited out silently. Restart now ends the job.
 */
export async function askAboutJob(
  d: AgentsResolved,
  id: string,
  ws: string | undefined,
): Promise<void> {
  const rec = agentRecord(d, id, ws);
  const job = await agentJob(d, rec);
  if (job)
    throw new AgentError(
      `agent ${rec.id}: a background job it started is still running (${job.minutes} min). Restart anyway? That ends the job (--now).`,
      { status: 409, code: "job_running", job },
    );
}

/**
 * Issue 1407: its turn has ended and a job it started still runs: the
 * wait stops (job_running, with what it runs and how long).
 */
async function jobStopsWait(
  d: AgentsResolved,
  rec: AgentRecord,
): Promise<void> {
  if ((await agentTurnBusy(d, rec).catch(() => null)) !== false) return;
  const job = await agentJobDetail(d, rec).catch(() => null);
  if (job)
    throw new AgentError(
      `agent ${rec.id}: its turn ended, but a background job it started is still running (${job.command}, ${job.minutes} min). Restart now ends the job.`,
      { status: 409, code: "job_running", job },
    );
}

/** 0.4.48: agents.restart_wait_minutes, in ms (its default if unreadable). */
export function restartWaitOf(d: AgentsResolved): number {
  try {
    return d.agentsConfig().restartWaitMs;
  } catch {
    return RESTART_WAIT_MINUTES_DEFAULT * 60_000;
  }
}

/** Issue 914: agents.rotation_wait_minutes, in ms (its default if unreadable). */
function rotationWaitOf(d: AgentsResolved): number {
  try {
    return (
      d.agentsConfig().rotationWaitMs ?? ROTATION_WAIT_MINUTES_DEFAULT * 60_000
    );
  } catch {
    return ROTATION_WAIT_MINUTES_DEFAULT * 60_000;
  }
}

/**
 * Issue 914: the background work agent `rec` has running under live
 * session `s`: its active helpers (running or idle, of this session) and
 * the jobs it left running (background shells). Empty when its runtime
 * can't tell. Never throws.
 */
async function leftRunningOf(
  d: AgentsResolved,
  rec: AgentRecord,
  s: SessionInfo,
): Promise<LeftRunning[]> {
  const rt = getRuntime(rec.runtime);
  const out: LeftRunning[] = [];
  const since = liveSince(s, rec);
  try {
    for (const h of rt?.helpers?.(rec, {
      env: d.env,
      settings: helperSettings(d),
      agentLive: true,
      ...(since !== undefined ? { liveSince: since } : {}),
    }) ?? [])
      if (!h.earlier && (h.status === "running" || h.status === "idle"))
        out.push({
          kind: "helper",
          id: h.id,
          what: h.description ?? h.workflow?.label ?? h.type ?? "",
          ...(h.branch ? { branch: h.branch } : {}),
        });
  } catch {
    /* its helpers can't be read: none counted */
  }
  try {
    if (rt?.jobPattern && s.pid)
      for (const j of jobsUnder(s.pid, rt.jobPattern, d.processes()))
        out.push({
          kind: "job",
          id: String(j.pid),
          what: `a background shell, running ${Math.round((j.secs ?? 0) / 60)} min`,
        });
  } catch {
    /* no process list: none counted */
  }
  return out;
}

/** Issue 218: agents.lock_wait_minutes, in ms (its default if unreadable). */
function lockWaitOf(d: AgentsResolved): number {
  try {
    return d.agentsConfig().lockWaitMs ?? LOCK_WAIT_MINUTES_DEFAULT * 60_000;
  } catch {
    return LOCK_WAIT_MINUTES_DEFAULT * 60_000;
  }
}

/**
 * Review M1, issue 218: one change to agent `id` at a time, in this
 * process and across processes (the CLI beside the web server). Another
 * process's change is waited for up to agents.lock_wait_minutes, then
 * refused with nothing changed.
 */
async function lockAgent<T>(
  d: AgentsResolved,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withAgentLock(d.stateDir(), id, fn, {
      waitMs: lockWaitOf(d),
    });
  } catch (e) {
    if (e instanceof AgentLockBusy)
      throw new AgentError(e.message, { status: 409, code: "still_busy" });
    throw e;
  }
}

/** Why agent `rec` can't change persona (it can't resume), or null. */
export function personaChangeRefusal(rec: AgentRecord): string | null {
  const rt = getRuntime(rec.runtime);
  if (!rt?.resume)
    return `${rt?.label ?? rec.runtime} can't continue a conversation, so it can't change persona`;
  return resumeRefusal(rec);
}

/**
 * AG-18, change persona: Den stops the agent's session and resumes the
 * same conversation with the new persona's launch settings (its role
 * prompt, permission mode, allowed commands). The history stays; so do the
 * id, name, workspace, folder and grants, and the model it runs unless
 * one is given. Mid-turn it never stops a turn unasked: refused with
 * PERSONA_BUSY, or `when` says to wait for the turn's end or stop now.
 * Only a runtime that can resume can. The person's only: callers refuse an
 * agent's token before this.
 */
export async function changePersona(
  d: AgentsResolved,
  id: string,
  ws: string | undefined,
  req: PersonaRequest,
  opts: { pollMs?: number; maxMs?: number } = {},
): Promise<PersonaChanged> {
  const where = "agents persona";
  const rec = agentRecord(d, id, ws);
  const cfg = agentsConfig(d);
  const all = personas(d, cfg, rec.workspace);
  if (!all.get(req.persona))
    throw usage(
      `${where}: no persona "${req.persona}" (personas: ${[...all.keys()].sort().join(", ")})`,
    );
  if (req.persona === rec.persona && req.model === undefined)
    throw usage(`${where}: agent ${rec.id} is already ${rec.persona}`);
  const why = personaChangeRefusal(rec);
  if (why) throw refused(why, [], 422);
  let busy = await agentBusy(d, rec);
  if (busy !== false && req.when === undefined)
    throw new AgentError(
      busy
        ? `agent ${rec.id} is working. Change after this turn, or stop it now?`
        : `agent ${rec.id} is running and Den can't tell whether it is mid-turn. Change after this turn, or stop it now?`,
      {
        status: 409,
        code: PERSONA_BUSY,
        hints: [
          `After this turn: ${d.cli} agents persona ${rec.id} ${req.persona} --after-turn`,
          `Stop it now: ${d.cli} agents persona ${rec.id} ${req.persona} --now`,
        ],
      },
    );
  if (busy === null && req.when === "after-turn")
    throw refused(
      `${where}: Den can't tell when agent ${rec.id}'s turn ends; stop it now instead (--now)`,
    );
  if (req.when !== "after-turn") return switchPersona(d, rec, req, where);
  // Waiting: marked on the record, so a restart that drops the wait can
  // say so (cancelStalePersonaChanges); cleared however this ends.
  writeRecord(d.stateDir(), {
    ...rec,
    pendingPersona: {
      to: req.persona,
      since: new Date().toISOString(),
      ...(req.by ? { by: req.by } : {}),
    },
  });
  try {
    const deadline = Date.now() + (opts.maxMs ?? restartWaitOf(d));
    while (busy) {
      if (Date.now() >= deadline)
        throw await stillBusyWhy(
          d,
          agentRecord(d, id, ws),
          where,
          opts.maxMs ?? restartWaitOf(d),
          "nothing changed",
        );
      await new Promise((r) => setTimeout(r, opts.pollMs ?? TURN_POLL_MS));
      busy = await agentBusy(d, agentRecord(d, id, ws));
    }
    return await switchPersona(d, rec, req, where);
  } catch (e) {
    clearPendingPersona(d, rec.id);
    throw e;
  }
}

/**
 * D44, Restart: stop agent `id` and resume the same conversation, so it
 * launches with what it gets now (Hub's tools, for one). `after-turn` (the
 * default) waits for its turn to end; `now` stops it at once. Never cuts a
 * turn otherwise: Den that can't tell when a turn ends refuses after-turn.
 * A stopped agent just resumes. The person's only (callers refuse agents).
 */
export async function restartAgent(
  d: AgentsResolved,
  id: string,
  ws: string | undefined,
  when: "now" | "after-turn" = "after-turn",
  opts: {
    pollMs?: number;
    maxMs?: number;
    /**
     * 0.4.48: a person asked. A job the agent left running is asked about
     * first (job_running) rather than waited for; Restart now ends it.
     */
    askIfJob?: boolean;
    /**
     * Issue 1407: a job found once its turn has ended stops the wait
     * (job_running, with what it runs), never waited out silently.
     */
    jobStops?: boolean;
  } = {},
): Promise<Resumed> {
  const where = "agents restart";
  const asked = Date.now();
  const rec = agentRecord(d, id, ws);
  const why = personaChangeRefusal(rec);
  if (why)
    throw refused(
      why.replace("change persona", "restart and keep its conversation"),
      [],
      422,
    );
  // Issue 216: the session it runs as now, to tell after the wait whether
  // another request restarted (or someone stopped) it meanwhile.
  const seen = await withClient(d, async (c) => {
    const s = sessionOf(await c.list(), rec);
    return s && !s.exited ? s : undefined;
  });
  let busy = await agentBusy(d, rec);
  if (busy === null && when === "after-turn")
    throw refused(
      `${where}: Den can't tell when agent ${rec.id}'s turn ends; restart it now instead (--now)`,
    );
  if (when === "after-turn" && opts.askIfJob)
    await askAboutJob(d, rec.id, rec.workspace);
  if (when === "after-turn") {
    const deadline = Date.now() + (opts.maxMs ?? restartWaitOf(d));
    while (busy) {
      if (Date.now() >= deadline)
        throw await stillBusyWhy(
          d,
          agentRecord(d, id, ws),
          where,
          opts.maxMs ?? restartWaitOf(d),
          "not restarted",
        );
      if (opts.jobStops) await jobStopsWait(d, agentRecord(d, id, ws));
      await new Promise((r) => setTimeout(r, opts.pollMs ?? TURN_POLL_MS));
      busy = await agentBusy(d, agentRecord(d, id, ws));
    }
  }
  // Review M1: stop and resume as one change (not the wait above, so a
  // person can still stop it while it waits).
  return lockAgent(d, rec.id, async () => {
    const cur = agentRecord(d, rec.id, rec.workspace);
    const now = await withClient(d, async (c) =>
      sessionOf(await c.list(), cur),
    );
    const live = now && !now.exited ? now : undefined;
    // Issue 216: a new session, started after this request: another
    // request restarted it. Done; never a second restart. This holds
    // when this request saw none at all, too: another restart had
    // already stopped it then, and resumed it while this one waited.
    if (
      live &&
      live.ref.id !== seen?.ref.id &&
      Date.parse(live.startedAt) >= asked - 1_000
    )
      return alreadyRestarted(cur, live);
    if (seen) {
      // It ran when asked and runs no more: someone stopped it (or it
      // ended). A restart never undoes a stop.
      if (!live)
        throw refused(
          `${where}: agent ${rec.id} stopped while this restart waited; not restarted`,
          [`Resume it: ${d.cli} agents resume ${rec.id}`],
        );
    }
    await notQuarantined(d, cur.runtime, cur.workspace);
    let stopped: Stopped;
    try {
      stopped = await stopAgent(
        d,
        rec.id,
        rec.workspace,
        seen ? { only: seen.ref.id } : {},
      );
    } catch (e) {
      // Issue 218: the session it saw was gone when the stop reached it.
      // A newer one, started after this request: restarted elsewhere.
      if (!(seen && e instanceof HostError && e.code === "not-found")) throw e;
      const cur = agentRecord(d, rec.id, rec.workspace);
      const now = await withClient(d, async (c) =>
        sessionOf(await c.list(), cur),
      );
      if (
        !now ||
        now.exited ||
        now.ref.id === seen.ref.id ||
        Date.parse(now.startedAt) < asked - 1_000
      )
        throw e;
      return alreadyRestarted(cur, now);
    }
    // Issue 193 (0.4.57): its session takes longer to end than stop's own
    // wait. Den stopped it, so Den waits for the stop to finish (at most
    // agents.restart_wait_minutes), then resumes; never left stopped.
    if (stopped.stillStopping && stopped.session) {
      const mins = Math.round(restartWaitOf(d) / 60_000);
      if (!(await sessionEnded(d, stopped.session.ref.id, restartWaitOf(d)))) {
        const why = `still stopping after ${mins} min`;
        notBackAfterRestart(d, rec.id, rec.workspace, why);
        throw refused(`${where}: agent ${rec.id} is ${why}; not resumed`, [
          `Resume it: ${d.cli} agents resume ${rec.id}`,
        ]);
      }
    }
    // Issue 124: a resume that fails never leaves it stopped by Den.
    let out: Resumed;
    try {
      // Issue 923: its rotation is ready, so a resume is bound to be
      // refused. Den stopped it: it relaunches from its handoff instead.
      out =
        (await relaunchIfReady(d, rec.id, rec.workspace)) ??
        (await resumeAgent(d, rec.id, rec.workspace));
    } catch (e) {
      if (stopped.session)
        notBackAfterRestart(d, rec.id, rec.workspace, (e as Error).message);
      else restoreStopped(d, rec.id, rec.workspace, cur.stoppedAt);
      throw e;
    }
    if (out.early && stopped.session)
      notBackAfterRestart(
        d,
        rec.id,
        rec.workspace,
        `exited at once${out.early.exitCode === undefined ? "" : ` (code ${out.early.exitCode})`}`,
      );
    return out;
  });
}

/** Issue 193: whether host session `ref` has ended, waiting up to `maxMs`. */
async function sessionEnded(
  d: AgentsResolved,
  ref: string,
  maxMs: number,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  return withClient(d, async (c) => {
    for (;;) {
      const s = (await c.list()).find((x) => x.ref.id === ref);
      if (!s || s.exited) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, EXIT_POLL_MS));
    }
  });
}

/**
 * Issue 124: Den stopped agent `id` for a restart and it didn't come
 * back. Marked interrupted, not stopped (Resume and restore-on-boot bring
 * it back), and the person is told: an audit row, and a "needs you" item
 * in the bell.
 */
function notBackAfterRestart(
  d: AgentsResolved,
  id: string,
  ws: string,
  why: string,
  o: { relaunchTried?: boolean } = {},
): void {
  const rec = readRecord(d.stateDir(), id);
  if (!rec) return;
  const { stoppedAt: _s, ...rest } = rec;
  writeRecord(d.stateDir(), {
    ...rest,
    restartFailed: {
      at: new Date().toISOString(),
      why,
      ...(o.relaunchTried ? { relaunchTried: true } : {}),
    },
  });
  auditConfig(
    {
      verb: "agents",
      detail: `restart ${id} in ${ws}: stopped, not back; marked interrupted`,
      outcome: "refused",
      reason: why,
    },
    d.stateDir(),
  );
  const name = rec.displayName || rec.persona || id;
  try {
    new NotificationStore(d.stateDir()).add({
      kind: "waiting",
      subject: `agent:${id}`,
      scope: `workspace/${ws}`,
      text: `${name} didn't come back after a restart: ${why}`,
      msg: { key: "bell.m.restartFailed", vars: { name, why } },
      link: `/agents?ws=${encodeURIComponent(ws)}`,
    });
  } catch {
    /* best effort: the audit row and the row's state still say so */
  }
}

/**
 * Issue 124: a stopped agent's restart that failed: as it was before
 * (its stop's time, or none).
 */
function restoreStopped(
  d: AgentsResolved,
  id: string,
  ws: string,
  was: string | undefined,
): void {
  const rec = readRecord(d.stateDir(), id);
  if (!rec || rec.workspace !== ws) return;
  const { stoppedAt: _s, ...rest } = rec;
  writeRecord(d.stateDir(), was ? { ...rest, stoppedAt: was } : rest);
}

/** Issue 216: the result of a restart another request already made. */
function alreadyRestarted(rec: AgentRecord, live: SessionInfo): Resumed {
  return {
    rec,
    info: live,
    warnings: [],
    early: null,
    fresh: false,
    already: { at: live.startedAt, note: alreadyRestartedNote(live.startedAt) },
  };
}

export interface Moved {
  rec: AgentRecord;
  from: string;
  /** Set when it was running: resumed, same conversation, in `to`. */
  resumed?: Resumed;
}

/**
 * D72: move agent `id` to workspace `to`, keeping its conversation, its
 * folder, its name and its link to services. A stopped agent's record
 * just changes. A running one waits for its turn to end (or `now`), then
 * Den resumes the same conversation in `to`: its tools and token are a
 * workspace's, so they must be the new one's. Nothing typed mid-turn is
 * cut off. Its record from a deleted workspace (D71) moves the same way.
 */
export async function moveAgent(
  d: AgentsResolved,
  id: string,
  from: string | undefined,
  to: string,
  when: "now" | "after-turn" = "after-turn",
  opts: { pollMs?: number; maxMs?: number } = {},
): Promise<Moved> {
  const where = "agents move";
  const rec = agentRecord(d, id, from);
  if (rec.workspace === to)
    throw usage(`${where}: agent ${rec.id} is already in ${to}`);
  if (isServerScope(to) || isServerScope(rec.workspace))
    throw usage(`${where}: Den's own agents stay in its own scope`);
  if (!d.workspaceExists(to))
    throw refused(`${where}: there is no project "${to}"`, [], 404);
  const live = await withClient(d, async (c) => {
    const s = sessionOf(await c.list(), rec);
    return Boolean(s && !s.exited);
  });
  const moveRecord = (cur: AgentRecord): AgentRecord => {
    const next: AgentRecord = {
      ...cur,
      workspace: to,
      sessionName: sessionName(d.dist, to, cur.id),
      // D65 v2: its project is its workspace's (until H5's projects). Its
      // repo stays only if the new one has it too.
      project: to,
    };
    delete next.peerName;
    if (next.repo && !workspaceRepoFolders(d, to).has(next.repo)) {
      delete next.repo;
      delete next.subpath;
    }
    writeRecord(d.stateDir(), next);
    return next;
  };
  if (!live) return { rec: moveRecord(rec), from: rec.workspace };
  const why = personaChangeRefusal(rec);
  if (why)
    throw refused(
      why.replace(
        "change persona",
        "move while it runs; stop it first, then move it",
      ),
      [],
      422,
    );
  let busy = await agentBusy(d, rec);
  if (busy === null && when === "after-turn")
    throw refused(
      `${where}: Den can't tell when agent ${rec.id}'s turn ends; move it now instead (--now)`,
    );
  if (when === "after-turn") {
    const deadline = Date.now() + (opts.maxMs ?? restartWaitOf(d));
    while (busy) {
      if (Date.now() >= deadline)
        throw await stillBusyWhy(
          d,
          agentRecord(d, id, rec.workspace),
          where,
          opts.maxMs ?? restartWaitOf(d),
          "not moved",
        );
      await new Promise((r) => setTimeout(r, opts.pollMs ?? TURN_POLL_MS));
      busy = await agentBusy(d, agentRecord(d, id, rec.workspace));
    }
  }
  // Review M1: stop, move and resume as one change (not the wait above).
  return lockAgent(d, rec.id, async () => {
    await notQuarantined(d, rec.runtime, to);
    const stopped = await stopAgent(d, rec.id, rec.workspace);
    if (stopped.stillStopping)
      throw refused(
        `${where}: agent ${rec.id} is still stopping; try again in a moment`,
      );
    moveRecord(agentRecord(d, rec.id, rec.workspace));
    const resumed = await resumeAgent(d, rec.id, to);
    return { rec: resumed.rec, from: rec.workspace, resumed };
  });
}

/** D71: a workspace's agents, for its delete to name. */
export interface WorkspaceAgent {
  id: string;
  name?: string;
  running: boolean;
}

/** D71: what a workspace delete did with its agents. */
export interface WorkspaceAgentsDone {
  stopped: string[];
  /** Moved now (stopped ones), or once their turn ends (`pending`). */
  moved: { id: string; pending: boolean }[];
}

/** D71: workspace `ws`'s agents, running or not. */
export async function workspaceAgents(
  d: AgentsResolved,
  ws: string,
): Promise<WorkspaceAgent[]> {
  const recs = listRecords(d.stateDir()).filter((r) => r.workspace === ws);
  if (!recs.length) return [];
  const sessions = await hostSessions(d);
  return recs.map((r) => ({
    id: r.id,
    ...(r.displayName ? { name: r.displayName } : {}),
    running: !isStoppedState(rowState(r, sessionOf(sessions, r))),
  }));
}

/**
 * D71: before workspace `ws` is deleted, its agents: never left running
 * with no workspace. With none, nothing. Otherwise the person chose:
 *   stop  each running one stops; all are removed (Undo brings one back)
 *   move  each moves to `to` (moveAgent): a stopped one now, a running
 *         one once its turn ends, the same conversation
 * No choice: refused (409, code has_agents), naming them.
 */
export async function disposeWorkspaceAgents(
  d: AgentsResolved,
  ws: string,
  how: "stop" | "move" | undefined,
  to?: string,
): Promise<WorkspaceAgentsDone> {
  const done: WorkspaceAgentsDone = { stopped: [], moved: [] };
  const list = await workspaceAgents(d, ws);
  if (!list.length) return done;
  if (how === undefined) {
    const names = list.map((a) => a.name ?? a.id).join(", ");
    throw new AgentError(
      `project "${ws}" has ${list.length} ${list.length === 1 ? "agent" : "agents"} (${names}): stop them, or move them to another project`,
      { status: 409, code: "has_agents" },
    );
  }
  if (how === "move") {
    if (!to) throw usage("give the project to move its agents to");
    if (to === ws) throw usage(`move its agents to another project, not ${ws}`);
    if (!d.workspaceExists(to))
      throw refused(`there is no project "${to}"`, [], 404);
    for (const a of list) {
      if (!a.running) {
        await moveAgent(d, a.id, ws, to, "now");
        done.moved.push({ id: a.id, pending: false });
      } else {
        // Its turn may be long: it moves when it ends.
        // Never left behind: if Den can't wait for it, it stops and moves.
        void moveAgent(d, a.id, ws, to, "after-turn").catch(async () => {
          try {
            await stopAgent(d, a.id, ws);
            await moveAgent(d, a.id, ws, to, "now");
          } catch {
            /* it shows under No workspace, with Move */
          }
        });
        done.moved.push({ id: a.id, pending: true });
      }
    }
    return done;
  }
  for (const a of list)
    if (a.running) {
      await stopAgent(d, a.id, ws);
      done.stopped.push(a.id);
    }
  await removeRecords(
    d,
    listRecords(d.stateDir()).filter((r) => r.workspace === ws),
  );
  return done;
}

/** Drop agent `id`'s pending persona change mark, if it has one. */
function clearPendingPersona(d: AgentsResolved, id: string): void {
  const cur = readRecord(d.stateDir(), id);
  if (!cur?.pendingPersona) return;
  const { pendingPersona: _pp, ...rest } = cur;
  writeRecord(d.stateDir(), rest);
}

/**
 * At start (AG-18): every persona change still marked pending was dropped
 * when Den stopped, since the wait lived in memory. Clears each mark and
 * returns them, for the audit trail.
 */
export function cancelStalePersonaChanges(d: AgentsResolved): {
  id: string;
  workspace: string;
  from: string;
  to: string;
  by?: string;
}[] {
  const out: ReturnType<typeof cancelStalePersonaChanges> = [];
  for (const rec of listRecords(d.stateDir())) {
    const p = rec.pendingPersona;
    if (!p) continue;
    clearPendingPersona(d, rec.id);
    out.push({
      id: rec.id,
      workspace: rec.workspace,
      from: rec.persona,
      to: p.to,
      ...(p.by ? { by: p.by } : {}),
    });
  }
  return out;
}

/** The switch itself: stop, the new persona's settings, resume. */
async function switchPersona(
  d: AgentsResolved,
  rec: AgentRecord,
  req: PersonaRequest,
  where: string,
): Promise<PersonaChanged> {
  await notQuarantined(d, rec.runtime, rec.workspace);
  const stopped = await stopAgent(d, rec.id, rec.workspace);
  if (stopped.stillStopping)
    throw refused(
      `${where}: agent ${rec.id} is still stopping; try again in a moment`,
    );
  // The new persona's permissions apply: the old one's choices go. The
  // model stays (the conversation's) unless one is given.
  const {
    permission: _p,
    allow: _a,
    overrides: _o,
    pendingPersona: _pp,
    ...base
  } = stopped.rec;
  const keptOverrides = (rec.overrides ?? []).filter(
    (o) => o === "runtime" || o === "model" || o === "version",
  );
  const next: AgentRecord = {
    ...base,
    persona: req.persona,
    ...(req.model !== undefined
      ? { model: req.model, version: req.version ?? "latest" }
      : {}),
    ...(keptOverrides.length || req.model !== undefined
      ? {
          overrides: [
            ...new Set([
              ...keptOverrides,
              ...(req.model !== undefined ? (["model"] as const) : []),
            ]),
          ],
        }
      : {}),
    personaChanges: [
      ...(rec.personaChanges ?? []),
      {
        from: rec.persona,
        to: req.persona,
        at: new Date().toISOString(),
        ...(req.by ? { by: req.by } : {}),
      },
    ],
  };
  writeRecord(d.stateDir(), next);
  const r = await resumeAgent(d, rec.id, rec.workspace);
  return { ...r, from: rec.persona };
}

// ── AG-14: start fresh, remove, restart ─────────────────────────────────────

/**
 * A new conversation for agent `id` (AG-14.1 Start fresh): the same
 * persona, runtime, model and workspace, under the same id. Its last
 * conversation stays in the runtime's own history.
 */
export async function startFresh(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<Started> {
  const rec = agentRecord(d, id, ws);
  return startAgent(d, {
    workspace: rec.workspace,
    persona: rec.persona,
    runtime: rec.runtime,
    ...keptChoices(rec),
    id: rec.id,
  });
}

/**
 * What a record was started with (AG-10.9), for Start fresh and Relaunch:
 * the same model, version, permission and extra commands.
 */
function keptChoices(rec: AgentRecord): Partial<StartRequest> {
  return {
    ...(rec.model ? { model: rec.model } : {}),
    ...(rec.version ? { version: rec.version } : {}),
    ...(rec.permission && rec.overrides?.includes("permission")
      ? { permission: rec.permission }
      : {}),
    ...(rec.allow ? { allow: [...rec.allow] } : {}),
  };
}

/**
 * den#48 (Vision 11-13): the mode an agent runs with, at every start,
 * resume and restart. A mode a person chose for it (an override: the
 * Start dialog, `agents permission <id>`) stays. Otherwise it is read
 * again now: its project's, else its persona's. Live, a project set to
 * auto and then a restart ran the mode recorded at start.
 */
export function permissionNow(
  d: AgentsResolved,
  rec: AgentRecord,
  persona: Persona,
  rt: Runtime,
): PermissionIntent | undefined {
  if (!rt.permissions) return rec.permission;
  return effectiveMode(d, rec, persona, rt)!.mode;
}

/** Issue 225: an agent's own mode (an override), if it has one. */
export function ownModeOf(rec: AgentRecord): PermissionIntent | undefined {
  return rec.permission && rec.overrides?.includes("permission")
    ? rec.permission
    : undefined;
}

/**
 * Issue 225: the mode an agent runs in now and where it comes from: its
 * own setting, its project's, the install's, its persona's, else Den's
 * default (effective-mode.ts has the order). The one rule every start,
 * resume, restart, mode check and page reads. `ignoreOwn`: the mode it
 * would follow without its own setting. Undefined for a runtime that
 * takes no mode from Den. A bad project or install mode throws, naming
 * its key; one that isn't read (an own setting wins) never does.
 */
export function effectiveMode(
  d: AgentsResolved,
  rec: AgentRecord,
  persona: Persona | undefined,
  rt: Runtime,
  opts: { ignoreOwn?: boolean } = {},
): EffectiveMode | undefined {
  if (!rt.permissions) return undefined;
  const own = opts.ignoreOwn ? undefined : ownModeOf(rec);
  if (own) return resolveMode({ own });
  const project = workspacePermissionOf(d, rec.workspace);
  return resolveMode({
    project,
    install: project ? undefined : installPermissionOf(d),
    persona: persona?.permissionMode,
  });
}

/**
 * 0.4.46 MODE-UI: running agents whose mode now (permissionNow) is not
 * the one they run in: a project's or the install's mode changed since.
 * Drill (b), 0.4.48: "the one they run in" is read from the process's own
 * command line when it says (running-mode.ts), else the record's: a record
 * that says auto over a process started in ask is drift too. `running` is
 * the mode read from the process, when known.
 */
export async function modeDrift(
  d: AgentsResolved,
  commandLineOf: CommandLineOf = psCommandLine,
): Promise<
  {
    id: string;
    workspace: string;
    want: PermissionIntent;
    /** Issue 252: where `want` comes from. */
    source: ModeSource;
    running?: PermissionIntent;
  }[]
> {
  const c = await d.connectExisting();
  let live: { ref: { id: string }; pid?: number; exited?: unknown }[] = [];
  try {
    live = c ? (await c.list()).filter((x) => !x.exited) : [];
  } finally {
    c?.close();
  }
  if (!live.length) return [];
  const find = personaLookup(d);
  const out: {
    id: string;
    workspace: string;
    want: PermissionIntent;
    source: ModeSource;
    running?: PermissionIntent;
  }[] = [];
  for (const rec of listRecords(d.stateDir())) {
    const session = live.find((x) => x.ref.id === rec.session.id);
    if (!session) continue;
    const rt = getRuntime(rec.runtime);
    const p = find(rec);
    if (!rt?.permissions || !p) continue;
    let want: PermissionIntent | undefined;
    let source: ModeSource = "default";
    try {
      const eff = effectiveMode(d, rec, p, rt);
      want = eff?.mode;
      if (eff) source = eff.source;
    } catch {
      continue; // a bad mode: its next start says so
    }
    const running = session.pid
      ? runningIntent(session.pid, rec.resumeToken, commandLineOf)
      : undefined;
    // Only a mode Den knows the agent runs in can differ: none recorded
    // (an older record, one written by hand) and none on its command line
    // is not drift, and never restarts a running agent.
    const ran = running ?? rec.startedIn ?? rec.permission;
    if (want && ran && want !== ran)
      out.push({
        id: rec.id,
        workspace: rec.workspace,
        want,
        source,
        ...(running ? { running } : {}),
      });
  }
  return out;
}

/** MODE-3 (0.4.48): the mode an agent should run in, and the one it runs in. */
export interface AgentMode {
  want: PermissionIntent;
  /** Issue 225: where `want` comes from (effective-mode.ts). */
  source: ModeSource;
  /** Its process's, when its command line says; else its record's. */
  running?: PermissionIntent;
  /** Issue 199: a mode of its own (an override), not its project's. */
  own?: true;
  /** Issue 199: with its own: the mode its project would give it. */
  followed?: PermissionIntent;
}

/**
 * MODE-3 (0.4.48): each running agent's mode for its row and pane (one
 * persona read per project per list). `pid` is its session's process:
 * the mode it runs in is read from there first (drill b), else the
 * record's. Undefined for a runtime without modes, or a persona gone.
 */
export function modeResolver(
  d: AgentsResolved,
  commandLineOf: CommandLineOf = psCommandLine,
): (rec: AgentRecord, pid?: number) => AgentMode | undefined {
  const find = personaLookup(d);
  return (rec, pid) => {
    const rt = getRuntime(rec.runtime);
    const p = find(rec);
    if (!rt?.permissions || !p) return undefined;
    let eff: EffectiveMode | undefined;
    try {
      eff = effectiveMode(d, rec, p, rt);
    } catch {
      return undefined; // a bad mode: its next start says so
    }
    const want = eff?.mode;
    if (!eff || !want) return undefined;
    const running =
      (pid ? runningIntent(pid, rec.resumeToken, commandLineOf) : undefined) ??
      rec.startedIn ??
      rec.permission;
    const own = eff.source === "own";
    let followed: PermissionIntent | undefined;
    if (own)
      try {
        followed = followedPermissionOf(d, rec.workspace);
      } catch {
        followed = undefined; // a bad project mode: said where it is set
      }
    return {
      want,
      source: eff.source,
      ...(running ? { running } : {}),
      ...(own ? { own: true as const, ...(followed ? { followed } : {}) } : {}),
    };
  };
}

/** Issue 252: a restart Den made on its own to apply an agent's mode. */
export interface ModeRestarted {
  agent: string;
  project: string;
  mode: PermissionIntent;
  source: ModeSource;
}

const MODE_SOURCE_WORDS: Record<ModeSource, string> = {
  own: "its own setting",
  project: "its project",
  install: "the Den-wide default",
  persona: "its persona",
  default: "Den's default",
};

/** Issue 252: the audit row's words for a restart for a mode. */
export function modeRestartDetail(e: ModeRestarted): string {
  return `restarted ${e.agent} in ${e.project} at idle to take mode ${e.mode}, from ${MODE_SOURCE_WORDS[e.source]}, by Den itself`;
}

export interface ModeCheck {
  /** One look: the agents it began restarting. */
  tick(): Promise<string[]>;
  pending(): Promise<void>;
}

/**
 * 0.4.46 MODE-UI: a mode change applies on its own. Each running agent
 * whose mode now differs is restarted after its turn, the same
 * conversation, in the new mode: nobody presses Restart.
 */
export function modeCheck(
  d: AgentsResolved,
  opts: {
    pollMs?: number;
    log?: (line: string) => void;
    /** Drill (b): a process's command line (default: ps). */
    commandLineOf?: CommandLineOf;
    /** Issue 252: each restart it made (the web server's audit row). */
    onRestarted?: (e: ModeRestarted) => void;
  } = {},
): ModeCheck {
  const running = new Map<string, Promise<void>>();
  return {
    async tick() {
      const began: string[] = [];
      for (const m of await modeDrift(d, opts.commandLineOf)) {
        if (running.has(m.id)) continue;
        began.push(m.id);
        const p = restartAgent(d, m.id, m.workspace, "after-turn", {
          pollMs: opts.pollMs,
        })
          .then((done) => {
            // Another request restarted it meanwhile: not Den's restart.
            if (done.already) return;
            opts.log?.(`agent ${m.id}: restarted after its turn in ${m.want}`);
            opts.onRestarted?.({
              agent: m.id,
              project: m.workspace,
              mode: m.want,
              source: m.source,
            });
          })
          .catch((e: unknown) =>
            opts.log?.(
              `agent ${m.id}: not restarted for its mode: ${(e as Error)?.message ?? e}`,
            ),
          )
          .finally(() => running.delete(m.id));
        running.set(m.id, p);
      }
      return began;
    },
    async pending() {
      await Promise.all([...running.values()]);
    },
  };
}

// ── den#4: relaunch from handoff ────────────────────────────────────────────

export interface Relaunched extends Started {
  /** Why the last session rotated: "3 compactions", "PR merged". */
  why: string;
  /** Where its handoff was kept. */
  handoff: string;
  /** Issue 658: why Den relaunched it (a rotation's reason, or manual). */
  reason: RelaunchReason;
}

/** Issue 658: relaunch from a handoff when no rotation is due. */
export interface FromHandoff {
  /** A handoff file a person named (CLI only); else the newest on file. */
  file?: string;
  /** What the record says: "manual" (default) or "resume_failed". */
  reason?: "manual" | "resume_failed";
}

/**
 * Issue 658: whether agent `rec`'s current conversation is a relaunch
 * from a handoff that never began: its runtime never wrote it and its
 * session isn't running (it stopped at the folder-trust question and the
 * answer was No, say). Only a runtime that can tell (its transcript).
 */
function unbegunRelaunch(
  d: AgentsResolved,
  rec: AgentRecord,
  sessions: SessionInfo[],
): RotationEntry | null {
  const token = rec.resumeToken;
  const entry = rec.rotations?.[rec.rotations.length - 1];
  if (!token || !entry || entry.next !== token) return null;
  const rt = getRuntime(rec.runtime);
  if (!rt?.conversationExists || rt.conversationExists(token, d.env))
    return null;
  const s = liveSessionOf(sessions, rec);
  if (s && !s.exited) return null;
  return entry;
}

/**
 * Issue 658: undo a relaunch that never began, whenever it ended (at once
 * or after its person answered a question): handoff.md is back from
 * handoffs/ and its rotation is due again for the conversation the record
 * names, with Relaunch asked (the relaunch was already chosen). True when
 * it did. Once: a handoff.md on file, or a rotation due, means done.
 */
function undoUnbegunRelaunch(
  d: AgentsResolved,
  rec: AgentRecord,
  sessions: SessionInfo[],
): boolean {
  const entry = unbegunRelaunch(d, rec, sessions);
  if (!entry) return false;
  const files = agentFilesDir(d.stateDir(), rec.id);
  if (fs.existsSync(handoffFile(files))) return false;
  const st = readRotation(files);
  if (st?.due && (!st.conversation || st.conversation === rec.resumeToken))
    return false;
  const kept = keptHandoffOf(files, entry.conversation);
  if (!kept) return false;
  try {
    fs.renameSync(kept, handoffFile(files));
  } catch {
    return false;
  }
  const due =
    entry.reason === "compactions" || entry.reason === "pr-merged"
      ? entry.reason
      : undefined;
  writeRotation(files, {
    ...(st ?? { compactions: 0, after: 0 }),
    ...(rec.resumeToken ? { conversation: rec.resumeToken } : {}),
    compactions: entry.compactions,
    ...(due ? { due, dueAt: new Date().toISOString() } : {}),
    relaunchWanted: true,
  });
  auditConfig(
    {
      verb: "agents",
      detail: `relaunch ${rec.id} in ${rec.workspace}: its new conversation was never written; its handoff is back and it can relaunch again`,
    },
    d.stateDir(),
  );
  return true;
}

/**
 * Issue 658: every agent whose relaunch never began is made relaunchable
 * again (undoUnbegunRelaunch); the ids it did. Den's server looks with
 * its rotation tick. Never starts a session host.
 */
export async function undoUnbegunRelaunches(
  d: AgentsResolved,
): Promise<string[]> {
  let sessions: SessionInfo[];
  try {
    sessions = await hostSessions(d);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rec of listRecords(d.stateDir()))
    try {
      if (undoUnbegunRelaunch(d, rec, sessions)) out.push(rec.id);
    } catch {
      /* the next look tries again */
    }
  return out;
}

/**
 * Relaunch from handoff (den#4): once agent `id`'s session rotated (a
 * trigger fired and handoff.md passes the check), a fresh conversation
 * with the same persona, runtime, model, workspace, folder and grants,
 * whose first prompt is the handoff. A running session is stopped first.
 * The handoff moves to handoffs/ so the next rotation needs a new one.
 * Missing or failing: refused, saying so, with Start fresh and Resume.
 */
export async function relaunchAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
  /** D28: Den relaunched it by itself (on_due auto). */
  o: { auto?: boolean; fromHandoff?: FromHandoff } = {},
): Promise<Relaunched> {
  return lockAgent(d, id, async () => {
    // Issue 658: a relaunch that never began is undone first.
    undoUnbegunRelaunch(d, agentRecord(d, id, ws), await hostSessions(d));
    const rec = agentRecord(d, id, ws);
    syncCatalog(d);
    const rt = runtimeFor(rec.runtime);
    const files = agentFilesDir(d.stateDir(), rec.id);
    const rot = rotationOf(d, rec);
    const fresh = `Start fresh: ${d.cli} agents start -w ${rec.workspace} --persona ${rec.persona} --id ${rec.id}`;
    const resume = `Resume: ${d.cli} agents resume ${rec.id}`;
    const fromLast = `Relaunch from its last handoff: ${d.cli} agents relaunch ${rec.id} --from-handoff`;
    if (!rt.firstPrompt)
      throw refused(
        `${rec.runtime} can't start a conversation from a handoff`,
        [fresh],
      );
    // Issue 658: with none due, only from a handoff asked for by name.
    const manual = !rot?.due ? o.fromHandoff : undefined;
    if (!rot?.due && !manual)
      throw refused(`agent ${rec.id} has not rotated: resume it instead`, [
        resume,
        fromLast,
      ]);
    let h: { status: string; text?: string; problems: string[] };
    let source = handoffFile(files);
    if (manual?.file !== undefined) {
      source = path.resolve(manual.file);
      let text: string;
      try {
        text = fs.readFileSync(source, "utf-8");
      } catch {
        throw usage(`agents relaunch: can't read ${source}`, 404);
      }
      const c = checkHandoff(text);
      h = { status: c.ok ? "ok" : "invalid", text, problems: c.problems };
    } else if (manual) {
      const n = newestHandoff(files);
      if (n) source = n.file;
      h = n
        ? { status: "ok", text: n.text, problems: [] }
        : { status: "missing", problems: [] };
    } else h = readHandoff(files);
    if (h.status !== "ok")
      throw new AgentError(
        h.status === "missing"
          ? manual
            ? `agent ${rec.id} has no handoff on file (handoff.md or one kept from a relaunch), so it can't relaunch from one`
            : `agent ${rec.id} has no handoff.md yet, so it can't relaunch from one`
          : `agent ${rec.id}'s ${manual?.file !== undefined ? source : "handoff.md"} is not ready: ${h.problems.join(" ")}`,
        { code: "no_handoff", hints: [fresh, resume] },
      );
    // Only handoff.md moves aside; a kept one, or a person's file, stays.
    const archive = source === handoffFile(files);
    // The rotated session ends here, if it is still open.
    const s = sessionOf(await hostSessions(d), rec);
    if (s && !s.exited) {
      await notQuarantined(d, rec.runtime, rec.workspace);
      const stopped = await stopAgent(d, rec.id, ws);
      if (stopped.stillStopping)
        throw refused(`agent ${rec.id} is still stopping; try again`);
    }
    const now = new Date().toISOString();
    const reason: RelaunchReason = rot?.due ?? manual?.reason ?? "manual";
    const compactions = rot?.compactions ?? 0;
    const why = reasonText(reason, compactions);
    const entry: RotationEntry = {
      at: now,
      reason,
      compactions,
      ...(rec.resumeToken ? { conversation: rec.resumeToken } : {}),
      ...(o.auto ? { auto: true } : {}),
    };
    let kept = "";
    const before = readRotation(files);
    // The launch failed: the handoff and the rotation are as they were, for
    // the conversation the record now names, so Relaunch is offered again.
    const undo = (conversation?: string) => {
      if (kept && fs.existsSync(kept) && !fs.existsSync(handoffFile(files)))
        fs.renameSync(kept, handoffFile(files));
      if (before)
        writeRotation(files, {
          ...before,
          ...(rot?.due ? { due: rot.due } : {}),
          ...(conversation ? { conversation } : {}),
        });
    };
    // Issue 658 point 5: the folder it ran in, which its runtime knows
    // (and trusts); never moved to a repo folder by a relaunch (gap 7
    // moves only a person's Start fresh).
    const folder =
      rec.cwd &&
      !rec.outside &&
      !isServerScope(rec.workspace) &&
      fs.statSync(rec.cwd, { throwIfNoEntry: false })?.isDirectory() &&
      inProject(d, rec.workspace, rec.cwd)
        ? rec.cwd
        : undefined;
    const started = await startAgent(
      d,
      {
        workspace: rec.workspace,
        persona: rec.persona,
        runtime: rec.runtime,
        ...keptChoices(rec),
        id: rec.id,
        ...(folder ? { folder } : {}),
      },
      {
        firstPrompt: handoffPrompt(
          h.text!,
          reason,
          compactions,
          manual ? [] : (before?.leftRunning ?? []),
        ),
        rotations: [...(rec.rotations ?? []), entry],
        beforeLaunch: () => {
          kept = archive
            ? archiveHandoff(
                files,
                `${now.replace(/[:.]/g, "-")}-${rec.resumeToken ?? "conversation"}`,
              )
            : source;
        },
      },
    ).catch((e: unknown) => {
      if (archive) undo();
      throw e;
    });
    if (started.early && archive) undo(started.rec.resumeToken);
    // Issue 658: the conversation it started, so one never written is
    // known as a relaunch that never began.
    const token = started.rec.resumeToken;
    const after = readRecord(d.stateDir(), rec.id);
    const last = after?.rotations?.[after.rotations.length - 1];
    if (after && last && token && last.at === now && !started.early) {
      last.next = token;
      writeRecord(d.stateDir(), after);
      started.rec.rotations = after.rotations;
    }
    return { ...started, why, handoff: kept, reason };
  });
}

/** The host's sessions, never starting a host (none running: none). */
async function hostSessions(d: AgentsResolved): Promise<SessionInfo[]> {
  const c = await d.connectExisting();
  try {
    return c ? await c.list() : [];
  } finally {
    c?.close();
  }
}

/** An agent removed (AG-14.1b): what Undo brings back. */
export interface Removed {
  agent: string;
  workspace: string;
}

/**
 * Forget agents `ids` (AG-14.1b): each record moves aside for Undo, its
 * actor tokens are revoked and the host forgets its ended session. A
 * running agent is refused: stop it first. Never asks a host to start.
 */
async function removeRecords(
  d: AgentsResolved,
  recs: AgentRecord[],
): Promise<Removed[]> {
  const c = await d.connectExisting();
  try {
    const sessions = c ? await c.list() : [];
    for (const rec of recs) {
      const s = sessionOf(sessions, rec);
      if (!isStoppedState(rowState(rec, s)))
        throw refused(`agent ${rec.id} is running: stop it first`, [
          `${d.cli} agents stop ${rec.id}`,
        ]);
    }
    const out: Removed[] = [];
    for (const rec of recs) {
      const s = sessionOf(sessions, rec);
      revokeAgentTokens(d.stateDir(), rec.id);
      if (c && s?.exited) await c.forget(s.ref.id).catch(() => undefined);
      removeSessionTmp(rec.sessionTmp, d.sessionTmpBase); // issue 1325
      d.forgetSandbox(rec.id); // issue 1328: its sandbox setting goes too
      const moved = removeRecord(d.stateDir(), rec.id);
      await d
        .hubAgentUnbind(rec.id)
        .catch((e) => noteHubUnbindFailed(d.stateDir(), rec.id, e));
      if (moved) out.push({ agent: rec.id, workspace: rec.workspace });
    }
    purgeRemoved(d.stateDir());
    return out;
  } finally {
    c?.close();
  }
}

export async function removeAgent(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<Removed[]> {
  return removeRecords(d, [agentRecord(d, id, ws)]);
}

/**
 * Remove every stopped, interrupted or exited agent of `workspaces`
 * (AG-14.1b Clear stopped); running ones stay.
 */
export async function removeStopped(
  d: AgentsResolved,
  workspaces: readonly string[],
): Promise<Removed[]> {
  const sessions = await hostSessions(d);
  const recs = listRecords(d.stateDir()).filter(
    (r) =>
      workspaces.includes(r.workspace) &&
      isStoppedState(rowState(r, sessionOf(sessions, r))),
  );
  return removeRecords(d, recs);
}

/** Undo: bring removed agents back; the ones that came back. */
export function restoreAgents(
  d: AgentsResolved,
  ids: readonly string[],
): string[] {
  return ids.filter((id) => restoreRecord(d.stateDir(), id));
}

/**
 * Forget stopped and exited agents older than `days` (AG-14.1b,
 * agents.remove_stopped_after in user.yml; 0: never). Interrupted ones
 * are never forgotten. Returns the ids forgotten.
 */
export async function pruneStopped(
  d: AgentsResolved,
  days: number,
  now = Date.now(),
): Promise<string[]> {
  if (!(days > 0)) return [];
  const sessions = await hostSessions(d);
  const cutoff = now - days * 86_400_000;
  const old = listRecords(d.stateDir()).filter((r) => {
    const st = rowState(r, sessionOf(sessions, r));
    if (st === "interrupted" || !isStoppedState(st)) return false;
    const at = Date.parse(r.stoppedAt ?? r.endedAt ?? r.startedAt);
    return Number.isFinite(at) && at < cutoff;
  });
  for (const r of old) {
    revokeAgentTokens(d.stateDir(), r.id);
    removeSessionTmp(r.sessionTmp, d.sessionTmpBase); // issue 1325
    d.forgetSandbox(r.id); // issue 1328
    removeRecord(d.stateDir(), r.id);
    await d
      .hubAgentUnbind(r.id)
      .catch((e) => noteHubUnbindFailed(d.stateDir(), r.id, e));
  }
  purgeRemoved(d.stateDir(), 0, now);
  return old.map((r) => r.id);
}

/** What a restart found (AG-14.3). */
export interface RestartFound {
  /** Agents newly marked interrupted. */
  interrupted: string[];
  /** Of those, the ones resumed on their own (standing, resume_on_restart). */
  resumed: string[];
  /** Ones that should have resumed but couldn't, with why. */
  failed: { agent: string; why: string }[];
  /** 0.4.46: resumed though Hub didn't answer in time (no Hub tools). */
  withoutHub: string[];
  /**
   * Issue 163: agents whose session is still running: they kept running
   * through whatever stopped the web server (its host outlived it).
   */
  kept: string[];
}

/** Poll `ok` until it says yes or `ms` pass; whether it said yes. */
async function waitUntil(
  ok: () => Promise<boolean>,
  ms: number,
  pollMs = 5000,
): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await ok().catch(() => false)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) =>
      setTimeout(r, Math.min(pollMs, Math.max(0, until - Date.now()))),
    );
  }
}

/**
 * When the web server starts (AG-14.3): every agent whose session is gone
 * though nobody stopped it and it never exited is marked interrupted. A
 * session host that survived a web-server-only restart still lists its
 * sessions, so nothing is marked. Then the standing personas, and those
 * with `resume_on_restart: true`, resume (when their runtime can); the
 * rest wait for someone to click Resume.
 */
export async function markInterrupted(
  d: AgentsResolved,
  opts: {
    autoResume?: boolean;
    /**
     * 0.4.46 agents.restore_on_boot: every agent that was running resumes,
     * not only standing personas and resume_on_restart (an agent's own
     * resume_on_restart: false still waits).
     */
    restoreAll?: boolean;
    /** Whether Hub answers; waited for first, so agents get its tools. */
    hubUp?: () => Promise<boolean>;
    /** agents.restore_hub_wait_seconds, in ms. */
    hubWaitMs?: number;
    hubPollMs?: number;
    /**
     * Issue 1129: the restart queue they go through (agents.resume): a
     * batch at a time, the ones that were working first. None: all at
     * once, as before.
     */
    queue?: RestartQueue;
  } = {},
): Promise<RestartFound> {
  const sessions = await hostSessions(d);
  const found: RestartFound = {
    interrupted: [],
    resumed: [],
    failed: [],
    withoutHub: [],
    kept: [],
  };
  const now = new Date().toISOString();
  const marked: AgentRecord[] = [];
  for (const rec of listRecords(d.stateDir())) {
    const st = rowState(rec, sessionOf(sessions, rec));
    if (st === "running") found.kept.push(rec.id);
    if (rec.interruptedAt) continue;
    if (st !== "interrupted") continue;
    const next = { ...rec, interruptedAt: now };
    writeRecord(d.stateDir(), next);
    marked.push(next);
    found.interrupted.push(rec.id);
  }
  if (opts.autoResume === false || !marked.length) return found;
  const find = personaLookup(d);
  const due = marked.filter((rec) => {
    const p = find(rec);
    const wants = opts.restoreAll
      ? rec.resumeOnRestart !== false
      : !!p && resumesOnRestart(rec, p);
    return wants && !resumeRefusal(rec);
  });
  if (!due.length) return found;
  const hubAnswered = opts.hubUp
    ? await waitUntil(opts.hubUp, opts.hubWaitMs ?? 120_000, opts.hubPollMs)
    : true;
  // den#4: a rotated one relaunches from its handoff instead.
  const bring = (rec: AgentRecord) =>
    rotationOf(d, rec)?.ready
      ? relaunchAgent(d, rec.id)
      : resumeAgent(d, rec.id);
  const note = (rec: AgentRecord, r: { early?: unknown }) => {
    if (r.early) found.failed.push({ agent: rec.id, why: "exited at once" });
    else {
      found.resumed.push(rec.id);
      if (!hubAnswered) found.withoutHub.push(rec.id);
    }
  };
  const failed = (rec: AgentRecord, e: unknown) =>
    found.failed.push({ agent: rec.id, why: (e as Error).message });
  if (opts.queue) {
    // Issue 1129: a batch at a time; the ones working when Den stopped first.
    const activity = readActivity(d.stateDir());
    const q = opts.queue;
    await Promise.all(
      due.map((rec) =>
        q
          .add({
            id: rec.id,
            why: "resume",
            working: activity[rec.id]?.working === true,
            run: () => bring(rec),
          })
          .then(
            (r) => note(rec, r as { early?: unknown }),
            (e) => failed(rec, e),
          ),
      ),
    );
    return found;
  }
  for (const rec of due) {
    try {
      note(rec, await bring(rec));
    } catch (e) {
      failed(rec, e);
    }
  }
  return found;
}

/** Issue 563: the agents whose session runs now (ids). */
export async function runningAgentIds(d: AgentsResolved): Promise<string[]> {
  const sessions = await hostSessions(d);
  // Issue 631: by the session it runs in, its record's or its name's.
  return listRecords(d.stateDir())
    .filter((rec) => rowState(rec, liveSessionOf(sessions, rec)) === "running")
    .map((rec) => rec.id);
}

/**
 * Issue 631: the agents `sessions` (a host's, at its stop) belong to: a
 * live session that is a record's, or carries its session name.
 */
export function agentsOfSessions(
  d: AgentsResolved,
  sessions: readonly SessionInfo[],
): string[] {
  const live = sessions.filter((s) => !s.exited);
  return listRecords(d.stateDir())
    .filter((rec) =>
      live.some(
        (s) => s.ref.id === rec.session.id || s.name === rec.sessionName,
      ),
    )
    .map((rec) => rec.id);
}

/**
 * Issue 631: of `ids` (resumed after a terminal host restart), the agents
 * whose session ended since, each with why: its state ("exited (1)") and
 * its last printed line (secret-shaped values redacted).
 */
export async function endedAfterHostRestart(
  d: AgentsResolved,
  ids: readonly string[],
): Promise<{ agent: string; why: string }[]> {
  const c = await d.connectExisting();
  if (!c) return [];
  try {
    const sessions = await c.list();
    const out: { agent: string; why: string }[] = [];
    for (const id of ids) {
      const rec = readRecord(d.stateDir(), id);
      if (!rec) continue;
      const s = sessionOf(sessions, rec);
      const st = rowState(rec, s);
      // Running, or stopped by someone since: not a resume that failed.
      if (!isStoppedState(st) || st === "stopped") continue;
      let last = "";
      if (s)
        try {
          const lines = plainLines(
            (await c.scrollback(s.ref.id, 16 * 1024)).toString("utf-8"),
          );
          last = lines.length ? redactSecrets(lines[lines.length - 1]) : "";
        } catch {
          /* its output is gone: its state says enough */
        }
      out.push({
        agent: id,
        why: `${st} after its resume${last ? `: ${last}` : ""}`,
      });
    }
    return out;
  } finally {
    c.close();
  }
}

/**
 * Issue 631: agent `id` didn't come back after the terminal host
 * restarted. Marked (Resume brings it back; Den's own restore after the
 * restart doesn't try it again unasked) and a "needs you" item in the
 * bell says why, as for a restart Den made (issue 124).
 */
export function noteNotBackAfterHostRestart(
  d: AgentsResolved,
  id: string,
  why: string,
): void {
  const rec = readRecord(d.stateDir(), id);
  if (!rec) return;
  const now = new Date().toISOString();
  const said = `the terminal host restarted; ${why}`;
  writeRecord(d.stateDir(), {
    ...rec,
    restartFailed: { at: now, why: said },
    interruptedAt: rec.interruptedAt ?? now,
  });
  const name = rec.displayName || rec.persona || id;
  try {
    new NotificationStore(d.stateDir()).add({
      kind: "waiting",
      subject: `agent:${id}`,
      scope: `workspace/${rec.workspace}`,
      text: `${name} didn't come back after a restart: ${said}`,
      msg: { key: "bell.m.restartFailed", vars: { name, why: said } },
      link: `/agents?ws=${encodeURIComponent(rec.workspace)}`,
    });
  } catch {
    /* best effort: the audit row and the row's state still say so */
  }
}

/**
 * Issue 563: of `ids`, the agents mid-turn now (in doubt: mid-turn), for
 * the terminal host's restart wait (issue 597). Issue 732: an agent with
 * a background job it started still running counts too: the host's
 * restart ends the job with its session, a real loss, so the wait holds
 * for it as "after its turn" does.
 */
export async function busyAgentIds(
  d: AgentsResolved,
  ids: readonly string[],
): Promise<string[]> {
  return (await busyAgentHolds(d, ids)).map((h) => h.agent);
}

/**
 * Issue 732: busyAgentIds with why each one holds the wait: mid-turn (no
 * `job`), or its turn ended and a background job it started still runs
 * (`job`, with its minutes), for doctor's honest words.
 */
export async function busyAgentHolds(
  d: AgentsResolved,
  ids: readonly string[],
): Promise<{ agent: string; job?: { minutes: number } }[]> {
  const out: { agent: string; job?: { minutes: number } }[] = [];
  for (const id of ids) {
    const rec = readRecord(d.stateDir(), id);
    if (!rec) continue;
    const st = await inputState(d, rec, new Set(), 3000, {
      promptCheck: false,
    });
    if (st === "busy") {
      out.push({ agent: id });
      continue;
    }
    if (st !== "idle") continue;
    const job = await agentJob(d, rec).catch(() => null);
    if (job) out.push({ agent: id, job: { minutes: job.minutes } });
  }
  return out;
}

/**
 * Issue 563: resume agent `id` after its terminal host restarted (a
 * rotated one relaunches from its handoff, as after a restart).
 * Issue 597: `note` (an agent the restart cut mid-turn) is typed in as its
 * next input once it is ready, the way a first instruction is; a relaunch
 * has its handoff as its first prompt instead. Not waited for.
 */
export async function resumeAfterHostRestart(
  d: AgentsResolved,
  id: string,
  note: string | null = null,
  send: typeof sendFirstInstruction = sendFirstInstruction,
): Promise<void> {
  const rec = readRecord(d.stateDir(), id);
  if (!rec) throw new Error(`no agent "${id}"`);
  const rotated = Boolean(rotationOf(d, rec)?.ready);
  const r = rotated
    ? await relaunchAgent(d, rec.id)
    : await resumeAgent(d, rec.id);
  // Issue 631: with its code and last line, for the row and the bell.
  if (r.early) {
    const code =
      r.early.exitCode === undefined ? "" : ` (exit ${r.early.exitCode})`;
    const last = r.early.tail[r.early.tail.length - 1];
    throw new Error(`exited at once${code}${last ? `: ${last}` : ""}`);
  }
  if (note && !rotated)
    void send(d, r.info.ref.id, r.rec.runtime, note).catch(() => false);
}

/**
 * Resume every interrupted agent of `workspaces` that can resume
 * (AG-14.3 "Resume all", `agents resume --all-interrupted`).
 */
export async function resumeInterrupted(
  d: AgentsResolved,
  workspaces?: readonly string[],
): Promise<{
  resumed: Resumed[];
  failed: { agent: string; why: string }[];
}> {
  const sessions = await hostSessions(d);
  const recs = listRecords(d.stateDir()).filter(
    (r) =>
      (!workspaces || workspaces.includes(r.workspace)) &&
      rowState(r, sessionOf(sessions, r)) === "interrupted",
  );
  const resumed: Resumed[] = [];
  const failed: { agent: string; why: string }[] = [];
  for (const rec of recs) {
    const rot = rotationOf(d, rec);
    const why =
      resumeRefusal(rec) ?? (rot?.ready ? rotatedRefusal(rec, rot) : null);
    if (why) {
      failed.push({ agent: rec.id, why });
      continue;
    }
    try {
      const r = await resumeAgent(d, rec.id);
      if (r.early) failed.push({ agent: rec.id, why: "exited at once" });
      else resumed.push(r);
    } catch (e) {
      failed.push({ agent: rec.id, why: (e as Error).message });
    }
  }
  return { resumed, failed };
}

// ── AG-10.1: the first instruction, a plain session ─────────────────────────

/** The longest first instruction. */
export const MAX_INSTRUCTION = 8000;

/**
 * A first instruction, checked: text of up to MAX_INSTRUCTION characters,
 * newlines and tabs allowed, no other control character (no escape
 * sequence can ride along) and no bidi override. Blank is none (null).
 */
export function checkInstruction(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw usage("instruction must be a string");
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (!t) return null;
  if (t.length > MAX_INSTRUCTION)
    throw usage(`instruction must be at most ${MAX_INSTRUCTION} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(t))
    throw usage("instruction can't have control characters");
  return t;
}

/** How long the session must print nothing before it counts as ready. */
export const READY_QUIET_MS = 800;
/** The longest a first instruction waits for the session to be ready. */
export const READY_MAX_MS = 30_000;
const READY_POLL_MS = 150;
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";

/**
 * The bytes a first instruction is typed as: a bracketed paste when the
 * program turned bracketed paste on (its output has ESC[?2004h, last), so
 * newlines stay newlines; else each newline as the runtime's soft newline
 * (catalog softNewline). Then Enter, separately.
 */
export function instructionBytes(
  text: string,
  said: string,
  softNewline: string,
): { body: string; enter: string } {
  const paste = said.lastIndexOf(PASTE_ON) > said.lastIndexOf(PASTE_OFF);
  return {
    body: paste
      ? `\x1b[200~${text}\x1b[201~`
      : text.split("\n").join(softNewline),
    enter: "\r",
  };
}

/**
 * Whether `screen` ends with a dialog of `runtime`'s that only its person
 * answers: a permission dialog, or its folder-trust question. Den never
 * types into one: Enter would pick its first choice.
 */
export function personDialogOnScreen(runtime: string, screen: string): boolean {
  const rt = getRuntime(runtime);
  return (
    promptOnScreen(screen, rt?.permissionPrompt) ||
    promptOnScreen(screen, rt?.trustPrompt)
  );
}

/**
 * Issue 664: the one screen check every path that types into an agent
 * uses (typingCheck): "ok" only when `runtime`'s input prompt ends the
 * screen and no dialog shows on it.
 */
export function agentScreenCheck(runtime: string, screen: string): TypingCheck {
  return typingCheck(screen, getRuntime(runtime));
}

/**
 * Issue 664: agents whose last look found them not at their input prompt
 * (with no dialog and an idle turn): their held text says why.
 */
const notAtPrompt = new Set<string>();

/** Issue 664: whether agent `id`'s text waits because it isn't at its prompt. */
export function heldNotAtPrompt(id: string): boolean {
  return notAtPrompt.has(id);
}

/**
 * Issue 1311: agents whose last look found their person's unsent draft on
 * the input line: what Den would type waits for it.
 */
const draftHeld = new Set<string>();

/** Issue 1311: whether agent `id`'s text waits for its person's draft. */
export function heldForDraft(id: string): boolean {
  return draftHeld.has(id);
}

/**
 * Issue 1311: how many texts Den holds for agent `id` while its person's
 * draft is on the line (typeIntoAgent's queue; Hub's own queue counts
 * apart). 0 when no draft holds it.
 */
export function draftWaiting(id: string): number {
  return draftHeld.has(id) ? (typingQueued.get(id) ?? 0) : 0;
}

/**
 * Send an agent its first instruction once it is ready (AG-10.1): it has
 * printed something and then nothing for READY_QUIET_MS (a TUI drawn and
 * waiting), or READY_MAX_MS passed. Typed into its session over the host's
 * write path (the same as a keystroke from the pane), never as an argument
 * or through a shell. False when the session ended first or there is no
 * host, or its screen shows a dialog for its person (never typed into;
 * `onDialog` says so), or (issue 664) it isn't at its input prompt by
 * READY_MAX_MS (`onNotAtPrompt` says so): agentScreenCheck.
 * Never throws.
 */
export async function sendFirstInstruction(
  d: AgentsResolved,
  sessionId: string,
  runtime: string,
  text: string,
  o: {
    quietMs?: number;
    maxMs?: number;
    /** Called when a dialog for its person held the text back. */
    onDialog?: () => void;
    /** Issue 664: called when it wasn't at its input prompt (text held). */
    onNotAtPrompt?: () => void;
    /**
     * Issue 1311: asked just before the text is typed; true (its person
     * has an unsent draft on the line) holds it: nothing typed, false.
     */
    held?: () => boolean;
  } = {},
): Promise<boolean> {
  const quiet = o.quietMs ?? READY_QUIET_MS;
  const max = o.maxMs ?? READY_MAX_MS;
  let c: HostClient | null = null;
  try {
    c = await d.connectExisting();
    if (!c) return false;
    const deadline = Date.now() + max;
    let last = "";
    let changedAt = Date.now();
    let said = "";
    let check: TypingCheck = "not_at_prompt";
    for (;;) {
      const s = (await c.list()).find((x) => x.ref.id === sessionId);
      if (!s || s.exited) return false;
      said = (await c.scrollback(sessionId, 256 * 1024)).toString("utf-8");
      if (said !== last) {
        last = said;
        changedAt = Date.now();
      } else if (said && Date.now() - changedAt >= quiet) {
        // Quiet: ready once its input prompt shows (issue 664).
        check = agentScreenCheck(runtime, said);
        if (check !== "not_at_prompt") break;
      }
      if (Date.now() >= deadline) {
        check = agentScreenCheck(runtime, said);
        break;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    // A dialog waiting for its person: nothing typed. Its answer is
    // theirs, and Enter would pick its first choice.
    if (check === "dialog") {
      o.onDialog?.();
      return false;
    }
    // Issue 664: typed only when its input prompt shows; any doubt holds.
    if (check !== "ok") {
      o.onNotAtPrompt?.();
      return false;
    }
    // Issue 1311: never into a prompt that holds its person's draft.
    if (o.held?.()) return false;
    const soft = softNewlineSeq(getRuntime(runtime)?.catalog);
    const b = instructionBytes(text, said, soft);
    c.write(sessionId, Buffer.from(b.body, "utf-8"));
    await new Promise((r) => setTimeout(r, 120));
    c.write(sessionId, Buffer.from(b.enter, "utf-8"));
    // Let the host take the bytes before the connection closes.
    await c.list();
    return true;
  } catch {
    return false;
  } finally {
    c?.close();
  }
}

/**
 * 0.4.40 comment delivery: whether agent `id` can take a Hub comment now.
 * missing: no such agent here (or the server agent, which Hub never
 * addresses); stopped: not running; busy: mid-turn (its turn alone: a
 * background job it left running doesn't count, issue 732), waiting on an approval,
 * or Den can't tell; idle: waiting for its person. Never throws.
 */
export async function agentInputState(
  d: AgentsResolved,
  id: string,
  waiting: ReadonlySet<string> = new Set(),
  quietMs = 3000,
): Promise<"missing" | "stopped" | "busy" | "idle"> {
  const rec = readRecord(d.stateDir(), id);
  if (!rec || isServerScope(rec.workspace)) return "missing";
  return inputState(d, rec, waiting, quietMs);
}

/**
 * Issue 701: the dialog for its person agent `id`'s screen ends with:
 * "trust" (its folder-trust question), "permission", or null (none, no
 * live session, or Den can't read it). Never throws.
 */
export async function agentDialogKind(
  d: AgentsResolved,
  id: string,
): Promise<"trust" | "permission" | null> {
  const rec = readRecord(d.stateDir(), id);
  if (!rec || rec.stoppedAt) return null;
  try {
    const c = await d.connectExisting();
    if (!c) return null;
    try {
      const s = sessionOf(await c.list(), rec);
      if (!s || s.exited) return null;
      const out = (await c.scrollback(s.ref.id, 16 * 1024)).toString("utf-8");
      const rt = getRuntime(rec.runtime);
      if (promptOnScreen(out, rt?.trustPrompt)) return "trust";
      if (promptOnScreen(out, rt?.permissionPrompt)) return "permission";
      return null;
    } finally {
      c.close();
    }
  } catch {
    return null;
  }
}

/**
 * Issue 954: whether agent `id`'s screen ends with something it waits on
 * its person for that isn't its input prompt: a list to pick from, a
 * question, a dialog (agentScreenCheck's "dialog"). False with no live
 * session or when Den can't read it. Never throws.
 */
export async function agentScreenShowsDialog(
  d: AgentsResolved,
  id: string,
): Promise<boolean> {
  const rec = readRecord(d.stateDir(), id);
  if (!rec || rec.stoppedAt) return false;
  try {
    const c = await d.connectExisting();
    if (!c) return false;
    try {
      const s = sessionOf(await c.list(), rec);
      if (!s || s.exited) return false;
      const out = (await c.scrollback(s.ref.id, 64 * 1024)).toString("utf-8");
      return agentScreenCheck(rec.runtime, out) === "dialog";
    } finally {
      c.close();
    }
  } catch {
    return false;
  }
}

/**
 * SRV-1a: the server agent's input state, for Den's own "Server is back"
 * line. (agentInputState skips it: Hub's comments never reach it.)
 */
export async function serverAgentInputState(
  d: AgentsResolved,
  quietMs = 3000,
): Promise<"missing" | "stopped" | "busy" | "idle"> {
  const rec = readRecord(d.stateDir(), SERVER_AGENT_ID);
  if (!rec || !isServerScope(rec.workspace)) return "missing";
  return inputState(d, rec, new Set(), quietMs);
}

/**
 * Whether the server agent's screen ends with a dialog for its person (a
 * permission dialog, its trust question). False when it has no live
 * session; true when Den can't read it (never typed into on a doubt).
 */
export async function serverAgentDialogOpen(
  d: AgentsResolved,
): Promise<boolean> {
  const rec = readRecord(d.stateDir(), SERVER_AGENT_ID);
  if (!rec) return false;
  try {
    const c = await d.connectExisting();
    if (!c) return false;
    try {
      const s = sessionOf(await c.list(), rec);
      if (!s || s.exited) return false;
      const out = (await c.scrollback(s.ref.id, 16 * 1024)).toString("utf-8");
      return personDialogOnScreen(rec.runtime, out);
    } finally {
      c.close();
    }
  } catch {
    return true;
  }
}

async function inputState(
  d: AgentsResolved,
  rec: AgentRecord,
  waiting: ReadonlySet<string>,
  quietMs: number,
  /** promptCheck false: idle by its turn alone (the restart waits). */
  o: { promptCheck?: boolean } = {},
): Promise<"missing" | "stopped" | "busy" | "idle"> {
  const id = rec.id;
  try {
    if (rec.stoppedAt) return "stopped";
    // Never starts a session host: none running means it isn't either.
    const c = await d.connectExisting();
    if (!c) return "stopped";
    let live = false;
    let screen: TypingCheck = "not_at_prompt";
    let out = "";
    let sid = rec.session.id;
    let readAt = 0;
    try {
      const s = sessionOf(await c.list(), rec);
      live = Boolean(s && !s.exited);
      if (s) sid = s.ref.id;
      // A dialog waiting for the person: not at its prompt, whatever its
      // transcript or quiet output says.
      if (live && s) {
        readAt = Date.now();
        out = (await c.scrollback(s.ref.id, 64 * 1024)).toString("utf-8");
        screen = agentScreenCheck(rec.runtime, out);
      }
    } finally {
      c.close();
    }
    if (o.promptCheck !== false) notAtPrompt.delete(id);
    if (!live) {
      // Issue 1311: a draft dies with its session.
      clearDraft(sid);
      draftHeld.delete(id);
      return "stopped";
    }
    // Issue 1311: its person's unsent draft on the line holds what Den
    // types, until it is sent or cleared (an empty input line on screen
    // clears it too). Not for the restart waits (promptCheck false).
    if (o.promptCheck !== false) {
      // An empty line read before the draft (or its echo) can't clear it.
      if (draftPending(sid) && inputLineEmpty(out, getRuntime(rec.runtime)))
        clearDraftSeenEmpty(sid, readAt);
      if (draftPending(sid)) {
        draftHeld.add(id);
        return "busy";
      }
      draftHeld.delete(id);
    }
    if (screen === "dialog") return "busy";
    if (waiting.has(id)) return "busy";
    // Issue 732: its turn alone. A background shell it left running (a
    // watcher, a gate) never holds what Den types: it takes input while
    // one runs. The restart waits count jobs (agentBusy, busyAgentIds).
    const busy = await agentTurnBusy(d, rec);
    if (busy === true) return "busy";
    // A runtime that can't say: quiet output for quietMs is waiting (a
    // working TUI redraws its spinner; a waiting one is still).
    if (busy === null && !(await outputQuiet(d, rec.session.id, quietMs)))
      return "busy";
    // Issue 664: its turn is over, but idle only at its input prompt.
    // Anything else holds what Den would type; the bell and its row say
    // why. (Not for the restart waits: busyAgentIds asks for "busy".)
    if (screen !== "ok" && o.promptCheck !== false) {
      notAtPrompt.add(id);
      return "busy";
    }
    return "idle";
  } catch {
    return "busy";
  }
}

/** Whether session `sessionId` printed nothing for `ms`. False on any doubt. */
async function outputQuiet(
  d: AgentsResolved,
  sessionId: string,
  ms: number,
): Promise<boolean> {
  const c = await d.connectExisting();
  if (!c) return false;
  try {
    const a = (await c.scrollback(sessionId, 64 * 1024)).toString("utf-8");
    await new Promise((r) => setTimeout(r, ms));
    const b = (await c.scrollback(sessionId, 64 * 1024)).toString("utf-8");
    return a.length > 0 && a === b;
  } catch {
    return false;
  } finally {
    c.close();
  }
}

// ── Issue 659: the folder-trust question, in plain words ──────────────────

/** What the row, its pane and the bell say while the question waits. */
export const TRUST_WAITING = "Waiting: trust this folder?";
/** What they say after it was declined and the agent ended. */
export const TRUST_DECLINED =
  "Didn't start: this folder isn't trusted. Resume and choose Yes.";

export interface TrustEvent {
  kind: "waiting" | "answered" | "declined";
  agent: string;
  workspace: string;
}

/** Sessions looked at once after they ended (a No between two looks). */
const trustLooked = new Set<string>();

/**
 * Issue 659: one look at every agent's folder-trust question (its
 * runtime's `trustPrompt`). On its screen now: the record notes it (its
 * row and pane say TRUST_WAITING) and the bell has a "needs you" item.
 * Gone while it runs: answered Yes; the wait and its item go. Ended
 * while asked (or ended with the question in its last output and no
 * conversation written): declined; the record, its row and the bell say
 * TRUST_DECLINED until its next start. Den never answers it: the answer
 * is its person's. The server agent has its own Trust step (SRV-1b).
 * Never starts a session host; never throws.
 */
export async function trustTick(d: AgentsResolved): Promise<TrustEvent[]> {
  const out: TrustEvent[] = [];
  let c: HostClient | null = null;
  try {
    c = await d.connectExisting();
    if (!c) return out;
    const sessions = await c.list();
    const store = () => new NotificationStore(d.stateDir());
    // Read again just before each write: another request may have
    // changed the record since the list was read.
    const patch = (id: string, f: (r: AgentRecord) => AgentRecord): void => {
      const cur = readRecord(d.stateDir(), id);
      if (cur) writeRecord(d.stateDir(), f(cur));
    };
    const unask = (r: AgentRecord): AgentRecord => {
      const { trustAsked: _a, ...rest } = r;
      return rest;
    };
    const subjectOf = (id: string) => `agent:${id}`;
    const dropItem = (id: string, key: string) => {
      try {
        store().remove(
          (n) => n.subject === subjectOf(id) && n.msg?.key === key && !n.read,
        );
      } catch {
        /* the bell is best effort */
      }
    };
    for (const rec of listRecords(d.stateDir())) {
      if (isServerScope(rec.workspace)) continue;
      const rt = getRuntime(rec.runtime);
      const tp = rt?.trustPrompt;
      if (!tp) continue;
      const s = sessionOf(sessions, rec);
      const name = rec.displayName || rec.persona || rec.id;
      const who = { agent: rec.id, workspace: rec.workspace };
      const link = `/agents?project=${encodeURIComponent(rec.workspace)}&agent=${encodeURIComponent(rec.id)}`;
      try {
        if (s && !s.exited) {
          // Only before its conversation exists, or while it was asked.
          const written =
            rt.conversationExists && rec.resumeToken
              ? rt.conversationExists(rec.resumeToken, d.env)
              : false;
          if (written && !rec.trustAsked) continue;
          const screen = (await c.scrollback(s.ref.id, 16 * 1024)).toString(
            "utf-8",
          );
          const on = trustPromptIn(screen, tp);
          if (on && !rec.trustAsked) {
            patch(rec.id, (r) => ({
              ...r,
              trustAsked: new Date().toISOString(),
            }));
            try {
              store().add({
                kind: "waiting",
                subject: subjectOf(rec.id),
                scope: `workspace/${rec.workspace}`,
                text: `${name}: ${TRUST_WAITING}`,
                msg: { key: "bell.m.trust", vars: { name } },
                link,
              });
            } catch {
              /* the bell is best effort: the row says it */
            }
            out.push({ kind: "waiting", ...who });
          } else if (!on && rec.trustAsked) {
            patch(rec.id, unask);
            dropItem(rec.id, "bell.m.trust");
            out.push({ kind: "answered", ...who });
          }
          continue;
        }
        // Ended. Asked when it ended, or (a No between two looks) the
        // question in its last output and nothing written: declined.
        if (rec.trustDeclined || rec.stoppedAt) {
          if (rec.trustAsked) {
            patch(rec.id, unask);
            dropItem(rec.id, "bell.m.trust");
          }
          continue;
        }
        let declined = Boolean(rec.trustAsked);
        if (!declined && s && !trustLooked.has(s.ref.id)) {
          trustLooked.add(s.ref.id);
          const written =
            rt.conversationExists && rec.resumeToken
              ? rt.conversationExists(rec.resumeToken, d.env)
              : true;
          if (!written && s.exitCode !== 0) {
            const said = plainTerminalText(
              (await c.scrollback(s.ref.id, 64 * 1024)).toString("utf-8"),
            );
            declined = new RegExp(tp.match.source, tp.match.flags).test(said);
          }
        }
        if (!declined) continue;
        patch(rec.id, (r) => ({
          ...unask(r),
          trustDeclined: new Date().toISOString(),
        }));
        dropItem(rec.id, "bell.m.trust");
        try {
          store().add({
            kind: "waiting",
            subject: subjectOf(rec.id),
            scope: `workspace/${rec.workspace}`,
            text: `${name}: ${TRUST_DECLINED}`,
            msg: { key: "bell.m.trustDeclined", vars: { name } },
            link,
          });
        } catch {
          /* the bell is best effort: the row says it */
        }
        out.push({ kind: "declined", ...who });
      } catch {
        /* the next look tries again */
      }
    }
  } catch {
    /* no host, or it went away: the next look */
  } finally {
    c?.close();
  }
  return out;
}

/**
 * SRV-1b: the server agent's runtime asks whether to trust its folder
 * (the end of its output is that prompt): the folder, or null.
 */
export async function serverAgentTrustPrompt(
  d: AgentsResolved,
): Promise<{ folder: string; sessionId: string; accept: string } | null> {
  const rec = readRecord(d.stateDir(), SERVER_AGENT_ID);
  if (!rec || !isServerScope(rec.workspace) || rec.stoppedAt) return null;
  const tp = getRuntime(rec.runtime)?.trustPrompt;
  if (!tp) return null;
  const c = await d.connectExisting();
  if (!c) return null;
  try {
    const s = sessionOf(await c.list(), rec);
    if (!s || s.exited) return null;
    const out = (await c.scrollback(s.ref.id, 16 * 1024)).toString("utf-8");
    return trustPromptIn(out, tp)
      ? { folder: rec.cwd, sessionId: s.ref.id, accept: tp.accept }
      : null;
  } catch {
    return null;
  } finally {
    c.close();
  }
}

/**
 * SRV-1b: the person's Trust. Den looks again first, and types the
 * runtime's accept key only while its prompt is still there. False: no
 * prompt (answered already, or gone).
 */
export async function answerServerAgentTrust(
  d: AgentsResolved,
): Promise<boolean> {
  const p = await serverAgentTrustPrompt(d);
  if (!p) return false;
  const rec = readRecord(d.stateDir(), SERVER_AGENT_ID);
  const tp = rec ? getRuntime(rec.runtime)?.trustPrompt : undefined;
  if (!tp) return false;
  const c = await d.connectExisting();
  if (!c) return false;
  const screen = async () =>
    (await c.scrollback(p.sessionId, 16 * 1024)).toString("utf-8");
  const settleMs = () => new Promise((r) => setTimeout(r, TRUST_KEY_WAIT_MS));
  try {
    // Issues 658, 659: Yes is chosen explicitly. While another choice is
    // highlighted ("No, exit", Claude Code 2.1.329's first), Den moves
    // down and looks again; Enter only once Yes is highlighted. Never a
    // bare Enter that could decline.
    for (let i = 0; i < TRUST_MAX_MOVES; i++) {
      const key = trustAnswerKey(await screen(), tp);
      if (key === null) return false;
      if (key === "down") {
        c.write(p.sessionId, Buffer.from(tp.down!, "utf-8"));
        await settleMs();
        continue;
      }
      c.write(p.sessionId, Buffer.from(tp.accept, "utf-8"));
      await settleMs();
      // Answered: the question went away.
      return !trustPromptIn(await screen(), tp);
    }
    return false;
  } catch {
    return false;
  } finally {
    c.close();
  }
}

/** How long Den waits for the screen after each key of its trust answer. */
const TRUST_KEY_WAIT_MS = 250;
/** How many Down presses Den's trust answer tries before it gives up. */
const TRUST_MAX_MOVES = 4;

/**
 * 0.4.40: type a Hub comment into agent `id`'s session, once its output is
 * quiet (as a first instruction is, AG-10.1). False when it isn't running,
 * or its screen ends with a dialog for its person (never typed into).
 */
export function typeIntoAgent(
  d: AgentsResolved,
  id: string,
  text: string,
  opts?: { onDraft?: "wait" | "refuse" },
): Promise<boolean>;
/**
 * Issue 629: with `ready`, it is asked once this text's turn in the queue
 * comes (what was typed just ahead may have started a turn); "not-ready"
 * when it says no, and nothing is typed.
 *
 * Issue 1311: while its person has an unsent draft on the input line,
 * nothing is typed. `onDraft` "wait" (the default): it waits, in order,
 * until the draft is sent or cleared (the agent stopping ends the wait:
 * false). "refuse": false at once, for a caller that keeps its own queue.
 */
export function typeIntoAgent(
  d: AgentsResolved,
  id: string,
  text: string,
  opts: { ready: () => Promise<boolean>; onDraft?: "wait" | "refuse" },
): Promise<boolean | "not-ready">;
export async function typeIntoAgent(
  d: AgentsResolved,
  id: string,
  text: string,
  opts?: { ready?: () => Promise<boolean>; onDraft?: "wait" | "refuse" },
): Promise<boolean | "not-ready"> {
  // Everything Den types into one agent (Hub comments, the tools note)
  // goes one at a time: two texts at once would land mixed in the pane.
  const before = typing.get(id) ?? Promise.resolve();
  typingQueued.set(id, (typingQueued.get(id) ?? 0) + 1);
  const mine = before.then(async (): Promise<boolean | "not-ready"> => {
    for (;;) {
      if (opts?.ready && !(await opts.ready())) return "not-ready";
      const rec = readRecord(d.stateDir(), id);
      if (!rec) return false;
      const sid = rec.session.id;
      if (draftPending(sid)) {
        draftHeld.add(id);
        if (opts?.onDraft === "refuse") return false;
        if (!(await draftCleared(d, rec))) return false;
        continue;
      }
      let heldByDraft = false;
      const sent = await sendFirstInstruction(d, sid, rec.runtime, text, {
        quietMs: 1500,
        maxMs: 10_000,
        held: () => (heldByDraft = draftPending(sid)),
      });
      if (!heldByDraft) {
        if (sent) draftHeld.delete(id);
        return sent;
      }
      // A draft began while it waited for quiet: as above.
      draftHeld.add(id);
      if (opts?.onDraft === "refuse") return false;
    }
  });
  const done = mine.then(
    () => undefined,
    () => undefined,
  );
  typing.set(id, done);
  void done.then(() => {
    const n = (typingQueued.get(id) ?? 1) - 1;
    if (n > 0) typingQueued.set(id, n);
    else typingQueued.delete(id);
    if (typing.get(id) === done) typing.delete(id);
  });
  return mine;
}
const typing = new Map<string, Promise<void>>();
/** Issue 1311: texts in each agent's typing queue (draftWaiting). */
const typingQueued = new Map<string, number>();

/** Issue 1311: how often a held text looks again for its draft's end. */
const DRAFT_LOOK_MS = 500;
/** Issue 1311: the same, once a draft has held it for a minute. */
const DRAFT_LOOK_SLOW_MS = 2000;

/**
 * Issue 1311: waits until agent `rec`'s person's draft is sent or cleared
 * (by their keys, or an empty input line on its screen): true. False when
 * its session ends first (the draft dies with it). Never throws.
 */
async function draftCleared(
  d: AgentsResolved,
  rec: AgentRecord,
): Promise<boolean> {
  const sid = rec.session.id;
  const began = Date.now();
  for (;;) {
    if (!draftPending(sid)) return true;
    try {
      const c = await d.connectExisting();
      if (!c) return (clearDraft(sid), false);
      try {
        const s = (await c.list()).find((x) => x.ref.id === sid);
        if (!s || s.exited) return (clearDraft(sid), false);
        const readAt = Date.now();
        const out = (await c.scrollback(sid, 64 * 1024)).toString("utf-8");
        if (
          inputLineEmpty(out, getRuntime(rec.runtime)) &&
          clearDraftSeenEmpty(sid, readAt)
        )
          return true;
      } finally {
        c.close();
      }
    } catch {
      /* the host didn't answer: look again */
    }
    // A draft left a while: look less often (each look reads its screen).
    const wait =
      Date.now() - began > 60_000 ? DRAFT_LOOK_SLOW_MS : DRAFT_LOOK_MS;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** A plain session started from the page (AG-10.1 "Plain session"). */
export interface PlainStarted {
  info: SessionInfo;
}

/**
 * Plain session (AG-10.1): the person's login shell ($SHELL when it is an
 * absolute path to an executable, else /bin/sh) in the workspace's folder,
 * named shell, shell-2, … in that workspace. Its env is a plain session's
 * (the allowlist, every runtime's scrubEnv); it counts against
 * sessions.max_concurrent, never the agents' cap.
 */
export async function startPlainSession(
  d: AgentsResolved,
  ws: string,
  opts: { cwd?: string; replaces?: string; operator?: boolean } = {},
): Promise<PlainStarted> {
  checkWorkspaceName("sessions start", ws);
  if (!d.workspaceExists(ws))
    throw usage(`project "${ws}" does not exist`, 404);
  // Issue 479: Open a terminal there (a quarantined copy's folder). A
  // person's own shell, so any folder they could cd to; it must be one.
  if (opts.cwd !== undefined) {
    if (!path.isAbsolute(opts.cwd))
      throw usage(`cwd must be an absolute path: ${opts.cwd}`);
    if (!fs.statSync(opts.cwd, { throwIfNoEntry: false })?.isDirectory())
      throw usage(`cwd ${opts.cwd} is not a folder`);
  }
  const dir = opts.cwd ?? d.workspaceDir(ws);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw refused(`project ${ws}'s directory ${dir} does not exist`);
  ptyOrRefuse(d);
  const sh = d.env.SHELL;
  let shell = "/bin/sh";
  if (sh && path.isAbsolute(sh))
    try {
      fs.accessSync(sh, fs.constants.X_OK);
      shell = sh;
    } catch {
      /* the default */
    }
  const { plainSessionEnv } = await import("./sessions-command.js");
  return withClient(d, async (c) => {
    const names = new Set((await c.list()).map((s) => s.name));
    let n = 1;
    let name = sessionName(d.dist, ws, "shell");
    while (names.has(name)) name = sessionName(d.dist, ws, `shell-${++n}`);
    const info = await c
      .start(
        {
          name,
          cwd: dir,
          // Issue 814, the Builder's decision (a): the test operator's
          // terminal is Den's fixed stub, never a shell, with its own env.
          argv: opts.operator ? operatorStubArgv() : [shell, "-l"],
          env: opts.operator ? operatorStubEnv() : plainSessionEnv(d.env),
          cols: 80,
          rows: 24,
        },
        { limit: d.maxSessions(), pool: "sessions" },
      )
      .catch((e: unknown) => {
        if (e instanceof HostError && e.code === "cap")
          throw new AgentError(e.message, {
            status: 429,
            code: "cap",
            hints: ["Stop a session first, or raise sessions.max_concurrent."],
          });
        throw e;
      });
    // Issue 482: Restart on an exited terminal: once the new one runs, the
    // host forgets the exited one, so the list keeps one row for it. Only
    // an exited plain shell of this project: never a running one, never an
    // agent's (its record keeps its session).
    if (opts.replaces) {
      const old = (await c.list()).find((s) => s.ref.id === opts.replaces);
      const agents = listRecords(d.stateDir());
      if (
        old?.exited &&
        old.name.startsWith(`${d.dist}-${ws}:`) &&
        !agents.some((r) => r.session.id === old.ref.id)
      )
        await c.forget(old.ref.id).catch(() => {});
    }
    return { info };
  });
}

// ── D28: rotation by itself (on_due auto), and the callout's actions ────────

/** How often the server looks at due agents. */
export const ROTATION_TICK_MS = 15_000;
/** Between two asks for the handoff, at least this long. */
export const ROTATION_ASK_GAP_MS = 120_000;
/** Asks before auto falls back to ask. */
export const ROTATION_MAX_ASKS = 2;

export type RotationEvent =
  | { kind: "asked"; agent: string; workspace: string; asked: number }
  /** Issue 914: due, turn over, background work still running: it waits. */
  | { kind: "waiting"; agent: string; workspace: string; running: number }
  | { kind: "fell-back"; agent: string; workspace: string }
  | {
      kind: "relaunched";
      agent: string;
      workspace: string;
      why: string;
      /** The conversation that ended (kept). */
      old?: string;
    }
  | { kind: "failed"; agent: string; workspace: string; why: string };

/**
 * D28, one look at every running agent whose rotation is due. Each one
 * whose settings say `auto`, at idle (never mid-turn; unknown counts as
 * busy): its handoff passes, so Den relaunches it; or Den asks it for the
 * handoff (at most ROTATION_MAX_ASKS times, ROTATION_ASK_GAP_MS apart),
 * then falls back to ask. The limit the hook counts against follows the
 * settings. Never throws: each agent's failure is an event.
 */
export async function rotationTick(
  d: AgentsResolved,
  now: Date = new Date(),
  o: { askGapMs?: number; send?: typeof sendFirstInstruction } = {},
): Promise<RotationEvent[]> {
  const events: RotationEvent[] = [];
  let sessions: SessionInfo[];
  try {
    sessions = await hostSessions(d);
  } catch {
    return events;
  }
  const policyOf = policyResolver(d);
  const gap = o.askGapMs ?? ROTATION_ASK_GAP_MS;
  const send = o.send ?? sendFirstInstruction;
  for (const rec of listRecords(d.stateDir())) {
    const who = { agent: rec.id, workspace: rec.workspace };
    try {
      const s = rec.session ? sessionOf(sessions, rec) : undefined;
      const pol = policyOf(rec);
      if (!pol) continue;
      if (!s || s.exited) {
        // Issue 923: a due agent that a Den restart stopped and left not
        // back (never one a person stopped) relaunches from a passing
        // handoff, once. Nothing to ask: it isn't running. On ask the
        // person was told when the restart failed.
        const failed = rec.restartFailed;
        if (!failed || failed.relaunchTried || rec.stoppedAt || rec.endedAt)
          continue;
        const rot = rotationOf(d, rec);
        if (!rot?.ready || (rot.onDue !== "auto" && !rot.relaunchWanted))
          continue;
        let r: Relaunched;
        try {
          r = await relaunchAgent(d, rec.id, rec.workspace, {
            ...(rot.onDue === "auto" ? { auto: true } : {}),
          });
        } catch (e) {
          // One try: the person is told, and the sweep leaves it be.
          notBackAfterRestart(
            d,
            rec.id,
            rec.workspace,
            `relaunch from its handoff failed: ${(e as Error).message}`,
            { relaunchTried: true },
          );
          throw e;
        }
        events.push({
          kind: "relaunched",
          ...who,
          why: r.why,
          ...(rec.resumeToken ? { old: rec.resumeToken } : {}),
        });
        continue;
      }
      const files = agentFilesDir(d.stateDir(), rec.id);
      const st = readRotation(files);
      if (!st) continue;
      if (
        st.conversation &&
        rec.resumeToken &&
        st.conversation !== rec.resumeToken
      )
        continue;
      syncAfter(files, pol.afterCompactions);
      const rot = rotationInfo(d.stateDir(), rec, pol);
      if (!rot?.due) continue;
      // Relaunch now, asked before the handoff, relaunches whatever on_due says.
      const wanted = rot.relaunchWanted === true;
      if (!wanted && (pol.onDue !== "auto" || rot.fellBack)) continue;
      // Its turn first: never mid-turn (unknown counts as busy).
      if ((await agentTurnBusy(d, rec, s)) !== false) continue;
      // Issue 914: then the background work it left running (helpers,
      // jobs such as a gate run): the rotation waits for it, at most
      // agents.rotation_wait_minutes, then goes ahead with a handoff
      // that lists each one.
      const left = await leftRunningOf(d, rec, s);
      // Forced, and its listing handoff not asked for yet: asked once,
      // whatever the person's Relaunch now or the gap between asks.
      let mustAsk = false;
      if (!left.length) clearWaiting(files);
      else {
        const was = readRotation(files)?.waitingSince;
        const since = noteWaiting(files, now, left.length);
        if (now.getTime() - since < rotationWaitOf(d)) {
          if (!was)
            events.push({ kind: "waiting", ...who, running: left.length });
          continue;
        }
        mustAsk = noteLeftRunning(files, left);
      }
      if (readHandoff(files).status === "ok") {
        const r = await relaunchAgent(d, rec.id, rec.workspace, {
          auto: true,
        });
        events.push({
          kind: "relaunched",
          ...who,
          why: r.why,
          ...(rec.resumeToken ? { old: rec.resumeToken } : {}),
        });
        continue;
      }
      if (!mustAsk) {
        const last = st.askedAt ? Date.parse(st.askedAt) : 0;
        if (now.getTime() - last < gap) continue;
        if (wanted) continue; // asked once, by the person: no more asks
        if ((st.asked ?? 0) >= ROTATION_MAX_ASKS) {
          noteFellBack(files);
          events.push({ kind: "fell-back", ...who });
          continue;
        }
      }
      const text = rotationInstruction(files, rot.due, rot.compactions);
      if (
        await send(d, s.ref.id, rec.runtime, text, {
          quietMs: 500,
          maxMs: 5000,
        })
      ) {
        const n = noteAsked(files, now, wanted);
        if (mustAsk) noteLeftAsked(files);
        events.push({ kind: "asked", ...who, asked: n?.asked ?? 1 });
      }
    } catch (e) {
      events.push({ kind: "failed", ...who, why: (e as Error).message });
    }
  }
  return events;
}

/**
 * D28 "Keep this conversation": its count starts again, nothing is due.
 * `never`: also this agent's override after_compactions never ("don't ask
 * again for this agent").
 */
/**
 * D59: whether agent `id` resumes on its own after a restart: on, off, or
 * null for its persona's (`resume_on_restart`, `standing`).
 */
export function setAgentResumeOnRestart(
  d: AgentsResolved,
  id: string,
  ws: string | undefined,
  value: boolean | null,
): AgentRecord {
  const rec = agentRecord(d, id, ws);
  const next = { ...rec };
  if (value === null) delete next.resumeOnRestart;
  else next.resumeOnRestart = value;
  writeRecord(d.stateDir(), next);
  return next;
}

export function keepAgentConversation(
  d: AgentsResolved,
  id: string,
  ws?: string,
  o: { never?: boolean } = {},
): AgentRecord {
  const rec = agentRecord(d, id, ws);
  if (!keepConversation(agentFilesDir(d.stateDir(), rec.id)))
    throw refused(`agent ${rec.id} has no rotation to reset`);
  if (o.never)
    setRotateValue(d.stateDir(), "agent", rec.id, "after_compactions", "never");
  return rec;
}

/**
 * D28 "Write handoff": types the handoff instruction into agent `id`'s
 * running session, at idle. Refused while it is mid-turn or not running.
 */
export async function askForHandoff(
  d: AgentsResolved,
  id: string,
  ws?: string,
  send: typeof sendFirstInstruction = sendFirstInstruction,
  /** Relaunch now: Den relaunches it once the handoff passes. */
  o: { relaunch?: boolean } = {},
): Promise<AgentRecord & { resumed?: boolean }> {
  const rec = agentRecord(d, id, ws);
  const s = sessionOf(await hostSessions(d), rec);
  if (!s || s.exited) {
    // Stopped, no handoff yet: its conversation resumes to write one (the
    // resume hook gives it the instruction), then Den relaunches it.
    const files = agentFilesDir(d.stateDir(), rec.id);
    if (!o.relaunch)
      throw refused(
        `agent ${rec.id} is not running: resume it to write its handoff`,
        [`Resume: ${d.cli} agents resume ${rec.id}`],
      );
    const r = await resumeAgent(d, rec.id, ws);
    noteAsked(files, new Date(), true);
    return { ...r.rec, resumed: true };
  }
  // Issue 732: typed in, so by its turn alone (a job it left running
  // doesn't hold what Den types).
  if ((await agentTurnBusy(d, rec)) === true)
    throw refused(`agent ${rec.id} is mid-turn: ask again when its turn ends`);
  const rot = rotationOf(d, rec);
  const files = agentFilesDir(d.stateDir(), rec.id);
  const text = rotationInstruction(
    files,
    rot?.due ?? "compactions",
    rot?.compactions ?? readRotation(files)?.compactions ?? 0,
  );
  if (
    !(await send(d, s.ref.id, rec.runtime, text, { quietMs: 500, maxMs: 5000 }))
  )
    throw refused(`agent ${rec.id}'s session did not take the prompt`);
  noteAsked(files, new Date(), o.relaunch === true);
  return rec;
}

/**
 * D28: Resume (or Start) on an agent follows its on_due: a due agent whose
 * handoff passes relaunches from it under auto; ask refuses with the
 * callout's choices (code "rotated"); off, or nothing due, resumes.
 */
export async function resumeOrRelaunch(
  d: AgentsResolved,
  id: string,
  ws?: string,
): Promise<
  { kind: "resumed"; s: Resumed } | { kind: "relaunched"; s: Relaunched }
> {
  // Issue 658: a relaunch that never began is undone first, so it
  // relaunches again (it was asked for: whatever on_due says).
  undoUnbegunRelaunch(d, agentRecord(d, id, ws), await hostSessions(d));
  const rec = agentRecord(d, id, ws);
  const rot = rotationOf(d, rec);
  if (rot?.ready && (rot.onDue === "auto" || rot.relaunchWanted))
    return {
      kind: "relaunched",
      s: await relaunchAgent(d, id, ws, {
        ...(rot.onDue === "auto" ? { auto: true } : {}),
      }),
    };
  return { kind: "resumed", s: await resumeAgent(d, id, ws) };
}

/** Issue 926: what the exit sweep did about one agent. */
export type ExitEvent = {
  agent: string;
  workspace: string;
  /** The ended session's exit code (128 + signal for a signal). */
  code: number;
} & (
  | { kind: "recorded" } // exit 0: it quit by itself; left down
  | { kind: "resumed" | "relaunched" }
  | { kind: "left"; why: string } // told, not brought back
);

/** Issue 926: how long after an exit the sweep looks at it. */
const EXIT_SEEN_MS = 5_000;

/** Issue 926: when the sweep first saw each exit with no time from its host. */
const exitFirstSeen = new Map<string, number>();

/**
 * Issue 926: when session `s` ended: its host's exit time, else when the
 * sweep first saw it ended (`now` the first time).
 */
export function exitSeenAt(s: SessionInfo, now: Date): number {
  const t = s.exitedAt ? Date.parse(s.exitedAt) : NaN;
  if (Number.isFinite(t)) return t;
  const seen = exitFirstSeen.get(s.ref.id);
  if (seen !== undefined) return seen;
  exitFirstSeen.set(s.ref.id, now.getTime());
  return now.getTime();
}

/** Issue 926: agents.unasked_exit_window_minutes, in ms. */
function unaskedExitWindowOf(d: AgentsResolved): number {
  try {
    return d.agentsConfig().unaskedExitWindowMs;
  } catch {
    return UNASKED_EXIT_WINDOW_MINUTES_DEFAULT * 60_000;
  }
}

/**
 * Issue 926: agents whose session ended without Den asking (no stop,
 * restart or relaunch from Den or a person: a signal from outside, a
 * crash). Each gets one audit row. Exit 0 (it quit by itself) is left
 * down. Otherwise the person is told, and Den brings it back once
 * (resumeOrRelaunch: from its handoff when its rotation is ready); a
 * second such exit within agents.unasked_exit_window_minutes is told and
 * left down. A host that went down (no exit code) is restore-on-boot's.
 */
export async function exitTick(
  d: AgentsResolved,
  now: Date = new Date(),
): Promise<ExitEvent[]> {
  const out: ExitEvent[] = [];
  let sessions: SessionInfo[];
  try {
    sessions = await hostSessions(d);
  } catch {
    return out;
  }
  const byId = new Map(sessions.map((x) => [x.ref.id, x]));
  const windowMs = unaskedExitWindowOf(d);
  for (const rec of listRecords(d.stateDir())) {
    const s = rec.session ? byId.get(rec.session.id) : undefined;
    if (!s?.exited || s.exitCode === undefined) continue;
    // Asked for: a stop (Den's or a person's), or a restart left not back.
    if (rec.stoppedAt || rec.restartFailed) continue;
    if (rec.unaskedExit?.session === s.ref.id) continue; // seen
    // A stop marks its record just after its TERM: give it time to. A
    // host that gives no exit time: from when the sweep first saw it.
    if (now.getTime() - exitSeenAt(s, now) < EXIT_SEEN_MS) continue;
    const e = await lockAgent(d, rec.id, () =>
      unaskedExit(d, s, now, windowMs),
    );
    if (e) out.push(e);
  }
  return out;
}

/** Issue 926: one agent's unasked exit, under its lock; undefined: none. */
async function unaskedExit(
  d: AgentsResolved,
  s: SessionInfo,
  now: Date,
  windowMs: number,
): Promise<ExitEvent | undefined> {
  {
    // Again under the lock: a stop or restart may have marked it since.
    const rec = listRecords(d.stateDir()).find(
      (r) => r.session?.id === s.ref.id,
    );
    if (!rec || rec.stoppedAt || rec.restartFailed) return undefined;
    if (rec.unaskedExit?.session === s.ref.id) return undefined;
    const code = s.exitCode ?? 0;
    const who = { agent: rec.id, workspace: rec.workspace, code };
    const prev = rec.unaskedExit;
    const at = now.toISOString();
    writeRecord(d.stateDir(), {
      ...rec,
      unaskedExit: { at, session: s.ref.id, code },
    });
    auditConfig(
      {
        verb: "agents",
        detail: `agent ${rec.id} in ${rec.workspace} ended without Den asking (exit ${code})`,
        ...(code === 0 ? {} : { outcome: "refused" as const }),
        ...(code === 0 ? {} : { reason: `exit ${code}` }),
      },
      d.stateDir(),
    );
    if (code === 0) {
      return { kind: "recorded", ...who };
    }
    const name = rec.displayName || rec.persona || rec.id;
    const tell = (kind: "waiting" | "finished", why: string) => {
      try {
        new NotificationStore(d.stateDir()).add({
          kind,
          subject: `agent:${rec.id}`,
          scope: `workspace/${rec.workspace}`,
          text: `${name} ended without Den asking (exit ${code}): ${why}`,
          msg: { key: "bell.m.unaskedExit", vars: { name, code, why } },
          link: `/agents?ws=${encodeURIComponent(rec.workspace)}`,
        });
      } catch {
        /* best effort: the audit row and the row's state still say so */
      }
    };
    const recent =
      prev !== undefined && now.getTime() - Date.parse(prev.at) < windowMs;
    if (windowMs <= 0 || recent) {
      const why = recent
        ? "it ended again soon after Den brought it back, so it is left down"
        : "bringing it back is off";
      tell("waiting", why);
      return { kind: "left", ...who, why };
    }
    try {
      const r = await resumeOrRelaunch(d, rec.id, rec.workspace);
      const back = agentRecord(d, rec.id, rec.workspace);
      writeRecord(d.stateDir(), {
        ...back,
        unaskedExit: { at, session: s.ref.id, code, back: true },
      });
      tell(
        "finished",
        r.kind === "relaunched"
          ? "Den relaunched it from its handoff"
          : "Den resumed it",
      );
      return { kind: r.kind, ...who };
    } catch (e) {
      const why = `Den couldn't bring it back: ${(e as Error).message}`;
      tell("waiting", why);
      return { kind: "left", ...who, why };
    }
  }
}

/** D28: the rotation settings, and agent `agent`'s effective values. */
/** D30: what the rotation overrides can name, with names to show. */
export interface RotationChoices {
  agents: { id: string; name: string; workspace?: string; state: string }[];
  personas: { id: string; name: string; category: string }[];
  workspaces: { id: string; name: string }[];
  services: { id: string; name: string; workspace: string }[];
}

/**
 * D30: the overrides form's pickers: every agent (its name, workspace and
 * state), persona (name and category), workspace and workspace service.
 * Never starts a session host to ask (a stopped one: agents from their
 * records). A part that can't be read is empty, not an error.
 */
export async function rotationChoices(
  d: AgentsResolved,
  workspaces: string[],
): Promise<RotationChoices> {
  let sessions: SessionInfo[] = [];
  try {
    const c = await d.connectExisting();
    try {
      sessions = c ? await c.list() : [];
    } finally {
      c?.close();
    }
  } catch {
    sessions = [];
  }
  const records = listRecords(d.stateDir());
  const agents = agentRows(sessions, records, d.stateDir())
    .filter((r) => r.agent)
    .map((r) => ({
      id: r.agent,
      name: r.displayName || r.sessionTitle || r.agent,
      ...(r.workspace ? { workspace: r.workspace } : {}),
      state: r.state,
    }));
  let personaList: RotationChoices["personas"] = [];
  try {
    personaList = listPersonas(d).map((p) => ({
      id: p.id,
      name: p.displayName ? `${p.displayName} (${p.id})` : p.id,
      category: p.category,
    }));
  } catch {
    personaList = [];
  }
  const services: RotationChoices["services"] = [];
  for (const ws of workspaces)
    try {
      for (const sv of d.workspaceServices(ws))
        if (!services.some((x) => x.id === sv.address))
          services.push({ id: sv.address, name: sv.address, workspace: ws });
    } catch {
      /* a workspace whose services can't be read: none */
    }
  return {
    agents,
    personas: personaList,
    workspaces: workspaces.map((w) => ({ id: w, name: w })),
    services,
  };
}

export function rotationSettings(
  d: AgentsResolved,
  agent?: string,
  ws?: string,
): {
  defaults: typeof ROTATE_DEFAULTS;
  org: OrgRotate;
  install: RotateValues;
  overrides: NonNullable<RotateFile["overrides"]>;
  effective?: RotationPolicy & { agent: string };
} {
  const f = readRotateFile(d.stateDir());
  let org: OrgRotate = {};
  try {
    org = d.agentsConfig().rotateOrg ?? {};
  } catch {
    org = {};
  }
  let effective: (RotationPolicy & { agent: string }) | undefined;
  if (agent) {
    const rec = agentRecord(d, agent, ws);
    const pol = policyResolver(d)(rec);
    if (pol) effective = { agent: rec.id, ...pol };
  }
  return {
    defaults: ROTATE_DEFAULTS,
    org,
    install: f.install ?? {},
    overrides: f.overrides ?? {},
    ...(effective ? { effective } : {}),
  };
}

/**
 * D28: set one rotation setting from a request body `{ scope, target?,
 * key, value }` (value null: cleared). A target is checked to be a name
 * (persona-workspace: `<persona>@<workspace>`).
 */
export function setRotationSetting(
  d: AgentsResolved,
  body: Record<string, unknown>,
): { file: RotateFile } {
  const scope = body.scope;
  if (
    scope !== "install" &&
    !(OVERRIDE_SCOPES as readonly unknown[]).includes(scope)
  )
    throw usage(
      `scope: one of install, ${OVERRIDE_SCOPES.join(", ")} (got ${JSON.stringify(scope)})`,
    );
  const target = body.target;
  if (scope !== "install") {
    const ok =
      typeof target === "string" &&
      (scope === "persona-workspace"
        ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(
            target,
          )
        : scope === "service"
          ? /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(target)
          : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target));
    if (!ok)
      throw usage(
        scope === "persona-workspace"
          ? "target: <persona>@<project>"
          : `target: the ${String(scope)} it is for`,
      );
  } else if (target !== undefined && target !== null)
    throw usage("target: install takes none");
  if (typeof body.key !== "string") throw usage("key is required");
  try {
    return {
      file: setRotateValue(
        d.stateDir(),
        scope as OverrideScope | "install",
        scope === "install" ? undefined : (target as string),
        body.key,
        body.value === null ? undefined : body.value,
      ),
    };
  } catch (e) {
    throw usage((e as Error).message);
  }
}
