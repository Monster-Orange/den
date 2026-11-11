#!/usr/bin/env node

/**
 * Den CLI
 * Main entry point for the interactive CLI
 */

import { composeStacksNotice } from "./workspace-notes.js";
import {
  runningComposeProjects,
  runningWorkspaceStacks,
} from "../../shared/stacks/status.js";
import { isNamedTarget } from "./named-target.js";
import { isNotice, printNotice } from "./notice.js";
import chalk from "chalk";
import { noun, plural } from "../../shared/plural.js";
// Spinners: progress on stderr (a terminal) or stdout (piped); plain lines
// where they cannot animate. See spinner.ts.
import { spinner as ora } from "./spinner.js";
import { newTable } from "./table.js";
import { validateAll, validateAllFailed } from "./validate-all.js";
import { cliPrompts } from "./prompts.js";
import { resultsViewer } from "./results-viewer.js";
import { testRunner } from "./test-runner.js";
import { envSelector } from "../../shared/environment/env-selector.js";
import {
  recordInvocation,
  recordFailure,
  shipFromDetachedSender,
  startTimer,
} from "../../shared/dev-metrics/emit.js";
import type { Environment, Pillar } from "../../shared/types/index.js";
import { moduleScanner } from "../../shared/test-discovery/module-scanner.js";
import { resolvePerformanceModules } from "./module-selection.js";
import {
  readCatalog,
  needsGhRepair,
  resolveRepoCloneSource,
  upsertCatalogEntry,
} from "../../shared/environment-manager/catalog.js";
import { seedSecretsFromSibling } from "../../shared/environment-manager/secrets-check.js";
import { upNeedsTarget } from "./up-args.js";
import {
  readWorkspacesFile,
  writeWorkspacesFile,
  getActiveWorkspace,
  getFocusedWorkspaceName,
  isWorkspaceActive,
  activateWorkspace,
  deactivateWorkspace,
  getActiveWorkspaces,
  setActiveWorkspace,
  setFocusedWorkspace,
  createWorkspace,
  deleteWorkspaceConfig,
  parseAddress,
  noAutostartRepos,
  generateVSCodeWorkspace,
  syncJetBrainsWorkspaceSymlinks,
  DEN_SERVICES_DIR,
  DEN_WORKSPACES_DIR,
} from "../../shared/environment-manager/workspaces.js";
import {
  ownersSuffix,
  parseScope,
  scopeLine,
  scopeView,
  takeScopeFlag,
} from "../../shared/environment-manager/scope.js";
import {
  deleteWorkspaceDirectory,
  checkBehindCount,
  pullRepo,
  ensureManagedServiceClone,
  runSetupHidden,
  runSetupInteractive,
  hasSetupSucceeded,
  hasSetupCommand,
  markSetupSucceeded,
  fetchAndFastForward,
} from "../../shared/environment-manager/workspace-manager.js";
import { stackNamespaceRows } from "../../shared/stacks/namespace.js";
import {
  runServiceCommand,
  claimHealthyService,
  daemonsOutsideWorkspaces,
  getWorkspaceServices,
  ensureDaemonRegistryLoaded,
  hasRunningOpctlContainers,
  releaseWorkspaceDaemons,
  resolveServiceRuntime,
} from "../../shared/environment-manager/service-runner.js";
import {
  blueprintWorkspaces,
  defaultWorkspaceNeedsSeeding,
  blueprintAlreadySeeded,
  defaultWorkspaceHasServices,
  isMultiBlueprint,
  seedBlueprintWorkspaces,
  seedDefaultWorkspace,
  topUpDefaultWorkspace,
  markDefaultWorkspaceDeclined,
} from "../../shared/environment-manager/default-workspace.js";
import {
  checkCatalogHealth,
  rollupRepoHealth,
  sortByRepoOrder,
} from "../../shared/environment-manager/health.js";
import { checkServiceHealth } from "../../shared/environment-manager/health.js";
import {
  resolveStartupOrder,
  getWaitDeps,
} from "../../shared/environment-manager/dag.js";
import { waitForReady } from "../../shared/environment-manager/readiness.js";
import {
  canonicalServiceAddress,
  previewServiceCommand,
  previewUpSettle,
  previewServiceSecretEnv,
  prepareServiceSecretEnv,
  resolveService,
  type DownOutcome,
  type ServiceCommandPreview,
} from "../../shared/environment-manager/service-runner.js";
import { getGitHubCoords } from "../../shared/smoke/git-remote.js";
import { isConfigError } from "../../shared/config-error.js";
import {
  assertDenConfigValid,
  waiveInvalidOrgs,
  getReposRoot,
  mergeUserConfig,
  readDenConfig,
  isProductionEnv,
  readUserConfig,
} from "../../shared/den-config.js";
import { deriveGraph } from "../../shared/environment-manager/derivation/derive-graph.js";
import {
  hardDepsOf,
  orderForUp,
  orderForDown,
  deriveStartTargets,
} from "../../shared/environment-manager/derivation/derived-up.js";
import type { DerivedGraph } from "../../shared/environment-manager/derivation/types.js";
import {
  repoOfAddress,
  resolveUpTargets,
  type UpTargets,
} from "../../shared/environment-manager/up-targets.js";
import { loadAliasResolver } from "../../shared/environment-manager/derivation/load-alias.js";
import {
  cmdApps,
  describeContributor,
  focusedAppRepos,
  takeAppFlag,
} from "./applications-command.js";
import { loadApplications } from "../../shared/environment-manager/load-applications.js";
import { hasRuntime, repoKind } from "../../shared/repo-kind.js";
import type { RepoKind, ValidationResult } from "../../shared/types/index.js";
import { localCommandsFor } from "../../shared/stacks/manifest-commands.js";
import {
  buildUpPlan,
  type NodePlan,
} from "../../shared/environment-manager/up-plan.js";
import { execSync } from "child_process";
import * as fs from "fs";
import {
  heldManifestsDir,
  readManifest,
} from "../../shared/manifest/read-manifest.js";
import * as nodePath from "path";
import { runInit } from "./init.js";
import {
  validateManifest,
  validateManifestLayers,
} from "../../shared/manifest/validate-manifest.js";
import {
  placementRefusal,
  placementSuffix,
  servicePlacement,
} from "../../shared/manifest/placement.js";
import {
  getDistRoot,
  getEngineRoot,
  getInvokeCwd,
} from "../../shared/paths.js";
import { engineBin } from "../../shared/engine.js";
import { runCreate } from "./create.js";
import {
  confirmWithTimeout,
  recoverStalledSetup,
  STALLED_SETUP_CONFIRM_TIMEOUT_MS,
} from "./stalled-setup-recovery.js";
import { cleanupStaleTabs } from "../../shared/cli-tabs.js";
import { cmdConfig } from "./config-command.js";
import { cmdEdge } from "./edge-command.js";
import { cmdDoctor } from "./doctor-command.js";
import { cmdSessions, SESSIONS_HELP } from "./sessions-command.js";
import { AGENTS_HELP, cmdAgents } from "./agents-command.js";
import { USAGE_HELP, cmdUsage } from "./usage-command.js";
import { HUB_HELP, cmdHub } from "./hub-command.js";
import { cmdService } from "./service-command.js";
import { cmdStack } from "./stack-command.js";
import { cmdTheme } from "./theme-command.js";
import { cmdPlugin } from "./plugin-command.js";
import {
  cmdOrg,
  orgFlag,
  orgListRows,
  printOrgWarnings,
  registerOrg,
  sameOrg,
} from "./org-command.js";
import {
  buildSetupPlan,
  renderClonePlan,
  workspaceClonePlan,
} from "./clone-plan.js";
import { githubOrgFor } from "../../shared/environment-manager/workspace-org.js";
import { cmdWeb, displayWebHelp } from "./web-command.js";
import { cmdGraph } from "./graph-command.js";
import { resolveTargetWorkspace } from "./target-workspace.js";
import { resolveLogsTarget, tailServiceLogs } from "./logs-command.js";
import {
  parseCliArgs,
  takeWorkspaceFlags,
  ownsSubcommandHelp,
  unknownCommandFlags,
  workspaceFlagRequiresActive,
  type ParsedCliArgs,
} from "./flag-parser.js";
import {
  resolveInvocationTarget,
  findInvocationRepoRoot,
  resolveCwdRepo,
} from "./invocation-target.js";
import { preflightSecrets } from "./secrets-preflight.js";
import {
  formatHealthDot,
  formatHealthLabel,
  formatHealthReason,
  formatRollupLabel,
  healthReasonText,
  rollupReasonText,
} from "./health-display.js";
import { DEN_BANNER_LINES, DEN_DIVIDER } from "../../shared/banner.js";

import { product } from "../../shared/product.js";
import { AGENT_SETUP_LINE } from "../../shared/agent-setup.js";
import { ExitRequested, printJson, quietStdout } from "./json-out.js";
const DEN_HELP_DESCRIPTION = `  ${product().title} - local-first test, service, and workspace orchestration`;

/**
 * Concise `<command> -h` help for commands without a dedicated help renderer.
 * Flag-heavy commands (up, graph, use-local, use-managed) have richer handlers.
 */
/** `workspace` subcommands, for `workspace --help` and `workspace <sub> --help`. */
const WORKSPACE_SUBCOMMANDS: {
  name: string;
  usage: string;
  lines: string[];
}[] = [
  {
    name: "list",
    usage: "list [--org <id>]",
    lines: [
      "every workspace, the active set, the focus and its org;",
      "--org <id> lists one org's workspaces",
    ],
  },
  {
    name: "activate",
    usage: "activate <n>",
    lines: ["add a workspace to the active set"],
  },
  {
    name: "deactivate",
    usage: "deactivate <n>",
    lines: [
      "remove it from the active set and stop the services",
      "only it owns. Only services {cli} tracks: compose",
      "stacks keep running; stop them with `{cli} down <repo>`",
    ],
  },
  {
    name: "focus",
    usage: "focus <n>",
    lines: ["make an active workspace the default for commands"],
  },
  {
    name: "use",
    usage: "use <n>",
    lines: ["activate and focus a workspace"],
  },
  {
    name: "create",
    usage: "create [n]",
    lines: ["create an empty workspace"],
  },
  {
    name: "delete",
    usage: "delete <n>",
    lines: ["delete a workspace (and its directory)"],
  },
  {
    name: "code",
    usage: "code [n]",
    lines: ["open it in your editor (VS Code: a .code-workspace)"],
  },
  {
    name: "seed",
    usage: "seed",
    lines: [
      "fill workspaces from the distribution's blueprint",
      "(defaults.workspace / defaults.workspaces), all managed",
    ],
  },
];

const COMMAND_HELP: Record<string, { usage: string; lines: string[] }> = {
  down: {
    usage: "down [repo] [-w <workspace>] [flags]",
    lines: [
      "Stop the cwd (or named) repo; --with-deps also stops what it sits on (its",
      "derived closure, in reverse order), naming anything else that uses it.",
      "-a/--all stops EVERY workspace system (reverse derived order, cwd-agnostic;",
      "every down script runs — no already-stopped skip).",
      "Flags: -w/--workspace <ws> (that active workspace, not the focused one; focus stays) · -a/--all · -A/--app <app> · --with-deps · -n/--dry-run (print order, stop nothing) · --manifest (legacy depends_on)",
    ],
  },
  restart: {
    usage: "restart [service...] [-w <workspace>] [-A <app>] [-n|--dry-run]",
    lines: [
      `Restart the given services, or every repo in an application (\`${product().cli} apps\`).`,
      "-w/--workspace <ws> acts in that active workspace instead of the focused one; focus stays.",
    ],
  },
  status: {
    usage: "status [-A <app>] [--scope <all|workspace>] [--verbose]",
    lines: [
      "Show service health for what is in view: every active workspace by",
      "default (the web UI's scope), or --scope <workspace> for one. A",
      "service several workspaces share is listed once, with its owners.",
      "--verbose (or --all) shows one row per service instead of per repo.",
    ],
  },
  logs: {
    usage: "logs [repo|repo/subsystem]",
    lines: [
      "Tail live local logs for the cwd (or named) repo's front-door service.",
      "Sources, in order: the manifest's logs.local command, the service's",
      `running container (docker logs -f), or the ${product().cli} daemon startup log.`,
      `If the repo isn't running, offers to start it first (${product().cli} up).`,
    ],
  },
  services: {
    usage: "services",
    lines: ["List all registered services in the catalog."],
  },
  register: {
    usage: "register [path] [-w <workspace>] [--org <id>]",
    lines: [
      "With a path: add that checkout (dev-managed) under its manifest name.",
      "Without one: pick the repo interactively. A managed clone is picked",
      "from the focused workspace's org; --org <id> picks from another.",
      "-w writes that workspace (active or not) and leaves focus alone.",
    ],
  },
  repo: {
    usage:
      'repo add <path|git-url> [--sidecar] [-w <workspace>] [--name <repo>] [--run "<cmd>"] [--health <url>] [--dry-run] [--json] | repo detect <folder> [--json]',
    lines: [
      "Add a repo with no prompts, never writing into it. A repo with no",
      "manifest (or --sidecar) gets a side-car manifest in manifests/, detected",
      "from its Makefile, compose file or package.json scripts. Safe to re-run.",
      "--dry-run prints the side-car it would write, validated, and writes nothing.",
      "detect: the git repos in a folder in your home, how each runs, and",
      "suggested workspaces. `{cli} repo add --help` says more.",
    ],
  },
  onboard: {
    usage: "onboard status [--json]",
    lines: [
      "What's set up (a distribution, the web server, workspaces, repos, a",
      "running service, Den's MCP) and the one next step, with its command.",
      "Reads only; it never runs an agent's CLI.",
    ],
  },
  relocate: {
    usage: "relocate <repo> <path> [--dry-run] [--force] [-w <workspace>]",
    lines: [
      "Point every workspace's dev-managed entries for <repo> at <path>.",
      "Refuses a path that is missing, holds a different repo, or has",
      "neither a manifest nor a remote naming this one (unless --force).",
      "-w limits it to that workspace; focus never changes.",
    ],
  },
  setup: {
    usage:
      "setup [service...] [-w <workspace>] [--force|-f] [--plan [-w <workspace>]... [--all-active]]",
    lines: [
      "Run 'make setup' once per system (clones missing managed repos first).",
      "Default targets MANAGED clones only — setup's codegen/installs",
      "shouldn't touch your own dev-managed checkouts uninvited.",
      "--force (-f) includes dev-managed repos; naming a service always works.",
      "--plan prints each repo's org and clone URL and stops: nothing is",
      "cloned, seeded or written (on a fresh machine: the blueprint's plan).",
      "It plans the focused workspace; -w <workspace> (repeatable) plans those,",
      "--all-active every active one. Repos only other workspaces hold are named.",
      "Without --plan, -w <workspace> sets up that workspace's systems instead of the focused one's.",
    ],
  },
  org: {
    usage: "org list [--org <id>]",
    lines: [
      "Every org: its label, its workspaces, whether it is the default",
      "(github_org), and any org warnings. A workspace's org is its own org:,",
      "then the blueprint's org:, then its repos' one catalog owner, then",
      "github_org.",
    ],
  },
  sync: {
    usage: "sync [service...]",
    lines: ["Check managed repos for upstream updates and offer to pull."],
  },
  workspace: {
    usage: `workspace <${WORKSPACE_SUBCOMMANDS.map((c) => c.name).join("|")}> [name]`,
    lines: [
      "Manage workspaces (named sets of services + their modes).",
      "",
      ...WORKSPACE_SUBCOMMANDS.flatMap((c) =>
        c.lines.map(
          (line, i) => `  ${(i === 0 ? c.usage : "").padEnd(16)}  ${line}`,
        ),
      ),
    ],
  },
  run: {
    usage: "run [options]",
    lines: ["Run tests (interactive picker, or pillar/module/env flags)."],
  },
  "view-results": {
    usage: "view-results",
    lines: ["Browse recent test results."],
  },
  create: {
    usage:
      "create <name> [dir] [--title <title>] [--cli <cli>] [--env-prefix <PREFIX>]",
    lines: [
      "Scaffold a new distribution (den.yml, config, bin shim, Makefile) in [dir].",
      "Also: npx @monster-orange/den@latest create <name>. See docs/distributions.md.",
    ],
  },
  validate: {
    usage: "validate [path|url]",
    lines: [
      `Validate a ${product().manifestYml} manifest (defaults to the cwd repo).`,
    ],
  },
  init: {
    usage: "init [repo-dir]",
    lines: [
      `In the ${product().cli} root: seed/reset the default workspace (all repos managed).`,
      `In a service repo: scaffold that repo's ${product().manifestYml} manifest.`,
    ],
  },
  config: {
    usage: "config [get|set ...]",
    lines: [`View or edit ${product().cli} configuration.`],
  },
  apps: {
    usage: "apps [--json]   (alias: applications)",
    lines: [
      "Org > Application > Repo > Services. Applications: config `applications:`,",
      "manifest `application:`; any other repo is its own application.",
      "Act on one: up|down|restart|status -A <app>.",
    ],
  },
  stack: {
    usage:
      "stack [ls|up|down|restart|health|ps|logs] <name…> [--build] [-w <workspace>]",
    lines: [
      "Run repos' compose stacks with no host ports, at https://<route>.<stack>.<edge.domain>.",
    ],
  },
  edge: {
    usage: "edge [up|down|status|trust|untrust|routes]",
    lines: [
      "This org's edge: routes at <name>.<edge.domain>, TLS as edge.tls says",
      "(none | mkcert | files). trust/untrust exist only under mkcert.",
    ],
  },
  doctor: {
    usage: "doctor [--probe] [--json]",
    lines: [
      "--json: one object, { ok, checks: [{ id, status: ok|warn|fail, detail, fix?, ask? }] }:",
      "Node 22.13+, git, Docker (only when a registered repo needs it), the web",
      "server and Den's MCP through it, then each strategy below. Exit 1 on a fail.",
      "Each strategy kind (secrets, tls): the one selected, whether it was implicit,",
      "and whether it can work here (a PATH check; nothing is run or prompted).",
      "--probe: start a short probe session (through the session host) for a",
      "plain session and each available runtime's agent env; key names only.",
      "Exit 1 when a runtime's scrubEnv name or a credential-shaped variable",
      "reaches one. Without the PTY module it says unavailable, not failed.",
    ],
  },
  plugin: {
    usage:
      "plugin [list] | validate [dir] | add <repo>[/<subpath>]@<ref> [--track] [--yes] | update <id> @<ref> | remove <id>",
    lines: [
      "Plugins (den.plugin/v1) in plugins/<id>/: local (the distribution's own, no lock entry)",
      "or added (vendored at an exact ref, pinned in plugins.lock.json). list checks each",
      "against the lock; validate checks every manifest. add refuses file:// sources.",
    ],
  },
  theme: {
    usage:
      "theme [list] | validate [dir] | new <id> | add <repo>[/<subpath>]@<ref> | remove <id>",
    lines: [
      "Web UI themes (den.theme/v1). add fetches one at an exact ref, validates it",
      "(schema, contrast in both modes, files) and vendors it into plugins/<id>/",
      "with a plugins.lock.json entry; commit both. list checks them against the lock.",
    ],
  },
  mcp: {
    usage: "mcp [--port <web port>] [--list | --call <tool> ['<json args>']]",
    lines: [
      "An MCP server over stdio for agents: a client of the running web server",
      `(\`${product().cli} web up\`). Read tools always; actions only as named in mcp.actions.`,
      "--list prints the tool names; --call runs one tool and prints its result.",
    ],
  },
  service: {
    usage: "service [install|status|print|uninstall]",
    lines: [
      "The web UI as a macOS launchd service, started at login. Label and logs:",
      "config web.service { label, logs }.",
    ],
  },
  "local-dev": {
    usage: "local-dev [on|off]",
    lines: [
      "Toggle the local-dev experience (web Workspaces page + service mgmt).",
    ],
  },
  menu: {
    usage: "menu",
    lines: ["Open the interactive menu (pillar/module/env picker)."],
  },
  sessions: SESSIONS_HELP,
  agents: AGENTS_HELP,
  usage: USAGE_HELP,
  hub: HUB_HELP,
};

function resolveCliBaseApiUrl(explicitBaseApiUrl?: string): string | undefined {
  return (
    explicitBaseApiUrl?.trim() ||
    process.env.BASE_URL ||
    process.env.BASE_API_URL ||
    undefined
  );
}

// ── Dev-tooling telemetry helpers ─────────────────────────────────────────────

/**
 * Registered den CLI commands — the ONLY values allowed in the telemetry
 * `command` attribute. Unknown input collapses to "unknown" so raw argv (which
 * can contain paths or secrets) never reaches telemetry.
 */
const TELEMETRY_COMMANDS = new Set<string>([
  "run",
  "view-results",
  "down",
  "menu",
  "web",
  "up",
  "down",
  "restart",
  "status",
  "logs",
  "services",
  "graph",
  "register",
  "relocate",
  "use-local",
  `use-managed`,
  "setup",
  "workspace",
  "org",
  "sync",
  "init",
  "validate",
  "create",
  "local-dev",
  "config",
  "edge",
  "doctor",
  "stack",
  "apps",
  "applications",
  "mcp",
  "sessions",
  "agents",
  "usage",
  "hub",
  "service",
  "theme",
  "plugin",
  "repo",
  "onboard",
]);

/**
 * Commands that run with a config that fails validation: the web and MCP
 * servers (each route or tool reports it), and those that read neither orgs,
 * the catalog nor clones (manifest validate, create, the per-engineer
 * config and local-dev toggles, saved results), and `down` (0.3.0-dev.40:
 * stopping is never stranded by a config that fails; it stops from the
 * daemon records and compose projects, reading no org data). Every other
 * registered command checks the config first.
 */
const CONFIG_FREE_COMMANDS = new Set<string>([
  "web",
  "mcp",
  "validate",
  "create",
  "config",
  "local-dev",
  "view-results",
  "down",
  // The session host and its clients read no org data, and stopping or
  // listing a session is never stranded by a config that fails (AG-3a).
  "sessions",
  "agents",
  // den#6: reads local transcripts and agent records, no org data.
  "usage",
  // D52: calls Den's own proxy to Hub, no org data.
  "hub",
]);

function configCheckedCommand(command: string): boolean {
  return TELEMETRY_COMMANDS.has(command) && !CONFIG_FREE_COMMANDS.has(command);
}

/** Map a raw command token to a PII-safe, registered telemetry command name. */
function telemetryCommandName(command?: string): string {
  if (!command) return "none";
  if (command === "--help" || command === "-h") return "help";
  if (command === "--version" || command === "-v") return "version";
  return TELEMETRY_COMMANDS.has(command) ? command : "unknown";
}

/** Error *class* for telemetry (never the message — PII). */
function telemetryReason(error: unknown): string {
  const name = (error as { constructor?: { name?: string } })?.constructor
    ?.name;
  return name && name !== "Object" ? name : "Error";
}

/**
 * What was typed, with each service alias (a manifest service key or a
 * compose stack name) mapped to its service's address, so the derived graph,
 * ownership and the daemon registry all see one name. Flags pass through; an
 * ambiguous alias throws, naming the candidates. `limit` maps only the first
 * n positional args.
 */
function canonicalTargets(args: string[], limit = Infinity): string[] {
  let seen = 0;
  return args.map((a) =>
    a.startsWith("-") || seen++ >= limit ? a : canonicalServiceAddress(a),
  );
}

/** Print one manifest's validation: a status line, then each issue. */
function printValidation(
  label: string,
  result: ValidationResult,
  layer?: string,
): void {
  const tag = layer ? `${layer}, ` : "";
  if (result.valid && result.warnings.length === 0) {
    console.log(
      chalk.green(`  ✓  ${label}`) +
        chalk.gray(`  (${tag}v${result.version}, no issues)`),
    );
  } else if (result.valid) {
    console.log(
      chalk.yellow(`  ⚠  ${label}`) +
        chalk.gray(
          `  (${tag}v${result.version}, ${plural(result.warnings.length, "warning")})`,
        ),
    );
  } else {
    console.log(
      chalk.red(`  ✗  ${label}`) +
        chalk.gray(
          `  (${tag}v${result.version}, ${plural(result.errors.length, "error")}${result.warnings.length > 0 ? `, ${plural(result.warnings.length, "warning")}` : ""})`,
        ),
    );
  }

  for (const err of result.errors) {
    const path = err.path ? chalk.gray(err.path) + "  " : "";
    console.log(`  ${chalk.red("ERROR")}   ${path}${err.message}`);
    if (err.suggestion) {
      console.log(`            ${chalk.gray("→ " + err.suggestion)}`);
    }
  }
  for (const warn of result.warnings) {
    const path = warn.path ? chalk.gray(warn.path) + "  " : "";
    console.log(`  ${chalk.yellow("WARNING")} ${path}${warn.message}`);
    if (warn.suggestion) {
      console.log(`            ${chalk.gray("→ " + warn.suggestion)}`);
    }
  }
}

/** What `up --json` collects while up runs (runServicesCommand fills it). */
interface UpReport {
  started: string[];
  failed: string[];
  alreadyRunning: string[];
  skipped: string[];
}

class DenCLI {
  /** Set while `up --json` runs. */
  private upReport: UpReport | null = null;

  private static readonly serviceCommands = new Set([
    "up",
    "down",
    "restart",
    "status",
    "logs",
    "services",
  ]);

  /**
   * Display the branded banner for the help screen.
   */
  private displayHelpBanner(): void {
    console.log();
    for (const line of DEN_BANNER_LINES) {
      console.log(chalk.cyan(line));
    }
    console.log();
    console.log(chalk.bold(DEN_HELP_DESCRIPTION));
    console.log(chalk.gray(DEN_DIVIDER));
    console.log();
  }

  /**
   * Main CLI loop
   */
  async run(): Promise<void> {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Dev-tooling telemetry: one `devtool.den.invocation` per CLI run. The
    // exit hook captures every termination path (normal completion,
    // process.exit, error) with the real exit code and writes the JSONL line
    // synchronously. `telCmd` is always a REGISTERED command name (never raw
    // argv — PII); it is refined once the args parse successfully.
    const stopTimer = startTimer();
    // The exit hook can't await a send; hand it to a detached sender.
    shipFromDetachedSender();
    let telCmd = telemetryCommandName(args.find((a) => !a.startsWith("-")));
    process.once("exit", (code) => {
      recordInvocation({
        command: telCmd,
        surface: "cli",
        durationMs: stopTimer(),
        exit: code,
      });
    });

    if (args.length > 0) {
      try {
        const parsed = parseCliArgs(args);
        telCmd = telemetryCommandName(parsed.command);
        this.applyGlobalFlags(parsed);
        this.prepareServiceCommand(parsed.command);
        await this.handleCommand(
          parsed.command ? [parsed.command, ...parsed.args] : [],
        );
      } catch (error) {
        recordFailure({
          command: telCmd,
          surface: "cli",
          reason: telemetryReason(error),
          durationMs: stopTimer(),
        });
        console.error(chalk.red(`\n❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
      return;
    }

    // Bare `den` shows help. The interactive menu is `den menu`
    // (what `make test` / `npm run cli` invoke).
    this.displayHelp();
    process.exit(0);
  }

  /**
   * Handle command line arguments
   */
  private applyGlobalFlags(parsed: ParsedCliArgs): void {
    if (parsed.flags.workspace) {
      const file = readWorkspacesFile();
      if (!file.workspaces[parsed.flags.workspace]) {
        throw new Error(`Workspace "${parsed.flags.workspace}" does not exist`);
      }
      if (
        workspaceFlagRequiresActive(parsed.command ?? "") &&
        !isWorkspaceActive(parsed.flags.workspace)
      ) {
        throw new Error(
          `Workspace "${parsed.flags.workspace}" is not active — run \`${product().cli} workspace activate ${parsed.flags.workspace}\` first`,
        );
      }
      process.env.DEN_WORKSPACE_OVERRIDE = parsed.flags.workspace;
    }

    if (parsed.flags.forceTabs !== undefined) {
      process.env.DEN_FORCE_TABS = parsed.flags.forceTabs ? "1" : "0";
    }

    if (parsed.flags.skipSecrets) {
      process.env.DEN_SKIP_SECRETS = "1";
    }
  }

  private prepareServiceCommand(command: string | undefined): void {
    if (!command || !DenCLI.serviceCommands.has(command)) return;
    ensureDaemonRegistryLoaded();
    cleanupStaleTabs();
  }

  private async handleCommand(args: string[]): Promise<void> {
    const command = args[0];

    // Args before the first `--` terminator are den's own; everything
    // after it is passthrough intended for a child command.
    const terminator = args.indexOf("--");
    const ownArgs = terminator === -1 ? args : args.slice(0, terminator);

    // `<command> -h/--help` → that command's help (every command supports it).
    // (`-h`/`--help` AS the command falls through to the switch → global help.)
    // A subcommand that prints its own help (`web sessions --help`, `mcp
    // connect --help`) is dispatched instead: its help wins.
    if (
      command &&
      !["-h", "--help", "-v", "--version"].includes(command) &&
      (ownArgs.includes("-h") || ownArgs.includes("--help")) &&
      !ownsSubcommandHelp(command, ownArgs[1])
    ) {
      this.printCommandHelp(command, ownArgs[1]);
      return;
    }

    // Mutation subcommands must not silently ignore a mistyped flag — a
    // typo'd --dry-run would otherwise perform a REAL bring-up.
    if (command) {
      const unknown = unknownCommandFlags(command, args.slice(1));
      if (unknown.length > 0) {
        console.log(
          chalk.red(
            `Unknown flag${unknown.length > 1 ? "s" : ""} for '${command}': ${unknown.join(", ")}`,
          ),
        );
        console.log(
          chalk.gray(
            `Run \`${product().cli} ${command} --help\` for accepted flags`,
          ),
        );
        process.exit(1);
      }
    }

    try {
      // A config that fails validation stops every command that touches
      // orgs, the catalog, clones or releases before it reads or writes
      // anything: some (sync over existing clones, register, workspace
      // create) never read `orgs:` and used to carry on (ORG-1d).
      if (command && configCheckedCommand(command)) assertDenConfigValid();
      // `down` is never stranded by an invalid config (0.3.0-dev.40): it
      // says so and stops from the daemon records and compose projects,
      // reading the config without its org data.
      if (command === "down") {
        try {
          assertDenConfigValid();
        } catch (e) {
          if (!isConfigError(e)) throw e;
          console.log(
            chalk.yellow(
              `\n  ⚠ ${e.message}\n  Stopping anyway, without the config's org data. Fix it, then \`${product().cli} validate\`.`,
            ),
          );
          waiveInvalidOrgs();
        }
      }

      switch (command) {
        case "run":
          await this.runTestsCommand(args.slice(1));
          break;

        case "view-results":
          await this.viewResultsCommand();
          break;

        case "menu":
          // Interactive menu (pillar/module/env picker). inquirer holds stdin
          // open after the last prompt, so exit explicitly when it returns.
          await this.interactiveMode();
          process.exit(0);
          break;

        case "web": {
          const sub = args[1];
          if (args.includes("--json") && (sub === "down" || sub === "stop")) {
            process.exitCode = await this.cmdWebDownJson(
              args.slice(1).filter((a) => a !== "--json"),
            );
            break;
          }
          if (
            args.includes("--json") &&
            (sub === undefined ||
              sub.startsWith("-") ||
              sub === "up" ||
              sub === "restart")
          ) {
            process.exitCode = await this.cmdWebUpJson(
              args.slice(1).filter((a) => a !== "--json"),
            );
            break;
          }
          await cmdWeb(args.slice(1));
          break;
        }

        // ── Environment manager commands ──────────────────────────────────
        case "up":
          if (args.slice(1).includes("--json"))
            process.exitCode = await this.cmdServiceUpJson(
              args.slice(1).filter((a) => a !== "--json"),
            );
          else await this.cmdServiceUp(args.slice(1));
          break;

        case "down":
          if (args.slice(1).includes("--json"))
            process.exitCode = await this.cmdServiceDownJson(
              args.slice(1).filter((a) => a !== "--json"),
            );
          else await this.cmdServiceDown(args.slice(1));
          break;

        case "restart":
          await this.cmdServiceRestart(args.slice(1));
          break;

        case "status":
          await this.cmdServiceStatus(args.slice(1));
          break;

        case "logs":
          await this.cmdLogs(args.slice(1));
          break;

        case "services":
          await this.cmdListServices();
          break;

        case "graph":
          await this.ensureWorkspaceSeeded();
          await cmdGraph(args.slice(1));
          break;

        case "register":
          await this.cmdRegister(args.slice(1));
          break;

        case "repo": {
          const { cmdRepo } = await import("./repo-command.js");
          process.exitCode = await cmdRepo(args.slice(1), validateManifest);
          break;
        }

        case "onboard": {
          const { cmdOnboard } = await import("./onboard-command.js");
          const { probeWebServer } = await import("./mcp-connect.js");
          process.exitCode = await cmdOnboard(args.slice(1), (u) =>
            probeWebServer(u),
          );
          break;
        }

        case "relocate":
          await this.cmdRelocate(args.slice(1));
          break;

        case "use-local":
          await this.cmdUseMode(args.slice(1), "dev-managed");
          break;

        case `use-managed`:
          await this.cmdUseMode(args.slice(1), "managed");
          break;

        case "setup":
          await this.cmdSetup(args.slice(1));
          break;

        case "workspace":
          await this.cmdWorkspace(args.slice(1));
          break;

        case "org":
          cmdOrg(args.slice(1));
          break;

        case "sync":
          await this.cmdSync(args.slice(1));
          break;

        case "init": {
          // In the den root, `init` seeds/resets the default workspace; pointed
          // at a service repo it scaffolds that repo's .den.yml (manifest init).
          const initTarget =
            args.slice(1).find((a) => !a.startsWith("-")) ?? getInvokeCwd();
          // Compare real paths: a symlinked tmp or home (/var → /private/var)
          // must not turn a seed into a manifest scaffold.
          const real = (p: string) => {
            try {
              return fs.realpathSync(nodePath.resolve(p));
            } catch {
              return nodePath.resolve(p);
            }
          };
          if (real(initTarget) === real(getDistRoot())) {
            await this.seedDefaultWorkspaceFlow(
              "init",
              args.slice(1).includes("--reset"),
              "init",
            );
          } else {
            await runInit(initTarget);
          }
          break;
        }

        case "validate":
          await this.cmdValidate(args.slice(1));
          break;

        case "create": {
          // bin/den routes `create` to its own entry (it needs no den.yml);
          // this covers the CLI run directly from a checkout.
          const code = await runCreate(args.slice(1), getInvokeCwd());
          if (code !== 0) process.exit(code);
          break;
        }

        case "local-dev":
          await this.cmdLocalDev(args[1]);
          break;

        case "config":
          await cmdConfig(args.slice(1));
          break;

        case "edge":
          await cmdEdge(args.slice(1));
          break;

        case "doctor":
          process.exitCode = await cmdDoctor(args.slice(1));
          break;

        case "service":
          process.exitCode = await cmdService(args.slice(1));
          break;

        case "stack":
          await cmdStack(args.slice(1));
          break;

        case "theme":
          process.exitCode = await cmdTheme(args.slice(1));
          break;

        case "plugin":
          process.exitCode = await cmdPlugin(args.slice(1));
          break;

        case "apps":
        case "applications":
          await this.ensureWorkspaceSeeded();
          cmdApps(args.slice(1));
          break;

        case "sessions":
          process.exitCode = await cmdSessions(args.slice(1));
          break;

        case "agents":
          process.exitCode = await cmdAgents(args.slice(1));
          break;

        case "usage":
          process.exitCode = await cmdUsage(args.slice(1));
          break;

        case "hub":
          process.exitCode = await cmdHub(args.slice(1));
          break;

        case "mcp": {
          // Setup subcommands: register the server with agents.
          const { MCP_CONNECT_SUBCOMMANDS, runMcpConnect } =
            await import("./mcp-connect.js");
          if (
            (MCP_CONNECT_SUBCOMMANDS as readonly string[]).includes(
              args[1] ?? "",
            )
          ) {
            process.exitCode = await runMcpConnect(args.slice(1));
            break;
          }
          // bin/den routes `mcp` to its own entry (stdout is the protocol);
          // this covers the CLI run directly from a checkout.
          await import("./mcp-stdout-guard.js");
          const { runMcp } = await import("../mcp/server.js");
          await runMcp(args.slice(1));
          break;
        }

        case "--help":
        case "-h":
          this.displayHelp();
          break;

        case "--version":
        case "-v":
          this.displayVersion();
          break;

        default:
          console.log(chalk.red(`Unknown command: ${command}`));
          console.log(chalk.gray("Run with --help for usage information"));
          process.exit(1);
      }
    } catch (error) {
      recordFailure({
        command: telemetryCommandName(command),
        surface: "cli",
        reason: telemetryReason(error),
      });
      console.error(chalk.red(`\n❌ Error: ${(error as Error).message}`));
      process.exit(1);
    }
  }

  /**
   * Interactive mode
   */
  private async interactiveMode(): Promise<void> {
    let running = true;

    while (running) {
      try {
        const action = await cliPrompts.promptForMainAction();

        switch (action) {
          case "run":
            await this.runTestsInteractive();
            break;

          case "results":
            await this.openHtmlReport();
            break;

          case "exit":
            running = false;
            console.log(chalk.cyan("\n👋 Goodbye!\n"));
            break;
        }
      } catch (error) {
        if ((error as { isTtyError?: boolean }).isTtyError) {
          console.error(
            chalk.red("Prompt could not be rendered in this environment"),
          );
          process.exit(1);
        } else {
          console.error(chalk.red(`\n❌ Error: ${(error as Error).message}\n`));
        }
      }
    }
  }

  /**
   * Run tests (interactive)
   */
  private async runTestsInteractive(): Promise<void> {
    const pillar = await cliPrompts.promptForPillar();

    // Ask which module to test (works for all pillars)
    const module = await cliPrompts.promptForModule(pillar);

    // Handle "Back" selection — return to main menu
    if (module === "back") {
      return;
    }

    // For smoke: if a specific service was chosen (not "all"), ask for collection
    let smokeCollection: string | undefined;
    if (pillar === "smoke" && module !== null) {
      const collection = await cliPrompts.promptForSmokeCollection(module);
      if (collection === "back") {
        return;
      }
      smokeCollection = collection ?? undefined;
    }

    const environment = await cliPrompts.promptForEnvironment();

    // Verify environment config exists
    try {
      await envSelector.loadEnvironment(environment);
    } catch (error) {
      console.log(
        chalk.red(`\n❌ Environment config not found for: ${environment}\n`),
      );
      return;
    }

    // Run tests
    try {
      const modules =
        pillar === "performance"
          ? resolvePerformanceModules({
              availableModules: await moduleScanner.scanModules("performance"),
              selectedModule: module,
            })
          : module
            ? [module]
            : undefined;

      await testRunner.runTests({
        pillar,
        environment,
        modules,
        smokeCollection,
        baseApiUrl: resolveCliBaseApiUrl(),
      });
    } catch (error) {
      console.error(
        chalk.red(`\n❌ Test execution failed: ${(error as Error).message}\n`),
      );
    }
  }

  /**
   * Run tests (command)
   */
  private async runTestsCommand(args: string[]): Promise<void> {
    // Parse arguments
    const pillarArg = args.find((arg) => arg.startsWith("--pillar="));
    const envArg = args.find((arg) => arg.startsWith("--environment="));
    const moduleArgs = args
      .filter((arg) => arg.startsWith("--module="))
      .map((arg) => arg.split("=")[1])
      .filter(Boolean);
    const repoArg = args.find((arg) => arg.startsWith("--repo="));
    const baseApiUrlArg = args.find((arg) => arg.startsWith("--baseApiUrl="));
    const useLocalCheckout = args.includes("--use-local-checkout");

    if (pillarArg && envArg) {
      const pillar = pillarArg.split("=")[1] as Pillar;
      const environment = envArg.split("=")[1] as Environment;
      const baseApiUrl = baseApiUrlArg?.split("=")[1];

      let modules: string[] | undefined;
      if (pillar === "performance") {
        if (moduleArgs.length > 0) {
          modules = moduleArgs;
        } else {
          modules = resolvePerformanceModules({
            availableModules: await moduleScanner.scanModules("performance"),
            selectedModule: null,
            repoName: repoArg?.split("=")[1] ?? null,
          });
        }
      } else {
        modules = moduleArgs.length > 0 ? moduleArgs : undefined;
      }

      // Run tests
      try {
        await testRunner.runTests({
          pillar,
          environment,
          modules,
          baseApiUrl: resolveCliBaseApiUrl(baseApiUrl),
          useLocalCheckout,
        });
      } catch (error) {
        console.error(
          chalk.red(
            `\n❌ Test execution failed: ${(error as Error).message}\n`,
          ),
        );
        process.exit(1);
      }

      return;
    }

    // No arguments, go interactive
    await this.runTestsInteractive();
  }

  /**
   * Open HTML report
   */
  private async openHtmlReport(): Promise<void> {
    console.log(chalk.cyan("\n📊 Opening interactive test report...\n"));

    const { spawn } = await import("child_process");

    const reportProcess = spawn(
      engineBin("playwright"),
      ["show-report", "playwright-report"],
      {
        cwd: getDistRoot(),
        stdio: "inherit",
      },
    );

    await new Promise<void>((resolve, reject) => {
      reportProcess.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else if (code === 1) {
          console.log(chalk.yellow("\n⚠️  No test report found."));
          console.log(chalk.gray("Run some tests first:\n"));
          console.log(chalk.cyan("  make test-basic    # Run basic tests"));
          console.log(chalk.cyan("  make test-auth     # Run auth tests"));
          console.log(
            chalk.cyan("  make test          # Interactive test runner\n"),
          );
          resolve();
        } else {
          reject(new Error(`Report viewer exited with code ${code}`));
        }
      });

      reportProcess.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * View results (interactive)
   */
  private async viewResultsInteractive(): Promise<void> {
    const days = await cliPrompts.promptForResultsDays();

    const spinner = ora("Loading results...").start();

    try {
      spinner.stop();
      await resultsViewer.displaySummary(days);
    } catch (error) {
      spinner.fail(chalk.red("Failed to load results"));
      throw error;
    }
  }

  /**
   * View results (command)
   */
  private async viewResultsCommand(): Promise<void> {
    await this.viewResultsInteractive();
  }

  // ── Environment manager: interactive sub-menu ──────────────────────────────

  /**
   * Clone any managed repos in the active workspace that don't exist on disk yet.
   * Works from workspace config + catalog only — no manifest needed — so it's safe
   * to call before manifests are readable (i.e. the bootstrap / setup scenario).
   */
  private cloneMissingManagedRepos(): void {
    const ws = getActiveWorkspace();
    if (!ws) return;
    const catalog = readCatalog();

    for (const [address, wsEntry] of Object.entries(ws.config.services)) {
      if (wsEntry.mode !== "managed") continue;
      const { repoName } = parseAddress(address);
      const catalogEntry = catalog[repoName];
      if (!catalogEntry) continue;
      const branch = wsEntry.branch ?? "main";
      try {
        // An entry with `gh: ""` clones from the workspace's org, as `up`
        // does (and `setup --plan` says), instead of failing on an empty slug.
        // ORG-1d: a repo with no source and a `remote:` clones from it.
        const ghSlug = resolveRepoCloneSource(repoName, catalog, () =>
          githubOrgFor(ws.name),
        );
        if (needsGhRepair(catalogEntry, ghSlug))
          upsertCatalogEntry(repoName, { ...catalogEntry, gh: ghSlug });
        ensureManagedServiceClone(repoName, ghSlug, branch);
      } catch (err) {
        console.log(
          chalk.red(
            `  ✗ Failed to clone ${repoName}: ${(err as Error).message}`,
          ),
        );
      }
    }
  }

  /**
   * `den up --pull`: fast-forward managed clones in the start set
   * before bringing them up. Dev-managed repos are the developer's own checkout
   * and are never touched. Missing clones are skipped (they get freshly cloned
   * anyway). Fast-forward-only never clobbers — a diverged clone is reported and
   * left as-is, and the up proceeds on whatever commit is checked out.
   */
  private pullManagedClonesFor(repoNames: string[]): void {
    const ws = getActiveWorkspace();
    if (!ws) return;
    const want = new Set(repoNames);
    const seen = new Set<string>();
    let any = false;
    for (const [address, wsEntry] of Object.entries(ws.config.services)) {
      if (wsEntry.mode !== "managed") continue;
      const { repoName } = parseAddress(address);
      if (!want.has(repoName) || seen.has(repoName)) continue;
      seen.add(repoName);
      const branch = wsEntry.branch ?? "main";
      const cloneDir = nodePath.join(DEN_SERVICES_DIR, repoName, branch);
      if (!fs.existsSync(cloneDir)) continue; // missing → freshly cloned below
      any = true;
      const spinner = ora(`pull ${chalk.bold(repoName)}...`).start();
      const r = fetchAndFastForward(cloneDir);
      if (r.pulled) {
        spinner.succeed(
          `pulled ${chalk.bold(repoName)} (+${r.behind} commit${r.behind === 1 ? "" : "s"})`,
        );
      } else if (r.behind === 0) {
        spinner.succeed(`${chalk.bold(repoName)} up to date`);
      } else if (r.behind === -1) {
        spinner.warn(
          `${chalk.bold(repoName)} — no upstream / unreachable, skipped`,
        );
      } else {
        spinner.fail(
          `pull ${chalk.bold(repoName)} — ${r.behind} behind but fast-forward failed`,
        );
        console.log(
          chalk.yellow(
            `    Diverged or local changes in ${cloneDir}. Resolve manually ` +
              `(or \`${product().cli} sync\`); starting on the current commit.`,
          ),
        );
      }
    }
    if (any) console.log();
  }

  /**
   * Ensure the managed repos in `repoNames` are cloned AND set up before
   * we try to run their `make up`. Only clones repos whose clone dir is MISSING —
   * never pulls an existing clone (that's `den sync`'s job; an implicit pull
   * mid-up would be surprising and could fail on local changes). For each freshly
   * cloned repo it runs setup hidden + non-interactive (mirroring the web UX)
   * rather than popping a Terminal window. Returns the repo names that failed to
   * clone or set up so the caller can fail-fast.
   */
  private async ensureManagedClonesFor(repoNames: string[]): Promise<string[]> {
    const ws = getActiveWorkspace();
    if (!ws) return [];
    const catalog = readCatalog();
    const want = new Set(repoNames);
    const handled = new Set<string>();
    const failed: string[] = [];
    // Repos that need setup run/re-run: freshly cloned, OR cloned previously but
    // never verifiably set up (no success marker — e.g. a prior setup failed).
    const needsSetup: { repoName: string; repoPath: string }[] = [];

    for (const [address, wsEntry] of Object.entries(ws.config.services)) {
      if (wsEntry.mode !== "managed") continue;
      const { repoName } = parseAddress(address);
      if (!want.has(repoName) || handled.has(repoName)) continue;
      const branch = wsEntry.branch ?? "main";
      const cloneDir = nodePath.join(DEN_SERVICES_DIR, repoName, branch);
      handled.add(repoName);

      if (fs.existsSync(cloneDir)) {
        // Already cloned. Only re-run setup when it hasn't verifiably succeeded
        // (no marker) AND the repo actually has a setup command — so a clone
        // whose setup previously failed is repaired instead of started broken.
        if (!hasSetupSucceeded(cloneDir) && hasSetupCommand(cloneDir)) {
          needsSetup.push({ repoName, repoPath: cloneDir });
        }
        continue;
      }

      // Catalog entries written by the dev-managed add flow carry `gh: ""`, so
      // an entry can exist yet be unclonable. Derive the conventional slug and
      // persist the repair rather than cloning from an empty URL.
      // ORG-1d: a repo with no source and a `remote:` clones from it.
      const ghSlug = resolveRepoCloneSource(repoName, catalog, () =>
        githubOrgFor(ws.name),
      );
      if (needsGhRepair(catalog[repoName], ghSlug))
        upsertCatalogEntry(repoName, { ...catalog[repoName], gh: ghSlug });
      try {
        // runSetup=false: clone only — setup is run below, hidden + non-interactive.
        ensureManagedServiceClone(repoName, ghSlug, branch, false);
        // Fill placeholder secrets from another checkout of the same repo
        // before setup runs — see seedSecretsFromSibling.
        const seeded = seedSecretsFromSibling(repoName, cloneDir);
        if (seeded) {
          console.log(
            chalk.gray(
              `  ↳ filled ${seeded.filled.length} local secret(s) from ${seeded.donorPath}: ${seeded.filled.join(", ")}`,
            ),
          );
        }
        needsSetup.push({ repoName, repoPath: cloneDir });
      } catch (err) {
        console.log(
          chalk.red(
            `  ✗ Failed to clone ${repoName}: ${(err as Error).message}`,
          ),
        );
        failed.push(repoName);
      }
    }

    // Run setup non-interactively (no Terminal windows). The non-interactive env
    // (CI/HUSKY/git creds) lets it run unattended; GUI auth (1Password Touch ID)
    // may still surface. On failure, surface the actual error output (the tail,
    // including stderr) so the user sees WHY — not just a bare exit code — and
    // record nothing, so the next `den up` retries instead of starting broken.
    // If it stalled on an interactive prompt, offer an in-terminal re-run so the
    // user can answer it without leaving `den up`.
    for (const { repoName, repoPath } of needsSetup) {
      const spinner = ora(`setup ${chalk.bold(repoName)}...`).start();
      const tail: string[] = [];
      const { code, stalledPrompt } = await runSetupHidden(repoPath, (line) => {
        tail.push(line);
        if (tail.length > 25) tail.shift();
        spinner.text = `setup ${chalk.bold(repoName)}: ${chalk.gray(line.slice(0, 80))}`;
      });
      if (code === 0) {
        markSetupSucceeded(repoPath);
        spinner.succeed(`setup ${chalk.bold(repoName)}`);
      } else if (stalledPrompt) {
        spinner.fail(
          `setup ${chalk.bold(repoName)} needs an interactive terminal`,
        );
        // The hidden child is already dead (stall guard killed its process
        // group) and setups run one at a time in the foreground, so the
        // terminal is free. The confirm auto-declines after a timeout so an
        // unattended pty can never hang `up` (the guarantee d64bacb made).
        const recovered = await recoverStalledSetup(
          repoName,
          repoPath,
          stalledPrompt,
          {
            isInteractive: () =>
              !!(process.stdin.isTTY && process.stdout.isTTY),
            confirm: (message) =>
              confirmWithTimeout(message, STALLED_SETUP_CONFIRM_TIMEOUT_MS),
            runSetupInteractive,
            markSetupSucceeded,
            log: (line) => console.log(line),
          },
        );
        if (!recovered) failed.push(repoName);
      } else {
        spinner.fail(`setup ${chalk.bold(repoName)} failed (exit ${code})`);
        console.log(
          chalk.red(`\n  ── setup output for ${repoName} (last lines) ──`),
        );
        for (const l of tail) console.log(chalk.gray(`  │ ${l}`));
        console.log(
          chalk.red(`  ───────────────────────────────────────────────`),
        );
        console.log(
          chalk.yellow(
            `  Fix setup in ${repoPath}, then re-run \`${product().cli} up\` ` +
              `(or \`${product().cli} setup ${repoName}\`).\n`,
          ),
        );
        failed.push(repoName);
      }
    }

    return failed;
  }

  /** The workspace a command acts on: -w override, else the focused one. */
  private focusedWs(): string {
    return (
      process.env.DEN_WORKSPACE_OVERRIDE ??
      getFocusedWorkspaceName() ??
      "default"
    );
  }

  /** Return addresses from the workspace that have the given local command in their manifest. */
  private workspaceAddressesWithCommand(command: string): string[] {
    return getWorkspaceServices()
      .filter((s) => !!localCommandsFor(s, this.focusedWs())[command])
      .map((s) => s.address);
  }

  private async manageWorkspacesInteractive(): Promise<void> {
    let running = true;
    while (running) {
      const action = await cliPrompts.promptForWorkspaceAction();
      const file = readWorkspacesFile();

      switch (action) {
        case "list":
          await this.cmdWorkspace(["list"]);
          break;
        case "use": {
          const names = Object.keys(file.workspaces);
          const selected = await cliPrompts.promptSelectWorkspace(
            names,
            file.focus ?? file.active[0],
          );
          setActiveWorkspace(selected);
          console.log(
            chalk.green(
              `\n  ✓ Activated and focused workspace: ${chalk.bold(selected)}\n`,
            ),
          );
          break;
        }
        case "create": {
          const name = await cliPrompts.promptForWorkspaceName(
            Object.keys(file.workspaces),
          );
          createWorkspace(name, { services: {} });
          const activate = await cliPrompts.confirm(
            `Switch to workspace "${name}" now?`,
            true,
          );
          if (activate) setActiveWorkspace(name);
          console.log(
            chalk.green(`\n  ✓ Created workspace: ${chalk.bold(name)}\n`),
          );
          break;
        }
        case "add-service":
          // Register handles the full flow: path → gh slug → mode/branch → workspace entry
          await this.cmdRegister([]);
          break;
        case "remove-service": {
          const ws = getActiveWorkspace();
          if (!ws) {
            console.log(chalk.red("\n  No active workspace.\n"));
            break;
          }

          const existing = Object.keys(ws.config.services);
          if (existing.length === 0) {
            console.log(chalk.yellow("\n  No services in this workspace.\n"));
            break;
          }

          const selected = await cliPrompts.promptSelectServices(
            existing,
            `Remove from workspace "${ws.name}":`,
          );
          if (selected.length === 0) break;

          const updatedFile = readWorkspacesFile();
          for (const addr of selected) {
            delete updatedFile.workspaces[ws.name].services[addr];
          }
          writeWorkspacesFile(updatedFile);
          console.log(
            chalk.green(
              `\n  ✓ Removed ${selected.length} service(s) from ${ws.name}\n`,
            ),
          );
          break;
        }
        case "delete": {
          const names = Object.keys(file.workspaces).filter(
            (n) => n !== "default",
          );
          if (names.length === 0) {
            console.log(
              chalk.yellow(
                "\n  No workspaces to delete (cannot delete default).\n",
              ),
            );
            break;
          }
          const name = await cliPrompts.promptSelectWorkspace(names, "");
          const confirmed = await cliPrompts.confirm(
            `Delete workspace "${name}"?`,
            false,
          );
          if (!confirmed) break;
          deleteWorkspaceDirectory(name);
          deleteWorkspaceConfig(name);
          console.log(chalk.green(`\n  ✓ Deleted workspace: ${name}\n`));
          break;
        }
        case "back":
          running = false;
          break;
      }
    }
  }

  // ── Environment manager: non-interactive commands ─────────────────────────

  /** Run a named command (up/down/restart) on one or more service addresses. */
  private async runServicesCommand(
    addresses: string[],
    command: string,
    plan?: {
      /** Pre-computed run order (from the derived graph) — skips manifest topo. */
      order: string[];
      /** Hard deps to block on per address (derived), replacing manifest wait. */
      waitDepsFor?: (address: string) => string[];
      /** Abort the whole flow on the first failure (derived `up`). */
      failFast?: boolean;
      /** Skip ANY already-healthy node (derived `up` starts only what's down). */
      skipHealthyAll?: boolean;
    },
    opts?: {
      force?: boolean;
      /**
       * What the user named on the command line (repo or address). A remote
       * service among them is refused with a non-zero exit; one reached only
       * as part of a workspace or app run is said and skipped.
       */
      named?: readonly string[];
      /**
       * `-n`/`--dry-run` (and `--plan` on this path): print what would run,
       * in order, and run nothing. Read-only on every path.
       */
      dryRun?: boolean;
      /** `--plan`: a preview that would run nothing exits 1. */
      plan?: boolean;
    },
  ): Promise<void> {
    // How long to show startup output before handing control back to the menu
    // for detachable (long-running) commands like `up`.
    const DETACH_WINDOW_MS = 4000;
    const workspace =
      process.env.DEN_WORKSPACE_OVERRIDE ??
      getFocusedWorkspaceName() ??
      undefined;
    const force = opts?.force ?? false;
    // R13: why a remote service is not run here, or null.
    const remoteRefusal = (address: string): string | null => {
      const placed = resolveService(address, workspace);
      return placed
        ? placementRefusal(
            address,
            servicePlacement(
              readManifest(placed.repoPath),
              placed.subsystem,
              "local",
            ),
            (e) => isProductionEnv(e),
            command,
          )
        : null;
    };

    // Resolve dependency order. Derived mode supplies the order directly;
    // otherwise topo-sort manifest depends_on (`down` → reverse).
    let ordered = addresses;
    if (plan) {
      ordered = plan.order;
    } else {
      try {
        const catalog = readCatalog();
        const ws = getActiveWorkspace();
        const startupOrder = ws
          ? resolveStartupOrder(addresses, catalog, ws.config, ws.name)
          : addresses;
        // Only up pulls in dependencies (a service needs them to start).
        // Down and restart act on what was named: its dependencies may be
        // serving other running services.
        const namedOnly = (): string[] => {
          const kept = startupOrder.filter((a) => addresses.includes(a));
          return [...kept, ...addresses.filter((a) => !kept.includes(a))];
        };
        if (command === "down") {
          ordered = namedOnly().reverse();
        } else if (command !== "up") {
          ordered = namedOnly();
        } else {
          ordered = startupOrder;
          if (ordered.length > addresses.length) {
            const added = ordered.filter((a) => !addresses.includes(a));
            console.log(
              chalk.gray(`\n  Including dependencies: ${added.join(", ")}\n`),
            );
          }
        }
      } catch (e: unknown) {
        console.log(chalk.red(`\n  ⚠ ${(e as Error).message}\n`));
        return;
      }
    }

    if (opts?.dryRun) {
      // The same lookup a real run makes, so the dry run says what it does.
      const previews = ordered.map((a): ServiceCommandPreview => {
        const remote = remoteRefusal(a);
        if (!remote) {
          const p = previewServiceCommand(a, command, workspace);
          // What up does first about a pre-dev.37 record or a held port.
          return (
            (command === "up" && p.kind === "run"
              ? previewUpSettle(a, workspace)
              : null) ?? p
          );
        }
        // As the loop below: a named remote target fails, any other is
        // said and skipped.
        return isNamedTarget(a, opts?.named ?? [])
          ? { kind: "error", address: a, note: remote }
          : {
              kind: "nothing",
              address: a,
              note: `${a} (remote, skipped): ${remote}`,
            };
      });
      const doing =
        { up: "starting", down: "stopping", restart: "restarting" }[command] ??
        `running "${command}" on`;
      const runs = previews
        .filter((p) => p.kind === "run" || p.kind === "via-repo")
        .map((p) => p.address);
      console.log(
        chalk.cyan(
          `\n  Would ${command}: ${[...new Set(runs)].join(" → ") || "(nothing)"}`,
        ),
      );
      for (const p of previews) {
        if (p.kind !== "error" && p.note)
          console.log(chalk.gray(`  ${p.note}`));
        if (p.kind === "error") console.log(chalk.red(`  ✗ ${p.note}`));
      }
      // R16: key names only. A dry run never asks the secrets provider.
      for (const a of new Set(runs)) {
        const sec = previewServiceSecretEnv(a, command, workspace);
        if (!sec) continue;
        const parts = [
          ...(sec.service.length ? [sec.service.join(", ")] : []),
          ...(sec.compose.length ? [`compose: ${sec.compose.join(", ")}`] : []),
        ];
        console.log(
          chalk.gray(
            `  ${sec.address}: would inject secret_env ${parts.join("; ")} (names only; not resolved in a dry run)`,
          ),
        );
      }
      if (previews.some((p) => p.kind === "error")) process.exitCode = 1;
      if (opts?.plan && runs.length === 0) process.exitCode = 1;
      console.log(chalk.gray(`  (--dry-run: not ${doing} anything)\n`));
      return;
    }

    // Build a catalog + workspace reference once per run for readiness lookups.
    const catalog = readCatalog();
    const ws = getActiveWorkspace();
    // Derived `up` treats every node as a dependency, so any already-healthy
    // node may be skipped; otherwise only non-seed deps are skip-eligible.
    const seedAddresses = plan?.skipHealthyAll
      ? new Set<string>()
      : new Set(addresses);
    const runtime = resolveServiceRuntime(command);

    // Fail-fast transparency: a partial abort intentionally leaves earlier
    // nodes running (they're often useful for debugging the failure) — but we
    // must SAY so, and post-detach service deaths must still trip fail-fast.
    const startedThisRun: string[] = [];
    const lateFailures = new Map<string, number>();
    const printPartialState = (): void => {
      if (startedThisRun.length === 0) return;
      console.log(
        chalk.yellow(
          `  Left running from this run: ${startedThisRun.join(", ")}`,
        ),
      );
      console.log(chalk.gray(`  Stop them with: ${product().cli} down`));
    };

    for (const address of ordered) {
      // A previously-detached service that has since died non-zero defeats the
      // point of continuing — its dependents will fail on a missing dep.
      if (plan?.failFast && lateFailures.size > 0) {
        const [failedAddr, code] = [...lateFailures.entries()][0];
        console.log(
          chalk.red(
            `  ✗ ${chalk.bold(failedAddr)} exited (${code}) after detaching — aborting (fail-fast).`,
          ),
        );
        printPartialState();
        return;
      }
      // R13: a remote service is never started or stopped from here. Said,
      // not failed, so a workspace or app up/down carries on past it.
      const remote = remoteRefusal(address);
      if (remote) {
        if (isNamedTarget(address, opts?.named ?? [])) {
          console.log(chalk.red(`  ✗ ${remote}`));
          process.exitCode = 1;
          this.upReport?.failed.push(address);
        } else {
          console.log(chalk.gray(`  • ${remote}`));
          this.upReport?.skipped.push(address);
        }
        continue;
      }
      if (command === "up" && !seedAddresses.has(address)) {
        const resolved = resolveService(address, workspace);
        if (resolved) {
          const health = await checkServiceHealth(resolved, "local");
          // `conflict`: a shared stack namespace runs another checkout's
          // project; the real up below refuses it, naming both.
          const claim =
            health.health === "ok" && workspace
              ? claimHealthyService(resolved, workspace, printNotice)
              : "untracked";
          // Healthy, but another process answers on its port: said (above),
          // never claimed, and nothing is started on top of it.
          if (health.health === "ok" && claim === "busy") {
            console.log(
              chalk.red(
                `  ✗ ${chalk.bold(address)} not started: its port is in use by a process ${product().cli} won't adopt`,
              ),
            );
            // A dependency only warns; the service you named failed.
            if (isNamedTarget(address, opts?.named ?? [])) process.exitCode = 1;
            this.upReport?.failed.push(address);
            continue;
          }
          if (health.health === "ok" && claim !== "conflict") {
            // Skipping must not lose the refcount — this workspace is an owner
            // of what's running, whether den tracked it or not.
            const suffix =
              claim === "adopted"
                ? " (adopted its running containers)"
                : claim === "attached"
                  ? ` (owned by "${workspace}" too)`
                  : "";
            console.log(
              chalk.gray(
                `  • ${chalk.bold(address)} already healthy — skipping dependency up${suffix}`,
              ),
            );
            if (command === "up") this.upReport?.alreadyRunning.push(address);
            continue;
          }
        }
      }

      // Block on any `wait: true` deps before starting this service on up/restart.
      if ((command === "up" || command === "restart") && ws) {
        const waitDeps = plan?.waitDepsFor
          ? plan.waitDepsFor(address)
          : getWaitDeps(address, catalog, ws.config, ws.name);
        let readinessFailed = false;
        for (const depAddr of waitDeps) {
          const depResolved = resolveService(depAddr);
          if (!depResolved) {
            console.log(
              chalk.yellow(
                `  ⚠ wait dep ${depAddr} not resolvable — skipping readiness check`,
              ),
            );
            continue;
          }
          const spinner = ora(
            `waiting for ${chalk.bold(depAddr)} to be ready…`,
          ).start();
          const result = await waitForReady(depResolved, "local", {
            onTick: (detail) => {
              spinner.text = `waiting for ${chalk.bold(depAddr)}: ${chalk.gray(detail)}`;
            },
          });
          if (!result.ok) {
            spinner.fail(
              `${chalk.bold(depAddr)} not ready after ${Math.round(result.elapsedMs / 1000)}s (${result.detail ?? "timeout"})`,
            );
            readinessFailed = true;
            break;
          }
          spinner.succeed(
            result.skipped
              ? `${chalk.bold(depAddr)} (no health check — proceeding)`
              : `${chalk.bold(depAddr)} ready (${Math.round(result.elapsedMs / 1000)}s)`,
          );
        }
        if (readinessFailed) {
          console.log(
            chalk.red(
              `  ✗ ${command} ${chalk.bold(address)} — blocked on readiness`,
            ),
          );
          if (plan?.failFast) {
            console.log(
              chalk.red(
                `  Aborting (fail-fast): a dependency did not become ready.`,
              ),
            );
            printPartialState();
            return;
          }
          continue;
        }
      }

      // R16: resolve the service's secret_env before anything spawns. A
      // missing key fails this target; nothing starts with a partial set.
      const secrets = await prepareServiceSecretEnv(
        address,
        command,
        workspace,
      );

      const started = await new Promise<boolean>((resolve) => {
        if (!secrets.ok) {
          console.log(chalk.red(`  ✗ ${command} ${chalk.bold(address)}`));
          for (const l of secrets.message.split("\n"))
            console.log(chalk.gray(`      ${l}`));
          resolve(false);
          return;
        }
        const spinner = ora(`${command} ${chalk.bold(address)}...`).start();
        let detachTimer: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        // Keep the tail of the command's output. onLine only updates the
        // transient spinner text, so on failure the actual reason (e.g.
        // "could not read .den.yml in <path>") vanished with the spinner and
        // the user saw a bare "exit 1" — which is exactly how a broken fresh
        // checkout looked like an inexplicable mass failure.
        const lastLines: string[] = [];
        let result: ReturnType<typeof runServiceCommand> | null = null;
        let detachable = false;
        let interactive = false;
        // A down that found nothing to stop is said as such, never as ✔.
        let downOutcome: DownOutcome | null = null;

        const settleFromClose = (exitCode: number): void => {
          if (settled) return;
          settled = true;
          if (detachTimer) clearTimeout(detachTimer);
          if (interactive) {
            // Reprint the result line after the interactive session ends.
            if (exitCode === 0) {
              console.log(chalk.green(`  ✓ ${command} ${chalk.bold(address)}`));
            } else {
              console.log(
                chalk.red(
                  `  ✗ ${command} ${chalk.bold(address)} (exit ${exitCode})`,
                ),
              );
            }
          } else if (exitCode === 0 && downOutcome === "nothing-recorded") {
            spinner.info(
              `${command} ${chalk.bold(address)} ${chalk.gray("(nothing to stop)")}`,
            );
          } else if (exitCode === 0 && downOutcome === "unstoppable") {
            spinner.warn(
              `${command} ${chalk.bold(address)} ${chalk.yellow("(could not stop it)")}`,
            );
            for (const l of lastLines) {
              console.log(chalk.gray(`      ${l}`));
            }
          } else if (exitCode === 0) {
            spinner.succeed(`${command} ${chalk.bold(address)}`);
          } else {
            spinner.fail(
              `${command} ${chalk.bold(address)} (exit ${exitCode})`,
            );
            for (const l of lastLines) {
              console.log(chalk.gray(`      ${l}`));
            }
          }
          resolve(exitCode === 0);
        };

        const settleAsBackground = (): void => {
          if (settled) return;
          settled = true;

          // Detachable daemon mode returns a tail process for startup streaming.
          // Stop that tail only; the service itself was already daemonized.
          const kill = (
            result?.proc as
              | { kill?: (signal?: NodeJS.Signals) => boolean }
              | undefined
          )?.kill;
          try {
            kill?.call(result?.proc, "SIGTERM");
          } catch {
            /* best-effort tail cleanup */
          }

          // The service process may have already died non-zero INSIDE the
          // detach window (onServiceExit) — that's a start failure, not a
          // background success.
          const lateExit = lateFailures.get(address);
          if (lateExit !== undefined) {
            spinner.fail(
              `${command} ${chalk.bold(address)} (service exited ${lateExit} during startup)`,
            );
            resolve(false);
            return;
          }
          spinner.succeed(
            `${command} ${chalk.bold(address)} ${chalk.gray("(running in background)")}`,
          );
          resolve(true);
        };

        result = runServiceCommand({
          address,
          command,
          runtime,
          workspace,
          force: command === "down" ? force : false,
          // Down fails when it cannot stop a service the user named; one
          // reached as part of a workspace-wide down warns instead.
          explicit: isNamedTarget(address, opts?.named ?? []),
          onDownOutcome: (outcome) => {
            downOutcome = outcome;
          },
          secretEnv: secrets.secretEnv,
          onLine: (line) => {
            // What Den decided about a record or a port is said, not
            // only flashed in the spinner (0.3.0-dev.39).
            if (isNotice(line)) {
              spinner.clear();
              printNotice(line);
              if (spinner.isEnabled) spinner.render();
            }
            spinner.text = `${command} ${chalk.bold(address)}: ${chalk.gray(line.slice(0, 80))}`;
            const trimmed = line.trim();
            if (trimmed) {
              lastLines.push(trimmed.slice(0, 160));
              if (lastLines.length > 3) lastLines.shift();
            }
          },
          onClose: (exitCode) => {
            settleFromClose(exitCode);
          },
          // Daemon mode settles via the detach timer + tail close — never the
          // service's real exit. Record non-zero service deaths so a failure
          // inside OR after the detach window still trips fail-fast.
          onServiceExit: (exitCode) => {
            if (exitCode !== 0 && (command === "up" || command === "restart")) {
              lateFailures.set(address, exitCode);
            }
          },
        });
        if (settled) return;

        detachable = result.detachable;
        interactive = result.interactive;

        if (interactive) {
          // HITL — suspend the spinner immediately so the TTY is clean for user input.
          spinner.stop();
          console.log(
            chalk.cyan(
              `\n  ↳ Interactive setup for ${chalk.bold(address)} — follow the prompts below:`,
            ),
          );
          console.log(chalk.gray("  " + "─".repeat(60)));
          return; // onClose drives resolve()
        }

        // Only use the detach timer for long-running startup commands.
        // `down` and all other teardown commands must run to completion before
        // moving to the next service — concurrent Docker teardowns conflict.
        if (detachable && (command === "up" || command === "restart")) {
          detachTimer = setTimeout(settleAsBackground, DETACH_WINDOW_MS);
        }
      });

      // Any target that failed makes the whole command fail (scripts and
      // agents read the exit code).
      if (!started) process.exitCode = 1;
      if (command === "up")
        this.upReport?.[started ? "started" : "failed"].push(address);
      if (plan?.failFast && !started) {
        console.log(
          chalk.red(
            `  Aborting (fail-fast): ${chalk.bold(address)} failed to start.`,
          ),
        );
        printPartialState();
        return;
      }
      if (started && (command === "up" || command === "restart")) {
        startedThisRun.push(address);
      }
    }

    // Post-run sweep: even without fail-fast, surface services that detached
    // "successfully" but whose process has since exited non-zero.
    if (lateFailures.size > 0) {
      for (const [addr, code] of lateFailures) {
        if (startedThisRun.includes(addr)) {
          console.log(
            chalk.yellow(
              `  ⚠ ${chalk.bold(addr)} exited (${code}) after detaching — check its log (${product().cli} web → /logs).`,
            ),
          );
        }
      }
    }
  }

  private resolveNoArgServiceTargets(
    command: "up" | "down" | "restart",
  ): string[] {
    const ws = getActiveWorkspace();
    const catalog = readCatalog();
    if (ws) {
      const invocation = resolveInvocationTarget(ws.name, ws.config, catalog);
      if (invocation) {
        console.log(chalk.cyan(`\n  Workspace: ${chalk.bold(ws.name)}`));
        console.log(chalk.gray(`  Invocation repo: ${invocation.repoRoot}`));
        console.log(
          chalk.gray(`  Resolved target: ${invocation.addresses.join(", ")}\n`),
        );
        return invocation.addresses;
      }
    }

    if (command === "down") {
      // Down stops everything in the workspace — auto-start only governs the
      // STARTING half of workspace-wide ops.
      return getWorkspaceServices().map((s) => s.address);
    }
    // up/restart with no resolvable target: nothing to start implicitly.
    return [];
  }

  /** Repo-system name for the current working directory, if any. */
  private cwdSeedRepo(): string | undefined {
    const root = findInvocationRepoRoot();
    return root ? nodePath.basename(root) : undefined;
  }

  /**
   * Resolve a derive seed: an explicit known-repo arg, else the cwd repo if it
   * is a known repo. Returns undefined (no logging) when neither applies — the
   * caller then falls back to the legacy manifest path.
   */
  private derivedSeed(seedArg: string | undefined): string | undefined {
    const knownRepos = loadAliasResolver().knownRepos;
    const seed = seedArg ?? this.cwdSeedRepo();
    return seed && knownRepos.has(seed) ? seed : undefined;
  }

  /**
   * `up --plan`'s clone half (ORG-1a): each repo's org and the URL a missing
   * managed clone would come from. Read-only, like the rest of the plan.
   */
  private renderUpClonePlan(repos: readonly string[]): void {
    const ws = getActiveWorkspace();
    if (!ws) return;
    const lines = renderClonePlan(
      {
        fromBlueprint: false,
        workspaces: [workspaceClonePlan(ws.name, repos)],
      },
      product().cli,
    );
    console.log(chalk.bold("  Repos and clone URLs:\n"));
    for (const line of lines) console.log(chalk.gray(`  ${line}`.trimEnd()));
    console.log();
  }

  /** Render the read-only `den up --plan` view: per-node command + flags. */
  private renderUpPlan(nodes: NodePlan[]): void {
    const tag = (n: NodePlan): string => {
      const parts: string[] = [];
      if (n.noAutostart)
        parts.push(chalk.yellow("auto-start off, not-started"));
      if (n.interactive)
        parts.push(
          chalk.red(
            n.interactiveKind
              ? `interactive (${n.interactiveKind})`
              : "interactive",
          ),
        );
      if (!n.upCommand) parts.push(chalk.red("no up command"));
      if (parts.length === 0) parts.push(chalk.green("headless"));
      return parts.join(" ");
    };
    console.log(chalk.bold("  Plan (no changes will be made):\n"));
    for (const n of nodes) {
      const willStart = n.defaultAction === "start";
      const marker = willStart ? chalk.green("●") : chalk.yellow("○");
      console.log(`  ${marker} ${chalk.bold(n.repo)}  [${tag(n)}]`);
      console.log(
        chalk.gray(
          `      up: ${n.upCommand ?? "(none found)"}  (${n.upSource})`,
        ),
      );
      if (n.healthUrl) console.log(chalk.gray(`      health: ${n.healthUrl}`));
      if (n.interactive)
        console.log(chalk.gray(`      ⚠ ${n.interactiveReason}`));
      for (const note of n.notes) console.log(chalk.gray(`      • ${note}`));
    }
    const ask = nodes.filter((n) => n.defaultAction === "skip");
    console.log();
    console.log(
      chalk.gray(
        `  ● auto-start (headless)   ○ needs a decision (optional/interactive) — ` +
          `${ask.length} node(s): ${ask.map((n) => n.repo).join(", ") || "none"}`,
      ),
    );
    console.log(
      chalk.gray(
        `  Run '${product().cli} up' to start; outliers are prompted (CLI) / toggled (web) / skipped (CI).\n`,
      ),
    );
  }

  /** Bring up the seed repo's derived dependency closure (hard-ordered, fail-fast). */
  private async runDerivedUp(
    seed: string,
    include: boolean,
    dryRun: boolean,
    plan = false,
    pull = false,
  ): Promise<void> {
    const named = [seed];
    const full = deriveGraph({ scope: "all" });
    // Same positional closure the web "up with deps" uses: everything the seed
    // sits ON TOP OF, never anything above it. Keeps the two entry points from
    // drifting — see startClosure.
    const derived = deriveStartTargets(full, seed, include);
    const { graph } = derived;
    const rawOrder = this.runtimeOnly(derived.order, "started");
    if (rawOrder.length === 0) {
      console.log(
        chalk.gray(
          `\n  ${chalk.bold(seed)} has no derived dependencies to start.\n`,
        ),
      );
      if (plan) process.exitCode = 1;
      return;
    }
    // Systems the user toggled to auto-start OFF in this workspace are not
    // started by a workspace-wide up — only when one IS the seed (you ran
    // `den up` from that repo / named it). They still appear in `--plan`,
    // flagged.
    const noAutostartSet = this.noAutostartSet();
    const order = rawOrder.filter((n) => n === seed || !noAutostartSet.has(n));
    const skippedOff = rawOrder.filter(
      (n) => n !== seed && noAutostartSet.has(n),
    );
    console.log(
      chalk.cyan(
        `\n  Derived up for ${chalk.bold(seed)}${include ? " (including self)" : " (dependencies only)"}`,
      ),
    );
    console.log(chalk.gray(`  Order: ${order.join(" → ")}\n`));
    if (skippedOff.length > 0) {
      console.log(
        chalk.gray(
          `  Skipping (auto-start off): ${skippedOff.join(", ")} ` +
            `(toggle in the web ⋮ menu, or start explicitly with \`${product().cli} up <repo>\`)\n`,
        ),
      );
    }
    // Retired config key — the toggle moved to per-workspace `autostart`.
    const staleOptional = (
      readDenConfig().graph as { optional?: string[] } | undefined
    )?.optional;
    if (staleOptional?.length) {
      console.log(
        chalk.gray(
          "  Note: config graph.optional is no longer used — toggle auto-start per system in the web ⋮ menu (or workspaces.yml).\n",
        ),
      );
    }
    // `--plan`: surface the discovered+classified plan and stop. Same discovery
    // as a real `up`; just doesn't execute. Shows the FULL set with auto-start-
    // off flagged so you can see what would be skipped and why.
    if (plan) {
      this.renderUpPlan(
        buildUpPlan(graph, rawOrder, { noAutostart: noAutostartSet }),
      );
      this.renderUpClonePlan(rawOrder);
      return;
    }
    // A repo with no up of its own starts its services, one with no up at
    // all is skipped: the decision `up -a` makes (resolveUpTargets).
    const targets = new Set(include ? [seed] : []);
    if (dryRun) {
      const up = this.upTargets(order, targets, graph);
      await this.runServicesCommand(
        up.order,
        "up",
        { order: up.order },
        { named, dryRun: true },
      );
      return;
    }
    // Check the secrets backend first so any first-clone `make setup` (and the up
    // commands) have developer secrets available.
    preflightSecrets();
    // `--pull`: fast-forward existing managed clones in the start set
    // before bringing them up (dev-managed checkouts are never touched).
    if (pull) this.pullManagedClonesFor(order);
    // Bring the start-set's managed clones on disk AND set them up (hidden,
    // non-interactive) before running their `make up` — a managed repo that's
    // configured but not cloned would otherwise fail with "could not read
    // .den.yml". Fail-fast if any clone or setup fails.
    const failedClones = await this.ensureManagedClonesFor(order);
    if (failedClones.length > 0) {
      console.log(
        chalk.red(
          `\n  Aborting (fail-fast): clone/setup failed for ${failedClones.join(", ")}.\n`,
        ),
      );
      return;
    }
    const up = this.upTargets(order, targets, graph);
    if (up.order.length === 0) {
      console.log(chalk.yellow("  Nothing to start.\n"));
      return;
    }
    await this.runServicesCommand(
      up.order,
      "up",
      {
        order: up.order,
        waitDepsFor: (address) =>
          up.depsAs(hardDepsOf(graph, repoOfAddress(address))),
        failFast: true,
        skipHealthyAll: true,
      },
      { named },
    );
  }

  /**
   * The start order `up` runs (`up <repo>` and `up -a` alike): a repo with
   * no up of its own replaced by its services' ups, one with no up at all
   * skipped (resolveUpTargets), said as it decides.
   */
  private upTargets(
    order: string[],
    targets: ReadonlySet<string>,
    graph: DerivedGraph,
  ): UpTargets {
    const up = resolveUpTargets(order, this.focusedWs(), { targets, graph });
    this.sayUpTargets(up);
    return up;
  }

  /** What resolveUpTargets decided, in `up`'s words. */
  private sayUpTargets(up: UpTargets): void {
    for (const [repo, addrs] of up.expanded)
      console.log(
        chalk.gray(
          `  ${repo} has no up of its own: starting ${addrs.join(", ")}`,
        ),
      );
    if (up.skippedNoUp.length > 0)
      console.log(
        chalk.gray(
          `  Skipping (no local up command): ${up.skippedNoUp.join(", ")}\n`,
        ),
      );
  }

  /**
   * Stop the seed repo and the dependencies it was started with — the same
   * closure `den up <seed>` brings up, torn down in reverse (seed first,
   * foundations last), so the two halves of the pair operate on one set. Matches
   * the web card's "down with deps".
   */
  private async runDerivedDown(
    seed: string,
    dryRun: boolean,
    force = false,
    withDeps = false,
  ): Promise<void> {
    const full = deriveGraph({ scope: "all" });
    // Only the named repo, unless --with-deps: what it sits on may be
    // serving other running systems (the same rule as a named service).
    const upOrder = this.runtimeOnly(
      withDeps ? deriveStartTargets(full, seed).order : [seed],
      "stopped",
    );
    if (upOrder.length === 0) return;
    // Down stops EVERYTHING in the closure — the auto-start toggle only governs
    // the starting half ("quiet my machine" quiets all of them).
    const order = [...upOrder].reverse();
    // Stopping shared foundations can break systems OUTSIDE the closure that are
    // still running on them. Name them rather than letting them fall over
    // silently.
    const inClosure = new Set(order);
    // Only what really stops here puts dependents at risk: a remote service
    // is refused (R13), so it stops nothing.
    const stopsHere = new Set(order.filter((a) => !this.isRemote(a, "down")));
    const atRisk = [
      ...new Set(
        full.edges
          .filter(
            (e) =>
              e.kind !== "jwks" &&
              e.ordering !== false &&
              stopsHere.has(e.to) &&
              !inClosure.has(e.from),
          )
          .map((e) => e.from),
      ),
    ].sort();
    console.log(
      chalk.cyan(
        `\n  Derived down for ${chalk.bold(seed)}${withDeps ? " (+ dependencies)" : ""}`,
      ),
    );
    console.log(chalk.gray(`  Order: ${order.join(" → ")}\n`));
    if (atRisk.length > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ also depends on what this stops: ${atRisk.join(", ")}\n` +
            `    stop or restart them if they misbehave\n`,
        ),
      );
    }
    if (dryRun) {
      await this.runServicesCommand(
        order,
        "down",
        { order },
        { force, named: [seed], dryRun: true },
      );
      return;
    }
    await this.runServicesCommand(
      order,
      "down",
      { order },
      { force, named: [seed] },
    );
  }

  /** Whether `address` runs remotely, so `command` is refused here (R13). */
  private isRemote(address: string, command: string): boolean {
    const placed = resolveService(address);
    return (
      !!placed &&
      placementRefusal(
        address,
        servicePlacement(
          readManifest(placed.repoPath),
          placed.subsystem,
          "local",
        ),
        (e) => isProductionEnv(e),
        command,
      ) !== null
    );
  }

  /** Workspace repos with no runtime (modules, libraries) → their kind. */
  private noRuntimeRepos(): Map<string, RepoKind> {
    const out = new Map<string, RepoKind>();
    for (const s of getWorkspaceServices()) {
      const kind = repoKind(s.repoPath);
      if (!hasRuntime(kind)) out.set(s.repoName, kind);
    }
    return out;
  }

  /** Drop modules/libraries from a start/stop order, saying so once. */
  private runtimeOnly(order: string[], verb: "started" | "stopped"): string[] {
    const none = this.noRuntimeRepos();
    const skipped = order.filter((r) => none.has(r));
    if (skipped.length > 0)
      console.log(
        chalk.gray(
          `  Not ${verb} (no runtime of their own): ${skipped.map((r) => `${r} (${none.get(r)})`).join(", ")}`,
        ),
      );
    return order.filter((r) => !none.has(r));
  }

  /**
   * Every repo in the active workspace, sorted by the full derived up order —
   * the CLI counterpart of the web UI's master Up/Down buttons. cwd-agnostic.
   * Returns null when there is no active workspace (or it has no services).
   */
  private allWorkspaceOrder(only?: Set<string>): {
    rawOrder: string[];
    graph: DerivedGraph;
  } | null {
    // Modules and libraries ship inside another repo's runtime: never started.
    const services = getWorkspaceServices().filter(
      (s) =>
        (!only || only.has(s.repoName)) && hasRuntime(repoKind(s.repoPath)),
    );
    if (services.length === 0) return null;
    const repos = new Set(services.map((s) => s.repoName));
    const graph = deriveGraph({ scope: "all" });
    const rank = new Map(orderForUp(graph).map((repo, i) => [repo, i]));
    const rawOrder = [...repos].sort(
      (a, b) =>
        (rank.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
    return { rawOrder, graph };
  }

  private async runAllUp(
    dryRun: boolean,
    plan: boolean,
    pull: boolean,
    only?: Set<string>,
  ): Promise<void> {
    const target = this.allWorkspaceOrder(only);
    if (!target) {
      console.log(
        chalk.yellow(
          "\n  No services in the active workspace — nothing to start.\n",
        ),
      );
      if (plan) process.exitCode = 1;
      return;
    }
    const { rawOrder, graph } = target;
    const noAutostartSet = this.noAutostartSet();
    const skippedOff = rawOrder.filter((n) => noAutostartSet.has(n));
    const candidates = rawOrder.filter((n) => !noAutostartSet.has(n));

    // plan / --dry-run are read-only and must run BEFORE the bootstrap below.
    // With clones missing the true order can't be known yet, so dry-run shows
    // the candidate set.
    if (plan) {
      this.renderUpPlan(
        buildUpPlan(graph, rawOrder, { noAutostart: noAutostartSet }),
      );
      this.renderUpClonePlan(rawOrder);
      return;
    }
    if (dryRun) {
      console.log(
        chalk.cyan(
          `\n  ${only ? "Application" : "Workspace-wide"} up — ${chalk.bold(String(candidates.length))} candidate system(s)`,
        ),
      );
      console.log(chalk.gray(`  Order: ${candidates.join(" → ")}\n`));
      if (skippedOff.length > 0) {
        console.log(
          chalk.gray(`  Skipping (auto-start off): ${skippedOff.join(", ")}\n`),
        );
      }
      console.log(
        chalk.gray(
          "  (--dry-run: not starting anything; a real run clones + sets up any missing managed repos first)\n",
        ),
      );
      return;
    }
    if (candidates.length === 0) {
      console.log(chalk.yellow("\n  Nothing to start.\n"));
      return;
    }

    // Bootstrap FIRST. The no-up filter below reads manifests, and a fresh
    // workspace has no clones to read — filtering first turned `up -a` into
    // "Nothing to start" on exactly the machine that needed it most. Starting
    // everything IS the stated intent, and managed repos are den's
    // to materialise: clone + setup happen implicitly, no separate command.
    preflightSecrets();
    if (pull) this.pullManagedClonesFor(candidates);
    const failedClones = await this.ensureManagedClonesFor(candidates);
    if (failedClones.length > 0) {
      console.log(
        chalk.red(
          `\n  Aborting (fail-fast): clone/setup failed for ${failedClones.join(", ")}.\n`,
        ),
      );
      return;
    }

    // Like the web master ▶ Up: a system with no runnable local `up` command
    // is skipped, not fatal. `-a` starts independent peers — one unrunnable
    // repo must not strand the rest (runServiceCommand exits 1 on a missing
    // command, and a fail-fast would turn that into a full abort). Now that
    // clones exist, the manifest lookup is meaningful. A repo with no up of
    // its own but per-service ups starts those services: the same decision
    // `up <repo>` makes for a dependency (upTargets).
    const up = resolveUpTargets(candidates, this.focusedWs(), {
      targets: new Set(candidates),
      graph,
    });
    const order = up.order;
    const systems = candidates.filter((r) => !up.skippedNoUp.includes(r));
    console.log(
      chalk.cyan(
        `\n  ${only ? "Application" : "Workspace-wide"} up — ${chalk.bold(String(systems.length))} ${noun(systems.length, "system")}`,
      ),
    );
    console.log(chalk.gray(`  Order: ${order.join(" → ")}\n`));
    if (skippedOff.length > 0) {
      console.log(
        chalk.gray(
          `  Skipping (auto-start off): ${skippedOff.join(", ")} ` +
            `(toggle in the web ⋮ menu, or start explicitly with \`${product().cli} up <repo>\`)\n`,
        ),
      );
    }
    this.sayUpTargets(up);
    if (order.length === 0) {
      console.log(chalk.yellow("  Nothing to start.\n"));
      return;
    }
    // Preflight, pull and clones+setup already ran above, before the manifest
    // filter. From here: the ordered start with hard-dep gating and
    // healthy-skip. Unlike runDerivedUp there is NO failFast on the start
    // loop: `-a`'s systems are independent peers — one failure must not
    // strand the rest (the web master button continues too).
    const repoSet = new Set(systems);
    await this.runServicesCommand(order, "up", {
      order,
      // Hard deps outside the workspace can't be waited on — filter to the set
      // we are actually starting.
      waitDepsFor: (address) =>
        up.depsAs(
          hardDepsOf(graph, repoOfAddress(address)).filter((dep) =>
            repoSet.has(dep),
          ),
        ),
      skipHealthyAll: true,
    });
  }

  private async runAllDown(
    dryRun: boolean,
    force = false,
    only?: Set<string>,
  ): Promise<void> {
    const target = this.allWorkspaceOrder(only);
    if (!target) {
      console.log(
        chalk.yellow(
          "\n  No services in the active workspace — nothing to stop.\n",
        ),
      );
      return;
    }
    // Reverse of the up order. Includes auto-start-off systems — the toggle
    // only governs starting ("quiet my machine" quiets all of them). Unlike
    // the web master Down, there is NO already-stopped skip here: every down
    // script runs (down on a stopped service is a cheap no-op), so systems
    // invisible to the container/health checks still get stopped.
    const order = [...target.rawOrder].reverse();
    console.log(
      chalk.cyan(
        `\n  ${only ? "Application" : "Workspace-wide"} down — ${chalk.bold(String(order.length))} ${noun(order.length, "system")}`,
      ),
    );
    console.log(chalk.gray(`  Order: ${order.join(" → ")}\n`));
    if (dryRun) {
      console.log(chalk.gray("  (--dry-run: not stopping anything)\n"));
      return;
    }
    await this.runServicesCommand(order, "down", { order }, { force });
    // Records no workspace reaches: -a stops every workspace's services,
    // not these. Said, and left alone (0.3.0-dev.39, a consumer's finding).
    if (!only)
      for (const d of daemonsOutsideWorkspaces())
        printNotice(
          `Warning: ${d.address} is recorded as running (${d.repoPath}) but is in no active workspace: ` +
            `down -a left it alone. Stop it yourself if it still runs.`,
        );
  }

  private printUpHelp(): void {
    console.log();
    console.log(chalk.bold(`  ${product().cli} up [repo] [flags]`));
    console.log();
    console.log(
      "  Bring up the current repo (or [repo]) and its derived dependency closure,",
    );
    console.log(
      "  ordered by the dependency graph. By default the current/seed repo IS started.",
    );
    console.log();
    console.log(chalk.bold("  Flags:"));
    // Two spaces at least between a flag and its text, a long one too.
    const row = (f: string, d: string) =>
      console.log(
        `    ${chalk.cyan(f.padEnd(Math.max(20, f.length + 2)))}${d}`,
      );
    row(
      "-x, --exclude",
      "start only the dependencies, not the current/seed repo",
    );
    row(
      "-a, --all",
      "start EVERY workspace system in derived order (cwd-agnostic; skips auto-start-off)",
    );
    row(
      "-A, --app <app>",
      `start every repo in an application (\`${product().cli} apps\`), in derived order`,
    );
    row("-n, --dry-run", "print the start order without starting anything");
    row(
      "--plan",
      "show the classified plan (commands, optional/interactive) and stop",
    );
    row(
      "--pull",
      "fast-forward managed clones in the start set first (ff-only; dev-managed untouched)",
    );
    row(
      "--manifest",
      `use legacy ${product().manifestYml} depends_on instead of the derived graph`,
    );
    row(
      "-w, --workspace <ws>",
      "act in that (active) workspace instead of the focused one; focus stays",
    );
    row("--skip-secrets", "skip the secrets-backend sign-in preflight");
    row(
      "--json",
      "log on stderr; stdout: { ok, services: [{ address, result, health }], fix? }",
    );
    row("-h, --help", "show this help");
    console.log();
  }

  private printGraphHelp(): void {
    console.log();
    console.log(chalk.bold(`  ${product().cli} graph [repo] [flags]`));
    console.log();
    console.log(
      "  Derive & render the cross-service dependency graph from real repo signals",
    );
    console.log(
      "  (SDK imports, *_URL env vars, IaC refs, EventBridge rules). Defaults to the",
    );
    console.log("  cwd repo's neighborhood; pass [repo] or --all for more.");
    console.log();
    console.log(chalk.bold("  Flags:"));
    const row = (f: string, d: string) =>
      console.log(`    ${chalk.cyan(f.padEnd(22))}${d}`);
    row(
      "--all",
      "the full known-systems graph (not just the cwd neighborhood)",
    );
    row("-u, --up", "render nodes in start order (deps-first) — default");
    row("-d, --down", "render nodes in shutdown order (reverse)");
    row("--source=<s>", "derived | declared | union (default derived)");
    row("--kind=<k>", "all | hard | infra | http | event");
    row("--format=<f>", "text | json | dot (default text)");
    row(
      "--diff",
      `compare derived deps vs ${product().manifestYml} depends_on`,
    );
    row("--refresh", "ignore the per-repo cache and re-derive");
    row("-h, --help", "show this help");
    console.log();
  }

  private printUseModeHelp(mode: "dev-managed" | "managed"): void {
    const verb = mode === "dev-managed" ? "use-local" : `use-managed`;
    console.log(`\n  ${product().cli} ${verb} [repo]\n`);
    console.log(
      mode === "dev-managed"
        ? `  Point ${product().cli} at your LOCAL checkout (dev-managed) — defaults to the repo you're\n  in, or a named repo's sibling under repos_root.`
        : `  Switch the repo back to a MANAGED clone (${product().servicesDir}) — defaults to\n  the repo you're in, or a named repo.`,
    );
    console.log();
    console.log(chalk.bold("  Flags:"));
    const row = (f: string, d: string) =>
      console.log(`    ${chalk.cyan(f.padEnd(18))}${d}`);
    if (mode === "managed")
      row("--branch=<name>", "branch for the managed clone (default main)");
    row("-h, --help", "show this help");
    console.log();
  }

  /** Help for `<command> -h`: dedicated renderer for flag-heavy commands, else the table. */
  private printCommandHelp(command: string, sub?: string): void {
    // `workspace <sub> --help`: that subcommand only.
    const wsSub =
      command === "workspace"
        ? WORKSPACE_SUBCOMMANDS.find((c) => c.name === sub)
        : undefined;
    if (wsSub) {
      console.log(`\n  ${product().cli} workspace ${wsSub.usage}\n`);
      for (const line of wsSub.lines)
        console.log(`  ${line.replaceAll("{cli}", product().cli)}`);
      console.log();
      return;
    }
    switch (command) {
      case "up":
        return this.printUpHelp();
      case "graph":
        return this.printGraphHelp();
      case "use-local":
        return this.printUseModeHelp("dev-managed");
      case `use-managed`:
        return this.printUseModeHelp("managed");
      case "web":
        return displayWebHelp(); // its own detailed actions/options help
    }
    const entry = COMMAND_HELP[command === "applications" ? "apps" : command];
    if (!entry) {
      console.log(
        chalk.yellow(
          `\n  No detailed help for '${command}'. Run '${product().cli} --help' for the command list.\n`,
        ),
      );
      return;
    }
    console.log(`\n  ${product().cli} ${entry.usage}\n`);
    for (const line of entry.lines)
      console.log(`  ${line.replaceAll("{cli}", product().cli)}`.trimEnd());
    console.log();
  }

  /**
   * Seed (or reset) the blueprint's workspaces from the committed config:
   * `defaults.workspace` fills `default`; `defaults.workspaces` creates each
   * named workspace, activates them all and focuses the marked one. All
   * repos managed. Prints clear guidance and, on a TTY, asks first.
   * `reason: "auto"` is the one-time offer on a genuine fresh setup (TTY
   * only: see ensureWorkspaceSeeded); `reason: "init"` is the explicit
   * `<cli> workspace seed` / `<cli> init` in the root. Returns true if seeded.
   */
  private async seedDefaultWorkspaceFlow(
    reason: "auto" | "init",
    reset = false,
    via: "init" | "workspace seed" = "workspace seed",
  ): Promise<boolean> {
    const bps = blueprintWorkspaces();
    if (bps.length === 0) {
      if (reason === "init") {
        console.log(
          chalk.yellow(
            `\n  No defaults.workspace.repos or defaults.workspaces in ${product().configFile} — nothing to seed.\n`,
          ),
        );
      }
      return false;
    }
    const multi = isMultiBlueprint();
    // A repeat seed: say so, and touch nothing.
    if (blueprintAlreadySeeded()) {
      console.log(
        chalk.green(
          multi
            ? `\n  ✓ ${plural(bps.length, "workspace")} already seeded (${bps.map((b) => b.name).join(", ")}): nothing changed.\n`
            : `\n  ✓ Default workspace already seeded — ${plural(bps[0].repos.length, "repo")} (managed): nothing changed.\n`,
        ),
      );
      return false;
    }
    const willReset = defaultWorkspaceHasServices();
    const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
    // A reset replaces every entry, dev-managed checkouts included. On a TTY
    // the user is asked (default No); without one there is nobody to ask, so
    // only an explicit --reset may do it (SEED-0).
    if (willReset && !interactive && !reset) {
      const what = multi
        ? "the blueprint's workspaces"
        : "the default workspace";
      console.error(
        chalk.red(
          `\n  ❌ Not resetting ${what}: it has entries, and a reset replaces them all\n` +
            `     (your own dev-managed checkouts included) with managed clones.\n` +
            `     Nothing changed. To reset anyway: ${product().cli} ${via} --reset\n`,
        ),
      );
      process.exitCode = 1;
      return false;
    }

    for (const bp of bps) {
      const label = multi ? `Workspace ${bp.name}` : "Default workspace";
      console.log(
        chalk.cyan(
          `\n  ${label} — ${plural(bp.repos.length, "repo")}, all managed:`,
        ),
      );
      console.log(chalk.gray(`    ${bp.repos.join(", ")}`));
    }
    console.log(
      chalk.gray(
        `  ${product().title} clones + tracks them on their branch under ${product().servicesDir}/. Switch any`,
      ),
    );
    console.log(
      chalk.gray(
        `  to your own checkout anytime: \`${product().cli} use-local <repo>\` (revert: use-managed).\n`,
      ),
    );

    if (interactive) {
      const what = multi ? "these workspaces" : "the default workspace";
      const question = willReset
        ? `  Reset ${what} to this shipped set?`
        : `  Seed ${what} now?`;
      const ok = await cliPrompts.confirm(question, !willReset);
      if (!ok) {
        if (reason === "auto") {
          markDefaultWorkspaceDeclined(); // don't ask again
          console.log(
            chalk.gray(
              `  Skipped — run \`${product().cli} workspace seed\` to set it up later.\n`,
            ),
          );
        } else {
          console.log(chalk.gray("  Aborted.\n"));
        }
        return false;
      }
    }

    if (multi) {
      const seeded = seedBlueprintWorkspaces();
      const focus = readWorkspacesFile().focus;
      console.log(
        chalk.green(
          `  ✓ ${plural(seeded.length, "workspace")} ${willReset ? "reset to the blueprint" : "ready"} (${seeded.map((w) => w.name).join(", ")}), all active; focus: ${focus}. ` +
            `Run \`${product().cli} up <repo>\` to bring up its closure.\n`,
        ),
      );
      return true;
    }
    const seeded = seedDefaultWorkspace();
    console.log(
      chalk.green(
        `  ✓ Default workspace ${willReset ? "reset to the blueprint" : "ready"} — ${plural(seeded.length, "repo")} (managed). ` +
          `Run \`${product().cli} up <repo>\` to bring up its closure.\n`,
      ),
    );
    return true;
  }

  /**
   * On a genuine fresh setup (nothing but an empty, never-seeded `default`),
   * offer to seed from the blueprint: on a TTY, ask; otherwise print a
   * one-line hint and change nothing. Afterwards keep a lone `default`
   * converged on the blueprint (repos added to defaults later join it
   * managed); never once the user has other workspaces.
   */
  private async ensureWorkspaceSeeded(): Promise<void> {
    if (defaultWorkspaceNeedsSeeding()) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await this.seedDefaultWorkspaceFlow("auto");
      } else {
        const hint = isMultiBlueprint()
          ? "no workspaces yet: run `{cli} workspace seed` to create them from the blueprint"
          : "default workspace is empty: run `{cli} workspace seed` to fill it from the blueprint";
        console.error(chalk.gray(`  ${hint.replace("{cli}", product().cli)}`));
      }
      return;
    }
    const added = topUpDefaultWorkspace();
    if (added.length > 0) {
      console.log(
        chalk.gray(
          `  default workspace: added standard ${noun(added.length, "repo")} ${added.join(", ")} (managed)`,
        ),
      );
    }
  }

  /**
   * With no `-w`: the workspace the named services are in, when it isn't
   * the focus (target-workspace.ts), set as this run's workspace. False
   * (exit 1, said why) when a name is in no active workspace, in several,
   * or the names are in different ones.
   */
  private pickTargetWorkspace(command: string, args: string[]): boolean {
    if (process.env.DEN_WORKSPACE_OVERRIDE) return true;
    const terminator = args.indexOf("--");
    const own = terminator === -1 ? args : args.slice(0, terminator);
    let rest: string[];
    try {
      const taken = takeAppFlag(own);
      if (taken.app) return true; // -A names an application, not services
      rest = taken.rest;
    } catch {
      return true; // the command itself reports a bad -A
    }
    const names = rest.filter((a) => !a.startsWith("-"));
    const r = resolveTargetWorkspace(names, product().cli, command);
    if (!r.ok) {
      console.error(chalk.red(`\n  ✗ ${r.error}\n`));
      process.exitCode = 1;
      return false;
    }
    if (r.workspace) {
      process.env.DEN_WORKSPACE_OVERRIDE = r.workspace;
      console.log(
        chalk.gray(
          `\n  ${names.join(", ")}: in workspace ${r.workspace} (not the focus)`,
        ),
      );
    }
    return true;
  }

  private async cmdServiceUp(args: string[]): Promise<void> {
    if (!this.pickTargetWorkspace("up", args)) return;
    // Tokens after a `--` terminator belong to a child command — they must
    // never be read as up's own flags (`den up -- -a` is NOT `up -a`).
    const terminator = args.indexOf("--");
    await this.ensureWorkspaceSeeded();
    const { app, rest } = takeAppFlag(
      terminator === -1 ? args : args.slice(0, terminator),
    );
    const ownArgs = canonicalTargets(rest);
    const dryRun = ownArgs.includes("--dry-run") || ownArgs.includes("-n");
    const plan = ownArgs.includes("--plan");
    const pull = ownArgs.includes("--pull");
    // `-A <app>`: every repo in that application, in derived order (like -a, scoped).
    if (app) {
      await this.runAllUp(dryRun, plan, pull, focusedAppRepos(app));
      return;
    }
    const seedArg = ownArgs.find((a) => !a.startsWith("-"));

    // `-a`/`--all`: the whole active workspace in derived order, regardless of
    // cwd — the CLI twin of the web UI's master ▶ Up button.
    if (ownArgs.includes("-a") || ownArgs.includes("--all")) {
      const conflicting = [
        "-x",
        "--exclude",
        "--manifest",
        "--no-derive",
      ].filter((f) => ownArgs.includes(f));
      if (conflicting.length > 0) {
        console.log(
          chalk.red(
            `\n  -a/--all cannot be combined with ${conflicting.join(", ")}.\n`,
          ),
        );
        process.exit(1);
      }
      if (seedArg) {
        console.log(
          chalk.red(
            `\n  -a/--all starts the whole workspace — drop the repo arg (${seedArg}) or the flag.\n`,
          ),
        );
        process.exit(1);
      }
      await this.runAllUp(dryRun, plan, pull);
      return;
    }

    // Default: derive the dependency closure from the cwd repo (or an explicit
    // known-repo arg) and bring it up. Falls back to the legacy manifest path
    // when there is no known seed (explicit service address, or run outside a
    // known repo) or when --manifest/--no-derive is passed.
    const forceManifest =
      ownArgs.includes("--manifest") || ownArgs.includes("--no-derive");
    const seed = forceManifest ? undefined : this.derivedSeed(seedArg);

    if (seed) {
      // Default now INCLUDES the current/seed repo; `-x`/`--exclude` starts only
      // its dependencies (the previous default).
      const include = !(
        ownArgs.includes("-x") || ownArgs.includes("--exclude")
      );
      await this.runDerivedUp(seed, include, dryRun, plan, pull);
      return;
    }
    await this.cmdServiceUpManifest(
      ownArgs.filter((a) => !a.startsWith("-")),
      dryRun || plan,
      plan,
    );
  }

  /**
   * `up --json` (ON-2): up as it always runs, its log on stderr, then one
   * JSON object on stdout: each service it touched, what happened to it
   * (started, already-running, failed, skipped) and its health once started
   * (a started service with a health check is waited on, up to 30s). Safe to
   * re-run: a healthy service is already-running. Every failure names a fix.
   */
  private async cmdServiceUpJson(args: string[]): Promise<number> {
    const report: UpReport = {
      started: [],
      failed: [],
      alreadyRunning: [],
      skipped: [],
    };
    const bin = fs.existsSync(
      nodePath.join(getDistRoot(), "bin", product().cli),
    )
      ? `./bin/${product().cli}`
      : product().cli;
    const before = process.exitCode;
    process.exitCode = undefined;
    let error: string | undefined;
    this.upReport = report;
    try {
      await quietStdout(() => this.cmdServiceUp(args));
    } catch (e) {
      if (!(e instanceof ExitRequested)) error = (e as Error).message;
      else if (e.code !== 0) process.exitCode = e.code;
    } finally {
      this.upReport = null;
    }
    const failedExit = process.exitCode !== undefined && process.exitCode !== 0;
    process.exitCode = before;
    const workspace =
      process.env.DEN_WORKSPACE_OVERRIDE ??
      getFocusedWorkspaceName() ??
      undefined;
    const result = (address: string): string =>
      report.failed.includes(address)
        ? "failed"
        : report.started.includes(address)
          ? "started"
          : report.alreadyRunning.includes(address)
            ? "already-running"
            : "skipped";
    const touched = [
      ...new Set([
        ...report.started,
        ...report.alreadyRunning,
        ...report.failed,
        ...report.skipped,
      ]),
    ];
    const services = await Promise.all(
      touched.map(async (address) => {
        const resolved = resolveService(address, workspace);
        let health = "unknown";
        let detail: string | undefined;
        if (resolved && result(address) !== "skipped") {
          const ready =
            result(address) === "started"
              ? await waitForReady(resolved, "local", { timeoutMs: 30_000 })
              : null;
          const h = await checkServiceHealth(resolved, "local");
          health = h.health;
          detail = h.healthDetail ?? ready?.detail;
        }
        return {
          address,
          result: result(address),
          health,
          ...(detail ? { detail } : {}),
        };
      }),
    );
    const unhealthy = services.filter(
      (s) => s.result !== "skipped" && s.health === "error",
    );
    const out: Record<string, unknown> = {
      ok:
        !error &&
        !failedExit &&
        report.failed.length === 0 &&
        unhealthy.length === 0 &&
        touched.length > 0,
      workspace: workspace ?? null,
      services,
    };
    if (error) {
      out.error = error;
      out.fix = `${bin} doctor --json`;
    } else if (report.failed.length > 0 || unhealthy.length > 0) {
      const names = [
        ...new Set([...report.failed, ...unhealthy.map((s) => s.address)]),
      ];
      out.error = `${names.join(", ")} did not start healthy`;
      out.fix = `${bin} logs ${names[0].split("/")[0]}`;
    } else if (failedExit) {
      out.error = "up failed (its log is on stderr)";
      out.fix = `${bin} up ${args.join(" ")} --plan`.replace(/\s+/g, " ");
    } else if (touched.length === 0) {
      out.error =
        "nothing was started: no repo named, and the folder up ran in is not a repo in the workspace";
      out.fix = `${bin} up -a --json`;
      out.ask = "Which repo should start? (its name, as `repo add` printed it)";
    }
    out.next = out.ok
      ? [`${bin} web up --no-open --json`, `${bin} doctor --json`]
      : [];
    printJson(out);
    return out.ok ? 0 : 1;
  }

  /**
   * `down --json`: down as it always runs, its log on stderr, then one JSON
   * object on stdout, `{ ok, workspace, services, all? }`. Safe to re-run:
   * stopping what is already stopped is ok. A failure names a fix.
   */
  private async cmdServiceDownJson(args: string[]): Promise<number> {
    const bin = fs.existsSync(
      nodePath.join(getDistRoot(), "bin", product().cli),
    )
      ? `./bin/${product().cli}`
      : product().cli;
    const before = process.exitCode;
    process.exitCode = undefined;
    let error: string | undefined;
    try {
      await quietStdout(() => this.cmdServiceDown(args));
    } catch (e) {
      if (!(e instanceof ExitRequested)) error = (e as Error).message;
      else if (e.code !== 0) process.exitCode = e.code;
    }
    const failedExit = process.exitCode !== undefined && process.exitCode !== 0;
    process.exitCode = before;
    const terminator = args.indexOf("--");
    const own = terminator === -1 ? args : args.slice(0, terminator);
    const all = own.includes("-a") || own.includes("--all");
    const out: Record<string, unknown> = {
      ok: !error && !failedExit,
      workspace:
        process.env.DEN_WORKSPACE_OVERRIDE ?? getFocusedWorkspaceName() ?? null,
      services: own.filter((a) => !a.startsWith("-")),
      ...(all ? { all: true } : {}),
    };
    if (!out.ok) {
      out.error = error ?? "down failed (its log is on stderr)";
      out.fix = `${bin} doctor --json`;
    }
    printJson(out);
    return out.ok ? 0 : 1;
  }

  /**
   * `web down --json`: the web server stopped as usual (its log on stderr),
   * then `{ ok, url, port, running: false, stopped }` once nothing answers
   * (up to 10s). `stopped` is false when it wasn't running: re-running is ok.
   */
  private async cmdWebDownJson(args: string[]): Promise<number> {
    const { parseWebCommandArgs } = await import("./web-command.js");
    const { probeWebServer } = await import("./mcp-connect.js");
    const bin = fs.existsSync(
      nodePath.join(getDistRoot(), "bin", product().cli),
    )
      ? `./bin/${product().cli}`
      : product().cli;
    let port: number;
    try {
      port = parseWebCommandArgs(args).port;
    } catch (e) {
      printJson({
        ok: false,
        error: (e as Error).message,
        fix: `${bin} web down --json`,
      });
      return 2;
    }
    const url = `http://localhost:${port}`;
    const was = (await probeWebServer(url)).kind === "up";
    let error: string | undefined;
    try {
      await quietStdout(() => cmdWeb(args));
    } catch (e) {
      if (!(e instanceof ExitRequested) || e.code !== 0)
        error = (e as Error).message;
    }
    let probe = await probeWebServer(url);
    const deadline = Date.now() + 10_000;
    while (!error && probe.kind === "up" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      probe = await probeWebServer(url);
    }
    const running = probe.kind === "up";
    // After an error (a lookup that never answered, say), whether it still
    // runs is unknown unless it answers: null, and never "stopped"
    // (0.4.29-dev.2's gate).
    const out: Record<string, unknown> = {
      ok: !error && !running,
      url,
      port,
      running: error && !running ? null : running,
      stopped: !error && was && !running,
    };
    if (!out.ok) {
      out.error = error ?? `the web server still answers at ${url}`;
      out.fix = `${bin} doctor --json`;
    }
    printJson(out);
    return out.ok ? 0 : 1;
  }

  /**
   * `web up|restart --json` (ON-2): the web server started as usual (its
   * log on stderr), then `{ ok, url, port, version? }` once it answers
   * (up to 30s), so an agent hands back the right URL.
   */
  private async cmdWebUpJson(args: string[]): Promise<number> {
    const { parseWebCommandArgs } = await import("./web-command.js");
    const { probeWebServer } = await import("./mcp-connect.js");
    const bin = fs.existsSync(
      nodePath.join(getDistRoot(), "bin", product().cli),
    )
      ? `./bin/${product().cli}`
      : product().cli;
    let port: number;
    try {
      port = parseWebCommandArgs(args).port;
    } catch (e) {
      printJson({
        ok: false,
        error: (e as Error).message,
        fix: `${bin} web up --no-open --json`,
      });
      return 2;
    }
    const url = `http://localhost:${port}`;
    let error: string | undefined;
    try {
      await quietStdout(() => cmdWeb(args));
    } catch (e) {
      if (!(e instanceof ExitRequested) || e.code !== 0)
        error = (e as Error).message;
    }
    let probe = await probeWebServer(url);
    const deadline = Date.now() + 30_000;
    while (!error && probe.kind !== "up" && probe.kind !== "foreign") {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
      probe = await probeWebServer(url);
    }
    // A server answering is not enough: `restart` that failed to stop the
    // old one leaves it answering (0.4.29-dev.2's gate). The error wins.
    const out: Record<string, unknown> = {
      ok: !error && probe.kind === "up",
      url,
      port,
      ...(probe.kind === "up" && probe.version
        ? { version: probe.version }
        : {}),
    };
    if (error && probe.kind !== "foreign") {
      out.error = error;
      out.fix = `${bin} web restart --no-open --json`;
    } else if (probe.kind === "foreign") {
      out.error = `${probe.who} answers at ${url}, not this distribution's web server`;
      out.ask = `Another Den distribution uses port ${port}. Which port should ${product().title} use? (web.port in config/local/user.yml)`;
    } else if (probe.kind !== "up") {
      out.error = error ?? `the web server is not answering at ${url}`;
      out.fix = `${bin} web restart --no-open --json`;
    }
    printJson(out);
    return out.ok ? 0 : 1;
  }

  /** Legacy: start the given services via manifest depends_on. */
  private async cmdServiceUpManifest(
    addresses: string[],
    dryRun = false,
    plan = false,
  ): Promise<void> {
    // Resolve targets BEFORE the secrets preflight — otherwise running
    // `den up` from a non-service dir (e.g. the den repo root) triggers
    // an interactive sign-in just to print "nothing to do".
    const targets =
      addresses.length > 0 ? addresses : this.resolveNoArgServiceTargets("up");
    if (targets.length === 0) {
      const here = this.cwdSeedRepo();
      if (here === `${product().cli}`) {
        console.log(
          chalk.yellow(
            `\n  You're in the ${product().cli} repo, which isn't a service itself.\n`,
          ) +
            chalk.gray(
              `  Start a system by name (\`${product().cli} up shop\`), cd into a service repo,\n` +
                `  or run \`${product().cli} graph\` to see the workspace.\n`,
            ),
        );
      } else if (process.env.DEN_WORKSPACE_OVERRIDE) {
        // `up -w <ws>` with nothing to start: -w picks the workspace, not
        // what in it to start. A usage error, not an empty plan.
        console.error(
          chalk.red(
            `\n  ${upNeedsTarget(product().cli, process.env.DEN_WORKSPACE_OVERRIDE, plan)}\n`,
          ),
        );
        process.exitCode = 2;
        return;
      } else {
        console.log(
          chalk.yellow(
            "No services specified and no invocation target resolvable — run from a service repo or pass a service name.",
          ),
        );
      }
      // A plan that resolves nothing is a failed plan (scripts check it).
      if (plan) process.exitCode = 1;
      return;
    }
    if (!dryRun) preflightSecrets();
    await this.runServicesCommand(targets, "up", undefined, {
      named: addresses,
      dryRun,
      plan,
    });
  }

  private async cmdServiceDown(args: string[]): Promise<void> {
    if (!this.pickTargetWorkspace("down", args)) return;
    // Tokens after a `--` terminator belong to a child command — they must
    // never be read as down's own flags (`den down -- -a` must NOT tear
    // down the whole workspace).
    const terminator = args.indexOf("--");
    const { app, rest } = takeAppFlag(
      terminator === -1 ? args : args.slice(0, terminator),
    );
    const ownArgs = canonicalTargets(rest);
    const dryRun = ownArgs.includes("--dry-run") || ownArgs.includes("-n");
    const force = ownArgs.includes("--force") || ownArgs.includes("-f");
    if (app) {
      await this.runAllDown(dryRun, force, focusedAppRepos(app));
      return;
    }

    // `-a`/`--all`: stop every workspace system in reverse derived order,
    // regardless of cwd — the CLI twin of the web UI's master ⏹ Down button
    // (minus its already-stopped skip: every down script runs).
    if (ownArgs.includes("-a") || ownArgs.includes("--all")) {
      const conflicting = ["--manifest", "--no-derive"].filter((f) =>
        ownArgs.includes(f),
      );
      if (conflicting.length > 0) {
        console.log(
          chalk.red(
            `\n  -a/--all cannot be combined with ${conflicting.join(", ")}.\n`,
          ),
        );
        process.exit(1);
      }
      const seedArg = ownArgs.find((a) => !a.startsWith("-"));
      if (seedArg) {
        console.log(
          chalk.red(
            `\n  -a/--all stops the whole workspace — drop the repo arg (${seedArg}) or the flag.\n`,
          ),
        );
        process.exit(1);
      }
      await this.runAllDown(dryRun, force);
      return;
    }

    const forceManifest =
      ownArgs.includes("--manifest") || ownArgs.includes("--no-derive");
    const seedArg = ownArgs.find((a) => !a.startsWith("-"));
    const seed = forceManifest ? undefined : this.derivedSeed(seedArg);

    if (seed) {
      await this.runDerivedDown(
        seed,
        dryRun,
        force,
        ownArgs.includes("--with-deps"),
      );
      return;
    }
    const addresses = ownArgs.filter((a) => !a.startsWith("-"));
    const targets =
      addresses.length > 0
        ? addresses
        : this.resolveNoArgServiceTargets("down");
    await this.runServicesCommand(targets, "down", undefined, {
      force,
      named: addresses,
      dryRun,
    });
  }

  private async cmdServiceRestart(argv: string[]): Promise<void> {
    if (!this.pickTargetWorkspace("restart", argv)) return;
    const { app, rest: args } = takeAppFlag(argv);
    const dryRun = args.includes("--dry-run") || args.includes("-n");
    if (!dryRun) preflightSecrets();
    if (app) {
      const order =
        this.allWorkspaceOrder(focusedAppRepos(app))?.rawOrder ?? [];
      await this.runServicesCommand(order, "restart", undefined, { dryRun });
      return;
    }
    // Drop flag tokens so a bare `den restart --foo` doesn't treat the flag
    // as a service address (matches cmdServiceUp/cmdServiceDown).
    const filtered = canonicalTargets(args.filter((a) => !a.startsWith("-")));
    const addresses =
      filtered.length > 0
        ? filtered
        : this.resolveNoArgServiceTargets("restart");
    await this.runServicesCommand(addresses, "restart", undefined, {
      named: filtered,
      dryRun,
    });
  }

  /** Service address with a ⏸ marker when the repo is auto-start off. */
  private labelWithAutostart(
    address: string,
    noAutostart: Set<string>,
  ): string {
    const base = chalk.bold(address);
    return noAutostart.has(parseAddress(address).repoName)
      ? `${base} ${chalk.yellow("⏸")}`
      : base;
  }

  /** Repos with auto-start toggled off in the active workspace. */
  private noAutostartSet(): Set<string> {
    const ws = getActiveWorkspace();
    if (!ws) return new Set();
    return noAutostartRepos(ws.config, readCatalog());
  }

  private async cmdServiceStatus(argv: string[] = []): Promise<void> {
    await this.ensureWorkspaceSeeded();
    const { app, rest: appRest } = takeAppFlag(argv);
    // The view scope (as the web UI's): every active workspace by default,
    // or `--scope <workspace>` for one. A view only: focus is unchanged.
    const scoped = takeScopeFlag(appRest);
    const args = scoped.rest;
    const scopeArg =
      scoped.scope === null
        ? null
        : parseScope(scoped.scope, getActiveWorkspaces());
    if (scoped.error || (scopeArg && !scopeArg.ok)) {
      console.log(
        chalk.red(
          `\n  ${scoped.error ?? (scopeArg && !scopeArg.ok ? scopeArg.error : "")}\n`,
        ),
      );
      process.exit(1);
    }
    // `-w <workspace>` still means that workspace only (active or not).
    const named = process.env.DEN_WORKSPACE_OVERRIDE
      ? getActiveWorkspace()
      : null;
    const view =
      named && !scopeArg
        ? {
            scope: named.name,
            fellBack: false,
            workspaces: [named],
            focus: named.name,
          }
        : scopeView(scopeArg?.ok ? scopeArg.value : undefined);
    const only = app ? focusedAppRepos(app) : null;
    const verbose = args.includes("--verbose") || args.includes("--all");
    const spinner = ora("Checking service health...").start();
    const raw = (
      await checkCatalogHealth(
        undefined,
        "local",
        view.workspaces.filter((w) => w.config),
      )
    ).filter((h) => !only || only.has(h.repoName));
    // One row per repo, rolled up from every checked service by the rule the
    // web UI's header and graph use: entry down → down, another checked
    // service down → degraded; unchecked services never count.
    const rolled = verbose ? raw : rollupRepoHealth(raw);
    // Order top-down like the graph: entry repo first (shop-web) … foundation
    // last (infra-stack), subsystems grouped under their repo.
    const order = orderForDown(deriveGraph({ scope: "all" }));
    const results = sortByRepoOrder(rolled, order);
    spinner.stop();
    const noAutostart = this.noAutostartSet();

    if (results.length === 0) {
      console.log(
        chalk.yellow(
          `\n  No services registered. Run: ${product().cli} register\n`,
        ),
      );
      return;
    }

    console.log(chalk.cyan(`\n  ${scopeLine(view)}\n`));

    const table = newTable({
      head: ["Service", "Mode", "Branch", "Health", "Reason"],
      style: { head: ["cyan"] },
    });

    for (const r of results) {
      const healthStr = r.rollup
        ? formatRollupLabel(r.rollup)
        : formatHealthLabel(r.health);
      const rolledWhy = r.rollup ? rollupReasonText(r.rollup) : "";
      const reasonStr =
        r.rollup && r.rollup.state !== "unknown"
          ? chalk.gray(
              [r.rollup.state === "down" ? healthReasonText(r) : "", rolledWhy]
                .filter(Boolean)
                .join("; ")
                .slice(0, 60),
            )
          : formatHealthReason(r) ||
            (rolledWhy ? chalk.gray(rolledWhy.slice(0, 60)) : "");
      const placed = placementSuffix({
        runs: r.runs ?? "none",
        target: r.target ?? null,
      });

      table.push([
        this.labelWithAutostart(r.address, noAutostart) +
          chalk.gray(ownersSuffix(r.workspaces)) +
          (placed ? chalk.cyan(`  ${placed}`) : ""),
        r.mode === "dev-managed"
          ? chalk.blue("dev-managed")
          : chalk.magenta("managed"),
        r.branch ?? chalk.gray("(dev-managed)"),
        healthStr,
        reasonStr,
      ]);
    }

    console.log(table.toString());
    if (
      results.some((r) => noAutostart.has(parseAddress(r.address).repoName))
    ) {
      console.log(
        chalk.gray("  ⏸ auto-start off — not started by workspace up"),
      );
    }
    if (!verbose && raw.length !== results.length) {
      console.log(
        chalk.gray(
          `  ▪ one row per repo, rolled up from its checked services — \`${product().cli} status --verbose\` for each`,
        ),
      );
    }
    const contributors = loadApplications()
      .filter((a) => !app || a.name === app)
      .flatMap((a) => a.contributors);
    if (contributors.length > 0) {
      console.log(chalk.cyan("\n  Contributes (no runtime of its own):"));
      for (const c of contributors)
        console.log(`    ${describeContributor(c)}`);
    }
    console.log();
  }

  private async cmdLogs(args: string[]): Promise<void> {
    await this.ensureWorkspaceSeeded();
    const alias = loadAliasResolver();
    const target = resolveLogsTarget(canonicalTargets(args, 1), alias);
    if (target.kind === "unknown-repo") {
      console.log(chalk.red(`\n  Unknown repo: ${target.arg}\n`));
      process.exit(1);
    }
    if (target.kind === "no-cwd-repo") {
      console.log(
        chalk.red(
          "\n  Not inside a known repo — run from a repo folder or pass a repo name.\n",
        ),
      );
      process.exit(1);
    }

    let resolved = resolveService(target.target);
    if (!resolved) {
      console.log(
        chalk.red(
          `\n  Service "${target.target}" not found in catalog or active workspace.\n`,
        ),
      );
      process.exit(1);
    }

    // The canonical run-state test (same as the web down-skip and log search):
    // container check first (cheap, host-truth), health probe as the fallback
    // for host-run processes with no container.
    const running =
      hasRunningOpctlContainers(resolved) ||
      (await checkServiceHealth(resolved, "local")).health === "ok";

    let justStarted = false;
    if (!running) {
      const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
      if (!interactive) {
        console.error(
          chalk.red(`${resolved.address} is not running.`) +
            chalk.gray(
              ` Start it with '${product().cli} up ${target.target}', then re-run '${product().cli} logs'.`,
            ),
        );
        process.exit(1);
      }
      console.log(
        chalk.yellow(
          `\n  ${resolved.address} is not running (no container or healthy endpoint).`,
        ),
      );
      const start = await cliPrompts.confirm(
        `Start it now with '${product().cli} up ${target.target}'?`,
        true,
      );
      if (!start) {
        console.log(chalk.gray("\n  Nothing to tail.\n"));
        // inquirer holds stdin open after a prompt — exit explicitly.
        process.exit(0);
      }
      await this.cmdServiceUp([target.target]);
      justStarted = true;

      // `up` detaches after ~4s with no success signal. Re-resolve (a first
      // clone can correct a bare repo's subsystem to the manifest entrypoint)
      // and wait for readiness so we tail what actually started — fail-open
      // when the service has no health check.
      resolved = resolveService(target.target) ?? resolved;
      const addr = resolved.address;
      const spinner = ora(`Waiting for ${addr} to become ready...`).start();
      const ready = await waitForReady(resolved, "local", {
        onTick: (detail) => {
          spinner.text = `Waiting for ${addr}: ${detail}`;
        },
      });
      if (!ready.ok) {
        spinner.warn(
          chalk.yellow(
            `${resolved.address} is still not healthy (${ready.detail}) — tailing its startup log anyway.`,
          ),
        );
      } else if (ready.skipped) {
        spinner.stop();
      } else {
        spinner.succeed(`${resolved.address} is ready`);
      }
    }

    const code = await tailServiceLogs(
      resolved,
      justStarted ? { waitForSourceMs: 15_000 } : {},
    );
    process.exit(code === 0 ? 0 : 1);
  }

  private async cmdListServices(): Promise<void> {
    await this.ensureWorkspaceSeeded();
    const spinner = ora("Loading services...").start();
    const catalog = readCatalog();
    const results = await checkCatalogHealth(catalog);
    spinner.stop();
    const noAutostart = this.noAutostartSet();

    if (results.length === 0) {
      console.log(chalk.yellow("\n  No services registered.\n"));
      console.log(
        chalk.gray(`  Register a repo: ${product().cli} register <path>\n`),
      );
      return;
    }

    const table = newTable({
      head: ["Service", "Mode", "Health", "Commands"],
      style: { head: ["cyan"] },
    });

    for (const r of results) {
      const healthStr = formatHealthDot(r.health);

      let cmds: string[] = [];
      try {
        cmds = Object.keys(localCommandsFor(r, this.focusedWs()));
      } catch {
        /* ignore */
      }

      const placed = placementSuffix({
        runs: r.runs ?? "none",
        target: r.target ?? null,
      });
      table.push([
        this.labelWithAutostart(r.address, noAutostart) +
          (placed ? chalk.cyan(`  ${placed}`) : ""),
        r.mode === "dev-managed"
          ? chalk.blue("dev-managed")
          : chalk.magenta("managed"),
        healthStr,
        // A remote service's commands are never run from here.
        placed ? chalk.gray("—") : cmds.join(", "),
      ]);
    }

    console.log(table.toString());
    if (
      results.some((r) => noAutostart.has(parseAddress(r.address).repoName))
    ) {
      console.log(
        chalk.gray("  ⏸ auto-start off — not started by workspace up"),
      );
    }
    console.log();
  }

  private async cmdRegister(args: string[]): Promise<void> {
    if (args.includes("-h") || args.includes("--help")) {
      console.log(
        `\n  ${product().cli} register [path] [--name <repo>] [--gh <owner/repo>] [-w <workspace>] [--org <id>]\n\n` +
          "  With a path: add that checkout to the catalog and the focused\n" +
          "  workspace as your own (dev-managed) copy, without prompts. The name\n" +
          "  defaults to the manifest's name, then the folder name; the GitHub\n" +
          "  slug to the git remote. -w writes that workspace (active or not)\n" +
          "  and leaves focus alone.\n" +
          "  Without a path: choose a local checkout or a managed clone interactively;\n" +
          "  a managed clone comes from the workspace's org, or --org <id>.\n",
      );
      return;
    }
    const repoPathArg = args.find(
      (a, i) =>
        !a.startsWith("-") && !/^--(name|gh|org)$/.test(args[i - 1] ?? ""),
    );
    // Without a path, register prompts: with no terminal (stdin closed or
    // piped, where readline would throw ERR_USE_AFTER_CLOSE mid-prompt), say
    // how to name one. Usage error: exit 2.
    if (!repoPathArg && !process.stdin.isTTY) {
      process.stderr.write(
        `register needs a terminal (stdin is not a TTY); without one: ` +
          `${product().cli} register <path> [--name <repo>] [--gh <owner/repo>] [-w <workspace>]\n`,
      );
      process.exitCode = 2;
      return;
    }
    const ws = getActiveWorkspace();
    if (!ws) {
      console.log(
        chalk.red(
          `\n  No active workspace. Create one first: ${product().cli} workspace create\n`,
        ),
      );
      return;
    }

    if (repoPathArg) {
      const flag = (n: string) => {
        const i = args.indexOf(n);
        return i >= 0 ? args[i + 1] : undefined;
      };
      await this.registerPath(ws, repoPathArg, flag("--name"), flag("--gh"));
      return;
    }

    const source = await cliPrompts.promptForRegistrationSource();

    if (source === "local") {
      await this.registerLinked(ws);
    } else {
      await this.registerManaged(ws, orgFlag(args));
    }
  }

  /**
   * `relocate <repo> <path>`: a checkout moved on disk. Rewrites the path of
   * every dev-managed entry for <repo> (bare and `<repo>/<svc>` addresses) in
   * every workspace, or only the `-w` one. Managed entries are Den's own
   * clones and are left alone. Focus and the active set never change.
   */
  private async cmdRelocate(args: string[]): Promise<void> {
    const usage = `${product().cli} relocate <repo> <path> [--dry-run] [--force] [-w <workspace>]`;
    if (args.includes("-h") || args.includes("--help")) {
      console.log(
        `\n  ${usage}\n\n` +
          "  A checkout moved: point every workspace's dev-managed entries for\n" +
          "  <repo> at <path>. Refuses a missing path, one whose manifest\n" +
          "  name or GitHub remote names a different repo, and one where\n" +
          "  neither names this repo (--force accepts that last). --dry-run shows\n" +
          "  the changes without writing. -w limits it to that workspace.\n" +
          "  Focus and the active set never change.\n",
      );
      return;
    }
    const dryRun = args.includes("--dry-run") || args.includes("-n");
    const force = args.includes("--force");
    const unknown = args.find(
      (a) => a.startsWith("-") && !["--dry-run", "-n", "--force"].includes(a),
    );
    const positional = args.filter((a) => !a.startsWith("-"));
    if (unknown || positional.length !== 2) {
      console.error(
        chalk.red(
          `\n  ❌ ${unknown ? `Unknown flag: ${unknown}` : "Need a repo and a path"}.\n     Usage: ${usage}\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    const [repoName, rawPath] = positional;
    const { existsSync, statSync } = await import("fs");
    const newPath = nodePath.resolve(rawPath);
    const fail = (msg: string) => {
      console.error(chalk.red(`\n  ❌ ${msg}\n`));
      process.exitCode = 1;
    };
    const file = readWorkspacesFile();
    const only = process.env.DEN_WORKSPACE_OVERRIDE;
    const names = only ? [only] : Object.keys(file.workspaces);
    const belongs = (key: string) =>
      key === repoName || key.startsWith(`${repoName}/`);
    if (
      !names.some((ws) =>
        Object.keys(file.workspaces[ws]?.services ?? {}).some(belongs),
      )
    ) {
      fail(
        `"${repoName}" is not in ${only ? `workspace "${only}"` : "any workspace"}.`,
      );
      return;
    }
    if (!existsSync(newPath) || !statSync(newPath).isDirectory()) {
      fail(`Path does not exist: ${newPath}`);
      return;
    }

    // The new path must hold this repo: its manifest name and GitHub remote,
    // when present, must agree with the repo and its catalog entry.
    const manifest = readManifest(newPath);
    const leaf = repoName.split("/").pop() ?? repoName;
    if (
      manifest?.name &&
      manifest.name !== repoName &&
      manifest.name !== leaf
    ) {
      fail(
        `${newPath} holds "${manifest.name}", not "${repoName}" (its manifest name).`,
      );
      return;
    }
    const catalogGh = readCatalog()[repoName]?.gh?.trim();
    const coords = getGitHubCoords(newPath);
    const remote = coords ? `${coords.owner}/${coords.repo}` : undefined;
    if (
      catalogGh &&
      remote &&
      catalogGh.toLowerCase() !== remote.toLowerCase()
    ) {
      fail(
        `${newPath} is a checkout of ${remote}; the catalog has "${repoName}" as ${catalogGh}.`,
      );
      return;
    }
    // Not contradicting is not enough: an empty or unrelated folder has no
    // manifest and no remote. Something must say this is the repo.
    const identified =
      manifest?.name === repoName ||
      manifest?.name === leaf ||
      (!!catalogGh &&
        !!remote &&
        catalogGh.toLowerCase() === remote.toLowerCase()) ||
      (!catalogGh && coords?.repo.toLowerCase() === leaf.toLowerCase());
    if (!identified && !force) {
      fail(
        `Nothing at ${newPath} says it is "${repoName}": no manifest named ` +
          `"${leaf}" and no GitHub remote ${catalogGh || `…/${leaf}`}.\n` +
          `     If it is, say so: ${product().cli} relocate ${repoName} ${rawPath} --force${dryRun ? " --dry-run" : ""}${only ? ` -w ${only}` : ""}`,
      );
      return;
    }

    const changes: { ws: string; addr: string; from: string }[] = [];
    const managed: { ws: string; addr: string }[] = [];
    for (const ws of names) {
      const entries = file.workspaces[ws]?.services ?? {};
      for (const [addr, entry] of Object.entries(entries)) {
        if (!belongs(addr)) continue;
        if (entry.mode !== "dev-managed") {
          managed.push({ ws, addr });
          continue;
        }
        if (entry.path && nodePath.resolve(entry.path) === newPath) continue;
        changes.push({ ws, addr, from: entry.path ?? "(default)" });
        if (!dryRun) entry.path = newPath;
      }
    }

    if (changes.length > 0 && !dryRun) writeWorkspacesFile(file);

    const verb = dryRun ? "Would point" : "Pointed";
    if (changes.length === 0) {
      console.log(
        chalk.gray(
          `\n  Nothing to change: "${repoName}" is already at ${newPath}.`,
        ),
      );
    } else {
      console.log(chalk.green(`\n  ✓ ${verb} at ${newPath}:\n`));
      for (const c of changes) {
        console.log(
          `    ${chalk.bold(c.addr)}  ${chalk.gray(`${c.ws}   was ${c.from}`)}`,
        );
      }
    }
    for (const m of managed) {
      console.log(
        chalk.gray(
          `    ${m.addr}  ${m.ws}   managed (Den's clone): left alone`,
        ),
      );
    }
    console.log();
  }

  /** Non-interactive `register <path>`: a dev-managed entry in the focused (or -w) workspace. */
  private async registerPath(
    ws: {
      name: string;
      config: import("../../shared/types/index.js").WorkspaceConfig;
    },
    rawPath: string,
    nameArg: string | undefined,
    ghArg: string | undefined,
  ): Promise<void> {
    const { existsSync } = await import("fs");
    const repoPath = nodePath.resolve(rawPath);
    if (!existsSync(repoPath)) {
      console.log(chalk.red(`\n  ❌ Path does not exist: ${repoPath}\n`));
      process.exitCode = 1;
      return;
    }
    const manifest = readManifest(repoPath);
    const repoName = nameArg ?? manifest?.name ?? nodePath.basename(repoPath);
    const coords = getGitHubCoords(repoPath);
    const gh = ghArg ?? (coords ? `${coords.owner}/${coords.repo}` : undefined);
    upsertCatalogEntry(repoName, { gh: gh ?? "" });
    await this.writeWorkspaceEntries(
      ws,
      repoName,
      manifest,
      "dev-managed",
      repoPath,
      undefined,
      true,
    );
  }

  /** Register a local checkout as a linked service in the active workspace. */
  private async registerLinked(ws: {
    name: string;
    config: import("../../shared/types/index.js").WorkspaceConfig;
  }): Promise<void> {
    const catalog = readCatalog();
    const repoPath = await cliPrompts.promptForRepoPath(Object.keys(catalog));

    const { existsSync } = await import("fs");
    if (!existsSync(repoPath)) {
      console.log(chalk.red(`\n  ❌ Path does not exist: ${repoPath}\n`));
      return;
    }

    const manifest = readManifest(repoPath);
    // Use the path relative to repos root as the catalog key so that repos in
    // project subdirectories get unique, path-based keys (e.g. "projectA/serviceA").
    const repoName = nodePath.relative(getReposRoot(), repoPath);

    // Auto-detect GH slug from git remote; fall back to asking
    let ghSlug: string;
    const coords = getGitHubCoords(repoPath);
    if (coords) {
      ghSlug = `${coords.owner}/${coords.repo}`;
    } else {
      ghSlug = await cliPrompts.promptForGhSlug();
    }

    upsertCatalogEntry(repoName, { gh: ghSlug });

    const linkedPath = await cliPrompts.promptForLinkedPath(repoPath);

    await this.writeWorkspaceEntries(
      ws,
      repoName,
      manifest,
      "dev-managed",
      linkedPath,
      undefined,
    );
  }

  /**
   * List an org's repos via `gh`, let the user pick one + branch → managed
   * service. The org is `--org <id>`, else the focused workspace's resolved
   * org (ORG-1a). Never Den's own checkout or remote (SEC-0).
   */
  private async registerManaged(
    ws: {
      name: string;
      config: import("../../shared/types/index.js").WorkspaceConfig;
    },
    orgArg?: string,
  ): Promise<void> {
    const org = registerOrg(ws.name, orgArg);
    if (!org) {
      console.log(
        chalk.red(
          `\n  ❌ No GitHub org to list: set github_org in ${product().configFile}, ` +
            `org: on workspace ${ws.name}, or pass --org <id> ` +
            `(an org with no GitHub source in orgs.<id>.sources has none)\n`,
        ),
      );
      return;
    }

    console.log(chalk.gray(`\n  Fetching repos from ${org}…`));
    let repos: { name: string; nameWithOwner: string; defaultBranch: string }[];
    try {
      const raw = execSync(
        `gh repo list ${org} --json name,nameWithOwner,defaultBranchRef --limit 100`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const parsed = JSON.parse(raw) as {
        name: string;
        nameWithOwner: string;
        defaultBranchRef: { name: string };
      }[];
      repos = parsed.map((r) => ({
        name: r.name,
        nameWithOwner: r.nameWithOwner,
        defaultBranch: r.defaultBranchRef?.name ?? "main",
      }));
    } catch (err) {
      console.log(
        chalk.red(
          `\n  ❌ Could not list repos via gh CLI: ${(err as Error).message}\n`,
        ),
      );
      console.log(
        chalk.gray(
          "  Make sure `gh` is installed and authenticated (`gh auth status`).\n",
        ),
      );
      return;
    }

    if (repos.length === 0) {
      console.log(chalk.yellow(`\n  No repos found under ${org}.\n`));
      return;
    }

    const selected = await cliPrompts.promptForGhOrgRepo(repos);
    const branch = await cliPrompts.promptForBranch(selected.defaultBranch);

    const repoName = selected.name;
    upsertCatalogEntry(repoName, { gh: selected.nameWithOwner });
    console.log(
      chalk.gray(
        `\n  ✓ Added ${repoName} to catalog (gh: ${selected.nameWithOwner})`,
      ),
    );

    // For managed repos we may not have the manifest yet (not cloned);
    // register the repo-level address and let expand handle subsystems later
    await this.writeWorkspaceEntries(
      ws,
      repoName,
      null,
      "managed",
      undefined,
      branch,
    );
  }

  /** Write workspace entries for all services in a repo's manifest. */
  private async writeWorkspaceEntries(
    ws: {
      name: string;
      config: import("../../shared/types/index.js").WorkspaceConfig;
    },
    repoName: string,
    manifest: ReturnType<typeof readManifest>,
    mode: "dev-managed" | "managed",
    linkedPath: string | undefined,
    branch: string | undefined,
    allServices = false,
  ): Promise<void> {
    const serviceKeys = Object.keys(manifest?.services ?? {});
    let addresses: string[];
    if (allServices) {
      // The bare repo name expands to every service in the manifest.
      addresses = [repoName];
    } else if (serviceKeys.length === 0) {
      addresses = [repoName];
    } else if (serviceKeys.length === 1) {
      // Single-service repo: always use the bare catalog key as the workspace address.
      // expandMonoRepoEntry corrects the subsystem during resolution.
      addresses = [repoName];
    } else {
      const all = serviceKeys.map((s) =>
        s === repoName ? repoName : `${repoName}/${s}`,
      );
      addresses = await cliPrompts.promptSelectServices(
        all,
        `Add which services to workspace "${ws.name}"?`,
        true,
      );
    }

    if (addresses.length === 0) {
      console.log(chalk.yellow("\n  No services selected.\n"));
      return;
    }

    const file = readWorkspacesFile();
    const svcEntries = file.workspaces[ws.name].services;
    // Replace ALL existing entries for this repo (bare name + any "repo/subsystem"
    // addresses) before writing the new ones. Otherwise switching mode (e.g.
    // managed → dev-managed) on a multi-service repo leaves a stale entry
    // that silently shadows the new one during resolution. Preserve the per-entry
    // auto-start toggle across the rewrite.
    let hadAutostartOff = false;
    for (const key of Object.keys(svcEntries)) {
      if (key === repoName || key.startsWith(`${repoName}/`)) {
        if (svcEntries[key].autostart === false) hadAutostartOff = true;
        delete svcEntries[key];
      }
    }
    for (const addr of addresses) {
      svcEntries[addr] = {
        mode,
        ...(mode === "dev-managed" && linkedPath ? { path: linkedPath } : {}),
        ...(mode === "managed" && branch ? { branch } : {}),
        ...(hadAutostartOff ? { autostart: false } : {}),
      };
    }
    writeWorkspacesFile(file);

    console.log(chalk.green(`\n  ✓ Added to workspace "${ws.name}":\n`));
    for (const addr of addresses) {
      const detail =
        mode === "managed"
          ? chalk.gray(`managed  branch: ${branch ?? "main"}`)
          : chalk.gray(`dev-managed   path: ${linkedPath ?? ""}`);
      console.log(`    ${chalk.bold(addr)}  ${detail}`);
    }
    console.log();
  }

  /**
   * `den use-local [repo]` / `den use-managed [repo]` — switch a repo's
   * boot source between your local checkout (dev-managed) and a managed
   * clone, in the active workspace. Defaults to the cwd repo; accepts a name.
   */
  private async cmdUseMode(
    args: string[],
    mode: "dev-managed" | "managed",
  ): Promise<void> {
    const repoArg = args.find((a) => !a.startsWith("-"));
    const alias = loadAliasResolver();
    let repo: string | undefined;
    let cwdRoot: string | undefined;
    if (repoArg) {
      const resolved = alias.resolve(repoArg);
      repo =
        resolved && alias.knownRepos.has(resolved)
          ? resolved
          : alias.knownRepos.has(repoArg)
            ? repoArg
            : undefined;
      if (!repo) {
        console.log(chalk.red(`\n  Unknown repo: ${repoArg}\n`));
        return;
      }
    } else {
      const cwd = resolveCwdRepo(alias);
      if (!cwd) {
        console.log(
          chalk.red(
            "\n  Not inside a known repo — run from a repo folder or pass a repo name.\n",
          ),
        );
        return;
      }
      repo = cwd.repo;
      cwdRoot = cwd.root;
    }

    if (mode === "dev-managed") {
      const localPath = cwdRoot ?? nodePath.join(getReposRoot(), repo);
      if (!fs.existsSync(localPath)) {
        console.log(
          chalk.red(`\n  No local checkout found at ${localPath}.`) +
            chalk.gray(
              `\n  Clone it there first, or use '${product().cli} register' to set a custom path.\n`,
            ),
        );
        return;
      }
      this.switchRepoMode(repo, "dev-managed", localPath, undefined);
    } else {
      const branch =
        args.find((a) => a.startsWith("--branch="))?.split("=")[1] ?? "main";
      this.switchRepoMode(repo, "managed", undefined, branch);
    }
  }

  /** Rewrite the active workspace's existing entries for a repo with a new mode. */
  private switchRepoMode(
    repoName: string,
    mode: "dev-managed" | "managed",
    linkedPath: string | undefined,
    branch: string | undefined,
  ): void {
    const ws = getActiveWorkspace();
    if (!ws) {
      console.log(chalk.red("\n  No active workspace.\n"));
      return;
    }
    const file = readWorkspacesFile();
    const wsFile = file.workspaces[ws.name];
    if (!wsFile) {
      console.log(chalk.red(`\n  Workspace "${ws.name}" not found.\n`));
      return;
    }
    if (!wsFile.services) wsFile.services = {};
    const svcEntries = wsFile.services;
    // Preserve the repo's existing subsystem addresses — just flip mode/path/branch.
    let keys = Object.keys(svcEntries).filter(
      (k) => k === repoName || k.startsWith(`${repoName}/`),
    );
    const added = keys.length === 0;
    if (added) keys = [repoName];
    for (const k of keys) {
      // Preserve the per-entry auto-start toggle across the mode rewrite.
      const keepOff = svcEntries[k]?.autostart === false;
      svcEntries[k] = {
        mode,
        ...(mode === "dev-managed" && linkedPath ? { path: linkedPath } : {}),
        ...(mode === "managed" ? { branch: branch ?? "main" } : {}),
        ...(keepOff ? { autostart: false } : {}),
      };
    }
    writeWorkspacesFile(file);

    const detail =
      mode === "dev-managed"
        ? `dev-managed → ${linkedPath}`
        : `managed (branch: ${branch ?? "main"})`;
    console.log(chalk.green(`\n  ✓ ${chalk.bold(repoName)} is now ${detail}`));
    console.log(
      chalk.gray(
        `    services: ${keys.join(", ")}${added ? "  (added to workspace)" : ""}`,
      ),
    );
    const revert =
      mode === "dev-managed"
        ? `${product().cli} use-managed ${repoName}`
        : `${product().cli} use-local ${repoName}`;
    console.log(chalk.gray(`    revert: ${revert}\n`));
  }

  private async cmdSetup(rawArgs: string[]): Promise<void> {
    // `-w <ws>` (repeatable) and `--all-active` pick the workspaces to plan.
    const { workspaces: planWs, rest: args } = takeWorkspaceFlags(rawArgs);
    const allActive = args.includes("--all-active");
    const force = args.includes("--force") || args.includes("-f");
    const names = args.filter((a) => !a.startsWith("-"));

    // `--plan`: each repo's org and clone URL, then stop. Read-only.
    if (args.includes("--plan")) {
      let plan: ReturnType<typeof buildSetupPlan>;
      try {
        plan = buildSetupPlan(names, { workspaces: planWs, allActive });
      } catch (e) {
        console.error(chalk.red(`\n  ${(e as Error).message}\n`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.bold("\n  Setup plan (no changes will be made):\n"));
      for (const line of renderClonePlan(plan, product().cli))
        console.log(`  ${line}`.trimEnd());
      console.log();
      return;
    }
    if (planWs.length > 1 || allActive) {
      console.error(
        chalk.red(
          `\n  More than one -w, and --all-active, go with --plan: setup itself works on one workspace (-w <workspace>, or the one the named repos are in, else the focus).\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    if (planWs.length === 1) {
      const ws = planWs[0];
      if (!readWorkspacesFile().workspaces[ws]) {
        console.error(chalk.red(`\n  Workspace "${ws}" does not exist\n`));
        process.exitCode = 1;
        return;
      }
      if (!isWorkspaceActive(ws)) {
        console.error(
          chalk.red(
            `\n  Workspace "${ws}" is not active — run \`${product().cli} workspace activate ${ws}\` first\n`,
          ),
        );
        process.exitCode = 1;
        return;
      }
      process.env.DEN_WORKSPACE_OVERRIDE = ws;
    } else if (!this.pickTargetWorkspace("setup", args)) return;

    // Clone any managed repos that aren't on disk yet before reading manifests.
    this.cloneMissingManagedRepos();

    const services = getWorkspaceServices();
    if (services.length === 0) {
      console.log(
        chalk.yellow(
          `\n  No services in active workspace. Run: ${product().cli} register\n`,
        ),
      );
      return;
    }

    // A name the listing doesn't spell the same way (an alias, a bare repo
    // listed only by subsystem) is matched as resolveService resolves it.
    const matches = (name: string, s: (typeof services)[number]): boolean => {
      if (name === s.address || name === s.repoName) return true;
      const r = resolveService(name);
      return !!r && (r.address === s.address || r.repoName === s.address);
    };
    const unmatched = names.filter((n) => !services.some((s) => matches(n, s)));
    if (unmatched.length > 0) {
      const ws = getActiveWorkspace()?.name ?? "default";
      console.error(
        chalk.red(
          `\n  ✗ Not in workspace ${ws}: ${unmatched.join(", ")}. Nothing was set up.\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    let targets =
      names.length > 0
        ? services.filter((s) => names.some((n) => matches(n, s)))
        : services;

    // Workspace-wide default: MANAGED clones only. `make setup` runs
    // codegen/dependency installs that dirty a checkout — fine for clones
    // den owns, uninvited in an engineer's own dev-managed repo. `--force`
    // (-f) includes dev-managed; naming a repo explicitly always works.
    if (names.length === 0 && !force) {
      const skipped = [
        ...new Set(
          targets
            .filter((s) => s.mode === "dev-managed")
            .map((s) => s.repoName),
        ),
      ];
      targets = targets.filter((s) => s.mode === "managed");
      if (skipped.length > 0) {
        console.log(
          chalk.gray(
            `\n  Skipping dev-managed (your own checkouts): ${skipped.join(", ")}` +
              `\n  Include them with \`${product().cli} setup --force\`, or name one explicitly.`,
          ),
        );
      }
    }

    // One setup per SYSTEM: run against the bare repo (resolves to the
    // entrypoint), not once per subsystem — several manifests declare `setup`
    // on multiple services and each run re-dirties the clone with codegen.
    // An explicitly named "repo/subsystem" address is honored as-is.
    const explicitAddrs = new Set(
      names.filter(
        (n) => n.includes("/") && targets.some((s) => s.address === n),
      ),
    );
    const seenRepos = new Set<string>();
    const runList: Array<{ label: string; target: string; path: string }> = [];
    for (const svc of targets) {
      if (explicitAddrs.has(svc.address)) {
        runList.push({
          label: svc.address,
          target: svc.address,
          path: svc.repoPath,
        });
      } else if (!seenRepos.has(svc.repoName)) {
        seenRepos.add(svc.repoName);
        runList.push({
          label: svc.repoName,
          target: svc.repoName,
          path: svc.repoPath,
        });
      }
    }

    for (const item of runList) {
      console.log(
        chalk.cyan(`\n  ▶ Setup: ${chalk.bold(item.label)} (${item.path})`),
      );
      await this.runServicesCommand([item.target], "setup");
    }
  }

  private async cmdWorkspace(args: string[]): Promise<void> {
    const sub = args[0];
    const file = readWorkspacesFile();
    const activeSet = new Set(file.active);
    const focus = file.focus ?? file.active[0];

    switch (sub) {
      case "list": {
        const only = orgFlag(args.slice(1));
        const { resolved, warnings } = orgListRows();
        const orgOfWs = new Map(resolved.map((w) => [w.workspace, w.org]));
        const shown = Object.entries(file.workspaces).filter(
          ([name]) => !only || sameOrg(orgOfWs.get(name) ?? null, only),
        );
        // A Stacks column only when a shown workspace's stack namespace is
        // not its default suffix (or is invalid): the list is otherwise as before.
        const nsRows = new Map(
          stackNamespaceRows(shown.map(([n]) => n)).map((r) => [
            r.workspace,
            r,
          ]),
        );
        const nsCol = [...nsRows.values()].some((r) => r.differs || r.error);
        const table = newTable({
          head: [
            "Workspace",
            "Org",
            "Active",
            "Focus",
            "Services",
            "Type",
            ...(nsCol ? ["Stacks"] : []),
          ],
          style: { head: ["cyan"] },
        });
        for (const [name, cfg] of shown) {
          const ns = nsRows.get(name);
          table.push([
            chalk.bold(name),
            orgOfWs.get(name) ?? chalk.gray("none"),
            activeSet.has(name) ? chalk.green("✓") : "",
            name === focus ? chalk.cyan("●") : "",
            Object.keys(cfg.services).join(", ") || chalk.gray("none"),
            cfg.directory ? chalk.magenta("feature") : chalk.blue("default"),
            ...(nsCol
              ? [
                  ns?.error
                    ? chalk.red("invalid")
                    : ns?.differs
                      ? `${ns.stack_namespace} ${chalk.gray(`(${ns.source})`)}`
                      : chalk.gray(ns?.default ?? ""),
                ]
              : []),
          ]);
        }
        console.log(table.toString());
        printOrgWarnings(
          [...nsRows.values()].flatMap((r) =>
            r.error ? [`workspace ${r.workspace}: ${r.error}`] : r.warnings,
          ),
        );
        if (only && shown.length === 0)
          console.log(chalk.yellow(`  No workspace in org ${only}.`));
        const names = new Set(shown.map(([n]) => n));
        printOrgWarnings(
          warnings.filter((w) =>
            [...names].some((n) => w.startsWith(`workspace ${n}:`)),
          ),
        );
        break;
      }
      case "activate": {
        const name = args[1];
        if (!name) {
          console.log(
            chalk.red(`Usage: ${product().cli} workspace activate <name>`),
          );
          return;
        }
        activateWorkspace(name);
        console.log(
          chalk.green(`\n  ✓ Activated workspace: ${chalk.bold(name)}\n`),
        );
        break;
      }
      case "deactivate": {
        const name = args[1];
        if (!name) {
          console.log(
            chalk.red(`Usage: ${product().cli} workspace deactivate <name>`),
          );
          return;
        }
        deactivateWorkspace(name);
        // Release AFTER the workspace has left active[] so shared services see
        // the post-deactivation owner set (design decision 5).
        const releases = await releaseWorkspaceDaemons(name, (line) =>
          console.log(chalk.gray(`    ${line}`)),
        );
        console.log(
          chalk.green(`\n  ✓ Deactivated workspace: ${chalk.bold(name)}`),
        );
        for (const release of releases) {
          switch (release.outcome) {
            case "detached":
              console.log(
                chalk.gray(
                  `    ${release.address} — still running for [${release.remaining.join(", ")}]`,
                ),
              );
              break;
            case "stopped":
              console.log(chalk.gray(`    ${release.address} — stopped`));
              break;
            case "stop-failed":
              console.log(
                chalk.yellow(
                  `    ${release.address} — stop failed; run \`${product().cli} down --force ${release.address}\``,
                ),
              );
              break;
            default: {
              const _exhaustive: never = release.outcome;
              throw new Error(`unhandled release outcome: ${_exhaustive}`);
            }
          }
        }
        // Deactivate releases tracked daemons only; say what it left up.
        // One docker ps for this workspace and every other active one.
        let up: ReturnType<typeof runningComposeProjects> | undefined;
        const running = () =>
          up === undefined ? (up = runningComposeProjects()) : up;
        const stacks = runningWorkspaceStacks(name, running);
        const heldBy = new Map<string, string[]>();
        if (stacks?.length)
          for (const other of getActiveWorkspaces())
            for (const s of runningWorkspaceStacks(other, running) ?? [])
              heldBy.set(s.project, [...(heldBy.get(s.project) ?? []), other]);
        const stacksNote = composeStacksNotice(product().cli, stacks, heldBy);
        if (stacksNote) console.log(chalk.yellow(`    ${stacksNote}`));
        console.log("");
        break;
      }
      case "focus": {
        const name = args[1];
        if (!name) {
          console.log(
            chalk.red(`Usage: ${product().cli} workspace focus <name>`),
          );
          return;
        }
        setFocusedWorkspace(name);
        console.log(
          chalk.green(`\n  ✓ Focused workspace: ${chalk.bold(name)}\n`),
        );
        break;
      }
      case "use": {
        const name = args[1];
        if (!name) {
          console.log(
            chalk.red(`Usage: ${product().cli} workspace use <name>`),
          );
          return;
        }
        setActiveWorkspace(name);
        console.log(
          chalk.green(
            `\n  ✓ Activated and focused workspace: ${chalk.bold(name)}\n`,
          ),
        );
        break;
      }
      case "seed": {
        await this.seedDefaultWorkspaceFlow("init", args.includes("--reset"));
        break;
      }
      case "create": {
        const name =
          args[1] ??
          (await cliPrompts.promptForWorkspaceName(
            Object.keys(file.workspaces),
          ));
        if (file.workspaces[name]) {
          console.log(
            chalk.yellow(`\n  Workspace "${name}" already exists.\n`),
          );
          return;
        }
        createWorkspace(name, { services: {} });
        console.log(
          chalk.green(`\n  ✓ Created workspace: ${chalk.bold(name)}`),
        );
        console.log(
          chalk.gray(`    Edit config/local/workspaces.yml to add services\n`),
        );
        break;
      }
      case "delete": {
        const name = args[1];
        if (!name) {
          console.log(
            chalk.red(`Usage: ${product().cli} workspace delete <name>`),
          );
          return;
        }
        const confirmed =
          args.includes("--yes") ||
          args.includes("-y") ||
          (await cliPrompts.confirm(
            `Delete workspace "${name}"? This will remove ${product().workspacesDir}/${name}/`,
            false,
          ));
        if (!confirmed) return;
        deleteWorkspaceDirectory(name);
        deleteWorkspaceConfig(name);
        console.log(chalk.green(`\n  ✓ Deleted workspace: ${name}\n`));
        break;
      }
      case "code": {
        const name = args[1] ?? focus;
        const wsCfg = file.workspaces[name];
        if (!wsCfg) {
          console.log(chalk.red(`  Workspace "${name}" not found\n`));
          return;
        }
        const editor = readUserConfig().editor ?? "";
        const vscodeLike = new Set(["vscode", "cursor"]);
        const jetbrains = new Set(["webstorm", "idea"]);
        const catalog = readCatalog();

        if (vscodeLike.has(editor)) {
          const wsFilePath = generateVSCodeWorkspace(name, wsCfg, catalog);
          console.log(chalk.green(`\n  ✓ ${wsFilePath}\n`));
          try {
            execSync(
              `${editor === "cursor" ? "cursor" : "code"} "${wsFilePath}"`,
              { stdio: "ignore" },
            );
          } catch {
            console.log(chalk.gray(`  Run: code "${wsFilePath}"\n`));
          }
        } else if (jetbrains.has(editor)) {
          syncJetBrainsWorkspaceSymlinks(file);
          // ws.directory is stored relative to the den root (see
          // workspace-routes.ts) — resolve against that anchor, never cwd.
          const wsDir = wsCfg.directory
            ? nodePath.resolve(getDistRoot(), wsCfg.directory)
            : nodePath.join(DEN_WORKSPACES_DIR, name);
          console.log(chalk.green(`\n  ✓ ${wsDir}\n`));
          try {
            execSync(`${editor} "${wsDir}"`, { stdio: "ignore" });
          } catch {
            console.log(chalk.gray(`  Run: ${editor} "${wsDir}"\n`));
          }
        } else {
          console.log(
            chalk.yellow(
              `\n  ⚠ No workspace-level open support for editor "${editor || "(none set)"}".\n` +
                `    Open individual repos from the graph or: ${product().cli} settings → set editor\n`,
            ),
          );
        }
        break;
      }
      default:
        console.log(
          chalk.gray(
            `Usage: ${product().cli} workspace <${WORKSPACE_SUBCOMMANDS.map((c) => c.name).join("|")}> [name]`,
          ),
        );
    }
  }

  private async cmdSync(args: string[]): Promise<void> {
    const allServices = getWorkspaceServices();
    if (allServices.length === 0) {
      console.log(
        chalk.yellow("\n  No services in active workspace to sync.\n"),
      );
      return;
    }

    // Deduplicate by repoPath — one pull per unique checkout
    const seen = new Set<string>();
    const targets = allServices.filter((s) => {
      if (
        args.length > 0 &&
        !args.includes(s.address) &&
        !args.includes(s.repoName)
      )
        return false;
      if (seen.has(s.repoPath)) return false;
      seen.add(s.repoPath);
      return true;
    });

    // Bootstrap: a managed repo that was never cloned can't be checked,
    // let alone pulled — and syncing it IS the intent. Clone + set it up first
    // (marker-aware: a previously failed setup is repaired too). After this,
    // the normal check below reports it up to date.
    const missing = [
      ...new Set(
        targets
          .filter((s) => s.mode === "managed" && !fs.existsSync(s.repoPath))
          .map((s) => s.repoName),
      ),
    ];
    if (missing.length > 0) {
      console.log(
        chalk.cyan(
          `\n  Cloning ${plural(missing.length, "managed repo")} not on disk yet: ${missing.join(", ")}`,
        ),
      );
      await this.ensureManagedClonesFor(missing);
    }

    console.log();
    for (const svc of targets) {
      const spinner = ora(`Checking ${chalk.bold(svc.repoName)}...`).start();
      const behind = checkBehindCount(svc.repoPath);
      spinner.stop();

      if (behind === -1) {
        console.log(
          chalk.gray(`  ${svc.repoName}: unable to check (no upstream?)`),
        );
        continue;
      }
      if (behind === 0) {
        console.log(chalk.green(`  ✓ ${svc.repoName}: up to date`));
        continue;
      }

      const label =
        svc.mode === "dev-managed"
          ? chalk.blue("[dev-managed]")
          : chalk.magenta("[managed]");
      console.log(
        chalk.yellow(
          `  ${svc.repoName} ${label}: ${behind} commit${behind === 1 ? "" : "s"} behind`,
        ),
      );

      if (svc.mode === "dev-managed") {
        console.log(chalk.gray(`    Dev-managed — pull in your own checkout.`));
        continue;
      }

      // Managed checkouts are den's to keep fresh — pull without
      // prompting (dev-managed repos above are never touched).
      const pullSpinner = ora(`Pulling ${svc.repoName}...`).start();
      try {
        pullRepo(svc.repoPath);
        pullSpinner.succeed(`Pulled ${svc.repoName}`);
      } catch (e) {
        pullSpinner.fail(
          `Failed to pull ${svc.repoName}: ${(e as Error).message}`,
        );
      }
    }
    console.log();
  }

  // ── den validate ────────────────────────────────────────────────────────

  private async cmdValidate(args: string[]): Promise<void> {
    // The org config first (0.3.0-dev.40, a consumer's 0.2.8 nit: a
    // ConfigError went unreported): each problem with its file and key
    // path, a non-zero exit, and the manifests are still checked, reading
    // the config without its org data.
    try {
      assertDenConfigValid();
    } catch (e) {
      if (!isConfigError(e)) throw e;
      console.error(chalk.red(`\n  ✗ ${product().configFile} is invalid:`));
      const issues = e.issues.length
        ? e.issues
        : [{ file: product().configFile, key: "", message: e.message }];
      for (const i of issues)
        console.error(
          chalk.red(`  ✗ ${i.file}  ${chalk.bold(i.key)}  ${i.message}`),
        );
      process.exitCode = 1;
      waiveInvalidOrgs();
    }
    // The distribution's secrets config, once: a 1password backend with no
    // refs leaves the vault-backed features off (no built-in vault/item).
    try {
      const { secretsConfigWarnings } =
        await import("../../shared/secrets/index.js");
      for (const w of secretsConfigWarnings())
        console.warn(chalk.yellow(`\n  ⚠  ${w.replace(/\n/g, "\n     ")}`));
    } catch {
      /* an unreadable config is reported elsewhere */
    }
    // The edge's TLS strategy, when there is an edge: its config, the
    // implicit-mkcert warning (once), and detect() (mkcert on PATH).
    {
      const { hasEdgeBlock, readEdgeConfig } =
        await import("../../shared/edge/config.js");
      const { edgeTlsWarnings, tlsStrategyFor, warnImplicitTlsOnce } =
        await import("../../shared/edge/tls.js");
      let edge: ReturnType<typeof readEdgeConfig> | null = null;
      try {
        if (hasEdgeBlock()) edge = readEdgeConfig();
      } catch (e) {
        console.error(chalk.red(`\n  ✗  edge: ${(e as Error).message}`));
        process.exitCode = 1;
      }
      if (edge) {
        const warn = (w: string) => console.warn(chalk.yellow(`\n  ⚠  ${w}`));
        warnImplicitTlsOnce(edge, warn);
        for (const w of edgeTlsWarnings(edge))
          if (edge.tlsFrom !== "implicit") warn(w);
        const d = tlsStrategyFor(edge).detect();
        if (!d.available) warn(`edge.tls ${edge.tls.strategy}: ${d.reason}`);
      }
    }
    // The web keys: a wrong value would stop `web up`; one read and
    // ignored (the distribution's web.allow_plain_http_remote: only
    // config/local/user.yml counts) is flagged, as `web up` says it.
    {
      const { ignoredConfigWarning, readWebAuthConfig } =
        await import("../../shared/web-session.js");
      try {
        const w = ignoredConfigWarning(
          readWebAuthConfig(getDistRoot(), product().configFile),
        );
        if (w) console.warn(chalk.yellow(`\n  ⚠  ${w}`));
      } catch (e) {
        console.error(chalk.red(`\n  ✗  web: ${(e as Error).message}`));
        process.exitCode = 1;
      }
    }
    // The caps: agents.max_concurrent (agents) and sessions.max_concurrent
    // (plain sessions). A wrong value would refuse every start.
    {
      const { readAgentsConfig, readSessionsConfig } =
        await import("../../shared/den-config.js");
      for (const read of [readAgentsConfig, readSessionsConfig])
        try {
          read();
        } catch (e) {
          console.error(chalk.red(`\n  ✗  ${(e as Error).message}`));
          process.exitCode = 1;
        }
    }
    const positional = args.filter((a) => !a.startsWith("-"));
    const held = args.includes("--held");
    // Bare `validate` in the distribution root (which has no manifest of its
    // own), or `--held`: every manifest the distribution uses.
    if (held || (positional.length === 0 && this.invokedInDistRoot())) {
      this.validateEverything(held);
      return;
    }
    const target = positional[0] ?? getInvokeCwd();
    const fs = await import("fs");
    const nodePath = await import("path");

    let input: string;
    if (target.startsWith("http://") || target.startsWith("https://")) {
      const { default: https } = await import("https");
      const { default: http } = await import("http");
      const fetcher = target.startsWith("https://") ? https : http;
      input = await new Promise<string>((resolve, reject) => {
        const req = fetcher.get(target, (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} fetching ${target}`));
            return;
          }
          let data = "";
          res.on("data", (c: Buffer) => (data += c));
          res.on("end", () => resolve(data));
          res.on("error", reject);
        });
        // Connection-level failures (DNS/ECONNREFUSED) fire on the request, not
        // the response — without this listener they crash the process.
        req.on("error", reject);
      });
    } else {
      const isDir = fs.existsSync(target) && fs.lstatSync(target).isDirectory();
      // A repo folder: validate each layer that applies to it (its own or the
      // held manifest, then manifests/<repo>.override.yml, then the merge).
      if (isDir) {
        const layered = validateManifestLayers(nodePath.resolve(target));
        if (layered.layers.length > 0) {
          console.log();
          for (const l of layered.layers)
            printValidation(
              chalk.bold(l.file ?? "merged"),
              l.result,
              l.layer === "merged" ? "merged" : l.layer,
            );
          console.log();
          if (!layered.valid) process.exit(1);
          return;
        }
      }
      const filePath = isDir
        ? nodePath.join(target, `${product().manifestYml}`)
        : target;

      if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`\n  ✗ File not found: ${filePath}\n`));
        process.exit(1);
      }
      input = fs.readFileSync(filePath, "utf-8") as string;
    }

    const result = validateManifest(input);
    const label = chalk.bold(
      target.startsWith("http") ? target : nodePath.resolve(target),
    );

    console.log();
    printValidation(label, result);
    console.log();
    if (!result.valid) process.exit(1);
  }

  /** Whether the CLI was run from the distribution root (real paths). */
  private invokedInDistRoot(): boolean {
    const real = (p: string) => {
      try {
        return fs.realpathSync(nodePath.resolve(p));
      } catch {
        return nodePath.resolve(p);
      }
    };
    return (
      real(getInvokeCwd()) === real(getDistRoot()) &&
      !fs.existsSync(nodePath.join(getDistRoot(), product().manifestYml))
    );
  }

  /** `validate` (bare, in the root) / `validate --held`: see validate-all.ts. */
  private validateEverything(held: boolean): void {
    const results = validateAll({ held, validate: validateManifestLayers });
    console.log();
    if (results.length === 0) {
      console.log(
        chalk.yellow(
          held
            ? `  No manifests in ${heldManifestsDir()}.`
            : "  No repos in any workspace and no held manifests.",
        ),
      );
      console.log();
      return;
    }
    const width = Math.max(...results.map((r) => r.repo.length));
    for (const r of results) {
      const where = r.checkout ?? "manifests/";
      const ws = r.workspaces.length ? `  [${r.workspaces.join(", ")}]` : "";
      const note = r.note ? `  (${r.note})` : "";
      const head = `${r.repo.padEnd(width)}  ${r.source.padEnd(15)} ${where}${ws}${note}`;
      if (r.missing) {
        console.log(chalk.yellow(`  ⚠  ${head}`));
        continue;
      }
      const warnings = r.result.layers.reduce(
        (n, l) => n + l.result.warnings.length,
        0,
      );
      if (r.result.valid && warnings === 0) {
        console.log(chalk.green(`  ✓  ${head}`));
        continue;
      }
      console.log(
        r.result.valid
          ? chalk.yellow(`  ⚠  ${head}`)
          : chalk.red(`  ✗  ${head}`),
      );
      for (const l of r.result.layers)
        if (!l.result.valid || l.result.warnings.length)
          printValidation(
            `    ${l.file ?? "merged"}`,
            l.result,
            l.layer === "merged" ? "merged" : l.layer,
          );
    }
    const failed = results.filter((r) => !r.missing && !r.result.valid).length;
    const missing = results.filter((r) => r.missing).length;
    console.log();
    console.log(
      `  ${plural(results.length, held ? "manifest" : "repo")}: ${failed ? chalk.red(`${failed} failed`) : chalk.green("all valid")}` +
        (missing ? chalk.yellow(`, ${missing} with no manifest to check`) : ""),
    );
    console.log();
    if (validateAllFailed(results)) process.exitCode = 1;
  }

  // ── den local-dev ───────────────────────────────────────────────────────

  private async cmdLocalDev(arg?: string): Promise<void> {
    if (arg === "on" || arg === "off") {
      const enabled = arg === "on";
      mergeUserConfig({ local_dev: enabled });
      console.log(
        chalk.green(
          `\n  ✓ Local dev experience ${enabled ? "enabled" : "disabled"}.\n`,
        ) +
          chalk.gray(
            `    Restart the web server for the change to take effect.\n`,
          ),
      );
      return;
    }

    // Interactive toggle
    const current = readUserConfig().local_dev ?? true;
    console.log(
      `\n  Local dev experience is currently: ${current ? chalk.green("enabled") : chalk.red("disabled")}`,
    );
    const answer = await cliPrompts.confirm(
      `  ${current ? "Disable" : "Enable"} it?`,
      !current,
    );
    if (answer !== current) {
      mergeUserConfig({ local_dev: answer });
      console.log(
        chalk.green(`\n  ✓ Local dev ${answer ? "enabled" : "disabled"}.`) +
          chalk.gray(" Restart web server to apply.\n"),
      );
    } else {
      console.log(chalk.gray("\n  No change.\n"));
    }
  }

  /**
   * Display help
   */
  private displayHelp(): void {
    this.displayHelpBanner();
    // ON-5: the line a developer pastes into their agent.
    console.log(`Set up by your agent: paste this into it:`);
    console.log(`  ${AGENT_SETUP_LINE}`);
    console.log();
    console.log("Usage:");
    console.log(`  ${product().cli} [command] [options]`);
    console.log("\nEnvironment commands:");
    console.log(
      "  up [repo] [-x] [-n]  Start the cwd (or named) repo's derived dependency closure",
    );
    console.log(
      "                       (default incl self · -x deps-only · -a all systems · -n dry-run · --plan · --manifest)",
    );
    console.log(
      "  down [repo]          Stop the derived closure cleanly (-a all systems · --manifest for legacy)",
    );
    console.log(
      "  restart [service...] Restart services (-A <app> for a whole application)",
    );
    console.log(
      "  status               Show service health for the view scope (-A <app>, --scope <ws>)",
    );
    console.log(
      "  apps                 Org > Application > Repo > Services (--json)",
    );
    console.log(
      "  logs [repo]          Tail a repo's local logs (offers to start it if down)",
    );
    console.log(
      "  graph [repo]         Derive & show the system dependency graph (--all, --diff, --format=)",
    );
    console.log("  services             List all registered services");
    console.log(
      "  use-local [repo]     Use your local checkout (dev-managed) — defaults to the cwd repo",
    );
    console.log(
      `  use-managed [repo]    Switch back to a managed clone — defaults to the cwd repo`,
    );
    console.log(
      "  register [path]      Register a repo in the service catalog",
    );
    console.log(
      "  repo add <path|url>  Add a repo with no prompts, never changing it (--sidecar, --dry-run, --json)",
    );
    console.log(
      "  repo detect <folder> Find the repos in a folder and suggest workspaces (--json)",
    );
    console.log(
      "  onboard status       What's set up, and the next step (--json)",
    );
    console.log(
      "  relocate <repo> <path>  Point a moved checkout's workspace entries at its new path",
    );
    console.log();
    console.log(
      "  setup [service...]   Run make setup for services (--plan: orgs + clone URLs, no changes)",
    );
    console.log("  sync [service...]    Check for updates and offer to pull");
    console.log(
      "  create <name> [dir]  Scaffold a new distribution of your own (--title, --cli, --env-prefix)",
    );
    console.log(
      "  mcp [--port <n>]     MCP server (stdio) for agents, over the running web server",
    );
    console.log(
      "  mcp --call <tool>    Call one MCP tool and print its result (--list: tool names)",
    );
    console.log(
      "  service install      Run the web UI as a launchd service (status, print, uninstall, help)",
    );
    console.log(
      "  theme add <repo>@<ref> Install a web UI theme (list, validate, remove)",
    );
    console.log(
      "  plugin list          Local and added plugins, checked (validate, add, update, remove)",
    );
    console.log(
      "  sessions start -w <ws> --name <n> -- <argv…>  A terminal that outlives the web server",
    );
    console.log(
      "  sessions list|attach|kill   List, attach to (ctrl-] detaches) or stop sessions",
    );
    console.log("  agents list -w <ws>  The workspace's agents");
    console.log(
      "  agents start -w <ws> --persona <p>  Run a persona in the workspace (stop, resume, rm, personas)",
    );
    console.log(
      "  usage agents|report      Agents' tokens and outcomes, from local transcripts (never sent)",
    );
    console.log();
    console.log(
      "  workspace list           List workspaces (active set + focus)",
    );
    console.log("  workspace activate <n>   Add workspace to the active set");
    console.log(
      "  workspace deactivate <n> Remove workspace from the active set",
    );
    console.log(
      "  workspace focus <n>      Focus an active workspace (the default)",
    );
    console.log("  workspace use <n>        Activate and focus a workspace");
    console.log("  workspace create [n]     Create a new workspace");
    console.log("  workspace delete <n>     Delete a workspace");
    console.log(
      "  workspace code [n]       Open workspace in VS Code (generates .code-workspace)",
    );
    console.log(
      "  org list [--org <id>]    List orgs: label, workspaces, default, warnings",
    );
    console.log("\nTest commands:");
    console.log(
      "  menu                 Open the interactive menu (pillar/module/env picker)",
    );
    console.log(
      "  run                  Run tests (interactive or with options)",
    );
    console.log("  view-results         View test results");
    console.log(
      `  web [up|down|restart]  Start, stop, or restart ${product().title} web`,
    );
    console.log("\nOptions:");
    console.log("  --help, -h             Show this help message");
    console.log("  --version, -v          Show version");
    console.log(
      "  -w, --workspace <name> Use a workspace for this command only",
    );
    console.log(
      "  -t, --tabs             Run up/restart commands in terminal tabs",
    );
    console.log("  --no-tabs              Force daemon mode for up/restart");
    console.log(
      "  --skip-secrets       Skip local secrets preflight for up/restart/logs",
    );
    console.log("\nExamples:");
    console.log(`  ${product().cli} --help`);
    console.log(`  ${product().cli} web`);
    console.log(`  ${product().cli} web restart --no-open`);
    console.log(`  ${product().cli} web down`);
    console.log(`  ${product().cli} web --port 8080`);
    console.log(`  ${product().cli} up`);
    console.log(`  ${product().cli} up --skip-secrets`);
    console.log(`  ${product().cli} up -w feat-streaming shop/api`);
    console.log(`  ${product().cli} up --tabs shop/api`);
    console.log(`  ${product().cli} up shop/api tasks-runner`);
    console.log(`  ${product().cli} status`);
    console.log(`  ${product().cli} workspace use feat-streaming`);
    console.log();
  }

  /**
   * Display version
   */
  private displayVersion(): void {
    // Den's own version: the engine's package.json, not the distribution's.
    const root = getEngineRoot();
    let packageVersion = "?";
    try {
      const pkg = JSON.parse(
        fs.readFileSync(nodePath.join(root, "package.json"), "utf-8"),
      ) as { version?: unknown };
      if (typeof pkg.version === "string") packageVersion = pkg.version;
    } catch {
      /* package version unavailable */
    }

    let gitVersion = `v${packageVersion}`;
    try {
      // Only in a Den checkout: an installed package has no .git of its own,
      // and git would describe the distribution's repo instead.
      if (!fs.existsSync(nodePath.join(root, ".git"))) throw new Error();
      gitVersion = execSync("git describe --tags --dirty --always", {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      }).trim();
    } catch {
      /* git metadata unavailable */
    }

    console.log(`${product().title} v${packageVersion} (${gitVersion})`);
  }
}

// Main entry point
const cli = new DenCLI();
cli.run().catch((error) => {
  console.error(chalk.red(`\n❌ Fatal error: ${error.message}`));
  process.exit(1);
});
