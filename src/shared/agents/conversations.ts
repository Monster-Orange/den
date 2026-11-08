/**
 * AG-17.1, bring in a conversation: the runtime's own recent conversations
 * for a folder, read from its history without ever reading a whole
 * transcript.
 *
 * Claude Code keeps one JSON-lines file per conversation,
 * `<projects>/<slug>/<id>.jsonl`, where <slug> is the cwd with every
 * character that isn't a letter or digit made "-" (`/w/a.b` → `-w-a-b`).
 * The slug alone can't tell `/w/north` from `/w/north-2`, so a
 * conversation is listed only when the `cwd` its own records carry is the
 * folder or inside it.
 *
 * Each file is read at its two ends only (ENDS_BYTES each): the head for
 * its cwd and its first prompt, the tail for its latest `/rename`
 * (custom-title). Title: the latest custom-title, else the first prompt a
 * person typed, else null. lastAt is the file's mtime: a conversation
 * written in the last OPEN_ELSEWHERE_MS is taken to be open in another
 * terminal (one writer only).
 */
import * as fs from "fs";
import * as path from "path";
import { claudeProjectsDir } from "../usage/paths.js";
import { cleanName } from "./transcript-follow.js";

/** One of a runtime's conversations, as Bring in lists it. */
export interface RuntimeConversation {
  /** The runtime's own id for it (Claude Code: the transcript's name). */
  id: string;
  /** Its name for people, or null when it has none yet. */
  title: string | null;
  /** When it was last written (ISO). */
  lastAt: string;
  /** The folder it ran in. */
  cwd: string;
  /**
   * AG-17.1c: the model its last answer came from (the last assistant
   * record's `message.model`), so Bring in keeps it. Absent when unknown.
   */
  model?: string;
  /**
   * AG-17.1c: the MCP servers its tools came from (`mcp__<server>__<tool>`
   * tool calls in the ends read), sorted. Absent when none.
   */
  mcp?: string[];
}

/** Bytes read at each end of a transcript. */
export const ENDS_BYTES = 64 * 1024;
/** Written this recently: still open in another terminal (AG-17.1). */
export const OPEN_ELSEWHERE_MS = 60_000;
/** The most conversations listed for one folder (the newest). */
export const MAX_CONVERSATIONS = 50;

export const OPEN_ELSEWHERE_MESSAGE =
  "Still open in another terminal. Close it there first";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Claude Code's project folder name for `dir`. */
export function claudeSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

/** Whether `p` is `dir` or inside it. */
function within(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The complete lines at the two ends of `file`: at most `bytes` from each.
 * A line cut at either edge is left out; a short file is all head.
 */
export function readEnds(
  file: string,
  bytes = ENDS_BYTES,
): { head: string[]; tail: string[] } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const read = (at: number, n: number) => {
      const buf = Buffer.alloc(n);
      const got = fs.readSync(fd, buf, 0, n, at);
      return buf.subarray(0, got).toString("utf-8");
    };
    const headText = read(0, Math.min(size, bytes));
    const head = headText.split("\n");
    // The whole file: every line. Else the last piece was cut.
    if (size <= bytes) return { head: head.filter(Boolean), tail: [] };
    head.pop();
    const start = Math.max(bytes, size - bytes);
    const tail = read(start, size - start).split("\n");
    // The first piece was cut (or is the head's).
    tail.shift();
    return { head: head.filter(Boolean), tail: tail.filter(Boolean) };
  } finally {
    fs.closeSync(fd);
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The text a person typed in a user record, or null (tool results, meta). */
function promptText(rec: Record<string, unknown>): string | null {
  if (rec.type !== "user" || rec.isMeta === true) return null;
  const msg = rec.message as { content?: unknown } | undefined;
  let text: unknown = msg?.content;
  if (Array.isArray(text)) {
    const first = text.find(
      (c) => (c as { type?: unknown })?.type === "text",
    ) as { text?: unknown } | undefined;
    text = first?.text;
  }
  if (typeof text !== "string") return null;
  // Slash commands and their output come wrapped in tags: not a prompt.
  if (text.trimStart().startsWith("<")) return null;
  return cleanName(text);
}

/** A model name as a transcript records it: short, printable, not synthetic. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
/** An MCP tool's name: `mcp__<server>__<tool>`. */
const MCP_TOOL_RE = /^mcp__([A-Za-z0-9_.-]+?)__[A-Za-z0-9_.-]+$/;

/** An assistant record's tool calls' names. */
function toolNames(rec: Record<string, unknown>): string[] {
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((c) => {
    const b = c as { type?: unknown; name?: unknown };
    return b?.type === "tool_use" && typeof b.name === "string" ? [b.name] : [];
  });
}

/** A transcript's summary from its two ends (AG-17.1, AG-17.1c). */
export interface TranscriptSummary {
  cwd: string | null;
  title: string | null;
  /** The last assistant record's model, or null. */
  model: string | null;
  /** The MCP servers its tool calls name, sorted. */
  mcp: string[];
}

/** A transcript's cwd, title, last model and MCP servers, from its two ends. */
export function transcriptSummary(
  file: string,
  bytes = ENDS_BYTES,
): TranscriptSummary {
  const { head, tail } = readEnds(file, bytes);
  let cwd: string | null = null;
  let prompt: string | null = null;
  let title: string | null = null;
  let model: string | null = null;
  const mcp = new Set<string>();
  const titleIn = (line: string) => {
    if (!line.includes("custom-title")) return;
    const r = parse(line);
    if (r?.type === "custom-title") title = cleanName(r.customTitle) ?? title;
  };
  // AG-17.1c: the last answer's model, and the MCP servers its tools came from.
  const assistantIn = (line: string) => {
    if (!line.includes('"assistant"')) return;
    const r = parse(line);
    if (r?.type !== "assistant") return;
    const m = (r.message as { model?: unknown } | undefined)?.model;
    if (typeof m === "string" && MODEL_RE.test(m) && m !== "<synthetic>")
      model = m;
    for (const n of toolNames(r)) {
      const hit = MCP_TOOL_RE.exec(n);
      if (hit) mcp.add(hit[1]);
    }
  };
  for (const line of head) {
    titleIn(line);
    assistantIn(line);
    if (cwd && prompt) continue;
    if (!line.includes('"cwd"') && !line.includes('"user"')) continue;
    const r = parse(line);
    if (!r) continue;
    if (!cwd && typeof r.cwd === "string" && path.isAbsolute(r.cwd))
      cwd = r.cwd;
    prompt ??= promptText(r);
  }
  for (const line of tail) {
    titleIn(line);
    assistantIn(line);
  }
  return { cwd, title: title ?? prompt, model, mcp: [...mcp].sort() };
}

/** Written this recently, a turn whose last record is an answer is still going. */
export const TURN_QUIET_MS = 5_000;

/**
 * AG-18: whether a conversation's turn is still going, from its tail: the
 * last user or assistant record. An answer that ended (`end_turn`, a stop
 * sequence, the token limit) is idle; a tool call, or a prompt or tool
 * result with no answer yet, is busy; an answer with no stop reason is busy
 * until the file has been quiet TURN_QUIET_MS. An interrupted turn is idle.
 * No transcript: idle (nothing was asked yet).
 */
export function transcriptBusy(
  file: string | null,
  now = Date.now(),
  bytes = ENDS_BYTES,
): boolean {
  if (!file) return false;
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return false;
  }
  const { head, tail } = readEnds(file, bytes);
  const lines = tail.length ? [...head, ...tail] : head;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"user"') && !line.includes('"assistant"')) continue;
    const r = parse(line);
    if (!r || r.isSidechain === true || r.isMeta === true) continue;
    if (r.type === "assistant") {
      const msg = r.message as { stop_reason?: unknown } | undefined;
      const stop = msg?.stop_reason;
      if (stop === "tool_use" || toolNames(r).length) return true;
      if (
        stop === "end_turn" ||
        stop === "stop_sequence" ||
        stop === "max_tokens"
      )
        return false;
      return now - mtime < TURN_QUIET_MS;
    }
    if (r.type === "user") {
      const content = (r.message as { content?: unknown } | undefined)?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? ((
                content.find(
                  (c) => (c as { type?: unknown })?.type === "text",
                ) as { text?: unknown } | undefined
              )?.text ?? "")
            : "";
      if (typeof text === "string" && text.startsWith("[Request interrupted"))
        return false;
      return true;
    }
  }
  return false;
}

/** A folder's absolute forms: as given and its real path. */
function forms(dir: string): string[] {
  const out = [path.resolve(dir)];
  try {
    const real = fs.realpathSync(dir);
    if (!out.includes(real)) out.push(real);
  } catch {
    /* gone: as given */
  }
  return out;
}

/**
 * Claude Code's conversations that ran in `folder` or a folder inside it,
 * newest first, at most MAX_CONVERSATIONS. Never throws: a history it
 * can't read is no conversations.
 */
/**
 * Where a workspace's conversations ran (AG-17.1): in or under one of
 * `under`, or exactly in one of `exact` (a shared repos root: its other
 * subfolders are other workspaces' or no repo's).
 */
export interface ConversationScope {
  under: string[];
  exact?: string[];
}

export function claudeConversations(
  scope: string | ConversationScope,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConversation[] {
  const sc = typeof scope === "string" ? { under: [scope] } : scope;
  const root = claudeProjectsDir(env);
  const dirs = sc.under.flatMap(forms);
  const exact = (sc.exact ?? []).flatMap(forms);
  const slugs = [...dirs, ...exact].map(claudeSlug);
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return [];
  }
  const files: { id: string; file: string; mtimeMs: number }[] = [];
  for (const p of projects) {
    if (!slugs.some((s) => p === s || p.startsWith(`${s}-`))) continue;
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, p));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const id = n.slice(0, -".jsonl".length);
      if (!ID_RE.test(id)) continue;
      const file = path.join(root, p, n);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0)
          files.push({ id, file, mtimeMs: st.mtimeMs });
      } catch {
        /* gone */
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: RuntimeConversation[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (out.length >= MAX_CONVERSATIONS) break;
    if (seen.has(f.id)) continue;
    let s: ReturnType<typeof transcriptSummary>;
    try {
      s = transcriptSummary(f.file);
    } catch {
      continue;
    }
    const cwd = s.cwd;
    // Filtered before the cap, so others' conversations never crowd out
    // this workspace's.
    if (
      !cwd ||
      !(
        dirs.some((d) => within(cwd, d)) ||
        exact.some((d) => path.resolve(cwd) === d)
      )
    )
      continue;
    seen.add(f.id);
    out.push({
      id: f.id,
      title: s.title,
      lastAt: new Date(f.mtimeMs).toISOString(),
      cwd,
      ...(s.model ? { model: s.model } : {}),
      ...(s.mcp.length ? { mcp: s.mcp } : {}),
    });
  }
  return out;
}

/** Whether a conversation that ran in `cwd` is in `scope` (AG-17.1). */
export function inScope(cwd: string, scope: ConversationScope): boolean {
  return (
    scope.under.flatMap(forms).some((d) => within(cwd, d)) ||
    (scope.exact ?? []).flatMap(forms).some((d) => path.resolve(cwd) === d)
  );
}

/** Whether a conversation last written at `lastAt` is still open elsewhere. */
export function openElsewhere(lastAt: string, now = Date.now()): boolean {
  const t = Date.parse(lastAt);
  return Number.isFinite(t) && now - t < OPEN_ELSEWHERE_MS;
}
