/**
 * Where a distribution's plugins live and how added ones are pinned (PL-1a,
 * PL-2a).
 *
 *   plugins/<id>/        every plugin, local or added, committed
 *   plugins.lock.json    one entry per added plugin: source, ref, commit,
 *                        content hash, kinds, approved capabilities
 *
 * A plugins/<id>/ with no lock entry is local: the distribution's own,
 * edited in place, of any kind. Being present is its approval. An added
 * plugin was vendored by `plugin add` (or `theme add`), and `list` fails when
 * its bytes differ from the lock.
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { PROFILE_FILE } from "../profile.js";
import { THEME_FILE, themeFiles } from "../theme/contract.js";
import {
  PLUGIN_FILE,
  PLUGIN_ID,
  themeDirIn,
  type PluginValidation,
} from "./manifest.js";

export const LOCK_FILE = "plugins.lock.json";
/** Where plugins live in the distribution. */
export const PLUGINS_DIR = "plugins";

export interface PluginSource {
  /** What `git clone` takes. */
  repo: string;
  /** Directory of the plugin inside the repo ("" for the root). */
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
export function parsePluginSource(spec: string): PluginSource {
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
    throw new Error(`plugin subpath "${p}" may not contain . or ..`);
  return s;
}

/** The lock's `source`: the repo, plus `//<subpath>` when there is one. */
export function sourceString(src: PluginSource): string {
  return src.subpath ? `${src.repo}//${src.subpath}` : src.repo;
}

/**
 * Why `add` refuses a file:// source (PL-2a). A path on one machine must
 * never reach a committed lock.
 */
export const FILE_SOURCE_HINT =
  "for your own plugin, put it in plugins/<id>/ as a local plugin; to try a published one before tagging, push a branch and use --track";

/**
 * `<host>/<owner>` of a git URL, lowercased host, or null when it has no
 * owner (a file:// path, a bare host).
 */
export function hostOwner(
  repo: string,
): { host: string; owner: string } | null {
  const m =
    /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\//.exec(repo) ??
    /^[^@\s]+@([^:]+):\/?([^/]+)\//.exec(repo);
  return m ? { host: m[1].toLowerCase(), owner: m[2] } : null;
}

/**
 * `plugins.allow` in the distribution's den.yml: the `<host>/<owner>` pairs
 * `add` accepts (a bare `<host>` accepts every owner there). Null when it is
 * absent: any host. Throws on a malformed value, so a typo can't open it up.
 */
export function readPluginsAllow(distRoot: string): string[] | null {
  const file = path.join(distRoot, PROFILE_FILE);
  if (!fs.existsSync(file)) return null;
  const doc = parseYaml(fs.readFileSync(file, "utf-8")) as {
    plugins?: { allow?: unknown };
  } | null;
  const allow = doc?.plugins?.allow;
  if (allow === undefined || allow === null) return null;
  if (
    !Array.isArray(allow) ||
    allow.some((a) => typeof a !== "string" || !/^[^/\s]+(\/[^/\s]+)?$/.test(a))
  )
    throw new Error(
      `${PROFILE_FILE}: plugins.allow must be a list of <host>/<owner> (or <host>) strings`,
    );
  return (allow as string[]).map((a) => a.trim());
}

/** Whether `repo` is allowed by `allow` (null: everything is). */
export function sourceAllowed(repo: string, allow: string[] | null): boolean {
  if (!allow) return true;
  const ho = hostOwner(repo);
  if (!ho) return false;
  return allow.some((a) => {
    const [host, owner] = a.split("/");
    return (
      host.toLowerCase() === ho.host &&
      (owner === undefined || owner.toLowerCase() === ho.owner.toLowerCase())
    );
  });
}

export interface LockEntry {
  id: string;
  name: string;
  version: string;
  source: string;
  ref: string;
  commit: string;
  /** sha256 over the plugin's files, in path order (see pluginContent). */
  sha256: string;
  /** What the plugin provides, from its manifest; a theme is ["theme"]. */
  kinds: string[];
  /** Capabilities approved at add (PL-4). A theme requests none. */
  approved_capabilities: string[];
  /** Added with --track: `ref` is a branch, so a re-add may differ. */
  tracking?: boolean;
}

/** Runs git; returns stdout, throws with stderr on failure. */
export type GitRunner = (args: string[], cwd?: string) => string;

export const defaultGit: GitRunner = (args, cwd) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.status !== 0)
    throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};

/**
 * What `ref` names in the repo: a full commit SHA, a tag, a branch, or
 * nothing. A tag wins over a branch of the same name.
 */
export function refKind(
  git: GitRunner,
  src: PluginSource,
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

export function writeLock(
  distRoot: string,
  plugins: Record<string, LockEntry>,
): void {
  const sorted = Object.fromEntries(
    Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b)),
  );
  const file = path.join(distRoot, LOCK_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ plugins: sorted }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * plugins/<id>/ in the distribution. The id is checked again here (the lock
 * file is editable), so a delete can only ever reach that directory.
 */
export function pluginDirFor(distRoot: string, id: string): string {
  if (!PLUGIN_ID.test(id)) throw new Error(`"${id}" is not a plugin id`);
  return path.join(distRoot, PLUGINS_DIR, id);
}

/**
 * Every directory in plugins/, sorted, whatever it holds (dot-dirs aside):
 * each one is a plugin, so one without a manifest, or with a name that is
 * not an id, is reported rather than skipped.
 */
export function pluginDirNames(distRoot: string): string[] {
  const root = path.join(distRoot, PLUGINS_DIR);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/**
 * Symlinks directly in plugins/ (not dot-names). Never a plugin: list and
 * validate report each one, so no entry under plugins/ goes unmentioned.
 */
export function pluginSymlinkNames(distRoot: string): string[] {
  const root = path.join(distRoot, PLUGINS_DIR);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isSymbolicLink() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/**
 * Every plugins/<id>/ that provides a theme (a den-theme.json, or a
 * den-plugin.json with a theme entry), locked or local, sorted.
 */
export function installedThemeIds(distRoot: string): string[] {
  return pluginDirNames(distRoot).filter(
    (id) =>
      PLUGIN_ID.test(id) &&
      themeDirIn(path.join(distRoot, PLUGINS_DIR, id)) !== null,
  );
}

/** LICENSE / OFL.txt files anywhere in the dir travel with it. */
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

/** Every regular file under `dir`, relative, skipping dot-entries. */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), {
      withFileTypes: true,
    })) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out;
}

/**
 * The files a validated plugin consists of, sorted: what `add` vendors and
 * the lock hashes. An implicit theme plugin is its manifest, the files it
 * names and its license files (as theme add has always vendored, so existing
 * lock hashes still match); a den-plugin.json plugin is every file in its
 * directory but dot-files.
 */
export function pluginContent(dir: string, v: PluginValidation): string[] {
  const p = v.plugin!;
  const files =
    p.implicit && p.theme
      ? [THEME_FILE, ...themeFiles(p.theme), ...licenseFiles(dir)]
      : [PLUGIN_FILE, ...allFiles(dir)];
  return files.filter((f, i, a) => a.indexOf(f) === i).sort();
}

export function hashFiles(dir: string, files: string[]): string {
  const h = createHash("sha256");
  for (const f of files) {
    h.update(`${f}\0`);
    h.update(fs.readFileSync(path.join(dir, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Files under `dir` that git has not committed as they are: untracked
 * (ignored ones too, since Den loads them all the same), modified or staged.
 * Null when `dir` is not in a git work tree: Den can't say, so it says
 * nothing.
 */
export function uncommittedFiles(dir: string): string[] | null {
  const r = spawnSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
      "--",
      ".",
    ],
    { cwd: dir, encoding: "utf-8" },
  );
  if (r.status !== 0) return null;
  return r.stdout
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""));
}
