/**
 * `theme validate | add | list | remove | new`
 *
 * Sugar over `plugin *` (PL-2a): the same commands, filtered to kind theme,
 * with the same output and exit codes. Only `new` is theme-specific.
 *
 * A theme is a den-theme.json (den.theme/v1) with its files, in any git repo.
 * `add` fetches one at an exact ref, validates it, and vendors it into the
 * distribution (`plugins/<id>/`) with a lock entry (`plugins.lock.json`: kinds,
 * source, ref, commit, content hash), so it is pinned the way Den is, works offline,
 * and the whole team gets the same files from the distribution's own repo.
 * Den's default theme ships inside Den (themes/den in the package).
 */
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { getDistRoot, getEngineRoot } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { readBrand } from "../../shared/brand.js";
import { THEME_FILE } from "../../shared/theme/contract.js";
import { PLUGIN_ID, PLUGIN_ID_RULE } from "../../shared/plugins/manifest.js";
import {
  PLUGINS_DIR,
  hashFiles,
  parsePluginSource,
  pluginDirFor,
  type LockEntry,
  type PluginSource,
} from "../../shared/plugins/store.js";
import { runPluginCommand, type PluginDeps } from "./plugin-command.js";

// The plugin store is where themes live (PL-2a); these names stay for
// theme-runtime and older callers.
export {
  LOCK_FILE,
  PLUGINS_DIR,
  installedThemeIds,
  readLock,
  refKind,
  type GitRunner,
  type LockEntry,
} from "../../shared/plugins/store.js";
export { validationSummary } from "./plugin-command.js";

export type ThemeSource = PluginSource;
export const parseThemeSource = parsePluginSource;
export const hashTheme = hashFiles;
export const themeDirFor = pluginDirFor;

/** The lock's theme entries (the lock is shared with other plugin kinds). */
export function themesIn(lock: Record<string, LockEntry>): LockEntry[] {
  return Object.values(lock).filter((e) => e.kinds?.includes("theme"));
}

export type ThemeDeps = PluginDeps;

/**
 * Run `theme <sub>`; returns the exit code. add, list, validate and remove
 * are `plugin <sub>` filtered to kind theme; new is the theme scaffold.
 */
export async function cmdTheme(
  args: string[],
  deps: ThemeDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const distRoot = deps.distRoot ?? getDistRoot();
  const [sub, ...rest] = args;
  const cli = product().cli;

  switch (sub) {
    case "validate":
    case "add":
    case "list":
    case "remove":
    case undefined:
      return runPluginCommand(args, "theme", deps);

    case "new": {
      // A local theme to edit: a copy of the built-in one, in plugins/<id>/,
      // committed with the distribution so the whole team gets it.
      const id = rest[0];
      if (!id || !PLUGIN_ID.test(id) || id === "den") {
        log(
          chalk.red(
            `Usage: ${cli} theme new <id>  (${PLUGIN_ID_RULE}; not "den")`,
          ),
        );
        return 1;
      }
      const dest = themeDirFor(distRoot, id);
      if (fs.existsSync(dest)) {
        log(
          chalk.red(`✗ ${PLUGINS_DIR}/${id}/ already exists; nothing changed`),
        );
        return 1;
      }
      const from = path.join(
        deps.engineRoot ?? getEngineRoot(),
        "themes",
        "den",
      );
      // Not Den's tab icon: a new theme's tab shows its own mark.
      const denIcon = path.join(from, "favicon.ico");
      fs.cpSync(from, dest, {
        recursive: true,
        filter: (src) => src !== denIcon,
      });
      const file = path.join(dest, THEME_FILE);
      const m = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
        string,
        unknown
      >;
      delete m.favicon;
      const name = id
        .split("-")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ");
      Object.assign(m, { id, name, version: "0.1.0" });
      delete m.homepage;
      // The author is the theme's maintainer (plugin rule 1): the team.
      m.author = readBrand().name;
      fs.writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
      log(
        `  ${id} → ${PLUGINS_DIR}/${id}/ (a copy of den: edit ${THEME_FILE} and mark.svg)`,
      );
      log(`  ${cli} theme validate checks it; commit it and your team has it.`);
      return 0;
    }

    default:
      log(
        `Usage: ${cli} theme [list] | validate [dir] | new <id> | add <repo>[/<subpath>]@<ref> | remove <id>`,
      );
      return 1;
  }
}
