/**
 * Issue 785: reading a runtime's own session files to know whether a
 * conversation can resume, carefully, since the id comes from the agent.
 *
 * - The id must be a conversation id (CONVERSATION_ID) before anything is
 *   looked for, and a file is found by listing its store, matching names,
 *   never by joining the id into a path.
 * - Every folder on the way and the file itself: not a link, owned by
 *   this user, and the file's real path stays under the store's.
 * - Reads are capped. Anything unreadable or malformed is "can't resume"
 *   (false), never a throw.
 *
 * Codex (codex-rs, rollout/src/recorder.rs and history/src/rollout_payload.rs):
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread uuid>[_<n>].jsonl,
 * whose first line is {"type":"session_meta","payload":SessionMeta}. A
 * sub-agent's thread has a parent_thread_id, a sub-agent source or
 * thread_source, or a session_id (the root thread's id) other than its own.
 *
 * Gemini (packages/core/src/services/chatRecordingService.ts):
 * <home>/.gemini/tmp/<project>/chats/session-<time>[-<n>]-<first 8 of id>.jsonl,
 * home $GEMINI_CLI_HOME or the user's. The first line ({sessionId, kind})
 * is written at startup; a reply ({type:"gemini"} with content, tool calls
 * or thoughts) is what makes it resumable here: a stricter rule than
 * Gemini's own, so at worst it starts fresh, never fails to resume.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CONVERSATION_ID } from "./resume-command.js";

/** Codex's first line carries its base instructions: tens of KiB. */
const FIRST_LINE_MAX = 1024 * 1024;
/** How much of a Gemini session is read looking for its first reply. */
const SCAN_MAX = 4 * 1024 * 1024;
/** Folders listed per level, at most (a store this big is not walked). */
const LIST_MAX = 10_000;

const uid = typeof process.getuid === "function" ? process.getuid() : -1;

/** A folder or file Den may read: no link, this user's. */
function ownPlain(p: string, kind: "dir" | "file"): boolean {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return false;
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return false;
    return uid < 0 || st.uid === uid;
  } catch {
    return false;
  }
}

function list(dir: string): string[] {
  try {
    const names = fs.readdirSync(dir);
    return names.length > LIST_MAX ? [] : names;
  } catch {
    return [];
  }
}

/**
 * The files under `root` at `levels` (each a folder name, or null for
 * any), whose names `match`: each folder and file plain and this user's,
 * the file's real path under the root's.
 */
function findFiles(
  root: string,
  levels: readonly (string | null)[],
  match: (name: string) => boolean,
): string[] {
  if (!ownPlain(root, "dir")) return [];
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return [];
  }
  let dirs = [root];
  for (const level of levels) {
    const next: string[] = [];
    for (const d of dirs)
      for (const name of level === null ? list(d) : [level]) {
        const p = path.join(d, name);
        if (ownPlain(p, "dir")) next.push(p);
      }
    dirs = next;
  }
  const out: string[] = [];
  for (const d of dirs)
    for (const name of list(d)) {
      if (!match(name)) continue;
      const p = path.join(d, name);
      if (!ownPlain(p, "file")) continue;
      try {
        if (fs.realpathSync(p).startsWith(realRoot + path.sep)) out.push(p);
      } catch {
        /* gone */
      }
    }
  return out;
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

/** $CODEX_HOME in Den's own environment, else ~/.codex. */
export function codexHomeOf(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
}

/**
 * Whether Codex thread `id` is a main thread (no parent, not a
 * sub-agent's) that ran in `cwd`, by its session file under `codexHome`
 * (Den's, from the agent's launch: never a path the agent reports).
 */
export function codexMainThread(
  id: string,
  cwd: string,
  codexHome: string,
): boolean {
  if (!CONVERSATION_ID.test(id)) return false;
  const files = findFiles(
    path.join(codexHome, "sessions"),
    [null, null, null],
    (n) =>
      n.startsWith("rollout-") &&
      (n.endsWith(`-${id}.jsonl`) || n.includes(`-${id}_`)),
  );
  return files.some((file) =>
    someLine(file, FIRST_LINE_MAX, (line, first) => {
      if (!first) return false;
      const o = parse(line);
      const m =
        o?.type === "session_meta" &&
        o.payload &&
        typeof o.payload === "object" &&
        !Array.isArray(o.payload)
          ? (o.payload as Record<string, unknown>)
          : null;
      if (!m) return false;
      return (
        m.id === id &&
        m.session_id === id &&
        m.parent_thread_id === undefined &&
        typeof m.source === "string" &&
        (m.thread_source === undefined || m.thread_source === "user") &&
        typeof m.cwd === "string" &&
        path.resolve(m.cwd) === path.resolve(cwd)
      );
    }),
  );
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
 * resumes. False: it stopped before its first turn, or isn't there.
 */
export function geminiResumable(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!CONVERSATION_ID.test(id) || id.length < 8) return false;
  const home = env.GEMINI_CLI_HOME || env.HOME || os.homedir();
  const short = id.slice(0, 8);
  const files = findFiles(
    path.join(home, ".gemini", "tmp"),
    [null, "chats"],
    (n) => n.startsWith("session-") && n.endsWith(`-${short}.jsonl`),
  );
  return files.some((file) => {
    let ours = false;
    return someLine(file, SCAN_MAX, (line, first) => {
      const o = parse(line);
      if (first) {
        ours = !!o && o.sessionId === id && o.kind !== "subagent";
        return false;
      }
      return ours && !!o && isReply(o);
    });
  });
}
