/**
 * D32: Claude Code's subagents for one conversation, read from its own
 * files (read-only: Den never writes there).
 *
 *   <projects>/<enc cwd>/<token>.jsonl               the agent's transcript
 *   <projects>/<enc cwd>/<token>/subagents/agent-<id>.jsonl      a helper's
 *   <projects>/<enc cwd>/<token>/subagents/agent-<id>.meta.json  its meta
 *   <projects>/<enc cwd>/<token>/workflows/wf_<run>.json          a workflow
 *
 * None of this is a published format, so everything is optional: unknown
 * fields are ignored, a field of the wrong type is as good as missing, a
 * meta that is missing or broken leaves the bare id, and nothing here
 * throws. Only the ends of a helper's file are read for the list; the
 * agent's own transcript is read once and then only what it appends.
 *
 * Status, strongest evidence first:
 *   1. the meta says the person stopped it (stoppedByUser);
 *   2. the workflow it ran in says so (done, error; a killed run stops it);
 *   3. the agent's task notification for it (<tool-use-id> + <status>);
 *   4. a foreground helper's tool result in the agent's transcript;
 *   5. the meta says finished;
 *   6. its last entry is a finished answer (end_turn) and it went quiet;
 *   7. otherwise, by its last activity: running if recent, else idle.
 * A helper of an agent that isn't running any more can't be running.
 */
import * as fs from "fs";
import * as path from "path";
import {
  HELPER_DEFAULTS,
  sortHelpers,
  type Helper,
  type HelperSettings,
  type HelperStatus,
  type HelperTranscript,
  type HelperTranscriptItem,
} from "./helpers.js";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** How much of each end of a helper's file the list reads. */
const END_BYTES = 64 * 1024;
/** A transcript view reads at most this much of a helper's file (its end). */
const VIEW_BYTES = 16 * 1024 * 1024;
/** A line longer than this in the agent's transcript is skipped. */
const MAX_LINE = 4 * 1024 * 1024;
/** A finished answer this quiet means done, though nothing else said so. */
const QUIET_MS = 30_000;

export interface ReadHelpersOptions {
  now?: number;
  settings?: Partial<HelperSettings>;
  /** Whether the agent itself is running (its helpers can't outlive it). */
  agentLive?: boolean;
}

const str = (v: unknown, max = 300): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const time = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
};
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return obj(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    return null;
  }
}

/** The JSON lines in `bytes` of `file` from `start` (whole lines only). */
function readLines(
  file: string,
  start: number,
  bytes: number,
): Record<string, unknown>[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, start);
    const lines = buf.subarray(0, n).toString("utf-8").split("\n");
    if (start > 0) lines.shift(); // a cut line
    if (start + n < fs.fstatSync(fd).size) lines.pop();
    const out: Record<string, unknown>[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const e = obj(JSON.parse(l));
        if (e) out.push(e);
      } catch {
        /* a line that isn't JSON: skipped */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** What the ends of a helper's file say: when, the model, the last entry. */
function fileEnds(file: string): {
  startedAt?: number;
  lastAt?: number;
  model?: string;
  endTurn: boolean;
  lastTool?: string;
  mtime?: number;
} {
  let size = 0;
  let mtime: number | undefined;
  try {
    const st = fs.statSync(file);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {
    return { endTurn: false };
  }
  const head = readLines(file, 0, Math.min(END_BYTES, size));
  const tail =
    size > END_BYTES ? readLines(file, size - END_BYTES, END_BYTES) : head;
  let startedAt: number | undefined;
  for (const e of head) {
    startedAt = time(e.timestamp);
    if (startedAt !== undefined) break;
  }
  let lastAt: number | undefined;
  let model: string | undefined;
  let endTurn = false;
  let lastTool: string | undefined;
  let sawLast = false;
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    lastAt ??= time(e.timestamp);
    const m = obj(e.message);
    if (e.type === "assistant" && m) {
      model ??= str(m.model, 80);
      if (!sawLast) {
        sawLast = true;
        endTurn = m.stop_reason === "end_turn";
      }
      if (!lastTool && Array.isArray(m.content))
        for (const c of [...m.content].reverse()) {
          const o = obj(c);
          if (o?.type === "tool_use" && str(o.name, 80)) {
            lastTool = str(o.name, 80);
            break;
          }
        }
    } else if (e.type === "user" && !sawLast && m) {
      // A user turn after the last answer: it is working on it.
      sawLast = true;
      endTurn = false;
    }
    if (lastAt !== undefined && model && sawLast && lastTool) break;
  }
  if (!model)
    for (const e of head) {
      const m = obj(e.message);
      if (e.type === "assistant" && m && str(m.model, 80)) {
        model = str(m.model, 80);
        break;
      }
    }
  return { startedAt, lastAt, model, endTurn, lastTool, mtime };
}

/** What the agent's own transcript says about its helpers (read on as it grows). */
interface ParentFacts {
  /** toolUseId → the last task-notification status. */
  notified: Map<string, string>;
  /** toolUseId → a tool result came back (error or not). */
  results: Map<string, boolean>;
}
const parentCache = new Map<
  string,
  { offset: number; rest: string; facts: ParentFacts; ino: number }
>();

const NOTE_RE =
  /<tool-use-id>([A-Za-z0-9_-]{1,128})<\/tool-use-id>[\s\S]*?<status>([a-z_]{1,32})<\/status>/g;

function parentFacts(file: string): ParentFacts {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { notified: new Map(), results: new Map() };
  }
  let c = parentCache.get(file);
  if (!c || c.ino !== st.ino || st.size < c.offset) {
    c = {
      offset: 0,
      rest: "",
      ino: st.ino,
      facts: { notified: new Map(), results: new Map() },
    };
    parentCache.set(file, c);
  }
  if (st.size === c.offset) return c.facts;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const chunk = 8 * 1024 * 1024;
    const buf = Buffer.alloc(chunk);
    while (c.offset < st.size) {
      const n = fs.readSync(
        fd,
        buf,
        0,
        Math.min(chunk, st.size - c.offset),
        c.offset,
      );
      if (n <= 0) break;
      c.offset += n;
      const text = c.rest + buf.subarray(0, n).toString("utf-8");
      const lines = text.split("\n");
      c.rest = lines.pop() ?? "";
      if (c.rest.length > MAX_LINE) c.rest = "";
      for (const l of lines) scanParentLine(l, c.facts);
    }
  } catch {
    /* what was read stands */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return c.facts;
}

function scanParentLine(l: string, f: ParentFacts): void {
  if (l.length > MAX_LINE) return;
  if (l.includes("<task-notification>"))
    for (const m of l.matchAll(NOTE_RE)) f.notified.set(m[1], m[2]);
  if (!l.includes('"tool_result"')) return;
  let e: Record<string, unknown> | null = null;
  try {
    e = obj(JSON.parse(l));
  } catch {
    return;
  }
  const content = obj(e?.message)?.content;
  if (!Array.isArray(content)) return;
  for (const x of content) {
    const o = obj(x);
    const id = str(o?.tool_use_id, 128);
    if (o?.type === "tool_result" && id) f.results.set(id, o.is_error === true);
  }
}

/** Forget what was read of agents' transcripts (tests). */
export function resetHelperCache(): void {
  parentCache.clear();
  workflowCache.clear();
}

interface WorkflowAgent {
  runId: string;
  name?: string;
  phase?: string;
  label?: string;
  state?: string;
  runStatus?: string;
  model?: string;
  startedAt?: number;
  durationMs?: number;
  lastTool?: string;
}
const workflowCache = new Map<
  string,
  { mtime: number; agents: Map<string, WorkflowAgent> }
>();

/** agentId → where it ran in a workflow, from every wf_*.json in `dir`. */
function workflowAgents(dir: string): Map<string, WorkflowAgent> {
  const out = new Map<string, WorkflowAgent>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^wf_[\w-]+\.json$/.test(n));
  } catch {
    return out;
  }
  for (const n of names) {
    const file = path.join(dir, n);
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let c = workflowCache.get(file);
    if (!c || c.mtime !== mtime) {
      const agents = new Map<string, WorkflowAgent>();
      const d = readJson(file);
      const runId = str(d?.runId, 128) ?? n.replace(/\.json$/, "");
      const progress = Array.isArray(d?.workflowProgress)
        ? d.workflowProgress
        : [];
      for (const p of progress) {
        const o = obj(p);
        const id = str(o?.agentId, 128);
        if (o?.type !== "workflow_agent" || !id) continue;
        agents.set(id, {
          runId,
          name: str(d?.workflowName, 120),
          phase: str(o.phaseTitle, 120),
          label: str(o.label, 160),
          state: str(o.state, 32),
          runStatus: str(d?.status, 32),
          model: str(o.model, 80),
          startedAt: time(o.startedAt),
          durationMs: num(o.durationMs),
          lastTool: str(o.lastToolName, 80),
        });
      }
      c = { mtime, agents };
      workflowCache.set(file, c);
    }
    for (const [k, v] of c.agents) out.set(k, v);
  }
  return out;
}

/** The folder Claude Code keeps conversation `transcript`'s helpers in. */
export function helpersDir(transcript: string): string {
  return transcript.replace(/\.jsonl$/, "");
}

/** The helpers of the conversation whose transcript is `transcript`. Never throws. */
export function readClaudeHelpers(
  transcript: string,
  opts: ReadHelpersOptions = {},
): Helper[] {
  try {
    return sortHelpers(readAll(transcript, opts));
  } catch {
    return [];
  }
}

function readAll(transcript: string, opts: ReadHelpersOptions): Helper[] {
  const now = opts.now ?? Date.now();
  const s = { ...HELPER_DEFAULTS, ...(opts.settings ?? {}) };
  const activeMs = Math.max(1, s.activeMinutes) * 60_000;
  const base = helpersDir(transcript);
  const sub = path.join(base, "subagents");
  let names: string[] = [];
  try {
    names = fs.readdirSync(sub);
  } catch {
    return [];
  }
  const ids = new Set<string>();
  for (const n of names) {
    const m = /^agent-([A-Za-z0-9_-]{1,128})\.(?:meta\.json|jsonl)$/.exec(n);
    if (m) ids.add(m[1]);
  }
  if (!ids.size) return [];
  const wf = workflowAgents(path.join(base, "workflows"));
  const facts = parentFacts(transcript);
  const out: Helper[] = [];
  for (const id of ids) {
    const meta = readJson(path.join(sub, `agent-${id}.meta.json`)) ?? {};
    const ends = fileEnds(path.join(sub, `agent-${id}.jsonl`));
    const w = wf.get(id);
    const toolUseId = str(meta.toolUseId, 128);
    const shape = str(meta.requestShape, 32);
    const lastAt = ends.lastAt ?? ends.mtime;
    const startedAt = w?.startedAt ?? ends.startedAt;
    let status: HelperStatus;
    let from: string;
    const note = toolUseId && !w ? facts.notified.get(toolUseId) : undefined;
    const result = toolUseId ? facts.results.get(toolUseId) : undefined;
    if (meta.stoppedByUser === true) {
      status = "stopped";
      from = "stopped by the person";
    } else if (w && (w.state === "done" || w.state === "error")) {
      status = w.state === "done" ? "done" : "failed";
      from = "its workflow";
    } else if (w && w.runStatus && w.runStatus !== "running") {
      status = w.runStatus === "completed" ? "done" : "stopped";
      from = `its workflow (${w.runStatus})`;
    } else if (note && note !== "running") {
      status =
        note === "completed"
          ? "done"
          : note === "failed"
            ? "failed"
            : "stopped";
      from = `the agent's notification (${note})`;
    } else if (shape !== "background" && result !== undefined) {
      status = result ? "failed" : "done";
      from = "its result in the agent's transcript";
    } else if (meta.finished === true) {
      status = "done";
      from = "its meta (finished)";
    } else if (
      ends.endTurn &&
      lastAt !== undefined &&
      now - lastAt > QUIET_MS
    ) {
      status = "done";
      from = "its last answer";
    } else if (lastAt !== undefined && now - lastAt <= activeMs) {
      status = "running";
      from = "recent activity";
    } else {
      status = "idle";
      from = "no recent activity";
    }
    if (
      opts.agentLive === false &&
      (status === "running" || status === "idle")
    ) {
      status = "stopped";
      from = "its agent isn't running";
    }
    const ended = status !== "running" && status !== "idle";
    const end = ended ? (lastAt ?? now) : now;
    const parentId = str(meta.parentAgentId, 128);
    const depth = Math.max(1, Math.min(9, num(meta.spawnDepth) ?? 1));
    out.push({
      id,
      ...(str(meta.description, 200) || w?.label
        ? { description: str(meta.description, 200) ?? w?.label }
        : {}),
      ...(str(meta.agentType, 120) ? { type: str(meta.agentType, 120) } : {}),
      ...(str(meta.model, 80) ||
      str(meta.pickedEffortModel, 80) ||
      w?.model ||
      ends.model
        ? {
            model:
              str(meta.model, 80) ??
              str(meta.pickedEffortModel, 80) ??
              w?.model ??
              ends.model,
          }
        : {}),
      ...(str(meta.worktreeBranch, 200)
        ? { branch: str(meta.worktreeBranch, 200) }
        : {}),
      ...(str(meta.worktreePath, 500)
        ? { worktree: str(meta.worktreePath, 500) }
        : {}),
      ...(shape ? { background: shape === "background" } : {}),
      depth,
      ...(parentId && ID_RE.test(parentId) ? { parentId } : {}),
      ...(w
        ? {
            workflow: {
              runId: w.runId,
              ...(w.name ? { name: w.name } : {}),
              ...(w.phase ? { phase: w.phase } : {}),
              ...(w.label ? { label: w.label } : {}),
            },
          }
        : {}),
      status,
      statusFrom: from,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(lastAt !== undefined ? { lastActivityAt: lastAt } : {}),
      ...(startedAt !== undefined
        ? {
            durationMs:
              ended && w?.durationMs !== undefined
                ? w.durationMs
                : Math.max(0, end - startedAt),
          }
        : {}),
      ...(ends.lastTool || w?.lastTool
        ? { lastTool: ends.lastTool ?? w?.lastTool }
        : {}),
    });
  }
  return out;
}

/** A tool call in a few words: its command, file, pattern or description. */
export function summarizeToolInput(name: string, input: unknown): string {
  const i = obj(input) ?? {};
  for (const k of [
    "description",
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "prompt",
  ]) {
    const v = str(i[k], 400);
    if (v) return oneLine(v, 200);
  }
  const keys = Object.keys(i).slice(0, 4);
  return keys.length ? `${name}(${keys.join(", ")})` : name;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const o = obj(c);
      return o?.type === "text" && typeof o.text === "string" ? o.text : "";
    })
    .filter(Boolean)
    .join("\n");
};

/**
 * Helper `id`'s transcript, tool calls summarized (thinking and the
 * runtime's own bookkeeping left out), the last `limit` lines. Null when
 * there is no such helper. Never throws.
 */
export function readClaudeHelperTranscript(
  transcript: string,
  id: string,
  opts: ReadHelpersOptions & { limit?: number } = {},
): HelperTranscript | null {
  try {
    if (!ID_RE.test(id)) return null;
    const helper = readClaudeHelpers(transcript, opts).find((h) => h.id === id);
    if (!helper) return null;
    const file = path.join(
      helpersDir(transcript),
      "subagents",
      `agent-${id}.jsonl`,
    );
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { helper, items: [], omitted: 0 };
    }
    const start = Math.max(0, size - VIEW_BYTES);
    const entries = readLines(file, start, size - start);
    const items: HelperTranscriptItem[] = [];
    if (start > 0)
      items.push({
        kind: "note",
        text: "Earlier lines are too long ago to show.",
      });
    let first = true;
    for (const e of entries) {
      const at = time(e.timestamp);
      const m = obj(e.message);
      if (!m) continue;
      if (e.type === "user") {
        if (typeof m.content === "string" || first) {
          const t = textOf(m.content);
          if (t.trim()) {
            items.push({
              ...(at !== undefined ? { at } : {}),
              kind: first ? "prompt" : "text",
              text: oneLine(t, first ? 4000 : 1000),
            });
            first = false;
            continue;
          }
        }
        if (Array.isArray(m.content))
          for (const c of m.content) {
            const o = obj(c);
            if (o?.type !== "tool_result") continue;
            const t =
              textOf(o.content) ||
              (typeof o.content === "string" ? o.content : "");
            items.push({
              ...(at !== undefined ? { at } : {}),
              kind: "result",
              text: oneLine(t || "(no output)", 300),
              ...(o.is_error === true ? { error: true } : {}),
            });
          }
      } else if (e.type === "assistant" && Array.isArray(m.content)) {
        for (const c of m.content) {
          const o = obj(c);
          if (o?.type === "text" && typeof o.text === "string" && o.text.trim())
            items.push({
              ...(at !== undefined ? { at } : {}),
              kind: "text",
              text: oneLine(o.text, 2000),
            });
          else if (o?.type === "tool_use") {
            const name = str(o.name, 80) ?? "tool";
            items.push({
              ...(at !== undefined ? { at } : {}),
              kind: "tool",
              tool: name,
              text: summarizeToolInput(name, o.input),
            });
          }
        }
      }
    }
    const limit = Math.max(1, Math.min(5000, opts.limit ?? 500));
    const omitted = Math.max(0, items.length - limit);
    return { helper, items: items.slice(-limit), omitted };
  } catch {
    return null;
  }
}
