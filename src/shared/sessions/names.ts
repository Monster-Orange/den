/**
 * Session names: `<dist>-<workspace>:<name>` (AG spec §2, MD-1). The
 * distribution prefix keeps two distributions apart on one machine; the
 * workspace part is what scopes a list to one workspace (§5c gate).
 */
import { WORKSPACE_NAME_RE } from "../agent-actor.js";
import type { SessionInfo } from "./types.js";

/** A session's own name: the same rules as a workspace name. */
export const SESSION_NAME_RE = WORKSPACE_NAME_RE;

export function sessionName(
  dist: string,
  workspace: string,
  name: string,
): string {
  if (!WORKSPACE_NAME_RE.test(workspace))
    throw new Error(
      `workspace "${workspace}" is not a workspace name (letters, digits, ".", "_", "-"; 1-64 long)`,
    );
  if (!SESSION_NAME_RE.test(name))
    throw new Error(
      `session name "${name}" must be letters, digits, ".", "_" or "-", 1-64 long, starting with a letter or digit`,
    );
  return `${dist}-${workspace}:${name}`;
}

/** The workspace and name in `full`, or null when it isn't one of `dist`'s. */
export function parseSessionName(
  full: string,
  dist: string,
): { workspace: string; name: string } | null {
  const prefix = `${dist}-`;
  if (!full.startsWith(prefix)) return null;
  const rest = full.slice(prefix.length);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return null;
  const workspace = rest.slice(0, colon);
  const name = rest.slice(colon + 1);
  if (!WORKSPACE_NAME_RE.test(workspace) || !SESSION_NAME_RE.test(name))
    return null;
  return { workspace, name };
}

/** Whether `s` belongs to `workspace` of `dist`. */
export function inWorkspace(
  s: Pick<SessionInfo, "name">,
  dist: string,
  workspace: string,
): boolean {
  return parseSessionName(s.name, dist)?.workspace === workspace;
}

/**
 * The session `target` names: an id, a full name, `<workspace>:<name>`, or
 * a bare name that only one session has (within `workspace` when given). A
 * running session wins over an exited one of the same name.
 */
export function resolveSession(
  sessions: SessionInfo[],
  dist: string,
  target: string,
  workspace?: string,
): SessionInfo {
  const byId = sessions.find((s) => s.ref.id === target);
  if (byId) return byId;
  const matches = sessions.filter((s) => {
    const p = parseSessionName(s.name, dist);
    if (!p) return s.name === target;
    if (s.name === target) return true;
    if (`${p.workspace}:${p.name}` === target) return true;
    return p.name === target && (!workspace || p.workspace === workspace);
  });
  const running = matches.filter((s) => !s.exited);
  const pool = running.length ? running : matches;
  const names = [...new Set(pool.map((s) => s.name))];
  if (names.length === 1) return pool[pool.length - 1];
  if (!names.length)
    throw new Error(
      `no session "${target}"${workspace ? ` in ${workspace}` : ""}`,
    );
  throw new Error(
    `"${target}" names more than one session: ${names.sort().join(", ")}. Give the full name or the id.`,
  );
}
