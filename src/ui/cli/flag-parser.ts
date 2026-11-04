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

const WORKSPACE_COMMANDS = new Set([
  ...WORKSPACE_MUTATION_COMMANDS,
  ...WORKSPACE_READ_COMMANDS,
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
  ],
  down: [
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
  ],
  restart: ["-A", "--app"],
  logs: [],
  setup: ["-f", "--force"],
  sync: [],
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
      // `--app=<name>` is the one flag that also takes the = form.
      !(allowed.includes("--app") && a.startsWith("--app=")),
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
