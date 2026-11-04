import chalk from "chalk";
import * as yaml from "yaml";
import {
  mergeUserConfig,
  readUserConfig,
  type UserConfig,
} from "../../shared/den-config.js";

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

function canonicalKey(input: string): ConfigKey {
  const key = KEY_ALIASES[input];
  if (!key) {
    throw new Error(
      `Unknown config key "${input}". Known keys: ${Object.keys(KEY_ALIASES).join(", ")}`,
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

  const key = canonicalKey(assignment.slice(0, eq));
  const value = parseValue(assignment.slice(eq + 1));
  mergeUserConfig({ [key]: value } as Partial<UserConfig>);
  console.log(chalk.green(`  ✓ Set ${key}`));
}
