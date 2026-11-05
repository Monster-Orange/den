/**
 * `plugin list | validate | add | update | remove` (PL-1a, PL-2a), and the
 * engine under `theme add | list | validate | remove`, which is the same
 * commands filtered to kind theme (see theme-command.ts).
 *
 * Two ways a plugin gets into a distribution (PL-SPEC §2):
 *   local  plugins/<id>/ with no lock entry: the distribution's own, of any
 *          kind, edited in place. Being present is its approval.
 *   added  vendored by `add` from a git repo at an exact ref, pinned in
 *          plugins.lock.json; `list` fails when its bytes change.
 * Every plugins/<id>/ needs a manifest (den-plugin.json, or den-theme.json
 * for a theme): one with neither is an error, never skipped.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";
import { getDistRoot, getEngineRoot } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { THEME_FILE, validateThemeDir } from "../../shared/theme/contract.js";
import {
  BUILTIN_ID,
  PLUGIN_FILE,
  PLUGIN_ID,
  PLUGIN_ID_RULE,
  PLUGIN_NOT_A_PLUGIN,
  actingCapabilities,
  validatePluginDir,
  type PluginValidation,
} from "../../shared/plugins/manifest.js";
import {
  FILE_SOURCE_HINT,
  LOCK_FILE,
  PLUGINS_DIR,
  defaultGit,
  hashFiles,
  installedThemeIds,
  parsePluginSource,
  pluginContent,
  pluginDirFor,
  pluginDirNames,
  pluginSymlinkNames,
  readLock,
  readPluginsAllow,
  refKind,
  sourceAllowed,
  sourceString,
  uncommittedFiles,
  writeLock,
  type GitRunner,
  type LockEntry,
  type PluginSource,
} from "../../shared/plugins/store.js";

export interface PluginDeps {
  distRoot?: string;
  engineRoot?: string;
  git?: GitRunner;
  tmpDir?: string;
  log?: (line: string) => void;
}

/** "plugin" for `plugin *`; "theme" for the `theme *` sugar (kind theme only). */
export type PluginScope = "plugin" | "theme";

/** One line naming what a failed validation found. */
export function validationSummary(v: {
  issues: { at: string; message: string }[];
  contrast: {
    mode: string;
    fg: string;
    bg: string;
    ratio: number;
    min: number;
  }[];
}): string {
  return [
    ...v.issues.map((i) => (i.at ? `${i.at}: ${i.message}` : i.message)),
    ...v.contrast.map(
      (c) => `${c.mode}: ${c.fg} on ${c.bg} is ${c.ratio}, needs ${c.min}`,
    ),
  ].join("; ");
}

export function printValidation(
  label: string,
  v: PluginValidation,
  log: (l: string) => void,
): void {
  if (v.ok) {
    log(chalk.green(`✓ ${label}: ${v.plugin!.name} ${v.plugin!.version}`));
    return;
  }
  log(chalk.red(`✗ ${label}`));
  for (const i of v.issues) {
    const at = i.at || v.manifestFile;
    log(`    ${at ? `${at}: ` : ""}${i.message}`);
  }
  for (const c of v.contrast)
    log(
      `    ${c.mode}: ${c.fg} on ${c.bg} is ${c.ratio.toFixed(2)}:1, needs ${c.min}:1`,
    );
}

/**
 * The git warning for a local plugin (PL-1a). Being present is a local
 * plugin's approval, and Den can't tell committed from uncommitted, so when
 * one that acts (api.actions, secrets, exec, net, send) has files git does
 * not hold as committed, say so: review happens where the distribution's
 * code is reviewed. Files-tier and read-only plugins never get it.
 */
function gitWarning(
  dir: string,
  shown: string,
  v: PluginValidation,
  log: (l: string) => void,
): void {
  const acting = actingCapabilities(v.plugin?.capabilities ?? []);
  if (acting.length === 0) return;
  const files = uncommittedFiles(dir);
  if (!files || files.length === 0) return;
  const list =
    files.slice(0, 5).join(", ") +
    (files.length > 5 ? `, and ${files.length - 5} more` : "");
  log(
    `    ${chalk.yellow("WARNING")} ${shown} has files git has not committed (${list}), and it declares ${acting.join(", ")}: Den loads what is on disk, so they are approved unreviewed`,
  );
  log(
    `            ${chalk.gray("→ commit them, so the distribution's review covers what this plugin may do")}`,
  );
}

const rel = (id: string) => `${PLUGINS_DIR}/${id}`;

interface Row {
  id: string;
  version: string;
  kinds: string[];
  ok: boolean;
  state: string;
}

/** Why a plugins/<name>/ is not a plugin, for list and validate. */
const NOT_AN_ID = `not a plugin id, which is ${PLUGIN_ID_RULE}`;
const NOT_A_PLUGIN = PLUGIN_NOT_A_PLUGIN;
const SYMLINK = `a symlink, not a directory: a plugin's files live in ${PLUGINS_DIR}/<id>/ itself (copy them in, or plugin add it)`;

const hasManifest = (dir: string) =>
  fs.existsSync(path.join(dir, PLUGIN_FILE)) ||
  fs.existsSync(path.join(dir, THEME_FILE));

/** The lock, or {} with a problem line when it cannot be read. */
function lockOrProblem(
  distRoot: string,
  problems: string[],
): Record<string, LockEntry> {
  try {
    return readLock(distRoot);
  } catch (e) {
    problems.push(
      `${LOCK_FILE} could not be read (${(e as Error).message}): fix it, or delete it and add each plugin again`,
    );
    return {};
  }
}

/** A lock key whose entry names another id: the dir and the lock disagree. */
const misfiled = (key: string, e: LockEntry) =>
  `in ${LOCK_FILE} as "${key}", but its id is "${String(e.id)}": fix the entry, or remove it and add the plugin again`;

interface Listing {
  builtin: Row | null;
  problems: string[];
  rows: Row[];
  lock: Record<string, LockEntry>;
}

/**
 * Every plugin in the distribution with its check: the built-in theme, each
 * lock entry against its bytes, then each local plugin. Theme scope keeps
 * only themes, and skips local dirs that are not themes. In plugin scope
 * every directory (and symlink) in plugins/ gets exactly one row: nothing
 * there throws or is skipped.
 */
function listRows(
  distRoot: string,
  engineRoot: string,
  scope: PluginScope,
): Listing {
  const cli = product().cli;
  const rows: Row[] = [];
  const problems: string[] = [];
  const bundled = validateThemeDir(path.join(engineRoot, "themes", "den"));
  const builtin: Row | null = bundled.theme
    ? {
        id: BUILTIN_ID,
        version: bundled.theme.version,
        kinds: ["theme"],
        ok: true,
        state: "built in",
      }
    : null;
  // 0.3.0-dev.0 vendored into themes/<id>/ with themes.lock.json.
  if (fs.existsSync(path.join(distRoot, "themes.lock.json")))
    problems.push(
      `themes.lock.json is from ${cli} 0.3.0-dev.0 and is no longer read: delete it and themes/<id>/, then run theme add again (now ${PLUGINS_DIR}/<id>/, ${LOCK_FILE})`,
    );
  const lock = lockOrProblem(distRoot, problems);
  const bad = (id: string, e: LockEntry | null, state: string): Row => ({
    id,
    version: e?.version ?? "?",
    kinds: e?.kinds ?? [],
    ok: false,
    state: chalk.red(state),
  });
  for (const [key, e] of Object.entries(lock)) {
    if (scope === "theme" && !e.kinds?.includes("theme")) continue;
    if (!PLUGIN_ID.test(key)) {
      rows.push(
        bad(key, e, `in ${LOCK_FILE} under a name that is not a plugin id`),
      );
      continue;
    }
    if (e.id !== key) {
      rows.push(bad(key, e, misfiled(key, e)));
      continue;
    }
    const dir = pluginDirFor(distRoot, key);
    try {
      const v = fs.existsSync(dir)
        ? validatePluginDir(dir, { expectId: key })
        : null;
      const now = v?.ok ? hashFiles(dir, pluginContent(dir, v)) : null;
      // Invalid is not the same as changed: a plugin added under an older
      // Den can be byte-identical and still fail this Den's rules.
      const state = !v
        ? chalk.red(`missing: run ${scope} add again`)
        : !v.ok
          ? chalk.red(
              `no longer valid under this ${cli}: ${validationSummary(v)}`,
            )
          : now !== e.sha256
            ? chalk.red("changed since it was added")
            : chalk.gray(`${e.source}@${e.ref}`);
      rows.push({
        id: key,
        version: e.version ?? "?",
        kinds: e.kinds ?? [],
        ok: !!v?.ok && now === e.sha256,
        state,
      });
    } catch (err) {
      rows.push(bad(key, e, `could not be read: ${(err as Error).message}`));
    }
  }
  // Local plugins: plugins/<id>/ with no lock entry. Nothing to check a hash
  // against; they must still validate, and must have a manifest.
  const themes = new Set(installedThemeIds(distRoot));
  for (const name of pluginDirNames(distRoot)) {
    if (Object.hasOwn(lock, name)) continue;
    if (scope === "theme" && !themes.has(name)) continue;
    const where = `local (${rel(name)})`;
    const dir = path.join(distRoot, PLUGINS_DIR, name);
    if (!PLUGIN_ID.test(name)) {
      rows.push(
        bad(
          name,
          null,
          `${where}: ${NOT_AN_ID}${hasManifest(dir) ? "" : `; ${NOT_A_PLUGIN}`}`,
        ),
      );
      continue;
    }
    if (!hasManifest(dir)) {
      rows.push(bad(name, null, `${where}: ${NOT_A_PLUGIN}`));
      continue;
    }
    try {
      const v = validatePluginDir(dir, { expectId: name });
      const problem =
        name === BUILTIN_ID
          ? `"${BUILTIN_ID}" is the built-in theme's id; rename the plugin`
          : v.ok
            ? null
            : `not valid under this ${cli}: ${validationSummary(v)}`;
      rows.push({
        id: name,
        version: v.plugin?.version ?? "?",
        kinds: v.plugin?.kinds ?? [],
        ok: !problem,
        state: problem ? chalk.red(`${where}, ${problem}`) : chalk.gray(where),
      });
    } catch (err) {
      rows.push(
        bad(
          name,
          null,
          `${where}, could not be read: ${(err as Error).message}`,
        ),
      );
    }
  }
  if (scope === "plugin")
    for (const name of pluginSymlinkNames(distRoot))
      if (!Object.hasOwn(lock, name))
        rows.push(bad(name, null, `local (${rel(name)}): ${SYMLINK}`));
  return { builtin, problems, rows, lock };
}

/** The ids `validate` checks, in order: every lock entry and every dir. */
function idsToValidate(
  distRoot: string,
  scope: PluginScope,
  lock: Record<string, LockEntry>,
): string[] {
  if (scope === "theme") return installedThemeIds(distRoot);
  return [
    ...new Set([
      ...pluginDirNames(distRoot),
      ...pluginSymlinkNames(distRoot),
      ...Object.keys(lock),
    ]),
  ].sort();
}

/** Validate plugins/<id>/ (an installed or listed id); true when it passes. */
function validateInstalledId(
  distRoot: string,
  scope: PluginScope,
  id: string,
  lock: Record<string, LockEntry>,
  log: (l: string) => void,
): boolean {
  const shown = path.join(distRoot, PLUGINS_DIR, id);
  const fail = (...why: string[]) => {
    log(chalk.red(`✗ ${id} (${shown})`));
    for (const w of why) log(`    ${w}`);
    return false;
  };
  if (!PLUGIN_ID.test(id))
    return fail(NOT_AN_ID, ...(hasManifest(shown) ? [] : [NOT_A_PLUGIN]));
  if (fs.lstatSync(shown, { throwIfNoEntry: false })?.isSymbolicLink())
    return fail(SYMLINK);
  const entry = Object.hasOwn(lock, id) ? lock[id] : undefined;
  if (entry && entry.id !== id) return fail(misfiled(id, entry));
  const d = pluginDirFor(distRoot, id);
  if (!fs.existsSync(d))
    return fail(
      `missing: in ${LOCK_FILE} but not on disk; run ${scope} add again`,
    );
  if (id === BUILTIN_ID)
    return fail(
      `"${BUILTIN_ID}" is the built-in theme's id; a distribution plugin can't use it`,
    );
  let v: PluginValidation;
  try {
    v = validatePluginDir(d, { expectId: id });
  } catch (err) {
    return fail(`could not be read: ${(err as Error).message}`);
  }
  if (scope === "theme" && v.plugin && !v.plugin.kinds.includes("theme"))
    return fail(
      `provides ${v.plugin.kinds.join(", ")}, not a theme: use plugin validate ${id}`,
    );
  printValidation(`${id} (${d})`, v, log);
  if (!entry) gitWarning(d, `${rel(id)}/`, v, log);
  return v.ok;
}

/** Validate a distribution's plugins (`validate` with no dir). */
function validateInstalled(
  distRoot: string,
  scope: PluginScope,
  log: (l: string) => void,
): number {
  const problems: string[] = [];
  const lock = lockOrProblem(distRoot, problems);
  for (const p of problems) log(chalk.red(`✗ ${p}`));
  const ids = idsToValidate(distRoot, scope, lock);
  if (ids.length === 0) {
    log(
      `  no ${scope}s in ${path.join(distRoot, PLUGINS_DIR)} (den is built in)`,
    );
    return problems.length === 0 ? 0 : 1;
  }
  let ok = problems.length === 0;
  for (const id of ids)
    ok = validateInstalledId(distRoot, scope, id, lock, log) && ok;
  return ok ? 0 : 1;
}

/**
 * The plugins/<id>/ a `validate <arg>` means, or null to treat `arg` as a
 * path. An id that names a dir in plugins/ or a lock entry is never read as
 * a cwd-relative path (consumers ran `plugin validate scratch` from the
 * distribution root and got "no den-plugin.json in ./scratch"). A bare name
 * that is not an id (plugins/x/) means that dir only when no such path
 * exists, so its id error is the one reported.
 */
function installedIdArg(
  distRoot: string,
  arg: string,
  problems: string[],
): { id: string; lock: Record<string, LockEntry> } | null {
  const bare = /^[^/\\]+$/.test(arg) && arg !== "." && arg !== "..";
  if (!bare) return null;
  const there =
    fs.lstatSync(path.join(distRoot, PLUGINS_DIR, arg), {
      throwIfNoEntry: false,
    }) !== undefined;
  if (!PLUGIN_ID.test(arg) && (!there || fs.existsSync(path.resolve(arg))))
    return null;
  const lock = lockOrProblem(distRoot, problems);
  return there || Object.hasOwn(lock, arg) ? { id: arg, lock } : null;
}

/**
 * `validate <dir>`: one plugin, a distribution (its plugins/), or a repo of
 * them (themes/<id>/ and plugins/<id>/ each, id checked against the dir, plus
 * starter/).
 */
function validateDir(
  dir: string,
  scope: PluginScope,
  log: (l: string) => void,
): number {
  if (
    fs.existsSync(path.join(dir, PLUGIN_FILE)) ||
    fs.existsSync(path.join(dir, THEME_FILE))
  ) {
    const v = validatePluginDir(dir);
    printValidation(`${path.basename(dir)} (${dir})`, v, log);
    gitWarning(dir, dir, v, log);
    return v.ok ? 0 : 1;
  }
  if (scope === "plugin" && fs.existsSync(path.join(dir, PLUGINS_DIR)))
    return validateInstalled(dir, scope, log);
  const groups = scope === "theme" ? ["themes"] : ["themes", PLUGINS_DIR];
  const dirs: [string, string | undefined][] = [
    ...groups.flatMap((group) =>
      fs.existsSync(path.join(dir, group))
        ? fs
            .readdirSync(path.join(dir, group))
            .map((d): [string, string] => [path.join(dir, group, d), d])
        : [],
    ),
    ...(fs.existsSync(path.join(dir, "starter", THEME_FILE)) ||
    fs.existsSync(path.join(dir, "starter", PLUGIN_FILE))
      ? [[path.join(dir, "starter"), undefined] as [string, undefined]]
      : []),
  ].filter(([d]) => fs.statSync(d).isDirectory());
  if (dirs.length === 0) {
    log(
      chalk.red(
        scope === "theme"
          ? `✗ no ${THEME_FILE} in ${dir} (or in its themes/*/)`
          : `✗ no ${PLUGIN_FILE} or ${THEME_FILE} in ${dir} (or in its themes/*/ or ${PLUGINS_DIR}/*/)`,
      ),
    );
    return 1;
  }
  let ok = true;
  for (const [d, expectId] of dirs) {
    const v = validatePluginDir(d, expectId ? { expectId } : {});
    printValidation(`${path.basename(d)} (${d})`, v, log);
    ok &&= v.ok;
  }
  return ok ? 0 : 1;
}

interface InstallRequest {
  src: PluginSource;
  track: boolean;
  yes: boolean;
  /** update: the entry being replaced (its id is required to match). */
  updating?: LockEntry;
}

/** Fetch, validate, approve and vendor one plugin: `add` and `update`. */
function install(
  req: InstallRequest,
  scope: PluginScope,
  distRoot: string,
  deps: PluginDeps,
  log: (l: string) => void,
): number {
  const { src, track, yes, updating } = req;
  const label = `${src.repo}${src.subpath ? `//${src.subpath}` : ""}@${src.ref}`;
  // PL-2a: a path on one machine never reaches a committed lock.
  if (src.repo.startsWith("file://")) {
    log(
      chalk.red(`✗ ${src.repo} is a path on this machine: ${FILE_SOURCE_HINT}`),
    );
    return 1;
  }
  let allow: string[] | null;
  try {
    allow = readPluginsAllow(distRoot);
  } catch (e) {
    log(chalk.red(`✗ ${(e as Error).message}; nothing changed`));
    return 1;
  }
  if (!sourceAllowed(src.repo, allow)) {
    log(
      chalk.red(
        `✗ ${src.repo} is not allowed by plugins.allow in den.yml (${allow!.join(", ")}); nothing changed`,
      ),
    );
    return 1;
  }
  const git = deps.git ?? defaultGit;
  const kind = refKind(git, src);
  if (kind === "branch" && !track) {
    log(
      chalk.red(
        `✗ ${src.ref} is a branch: pin a tag or a full commit SHA, so the ${scope} is reproducible` +
          ` (${scope} authors: --track ${src.ref} follows the branch, recorded as tracking)`,
      ),
    );
    return 1;
  }
  if (kind === "none") {
    log(
      chalk.red(
        `✗ ${src.repo} has no tag or branch "${src.ref}" (a commit must be its full 40-character SHA)`,
      ),
    );
    return 1;
  }
  const work = fs.mkdtempSync(
    path.join(deps.tmpDir ?? os.tmpdir(), `den-${scope}-add-`),
  );
  try {
    const clone = path.join(work, "repo");
    if (kind === "commit") {
      fs.mkdirSync(clone);
      git(["init", "--quiet"], clone);
      git(["fetch", "--quiet", "--depth", "1", src.repo, src.ref], clone);
      git(["checkout", "--quiet", "FETCH_HEAD"], clone);
    } else
      git([
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        src.ref,
        src.repo,
        clone,
      ]);
    const commit = git(["rev-parse", "HEAD"], clone);
    const pluginDir = path.join(clone, src.subpath);
    const v = validatePluginDir(pluginDir);
    printValidation(label, v, log);
    if (!v.ok) return 1;
    const p = v.plugin!;
    if (scope === "theme" && !p.kinds.includes("theme")) {
      log(
        chalk.red(
          `✗ ${p.id} provides ${p.kinds.join(", ")}, not a theme: use plugin add`,
        ),
      );
      return 1;
    }
    if (p.id === BUILTIN_ID) {
      // Den's own theme ships in the package; a fetched one would shadow it.
      log(chalk.red(`✗ "den" is the built-in theme's id; give yours another`));
      return 1;
    }
    if (updating && p.id !== updating.id) {
      log(
        chalk.red(
          `✗ ${label} is plugin "${p.id}", not "${updating.id}"; nothing changed`,
        ),
      );
      return 1;
    }
    const dest = pluginDirFor(distRoot, p.id);
    const lock = readLock(distRoot);
    const held = lock[p.id];
    // Only ever replace what an earlier add vendored: an unlocked dir is
    // the distribution's own plugin, and theme add leaves other kinds alone.
    if (
      held
        ? scope === "theme" && !held.kinds?.includes("theme")
        : fs.existsSync(dest)
    ) {
      log(
        chalk.red(
          `✗ ${PLUGINS_DIR}/${p.id}/ is already ${held ? `a ${held.kinds.join("/")} plugin` : "a local plugin (not in " + LOCK_FILE + ")"}; nothing changed`,
        ),
      );
      return 1;
    }
    const source = sourceString(src);
    if (scope === "plugin" && held && !updating && held.source !== source) {
      log(
        chalk.red(
          `✗ ${p.id} was added from ${held.source}: remove it first to add it from ${source}; nothing changed`,
        ),
      );
      return 1;
    }
    // Approval: what an added plugin may touch is approved here and kept in
    // the lock. update asks again only when the set grows.
    const asks = p.capabilities;
    const unapproved = updating
      ? asks.filter((c) => !(updating.approved_capabilities ?? []).includes(c))
      : asks;
    if (unapproved.length > 0 && !yes) {
      log(
        chalk.red(
          `✗ ${p.id} asks for ${unapproved.join(", ")}${updating ? " (more than was approved)" : ""}: run again with --yes to approve, recorded in ${LOCK_FILE}; nothing changed`,
        ),
      );
      return 1;
    }
    const files = pluginContent(pluginDir, v);
    const staging = path.join(work, "out");
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(staging, f)), { recursive: true });
      fs.copyFileSync(path.join(pluginDir, f), path.join(staging, f));
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
    lock[p.id] = {
      id: p.id,
      name: p.name,
      version: p.version,
      source,
      ref: src.ref,
      commit,
      sha256: hashFiles(dest, files),
      kinds: p.kinds,
      approved_capabilities: asks,
      ...(kind === "branch" ? { tracking: true } : {}),
    };
    writeLock(distRoot, lock);
    log(
      `  ${p.id} ${p.version} at ${commit.slice(0, 12)} → ${PLUGINS_DIR}/${p.id}/ (${LOCK_FILE}); commit both`,
    );
    if (asks.length > 0) log(`  approved: ${asks.join(", ")}`);
    return 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Run `plugin <sub>` (or `theme <sub>`, scope "theme"); returns the exit code. */
export async function runPluginCommand(
  args: string[],
  scope: PluginScope,
  deps: PluginDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const distRoot = deps.distRoot ?? getDistRoot();
  const engineRoot = deps.engineRoot ?? getEngineRoot();
  const [sub, ...rest] = args;
  const cli = product().cli;
  const flags = rest.filter((a) => a.startsWith("-"));
  const positional = rest.filter((a) => !a.startsWith("-"));
  const unknown = flags.filter((f) => !["--track", "--yes"].includes(f));
  if (scope === "plugin" && unknown.length > 0) {
    log(chalk.red(`✗ unknown flag ${unknown.join(", ")}`));
    return 1;
  }

  switch (sub) {
    case "validate": {
      const arg = positional[0];
      if (!arg) return validateInstalled(distRoot, scope, log);
      // An id means plugins/<id>/, before any cwd-relative path.
      const problems: string[] = [];
      const installed = installedIdArg(distRoot, arg, problems);
      for (const p of problems) log(chalk.red(`✗ ${p}`));
      if (installed) {
        const ok = validateInstalledId(
          distRoot,
          scope,
          installed.id,
          installed.lock,
          log,
        );
        return ok && problems.length === 0 ? 0 : 1;
      }
      // `validate den`: the built-in theme, unless a path of that name exists.
      if (arg === BUILTIN_ID && !fs.existsSync(path.resolve(arg)))
        return validateDir(
          path.join(engineRoot, "themes", BUILTIN_ID),
          scope,
          log,
        );
      return validateDir(path.resolve(arg), scope, log);
    }

    case "add": {
      const spec = positional[0];
      if (!spec) {
        log(
          `Usage: ${cli} ${scope} add <repo>[/<subpath>]@<tag|commit> [--track]${scope === "plugin" ? " [--yes]" : ""}`,
        );
        return 1;
      }
      return install(
        {
          src: parsePluginSource(spec),
          track: flags.includes("--track"),
          yes: flags.includes("--yes"),
        },
        scope,
        distRoot,
        deps,
        log,
      );
    }

    case "update": {
      const id = positional[0];
      const lock = readLock(distRoot);
      const entry = id ? lock[id] : undefined;
      if (!id || !entry) {
        log(
          chalk.red(
            id &&
              PLUGIN_ID.test(id) &&
              fs.existsSync(pluginDirFor(distRoot, id))
              ? `✗ ${id} is a local plugin (not in ${LOCK_FILE}): edit it in ${rel(id)}/`
              : `Usage: ${cli} plugin update <id> @<tag|commit> (an added plugin)`,
          ),
        );
        return 1;
      }
      const at = positional[1]?.replace(/^@/, "");
      // A tracking entry may re-pull its branch; anything else names a ref.
      const ref = at || (entry.tracking ? entry.ref : "");
      if (!ref) {
        log(chalk.red(`Usage: ${cli} plugin update ${id} @<tag|commit>`));
        return 1;
      }
      return install(
        {
          src: parsePluginSource(`${entry.source}@${ref}`),
          track:
            flags.includes("--track") ||
            (!!entry.tracking && ref === entry.ref),
          yes: flags.includes("--yes"),
          updating: entry,
        },
        scope,
        distRoot,
        deps,
        log,
      );
    }

    case "list":
    case undefined: {
      const { builtin, problems, rows, lock } = listRows(
        distRoot,
        engineRoot,
        scope,
      );
      // The id column fits the longest id (up to 40), never less than 14.
      const idWidth = Math.max(
        14,
        ...[builtin, ...rows].map((r) => r?.id.length ?? 0),
      );
      const line = (r: Row) =>
        scope === "theme"
          ? `  ${r.id.padEnd(idWidth)} ${r.version.padEnd(8)} ${r.state}`
          : `  ${r.id.padEnd(idWidth)} ${r.version.padEnd(8)} ${(r.kinds.join(",") || "?").padEnd(10)} ${r.state}`;
      // The built-in line, any problem with the lock itself, then each plugin.
      if (builtin) log(line(builtin));
      for (const p of problems) log(chalk.red(`  ${p}`));
      for (const r of rows) log(line(r));
      // Locks from 0.3.0-dev.2 may hold a file:// source, which nobody else
      // can re-add from. A warning only (PL-SPEC d4): never fails the list.
      for (const e of Object.values(lock))
        if (
          e.source?.startsWith("file://") &&
          (scope === "plugin" || e.kinds?.includes("theme"))
        )
          log(
            chalk.yellow(
              `  ⚠ ${e.id} was added from ${e.source}, a path on one machine: re-add it from a remote, or make it a local plugin (keep ${rel(e.id)}/ and drop its ${LOCK_FILE} entry)`,
            ),
          );
      // A filtered view: plugin dirs it hides never fail it, but every broken
      // one is counted, shown as a row above or not, so none is ever silent.
      if (scope === "theme") {
        const broken = listRows(distRoot, engineRoot, "plugin").rows.filter(
          (r) => !r.ok,
        ).length;
        if (broken > 0)
          log(
            chalk.yellow(
              `  ${broken} plugin ${broken === 1 ? "dir has" : "dirs have"} errors: run \`${cli} plugin list\``,
            ),
          );
      }
      return problems.length === 0 && rows.every((r) => r.ok) ? 0 : 1;
    }

    case "remove": {
      const id = positional[0];
      const lock = readLock(distRoot);
      const entry = id ? lock[id] : undefined;
      if (
        !id ||
        !entry ||
        (scope === "theme" && !entry.kinds?.includes("theme"))
      ) {
        const local =
          scope === "plugin" &&
          !!id &&
          PLUGIN_ID.test(id) &&
          fs.existsSync(pluginDirFor(distRoot, id));
        log(
          chalk.red(
            local
              ? `✗ ${id} is a local plugin (not in ${LOCK_FILE}): remove it by deleting ${rel(id)}/ in git`
              : `✗ no installed ${scope} "${id ?? ""}"`,
          ),
        );
        return 1;
      }
      fs.rmSync(pluginDirFor(distRoot, id), { recursive: true, force: true });
      delete lock[id];
      writeLock(distRoot, lock);
      log(`  removed ${id}`);
      return 0;
    }

    default:
      log(
        `Usage: ${cli} plugin [list] | validate [dir] | add <repo>[/<subpath>]@<ref> [--track] [--yes] | update <id> @<ref> | remove <id>`,
      );
      return 1;
  }
}

/** Run `plugin <sub>`; returns the exit code. */
export function cmdPlugin(
  args: string[],
  deps: PluginDeps = {},
): Promise<number> {
  return runPluginCommand(args, "plugin", deps);
}
