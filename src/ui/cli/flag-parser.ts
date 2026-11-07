import { product } from "../../shared/product.js";
export type CommandName =
  | "run"
  | "menu"
  | "view-results"
  | "web"
  | "up"
  | "down"
  | "restart"
  | "status"
  | "logs"
  | "services"
  | "graph"
  | "register"
  | "relocate"
  | "use-local"
  | "use-managed"
  | "setup"
  | "workspace"
  | "sync"
  | "init"
  | "validate"
  | "create"
  | "local-dev"
  | "config"
  | "--help"
  | "-h"
  | "--version"
  | "-v";

export interface ParsedCliArgs {
  command?: string;
  args: string[];
  flags: {
    workspace?: string;
    forceTabs?: boolean;
    skipSecrets?: boolean;
  };
}

/**
 * Commands that CHANGE what is running, so `-w` must name an active workspace:
 * ownership refcounts, conflict blocks and shared-instance decisions are all
 * defined over the active set (design decision 6).
 */
const WORKSPACE_MUTATION_COMMANDS = new Set(["up", "down", "restart"]);

/**
 * Read-only commands that are workspace-relative but require no activation —
 * inspecting a workspace is not operating on it. `/api/graph` has always
 * allowed this ("any workspace may be graphed"); requiring activation here
 * would also regress the pre-multi-active `-w` ("use this workspace for this
 * command only").
 */
const WORKSPACE_READ_COMMANDS = new Set([
  "status",
  "logs",
  "services",
  // A repo name resolves per workspace, so the graph is workspace-relative too.
  "graph",
  // Compose stacks run per workspace (project `<stack>-<workspace>`).
  "stack",
]);

/**
 * Commands that edit one workspace's entries without changing what runs:
 * `-w` picks the workspace to write, whether or not it is active, and leaves
 * focus alone.
 */
const WORKSPACE_EDIT_COMMANDS = new Set(["register", "relocate"]);

const WORKSPACE_COMMANDS = new Set([
  ...WORKSPACE_MUTATION_COMMANDS,
  ...WORKSPACE_READ_COMMANDS,
  ...WORKSPACE_EDIT_COMMANDS,
]);

/**
 * Commands that read `-w`/`--workspace` themselves, so it is left in their
 * args: `setup --plan -w a -w b` takes several, `mcp --workspace <ws>`
 * scopes the MCP server, and `sessions`/`agents` name a session's
 * workspace. None of them sets the CLI's workspace override.
 */
const OWN_WORKSPACE_FLAG_COMMANDS = new Set([
  "setup",
  "mcp",
  // A session's workspace is part of its name (AG-3a); -w never sets the
  // CLI's workspace override here.
  "sessions",
  "agents",
  // `repo add -w <ws>` names (or creates) the workspace to write.
  "repo",
]);

/** Whether `-w <name>` on this command requires `<name>` to be active. */
export function workspaceFlagRequiresActive(command: string): boolean {
  return WORKSPACE_MUTATION_COMMANDS.has(command);
}
const TAB_COMMANDS = new Set(["up", "restart"]);
const SKIP_SECRETS_COMMANDS = new Set(["up", "restart", "logs"]);

function consumeFlagValue(raw: string[], index: number, flag: string): string {
  const value = raw[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function applyFlag(
  raw: string[],
  index: number,
  flags: ParsedCliArgs["flags"],
): number | null {
  const token = raw[index];
  // `--flag=value` form for value-taking flags (-w/--workspace).
  const eq = token.indexOf("=");
  const name = eq === -1 ? token : token.slice(0, eq);
  if (name === "-w" || name === "--workspace") {
    if (eq !== -1) {
      const value = token.slice(eq + 1);
      if (!value) {
        throw new Error(`${name} requires a value`);
      }
      flags.workspace = value;
      return index + 1;
    }
    flags.workspace = consumeFlagValue(raw, index, token);
    return index + 2;
  }
  if (token === "-t" || token === "--tabs") {
    flags.forceTabs = true;
    return index + 1;
  }
  if (token === "--no-tabs") {
    flags.forceTabs = false;
    return index + 1;
  }
  if (token === "--skip-secrets") {
    flags.skipSecrets = true;
    return index + 1;
  }
  return null;
}

function validateFlagScopes(parsed: ParsedCliArgs): void {
  const command = parsed.command;
  if (!command) {
    if (
      parsed.flags.workspace ||
      parsed.flags.forceTabs !== undefined ||
      parsed.flags.skipSecrets
    ) {
      throw new Error("Global flags require a command");
    }
    return;
  }

  if (parsed.flags.workspace && !WORKSPACE_COMMANDS.has(command)) {
    if (command === "workspace") {
      throw new Error(
        `-w/--workspace is not valid with workspace mutations; use \`${product().cli} workspace use <name>\` instead`,
      );
    }
    throw new Error(`-w/--workspace is not valid with ${command}`);
  }
  if (parsed.flags.forceTabs !== undefined && !TAB_COMMANDS.has(command)) {
    throw new Error(`--tabs/--no-tabs is not valid with ${command}`);
  }
  if (parsed.flags.skipSecrets && !SKIP_SECRETS_COMMANDS.has(command)) {
    throw new Error(`--skip-secrets is not valid with ${command}`);
  }
}

/**
 * Subcommands that print their own `--help`: the dispatcher's
 * `<command> --help` must not answer for them (`web sessions --help` printed
 * the general web help). web-command.ts's WEB_SUBCOMMANDS_WITH_HELP and
 * mcp-connect.ts's MCP_CONNECT_SUBCOMMANDS are the same lists (a test
 * checks).
 */
export const SUBCOMMAND_OWN_HELP: Readonly<Record<string, readonly string[]>> =
  {
    web: [
      "token",
      "login",
      "sessions",
      "logout",
      "owner",
      "approve",
      "claim-link",
    ],
    mcp: ["connect", "disconnect", "clients", "config"],
    repo: ["add"],
  };

/** Whether `<command> <sub> --help` is the subcommand's own to answer. */
export function ownsSubcommandHelp(
  command: string,
  sub: string | undefined,
): boolean {
  return !!sub && (SUBCOMMAND_OWN_HELP[command] ?? []).includes(sub);
}

// Dash-flags each mutation subcommand accepts (global flags — -w/--workspace,
// -t/--tabs/--no-tabs, --skip-secrets — are consumed by parseCliArgs before
// dispatch, and -h/--help is handled by the dispatcher). Commands not listed
// here are not checked.
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  up: [
    "--manifest",
    "--no-derive",
    "-x",
    "--exclude",
    "-a",
    "--all",
    "-n",
    "--dry-run",
    "--plan",
    "--pull",
    "-A",
    "--app",
    "--json",
  ],
  down: [
    "--json",
    "--manifest",
    "--no-derive",
    "-a",
    "--all",
    "-n",
    "--dry-run",
    "-f",
    "--force",
    "-A",
    "--app",
    "--with-deps",
  ],
  restart: ["-A", "--app", "-n", "--dry-run"],
  logs: [],
  setup: ["-f", "--force", "--plan", "-w", "--workspace", "--all-active"],
  sync: [],
  // The only override for an edge another state dir owns; a typo'd one
  // must not be ignored.
  edge: ["--take-over"],
};

/**
 * Unrecognized dash-args for `command` among `args`, stopping at the first
 * `--` terminator (everything after it belongs to a child command). Returns
 * [] when the command isn't flag-checked or every flag is known — mutation
 * commands must NOT run when this is non-empty (a typo'd --dry-run would
 * otherwise silently perform a real bring-up).
 */
export function unknownCommandFlags(command: string, args: string[]): string[] {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) return [];
  const end = args.indexOf("--");
  const own = end === -1 ? args : args.slice(0, end);
  return own.filter(
    (a) =>
      a.startsWith("-") &&
      !allowed.includes(a) &&
      // `--app=<name>` and `-w=`/`--workspace=` also take the = form.
      !(allowed.includes("--app") && a.startsWith("--app=")) &&
      !(allowed.includes("--workspace") && /^(-w|--workspace)=/.test(a)),
  );
}

export function parseCliArgs(raw: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = { args: [], flags: {} };
  let i = 0;
  let passthrough = false;

  while (i < raw.length) {
    const token = raw[i];

    if (passthrough) {
      parsed.args.push(token);
      i += 1;
      continue;
    }

    if (token === "--") {
      // Keep the terminator so downstream dispatch can tell den's own
      // args from passthrough args intended for a child command.
      passthrough = true;
      parsed.args.push(token);
      i += 1;
      continue;
    }

    if (
      parsed.command &&
      OWN_WORKSPACE_FLAG_COMMANDS.has(parsed.command) &&
      /^(-w|--workspace)(=|$)/.test(token)
    ) {
      parsed.args.push(token);
      i += 1;
      continue;
    }

    const nextIndex = applyFlag(raw, i, parsed.flags);
    if (nextIndex !== null) {
      i = nextIndex;
      continue;
    }

    if (!parsed.command) {
      parsed.command = token;
    } else {
      parsed.args.push(token);
    }
    i += 1;
  }

  validateFlagScopes(parsed);
  return parsed;
}

/**
 * Every `-w <ws>` / `--workspace <ws>` (and `=` form) in `args`, in order and
 * repeatable, and the args without them. For a command that reads `-w`
 * itself (OWN_WORKSPACE_FLAG_COMMANDS).
 */
export function takeWorkspaceFlags(args: readonly string[]): {
  workspaces: string[];
  rest: string[];
} {
  const workspaces: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^(-w|--workspace)(?:=(.*))?$/.exec(a);
    if (!m) {
      rest.push(a);
      continue;
    }
    if (m[2] !== undefined) {
      if (!m[2]) throw new Error(`${m[1]} requires a value`);
      workspaces.push(m[2]);
      continue;
    }
    workspaces.push(consumeFlagValue([...args], i, m[1]));
    i++;
  }
  return { workspaces, rest };
}
