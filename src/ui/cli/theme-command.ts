/**
 * `theme validate | add | list | remove`
 *
 * A theme is a den-theme.json (den.theme/v1) with its files, in any git repo.
 * `add` fetches one at an exact ref, validates it, and vendors it into the
 * distribution (`plugins/<id>/`) with a lock entry (`plugins.lock.json`: kinds,
 * source, ref, commit, content hash), so it is pinned the way Den is, works offline,
 * and the whole team gets the same files from the distribution's own repo.
 * Den's default theme ships inside Den (themes/den in the package).
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";
import { getDistRoot, getEngineRoot } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import {
  THEME_FILE,
  themeFiles,
  validateThemeDir,
  type ThemeValidation,
} from "../../shared/theme/contract.js";

export const LOCK_FILE = "plugins.lock.json";
/** Where installed plugins are vendored in the distribution. */
export const PLUGINS_DIR = "plugins";

export interface ThemeSource {
  /** What `git clone` takes. */
  repo: string;
  /** Directory of the theme inside the repo ("" for the root). */
  subpath: string;
  ref: string;
}

/**
 * `github.com/<owner>/<repo>[/<subpath>]@<ref>` (any host of that shape over
 * https), or a full git URL with an optional `//<subpath>`:
 * `https://git.example/x/themes.git//nightly@v1.0.0`,
 * `git@github.com:o/r.git//nightly@v1.0.0`. The ref is required: a tag or a
 * commit, never "latest".
 */
export function parseThemeSource(spec: string): ThemeSource {
  const at = spec.lastIndexOf("@");
  // `git@host:` has its @ before the first colon; the ref's @ comes after.
  if (at <= 0 || (spec.startsWith("git@") && at < spec.indexOf(":")))
    throw new Error(
      `${spec}: name an exact ref (a tag or a commit): <repo>[/<subpath>]@<ref>`,
    );
  const where = spec.slice(0, at);
  const ref = spec.slice(at + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(ref) || ref.includes(".."))
    throw new Error(`${spec}: "${ref}" is not a usable git ref`);
  const sub = where.indexOf("//", where.indexOf("://") + 3);
  if (/^(https?:\/\/|ssh:\/\/|file:\/\/|git@)/.test(where)) {
    const repo = sub === -1 ? where : where.slice(0, sub);
    return {
      repo,
      subpath: sub === -1 ? "" : cleanSubpath(where.slice(sub + 2)),
      ref,
    };
  }
  const parts = where.split("/").filter(Boolean);
  if (parts.length < 3 || !parts[0].includes("."))
    throw new Error(
      `${spec}: expected <host>/<owner>/<repo>[/<subpath>]@<ref>, or a git URL`,
    );
  const [host, owner, name, ...rest] = parts;
  return {
    repo: `https://${host}/${owner}/${name.replace(/\.git$/, "")}.git`,
    subpath: cleanSubpath(rest.join("/")),
    ref,
  };
}

function cleanSubpath(p: string): string {
  const s = p.replace(/^\/+|\/+$/g, "");
  if (s.split("/").some((x) => x === ".." || x === "."))
    throw new Error(`theme subpath "${p}" may not contain . or ..`);
  return s;
}

export interface LockEntry {
  id: string;
  name: string;
  version: string;
  source: string;
  ref: string;
  commit: string;
  /** sha256 over the theme's manifest and files, in path order. */
  sha256: string;
  /** What the plugin provides; a theme is ["theme"]. */
  kinds: string[];
  /** Capabilities approved at install (PL admission). A theme requests none. */
  approved_capabilities: string[];
  /** Added with --track: `ref` is a branch, so a re-add may differ. */
  tracking?: boolean;
}

/**
 * What `ref` names in the repo: a full commit SHA, a tag, a branch, or
 * nothing. A tag wins over a branch of the same name.
 */
export function refKind(
  git: GitRunner,
  src: ThemeSource,
): "commit" | "tag" | "branch" | "none" {
  if (/^[0-9a-f]{40}$/.test(src.ref)) return "commit";
  const out = git([
    "ls-remote",
    "--tags",
    "--heads",
    src.repo,
    `refs/tags/${src.ref}`,
    `refs/heads/${src.ref}`,
  ]);
  if (out.includes(`refs/tags/${src.ref}`)) return "tag";
  if (out.includes(`refs/heads/${src.ref}`)) return "branch";
  return "none";
}

export function readLock(distRoot: string): Record<string, LockEntry> {
  const file = path.join(distRoot, LOCK_FILE);
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
    plugins?: Record<string, LockEntry>;
  };
  return raw.plugins ?? {};
}

function writeLock(distRoot: string, plugins: Record<string, LockEntry>): void {
  const sorted = Object.fromEntries(
    Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b)),
  );
  const file = path.join(distRoot, LOCK_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ plugins: sorted }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The files a theme consists of: its manifest plus what it references. */
function themeContent(dir: string, v: ThemeValidation): string[] {
  return [THEME_FILE, ...themeFiles(v.theme!), ...licenseFiles(dir)]
    .filter((f, i, a) => a.indexOf(f) === i)
    .sort();
}

/** LICENSE / OFL.txt files anywhere in the theme travel with it. */
function licenseFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), {
      withFileTypes: true,
    })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !e.name.startsWith(".")) walk(r);
      else if (/^(LICEN[CS]E|OFL|COPYING)(\.(txt|md))?$/i.test(e.name))
        out.push(r);
    }
  };
  walk("");
  return out;
}

/** The lock's theme entries (the lock is shared with other plugin kinds). */
function themesIn(lock: Record<string, LockEntry>): LockEntry[] {
  return Object.values(lock).filter((e) => e.kinds?.includes("theme"));
}

export function hashTheme(dir: string, files: string[]): string {
  const h = createHash("sha256");
  for (const f of files) {
    h.update(`${f}\0`);
    h.update(fs.readFileSync(path.join(dir, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * plugins/<id>/ in the distribution. The id is checked again here (the lock
 * file is editable), so a delete can only ever reach that directory.
 */
function themeDirFor(distRoot: string, id: string): string {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id))
    throw new Error(`"${id}" is not a plugin id`);
  return path.join(distRoot, PLUGINS_DIR, id);
}

/** Runs git; returns stdout, throws with stderr on failure. */
export type GitRunner = (args: string[], cwd?: string) => string;

const defaultGit: GitRunner = (args, cwd) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0)
    throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};

export interface ThemeDeps {
  distRoot?: string;
  engineRoot?: string;
  git?: GitRunner;
  tmpDir?: string;
  log?: (line: string) => void;
}

function printValidation(
  label: string,
  v: ThemeValidation,
  log: (l: string) => void,
): void {
  if (v.ok) {
    log(chalk.green(`✓ ${label}: ${v.theme!.name} ${v.theme!.version}`));
    return;
  }
  log(chalk.red(`✗ ${label}`));
  for (const i of v.issues) log(`    ${i.at || THEME_FILE}: ${i.message}`);
  for (const c of v.contrast)
    log(
      `    ${c.mode}: ${c.fg} on ${c.bg} is ${c.ratio.toFixed(2)}:1, needs ${c.min}:1`,
    );
}

/** Run `theme <sub>`; returns the exit code. */
export async function cmdTheme(
  args: string[],
  deps: ThemeDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const distRoot = deps.distRoot ?? getDistRoot();
  const [sub, ...rest] = args;
  const cli = product().cli;

  switch (sub) {
    case "validate": {
      // A theme dir, or a repo of themes (themes/<id>/ each, plus starter/).
      const dir = path.resolve(rest[0] ?? ".");
      const dirs = fs.existsSync(path.join(dir, THEME_FILE))
        ? [dir]
        : [
            ...(fs.existsSync(path.join(dir, "themes"))
              ? fs
                  .readdirSync(path.join(dir, "themes"))
                  .map((d) => path.join(dir, "themes", d))
              : []),
            ...(fs.existsSync(path.join(dir, "starter", THEME_FILE))
              ? [path.join(dir, "starter")]
              : []),
          ].filter((d) => fs.statSync(d).isDirectory());
      if (dirs.length === 0) {
        log(chalk.red(`✗ no ${THEME_FILE} in ${dir} (or in its themes/*/)`));
        return 1;
      }
      let ok = true;
      for (const d of dirs) {
        const inThemes = path.basename(path.dirname(d)) === "themes";
        const v = validateThemeDir(d, {
          expectId: inThemes ? path.basename(d) : undefined,
        });
        printValidation(`${path.basename(d)} (${d})`, v, log);
        ok &&= v.ok;
      }
      return ok ? 0 : 1;
    }

    case "add": {
      const track = rest.includes("--track");
      const spec = rest.find((a) => !a.startsWith("-"));
      if (!spec) {
        log(
          `Usage: ${cli} theme add <repo>[/<subpath>]@<tag|commit> [--track]`,
        );
        return 1;
      }
      const src = parseThemeSource(spec);
      if (src.repo.startsWith("file://"))
        log(
          chalk.yellow(
            `  ${src.repo} is a path on this machine: the lock records it, so others cannot re-add from it. Publish the repo and add from its URL before committing.`,
          ),
        );
      const git = deps.git ?? defaultGit;
      const kind = refKind(git, src);
      if (kind === "branch" && !track) {
        log(
          chalk.red(
            `✗ ${src.ref} is a branch: pin a tag or a full commit SHA, so the theme is reproducible` +
              ` (theme authors: --track ${src.ref} follows the branch, recorded as tracking)`,
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
        path.join(deps.tmpDir ?? os.tmpdir(), "den-theme-add-"),
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
        const themeDir = path.join(clone, src.subpath);
        const v = validateThemeDir(themeDir);
        printValidation(
          `${src.repo}${src.subpath ? `//${src.subpath}` : ""}@${src.ref}`,
          v,
          log,
        );
        if (!v.ok) return 1;
        const theme = v.theme!;
        if (theme.id === "den") {
          // Den's own theme ships in the package; a fetched one would shadow it.
          log(
            chalk.red(`✗ "den" is the built-in theme's id; give yours another`),
          );
          return 1;
        }
        const files = themeContent(themeDir, v);
        const dest = themeDirFor(distRoot, theme.id);
        const held = readLock(distRoot)[theme.id];
        // Only ever replace what an earlier add vendored: an unlocked dir is
        // the distribution's own plugin, and another kind is not ours.
        if (held ? !held.kinds?.includes("theme") : fs.existsSync(dest)) {
          log(
            chalk.red(
              `✗ ${PLUGINS_DIR}/${theme.id}/ is already ${held ? `a ${held.kinds.join("/")} plugin` : "a local plugin (not in " + LOCK_FILE + ")"}; nothing changed`,
            ),
          );
          return 1;
        }
        const staging = path.join(work, "out");
        for (const f of files) {
          fs.mkdirSync(path.dirname(path.join(staging, f)), {
            recursive: true,
          });
          fs.copyFileSync(path.join(themeDir, f), path.join(staging, f));
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest))
          fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(staging, dest);
        const lock = readLock(distRoot);
        lock[theme.id] = {
          id: theme.id,
          name: theme.name,
          version: theme.version,
          source: src.subpath ? `${src.repo}//${src.subpath}` : src.repo,
          ref: src.ref,
          commit,
          sha256: hashTheme(dest, files),
          kinds: ["theme"],
          approved_capabilities: [],
          ...(kind === "branch" ? { tracking: true } : {}),
        };
        writeLock(distRoot, lock);
        log(
          `  ${theme.id} ${theme.version} at ${commit.slice(0, 12)} → ${PLUGINS_DIR}/${theme.id}/ (${LOCK_FILE}); commit both`,
        );
        return 0;
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    }

    case "list":
    case undefined: {
      const lock = readLock(distRoot);
      const bundled = validateThemeDir(
        path.join(deps.engineRoot ?? getEngineRoot(), "themes", "den"),
      );
      if (bundled.theme)
        log(`  den            ${bundled.theme.version.padEnd(8)} built in`);
      let ok = true;
      // 0.3.0-dev.0 vendored into themes/<id>/ with themes.lock.json.
      if (fs.existsSync(path.join(distRoot, "themes.lock.json"))) {
        ok = false;
        log(
          chalk.red(
            `  themes.lock.json is from ${cli} 0.3.0-dev.0 and is no longer read: delete it and themes/<id>/, then run theme add again (now ${PLUGINS_DIR}/<id>/, ${LOCK_FILE})`,
          ),
        );
      }
      for (const e of themesIn(lock)) {
        const dir = themeDirFor(distRoot, e.id);
        const v = fs.existsSync(dir) ? validateThemeDir(dir) : null;
        const now = v?.ok ? hashTheme(dir, themeContent(dir, v)) : null;
        const state = !v
          ? chalk.red("missing: run theme add again")
          : now !== e.sha256
            ? chalk.red("changed since it was added")
            : chalk.gray(`${e.source}@${e.ref}`);
        if (!v || now !== e.sha256) ok = false;
        log(`  ${e.id.padEnd(14)} ${e.version.padEnd(8)} ${state}`);
      }
      return ok ? 0 : 1;
    }

    case "remove": {
      const id = rest[0];
      const lock = readLock(distRoot);
      if (!id || !lock[id]?.kinds?.includes("theme")) {
        log(chalk.red(`✗ no installed theme "${id ?? ""}"`));
        return 1;
      }
      fs.rmSync(themeDirFor(distRoot, id), { recursive: true, force: true });
      delete lock[id];
      writeLock(distRoot, lock);
      log(`  removed ${id}`);
      return 0;
    }

    default:
      log(
        `Usage: ${cli} theme [list] | validate [dir] | add <repo>[/<subpath>]@<ref> | remove <id>`,
      );
      return 1;
  }
}
