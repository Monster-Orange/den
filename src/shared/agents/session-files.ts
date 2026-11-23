/**
 * Issue 785: reading a runtime's own session files to know whether a
 * conversation can resume, carefully, since the id comes from the agent.
 *
 * - The id must be a conversation id (CONVERSATION_ID) before anything is
 *   looked for, and a file is found by listing its store, matching names,
 *   never by joining the id into a path.
 * - Every folder on the way and the file itself: not a link, owned by
 *   Den's user or the agent's own login (issue 988's runAs), and the
 *   file's real path stays under the store's.
 * - Reads are capped. Anything unreadable or malformed is "can't resume"
 *   (false), never a throw.
 * - The store is the agent's (its record's runAs home, issue 988), else
 *   Den's own environment's: never a path the agent reports.
 *
 * Codex (codex-rs, rollout/src/recorder.rs and history/src/rollout_payload.rs):
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread uuid>[_<n>].jsonl,
 * whose first line is {"timestamp","type":"session_meta","payload":SessionMeta}.
 * A sub-agent's thread has a parent_thread_id, a sub-agent source or
 * thread_source, or a session_id (the root thread's id) other than its own.
 * It is read without blocking (the report route runs in the server), and
 * only the day folders from the agent's creation on are listed.
 *
 * Gemini (packages/core/src/services/chatRecordingService.ts):
 * <home>/.gemini/tmp/<project>/chats/session-<time>[-<n>]-<first 8 of id>.jsonl,
 * home $GEMINI_CLI_HOME or the user's. The first line ({sessionId, kind})
 * is written at startup; a reply ({type:"gemini"} with content, tool calls
 * or thoughts) is what makes it resumable here: a stricter rule than
 * Gemini's own, so at worst it starts fresh, never fails to resume. Its id
 * is Den's own, so nothing the agent writes chooses the file.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CONVERSATION_ID } from "./resume-command.js";

/** Codex's first line carries its base instructions: tens of KiB. */
export const FIRST_LINE_MAX_DEFAULT = 1024 * 1024;
/** How much of a Gemini session is read looking for its first reply. */
const SCAN_MAX = 4 * 1024 * 1024;
/** Entries listed per folder, at most (a store this big is not walked). */
const LIST_MAX = 10_000;
/** Slack around an agent's creation: clocks, and a day folder's zone. */
const SLACK_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ownUid = typeof process.getuid === "function" ? process.getuid() : -1;

/** Where a runtime keeps an agent's sessions, and who may own them. */
export interface SessionStore {
  /** HOME, CODEX_HOME, GEMINI_CLI_HOME as the runtime saw them. */
  env: NodeJS.ProcessEnv;
  /** The owners accepted: Den's user, and the agent's login (988). */
  uids: readonly number[];
}

/**
 * The store for an agent: its own login's home (runAs, issue 988) when
 * it runs as one, else Den's environment (the runtime inherits it).
 * Null: its runAs comes from a record file an agent could have written
 * (`runAsTrusted` false), or is malformed: nothing resumes, it starts
 * fresh.
 */
export function sessionStoreOf(
  rec: {
    runAs?: {
      uid: number;
      home: string;
      env?: { CODEX_HOME?: string; GEMINI_CLI_HOME?: string };
    };
  },
  denEnv: NodeJS.ProcessEnv,
  runAsTrusted: boolean,
): SessionStore | null {
  const r = rec.runAs;
  if (r === undefined) return { env: denEnv, uids: [ownUid] };
  const abs = (v: unknown) => typeof v === "string" && path.isAbsolute(v);
  if (
    !runAsTrusted ||
    !Number.isInteger(r.uid) ||
    !abs(r.home) ||
    (r.env?.CODEX_HOME !== undefined && !abs(r.env.CODEX_HOME)) ||
    (r.env?.GEMINI_CLI_HOME !== undefined && !abs(r.env.GEMINI_CLI_HOME))
  )
    return null;
  {
    return {
      env: {
        HOME: r.home,
        ...(r.env?.CODEX_HOME ? { CODEX_HOME: r.env.CODEX_HOME } : {}),
        ...(r.env?.GEMINI_CLI_HOME
          ? { GEMINI_CLI_HOME: r.env.GEMINI_CLI_HOME }
          : {}),
      },
      uids: [ownUid, r.uid],
    };
  }
}

const owned = (st: fs.Stats, uids: readonly number[]) =>
  ownUid < 0 || uids.includes(st.uid);

/** A folder or file Den may read: no link, an accepted owner's. */
function plainSync(
  p: string,
  kind: "dir" | "file",
  uids: readonly number[],
): boolean {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return false;
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return false;
    return owned(st, uids);
  } catch {
    return false;
  }
}

async function plain(
  p: string,
  kind: "dir" | "file",
  uids: readonly number[],
): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(p);
    if (st.isSymbolicLink()) return false;
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return false;
    return owned(st, uids);
  } catch {
    return false;
  }
}

function listSync(dir: string): string[] {
  try {
    const names = fs.readdirSync(dir);
    return names.length > LIST_MAX ? [] : names;
  } catch {
    return [];
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(dir);
    return names.length > LIST_MAX ? [] : names;
  } catch {
    return [];
  }
}

/** Whether `p`'s real path is inside `realRoot`. */
function underSync(p: string, realRoot: string): boolean {
  try {
    return fs.realpathSync(p).startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

async function under(p: string, realRoot: string): Promise<boolean> {
  try {
    return (await fs.promises.realpath(p)).startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** $CODEX_HOME in the store's environment, else its HOME's ~/.codex. */
export function codexHomeOf(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
}

/**
 * The first line of `file`, read once with at most `max` bytes: null
 * when it is longer, or the file can't be read. Never more in memory.
 */
async function firstLine(file: string, max: number): Promise<string | null> {
  let h: fs.promises.FileHandle | undefined;
  try {
    h = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const buf = Buffer.alloc(max);
    const { bytesRead } = await h.read(buf, 0, max, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
    return nl < 0 ? null : buf.toString("utf-8", 0, nl);
  } catch {
    return null;
  } finally {
    await h?.close().catch(() => {});
  }
}

/** A day folder's date (YYYY/MM/DD names) as ms at its UTC midnight. */
function dayOf(y: string, m: string, d: string): number {
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d))
    return NaN;
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

/** What a Codex thread is checked against. */
export interface CodexCheck {
  store: SessionStore;
  /** The agent's folder: the thread must have run there. */
  cwd: string;
  /**
   * When the agent was created (ISO 8601): the thread must have started
   * then or later, so a session from before it (the person's own, in the
   * same folder) is never taken. Unset: no thread is taken.
   */
  notBefore: string | undefined;
  /** agents.resume_first_line_max_bytes. */
  firstLineMaxBytes?: number;
}

/**
 * Whether Codex thread `id` is a main thread (no parent, not a
 * sub-agent's) that started after the agent was created, in its folder,
 * by its session file in the agent's store. Never blocks; never throws.
 */
export async function codexMainThread(
  id: string,
  c: CodexCheck,
): Promise<boolean> {
  if (!CONVERSATION_ID.test(id)) return false;
  const since = c.notBefore ? Date.parse(c.notBefore) : NaN;
  if (!Number.isFinite(since)) return false;
  const max = c.firstLineMaxBytes ?? FIRST_LINE_MAX_DEFAULT;
  const uids = c.store.uids;
  const root = path.join(codexHomeOf(c.store.env), "sessions");
  if (!(await plain(root, "dir", uids))) return false;
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return false;
  }
  // Only the day folders from a day before its creation on (a folder's
  // date is local time; the slack covers any zone).
  const floor = since - DAY_MS;
  const days: string[] = [];
  for (const y of await list(root)) {
    const yp = path.join(root, y);
    if (!/^\d{4}$/.test(y) || Date.UTC(Number(y) + 1, 0, 1) <= floor) continue;
    if (!(await plain(yp, "dir", uids))) continue;
    for (const m of await list(yp)) {
      const mp = path.join(yp, m);
      if (!/^\d{2}$/.test(m) || Date.UTC(Number(y), Number(m), 1) <= floor)
        continue;
      if (!(await plain(mp, "dir", uids))) continue;
      for (const d of await list(mp)) {
        const day = dayOf(y, m, d);
        if (!Number.isFinite(day) || day + DAY_MS <= floor) continue;
        const dp = path.join(mp, d);
        if (await plain(dp, "dir", uids)) days.push(dp);
      }
    }
  }
  for (const dp of days)
    for (const n of await list(dp)) {
      if (
        !n.startsWith("rollout-") ||
        !(n.endsWith(`-${id}.jsonl`) || n.includes(`-${id}_`))
      )
        continue;
      const file = path.join(dp, n);
      if (!(await plain(file, "file", uids))) continue;
      if (!(await under(file, realRoot))) continue;
      const line = await firstLine(file, max);
      const o = line === null ? null : parse(line);
      const m =
        o?.type === "session_meta" &&
        o.payload &&
        typeof o.payload === "object" &&
        !Array.isArray(o.payload)
          ? (o.payload as Record<string, unknown>)
          : null;
      if (!m) continue;
      const began =
        typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
      if (
        m.id === id &&
        m.session_id === id &&
        m.parent_thread_id === undefined &&
        typeof m.source === "string" &&
        (m.thread_source === undefined || m.thread_source === "user") &&
        typeof m.cwd === "string" &&
        path.resolve(m.cwd) === path.resolve(c.cwd) &&
        Number.isFinite(began) &&
        began >= since - SLACK_MS
      )
        return true;
    }
  return false;
}

/**
 * Calls `each` with every line of `file` (the last one may be cut short
 * at `max` bytes) until it returns true. False when no line did, or the
 * file can't be read.
 */
function someLine(
  file: string,
  max: number,
  each: (line: string, first: boolean) => boolean,
): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const buf = Buffer.alloc(64 * 1024);
    let rest = "";
    let read = 0;
    let first = true;
    while (read < max) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, max - read), null);
      if (n <= 0) break;
      read += n;
      rest += buf.toString("utf-8", 0, n);
      let nl: number;
      while ((nl = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        if (each(line, first)) return true;
        first = false;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Whether a Gemini message is a reply worth resuming. */
function isReply(o: Record<string, unknown>): boolean {
  if (o.type !== "gemini") return false;
  const c = o.content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c
            .map((p) =>
              p &&
              typeof p === "object" &&
              typeof (p as { text?: unknown }).text === "string"
                ? (p as { text: string }).text
                : "",
            )
            .join("")
        : "";
  return (
    text.trim().length > 0 ||
    (Array.isArray(o.toolCalls) && o.toolCalls.length > 0) ||
    (Array.isArray(o.thoughts) && o.thoughts.length > 0)
  );
}

/**
 * Whether Gemini session `id` (an id Den chose) holds a reply: it
 * resumes. False: it stopped before its first turn, or isn't there. `env`
 * is the store's (sessionStoreOf); `uids` the owners accepted.
 */
export function geminiResumable(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  uids: readonly number[] = [ownUid],
): boolean {
  if (!CONVERSATION_ID.test(id) || id.length < 8) return false;
  const home = env.GEMINI_CLI_HOME || env.HOME || os.homedir();
  const root = path.join(home, ".gemini", "tmp");
  if (!plainSync(root, "dir", uids)) return false;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false;
  }
  const short = id.slice(0, 8);
  for (const project of listSync(root)) {
    const chats = path.join(root, project, "chats");
    if (
      !plainSync(path.join(root, project), "dir", uids) ||
      !plainSync(chats, "dir", uids)
    )
      continue;
    for (const n of listSync(chats)) {
      if (!n.startsWith("session-") || !n.endsWith(`-${short}.jsonl`)) continue;
      const file = path.join(chats, n);
      if (!plainSync(file, "file", uids) || !underSync(file, realRoot))
        continue;
      let ours = false;
      const found = someLine(file, SCAN_MAX, (line, first) => {
        const o = parse(line);
        if (first) {
          ours = !!o && o.sessionId === id && o.kind !== "subagent";
          return false;
        }
        return ours && !!o && isReply(o);
      });
      if (found) return true;
    }
  }
  return false;
}
