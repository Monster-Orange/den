import chalk from "chalk";
import * as yaml from "yaml";
import {
  mergeUserConfig,
  readUserConfig,
  writeUserConfig,
  type UserConfig,
} from "../../shared/den-config.js";
import { patchCliRows } from "../../shared/settings-cli-rows.js";

import { product } from "../../shared/product.js";
type ConfigKey = keyof UserConfig;

const KEY_ALIASES: Record<string, ConfigKey> = {
  tabs: "cli_tabs",
  cli_tabs: "cli_tabs",
  "local-dev": "local_dev",
  local_dev: "local_dev",
  editor: "editor",
  terminal: "terminal",
  editor_overrides: "editor_overrides",
  log_window_lines: "log_window_lines",
  log_window: "log_window_lines",
};

/**
 * MODE-5: limits inside a block, as Settings names them (`config
 * panes.reconnect_max_failures=20`): the Settings field and its limit, so
 * the same checks hold here as on the page.
 */
const DOTTED: Record<string, [field: string, limit: string]> = {
  "panes.reconnect_seconds": ["panes_reconnect", "seconds"],
  "panes.reconnect_max_seconds": ["panes_reconnect", "max_seconds"],
  "panes.reconnect_max_failures": ["panes_reconnect", "max_failures"],
  "panes.reconnect_window_seconds": ["panes_reconnect", "window_seconds"],
  "panes.connect_timeout_seconds": [
    "panes_reconnect",
    "connect_timeout_seconds",
  ],
  "web.crash_loop_restarts": ["crash_loop", "restarts"],
  "web.crash_loop_minutes": ["crash_loop", "minutes"],
  "web.crash_loop_max_wait_seconds": ["crash_loop", "max_wait_seconds"],
};

/** Every key `config` accepts, aliases too. */
export function configKeyNames(): string[] {
  return [...Object.keys(KEY_ALIASES), ...Object.keys(DOTTED)];
}

/** A dotted limit set (or, with null, cleared) as Settings would. */
function setDotted(name: string, value: unknown): void {
  const [field, limit] = DOTTED[name]!;
  const user = readUserConfig() as Record<string, unknown>;
  const r = patchCliRows(user, { [field]: { [limit]: value } }, { cli: true });
  if (!r.ok) throw new Error(r.error);
  writeUserConfig(user as UserConfig);
}

function canonicalKey(input: string): ConfigKey {
  const key = KEY_ALIASES[input];
  if (!key) {
    throw new Error(
      `Unknown config key "${input}". Known keys: ${configKeyNames().join(", ")}`,
    );
  }
  return key;
}

function parseValue(raw: string): unknown {
  const parsed = yaml.parse(raw);
  return parsed === null ? "" : parsed;
}

export async function cmdConfig(args: string[]): Promise<void> {
  if (args.length === 0) {
    const current = readUserConfig();
    const output = yaml.stringify(current).trim();
    console.log(output || "{}");
    return;
  }

  if (args[0] === "rm") {
    const keyArg = args[1];
    if (!keyArg) throw new Error(`Usage: ${product().cli} config rm <key>`);
    if (DOTTED[keyArg]) {
      setDotted(keyArg, null);
      console.log(chalk.green(`  ✓ Removed ${keyArg}`));
      return;
    }
    const key = canonicalKey(keyArg);
    mergeUserConfig({ [key]: undefined });
    console.log(chalk.green(`  ✓ Removed ${key}`));
    return;
  }

  const assignment = args[0];
  const eq = assignment.indexOf("=");
  if (eq <= 0) {
    throw new Error(
      `Usage: ${product().cli} config <key>=<value> or ${product().cli} config rm <key>`,
    );
  }

  const name = assignment.slice(0, eq);
  if (DOTTED[name]) {
    setDotted(name, parseValue(assignment.slice(eq + 1)));
    console.log(chalk.green(`  ✓ Set ${name}`));
    return;
  }
  const key = canonicalKey(name);
  const value = parseValue(assignment.slice(eq + 1));
  mergeUserConfig({ [key]: value } as Partial<UserConfig>);
  console.log(chalk.green(`  ✓ Set ${key}`));
}
