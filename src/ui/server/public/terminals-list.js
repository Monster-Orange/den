/**
 * Issue 482 (model A): terminals get their own list. The rules of the
 * Terminals list and of the Agents list's split, with no DOM, so they run
 * without a browser (tests/unit/server/terminals-list.test.ts). Which
 * shell the rail opens is issue 448's (shell-pick.js); "last used" here is
 * its shellUsedAt, so the list's order and the rail agree.
 */
import { shellUsedAt } from "/shell-pick.js";

/** A plain shell: a session with no agent, never the server agent. */
export const isShell = (r) => r?.kind === "session" && !r.server;

/** The rows page `page` lists: "terminals" shells only, "agents" no shell. */
export function forPage(page, rows) {
  return (rows ?? []).filter((r) =>
    page === "terminals" ? isShell(r) : !isShell(r),
  );
}

/** The rows of project `ws`; null (All projects): every row. */
export function inProject(rows, ws) {
  return ws === null ? [...rows] : rows.filter((r) => r.workspace === ws);
}

/**
 * Running first, then exited, each by last used (shellUsedAt), newest
 * first. `used`: this browser's own map (id to ms).
 */
export function shellGroups(rows, used = {}) {
  const newest = (a, b) => shellUsedAt(b, used) - shellUsedAt(a, used);
  return {
    running: rows.filter((r) => !r.exited).sort(newest),
    exited: rows.filter((r) => r.exited).sort(newest),
  };
}

/**
 * A row's second line: "<project> · <folder>" (issue 169, Den Design's
 * option a: the project, then the folder, in one project too).
 */
export function shellMeta(r, { projName }) {
  return [projName(r.workspace), r.folder ?? ""].filter(Boolean).join(" · ");
}

/** A terminal's own name, this release's or an older one's: its number. */
const TERMINAL_NAME = /^(?:terminal-([1-9]\d{0,8})|shell(?:-([1-9]\d{0,8}))?)$/;

/**
 * Issue 169 (Den Design, option a): a terminal's title everywhere it is
 * named: "Terminal N" (t("tm.title")). N: the server's number for the row
 * (terminalNo, per project), else its name's own ("shell" is 1, "shell-2"
 * and "terminal-2" are 2). A name a person gave it wins, and so does a
 * name that isn't a terminal's. `r`: a row, or { label } when only the
 * session's name is known.
 */
export function terminalTitle(r, t) {
  const own = (r?.displayName ?? "").trim();
  if (own) return own;
  let n = Number.isInteger(r?.terminalNo) ? r.terminalNo : null;
  if (n === null) {
    const m = TERMINAL_NAME.exec(r?.label ?? "");
    if (m) n = Number(m[1] ?? m[2] ?? 1);
  }
  return n === null ? (r?.label ?? r?.name ?? "") : t("tm.title", { n });
}

/** A row's own buttons: an exited shell's Restart and Remove; else none. */
export function rowActions(r) {
  return r?.exited ? ["restart", "remove"] : [];
}

/**
 * The one-time note on Agents ("N shells moved to Terminals"): shown once
 * per browser, only when there are shells to speak of. Seen either way,
 * so an install with none never shows it later.
 */
export function movedNote({ seen, shells }) {
  if (seen) return { show: false, n: shells, markSeen: false };
  return { show: shells > 0, n: shells, markSeen: true };
}

/**
 * Where a new shell starts when none runs in scope: project `ws`; in All
 * projects (null), the project of the shell used last (exited ones too),
 * else the first project; null with no project at all.
 */
export function startProject(rows, ws, all, used = {}) {
  if (ws) return ws;
  let best = null;
  for (const r of rows ?? [])
    if (isShell(r) && (!best || shellUsedAt(r, used) > shellUsedAt(best, used)))
      best = r;
  return best?.workspace ?? all?.[0] ?? null;
}
