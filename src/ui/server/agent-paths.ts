/**
 * Which file paths an agent printed are links (AG-4b): GET
 * /api/workspaces/<ws>/agents/<id>/paths?p=<path>&p=<path>… answers
 * { paths: { <path as given>: <absolute path> | null } }.
 *
 * A path is resolved against the agent's cwd (an absolute one stays), and
 * is a link only when it exists and its real path (symlinks followed) is
 * inside the agent's workspace: the workspace's directory, or the agent's
 * own cwd (a worktree of it). Anything else is null, so a path outside
 * the workspace is never a link and the page never learns whether it
 * exists. Only stat is used: nothing is read, nothing is opened.
 *
 * AG-DROP-2: the same roots, plus the agent's uploads folder, say which
 * file `GET /api/workspaces/<ws>/agents/<id>/file?p=<path>` sends back to
 * the browser (agentFile): a regular file inside them, else nothing.
 */
import * as fs from "fs";
import * as path from "path";
import { denied } from "../../shared/agents/file-deny.js";

/** The most paths one ask takes (a screen's worth). */
export const MAX_PATHS = 64;
/** The longest path taken. */
const MAX_PATH_LEN = 1024;

/**
 * The real path, in the disk's own case: `realpathSync` keeps the case it
 * was given, so on a case-insensitive disk (macOS) `.ENV` would pass a
 * check for `.env` and still open it. The native one asks the disk.
 */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

const inside = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * `inside`, whatever the case: for what is refused only (more is refused,
 * never less), so a disk that ignores case can't slip a name past.
 */
const insideAnyCase = (p: string, root: string) =>
  inside(p.toLowerCase(), root.toLowerCase());

/**
 * What a path link and a download may never reach (AG-DROP-2), whatever
 * the roots are: Den's state folder (but this session's uploads), and the
 * person's secrets in their home folder.
 */
export interface PathFence {
  home: string;
  stateDir: string;
  /** The one part of the state folder that is the agent's: its uploads. */
  uploads?: string;
  /** agents.files.deny: globs below a root that are never reached. */
  deny?: readonly string[];
}

/** Folders and files in a home folder that hold secrets: never a link. */
const HOME_SECRETS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".claude",
  ".claude.json",
  ".config",
  ".local/share",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "Library/Keychains",
  "Library/Application Support",
];

/**
 * A root that would open too much is dropped: `/`, the home folder, or a
 * folder holding the home or state folder (an agent whose folder is ~).
 */
function rootAllowed(root: string, f: PathFence): boolean {
  const home = realOrNull(f.home) ?? f.home;
  const state = realOrNull(f.stateDir) ?? f.stateDir;
  return (
    root !== path.parse(root).root &&
    !inside(home, root) &&
    !inside(state, root)
  );
}

/** Whether the real path `r` is fenced off (see PathFence). */
function fenced(r: string, f: PathFence): boolean {
  const home = realOrNull(f.home) ?? f.home;
  const state = realOrNull(f.stateDir) ?? f.stateDir;
  const uploads = f.uploads ? (realOrNull(f.uploads) ?? f.uploads) : null;
  if (insideAnyCase(r, state)) return !(uploads && inside(r, uploads));
  if (insideAnyCase(r, home)) {
    const rel = path.relative(home.toLowerCase(), r.toLowerCase());
    // A dotfile right in home (~/.zshenv, ~/.bash_history).
    if (!rel.includes(path.sep) && rel.startsWith(".")) return true;
    if (HOME_SECRETS.some((s) => insideAnyCase(r, path.join(home, s))))
      return true;
  }
  return false;
}

/** Each path's absolute path when it is a link, else null. */
export function agentPathLinks(
  given: readonly string[],
  cwd: string,
  roots: readonly string[],
  fence?: PathFence,
): Record<string, string | null> {
  const real = roots
    .map((r) => realOrNull(r))
    .filter((r): r is string => r !== null)
    .filter((r) => !fence || rootAllowed(r, fence));
  const base = realOrNull(cwd) ?? path.resolve(cwd);
  const out: Record<string, string | null> = {};
  for (const p of given) {
    if (Object.hasOwn(out, p)) continue;
    out[p] = null;
    if (!p || p.length > MAX_PATH_LEN || p.includes("\0")) continue;
    const abs = path.resolve(base, p);
    const r = realOrNull(abs);
    if (!r) continue;
    const within = real.filter((root) => inside(r, root));
    if (!within.length || (fence && fenced(r, fence))) continue;
    if (
      fence?.deny?.length &&
      within.some((root) =>
        denied(path.relative(root, r).split(path.sep).join("/"), fence.deny!),
      )
    )
      continue;
    out[p] = r;
  }
  return out;
}

/**
 * AG-DROP-2: `given` as a file the browser may download: inside `roots`
 * (symlinks followed) and a regular file; else null.
 */
export function agentFile(
  given: string,
  cwd: string,
  roots: readonly string[],
  fence?: PathFence,
): string | null {
  const abs = agentPathLinks([given], cwd, roots, fence)[given];
  if (!abs) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/** `attachment` with the file's name, plain and UTF-8 (RFC 6266). */
export function attachmentHeader(file: string): string {
  const name = path.basename(file);
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
