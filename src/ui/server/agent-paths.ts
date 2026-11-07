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
 */
import * as fs from "fs";
import * as path from "path";

/** The most paths one ask takes (a screen's worth). */
export const MAX_PATHS = 64;
/** The longest path taken. */
const MAX_PATH_LEN = 1024;

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

const inside = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Each path's absolute path when it is a link, else null. */
export function agentPathLinks(
  given: readonly string[],
  cwd: string,
  roots: readonly string[],
): Record<string, string | null> {
  const real = roots
    .map((r) => realOrNull(r))
    .filter((r): r is string => r !== null);
  const base = realOrNull(cwd) ?? path.resolve(cwd);
  const out: Record<string, string | null> = {};
  for (const p of given) {
    if (Object.hasOwn(out, p)) continue;
    out[p] = null;
    if (!p || p.length > MAX_PATH_LEN || p.includes("\0")) continue;
    const abs = path.resolve(base, p);
    const r = realOrNull(abs);
    if (r && real.some((root) => inside(r, root))) out[p] = r;
  }
  return out;
}
