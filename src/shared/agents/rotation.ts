/**
 * Session rotation (den#4, rule R2: one session per objective). A session
 * that never ends re-reads its whole context on every call, so a session
 * ends when its pull request merges or after a few compactions, and the
 * role relaunches from a handoff in a fresh conversation.
 *
 *   agent-files/<id>/rotation.json   the compaction count of the agent's
 *                                    current conversation (the SessionStart
 *                                    "compact" hook's), and whether a rotation is due
 *   agent-files/<id>/handoff.md      what the session wrote when it rotated
 *                                    (handoff.ts checks it)
 *   agent-files/<id>/handoffs/       handoffs Den relaunched from, kept
 *
 * Triggers (org config `agents.rotate`):
 *   - `after_compactions` (default 3): SessionStart "compact" counts each
 *     compaction that happened; at that many, a rotation is due;
 *   - the agent's pull request merged: the record's outcome
 *     (`prMerged`, den#6), which `<cli> usage` fills in.
 *   `standing: false` keeps standing personas (planner, orchestrator) out:
 *   they never rotate. Default true: only their context resets, they keep
 *   their name.
 *
 * A rotation is "ready" once it is due and handoff.md passes the check.
 * Then Den declines a plain Resume and offers Relaunch from handoff.
 * Everything here is this machine's files; nothing is sent.
 */
import * as fs from "fs";
import * as path from "path";
import { isTimeZone } from "../time-zone.js";
import { checkHandoff } from "./handoff.js";
import { agentFilesDir, writePrivate, type AgentRecord } from "./records.js";

export const ROTATION_FILE = "rotation.json";
export const HANDOFF_FILE = "handoff.md";
export const HANDOFFS_DIR = "handoffs";

/** Why a session rotates. */
export type RotateReason = "compactions" | "pr-merged";

/**
 * Why Den relaunched an agent from a handoff: a rotation's reason, or
 * (issue 658) a person's relaunch from its last handoff when none was due
 * ("manual"), or a resume whose conversation was never written
 * ("resume_failed").
 */
export type RelaunchReason = RotateReason | "manual" | "resume_failed";

export interface RotationState {
  /**
   * The conversation counted: Claude Code's session_id, which is the
   * record's resumeToken. A count for another conversation is stale.
   */
  conversation?: string;
  compactions: number;
  /** Rotate after this many compactions; 0: this agent never rotates. */
  after: number;
  /** The last compaction (ISO 8601) and what triggered it (manual, auto). */
  lastCompactAt?: string;
  lastTrigger?: string;
  /**
   * PreCompact's trigger, kept until SessionStart "compact" counts the
   * compaction (SessionStart's input has no trigger).
   */
  pendingTrigger?: string;
  /** Set when a trigger fired. */
  due?: RotateReason;
  dueAt?: string;
  /** D28: how many times Den asked for the handoff, and the last time. */
  asked?: number;
  askedAt?: string;
  /** D28: auto gave up asking (2 asks, still no handoff): ask mode. */
  fellBack?: boolean;
  /** D28 "Relaunch now" before a handoff: relaunch once it passes, whatever on_due says. */
  relaunchWanted?: boolean;
  /**
   * Issue 914: when Den first found the due agent's turn over but its
   * background work still running (ISO 8601). The rotation waits from
   * here, at most agents.rotation_wait_minutes.
   */
  waitingSince?: string;
  /** Issue 914: how many background items it waits on (the row says so). */
  waitingOn?: number;
  /**
   * Issue 914: the background work still running when the wait ran out.
   * The handoff must list each one; the next session starts each again.
   */
  leftRunning?: LeftRunning[];
  /**
   * Issue 914: Den asked for the handoff that lists leftRunning. Until it
   * has, it asks once, whatever the person's Relaunch now or the gap.
   */
  leftAsked?: boolean;
}

/**
 * Issue 914: one piece of background work a rotating session left running:
 * a helper (a background subagent, a workflow's agent) or a job (a
 * background shell, such as a gate run).
 */
export interface LeftRunning {
  kind: "helper" | "job";
  /** The helper's id, or the job's process id. */
  id: string;
  /** What it was doing, in a few words. */
  what: string;
  branch?: string;
}

/** A helper's id as its runtime gives it (Claude Code: up to 128), or a pid. */
const LEFT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The most items kept: far more than any agent runs at once. */
const LEFT_MAX = 500;

/** Where a helper left running writes its own handoff. */
export function helperHandoffFile(filesDir: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "-");
  return path.join(filesDir, HANDOFFS_DIR, `helper-${safe}.md`);
}

/** Whether `text` names `id` as a whole word (never inside a longer one). */
function namesId(text: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`).test(text);
}

function leftOf(v: unknown): LeftRunning[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: LeftRunning[] = [];
  for (const x of v.slice(0, LEFT_MAX)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (o.kind !== "helper" && o.kind !== "job") continue;
    if (typeof o.id !== "string" || !LEFT_ID.test(o.id)) continue;
    out.push({
      kind: o.kind,
      id: o.id,
      what: typeof o.what === "string" ? o.what.slice(0, 200) : "",
      ...(typeof o.branch === "string" && o.branch
        ? { branch: o.branch.slice(0, 200) }
        : {}),
    });
  }
  return out.length ? out : undefined;
}

/** One item, as the instruction and the problems name it. */
function leftName(l: LeftRunning): string {
  return l.kind === "helper"
    ? `helper ${l.id} (${l.what || "a background helper"})`
    : `job ${l.id} (${l.what || "a background shell"})`;
}

/** `agents.rotate` with its defaults applied. */
export interface RotateSettings {
  /** Compactions before a session rotates (at least 1). */
  afterCompactions: number;
  /** Whether standing personas rotate too. */
  standing: boolean;
}

export const DEFAULT_ROTATE: RotateSettings = {
  afterCompactions: 3,
  standing: true,
};

/** A rotation Den did (kept in the record, newest last). */
export interface RotationEntry {
  /** When it relaunched (ISO 8601). */
  at: string;
  reason: RelaunchReason;
  /** Compactions of the conversation that ended. */
  compactions: number;
  /** The conversation that ended (its resume token). */
  conversation?: string;
  /**
   * Issue 658: the conversation the relaunch started (its resume token),
   * so a relaunch that never began is known as one.
   */
  next?: string;
  /** D28: Den relaunched it by itself (on_due auto). */
  auto?: boolean;
}

/** The compactions after which `persona` rotates; 0: it never does. */
export function rotateAfter(
  settings: RotateSettings,
  persona: { standing?: boolean },
): number {
  if (persona.standing && !settings.standing) return 0;
  return settings.afterCompactions;
}

export const rotationFile = (filesDir: string) =>
  path.join(filesDir, ROTATION_FILE);
export const handoffFile = (filesDir: string) =>
  path.join(filesDir, HANDOFF_FILE);

const count = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;

/** The rotation state in `filesDir`; null when there is none (or it is unreadable). */
export function readRotation(filesDir: string): RotationState | null {
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(rotationFile(filesDir), "utf-8"));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const s: RotationState = {
    compactions: count(o.compactions),
    after: count(o.after),
  };
  if (typeof o.conversation === "string") s.conversation = o.conversation;
  if (typeof o.lastCompactAt === "string") s.lastCompactAt = o.lastCompactAt;
  if (typeof o.lastTrigger === "string") s.lastTrigger = o.lastTrigger;
  if (typeof o.pendingTrigger === "string") s.pendingTrigger = o.pendingTrigger;
  if (o.due === "compactions" || o.due === "pr-merged") s.due = o.due;
  if (typeof o.dueAt === "string") s.dueAt = o.dueAt;
  if (count(o.asked)) s.asked = count(o.asked);
  if (typeof o.askedAt === "string") s.askedAt = o.askedAt;
  if (o.fellBack === true) s.fellBack = true;
  if (o.relaunchWanted === true) s.relaunchWanted = true;
  if (typeof o.waitingSince === "string") s.waitingSince = o.waitingSince;
  if (count(o.waitingOn)) s.waitingOn = count(o.waitingOn);
  if (o.leftAsked === true) s.leftAsked = true;
  const left = leftOf(o.leftRunning);
  if (left) s.leftRunning = left;
  return s;
}

/**
 * Issue 914: the due agent's background work still runs at `now`. The
 * first time, the wait starts; returns when it started (ms).
 */
export function noteWaiting(
  filesDir: string,
  now: Date,
  running: number,
): number {
  const s = readRotation(filesDir);
  if (!s) return now.getTime();
  const at = s.waitingSince ? Date.parse(s.waitingSince) : Number.NaN;
  const since = Number.isFinite(at) ? at : now.getTime();
  if (since !== at || s.waitingOn !== running)
    writeRotation(filesDir, {
      ...s,
      waitingSince: new Date(since).toISOString(),
      waitingOn: running,
    });
  return since;
}

/**
 * Issue 914: the wait ran out: the handoff must list `left`. A changed
 * list is asked for again. Returns whether Den still has to ask for it.
 */
export function noteLeftRunning(
  filesDir: string,
  left: LeftRunning[],
): boolean {
  const s = readRotation(filesDir);
  if (!s) return false;
  const kept = leftOf(left);
  const ids = (l?: LeftRunning[]) => (l ?? []).map((x) => x.id).join("\n");
  const next: RotationState = { ...s };
  if (kept) next.leftRunning = kept;
  else delete next.leftRunning;
  if (ids(kept) !== ids(s.leftRunning)) delete next.leftAsked;
  writeRotation(filesDir, next);
  return Boolean(kept) && !next.leftAsked;
}

/** Issue 914: Den asked for the handoff that lists leftRunning. */
export function noteLeftAsked(filesDir: string): void {
  const s = readRotation(filesDir);
  if (s) writeRotation(filesDir, { ...s, leftAsked: true });
}

/** Issue 914: nothing runs any more: no wait, nothing to list. */
export function clearWaiting(filesDir: string): void {
  const s = readRotation(filesDir);
  if (!s || (!s.waitingSince && !s.leftRunning)) return;
  const next: RotationState = { ...s };
  delete next.waitingSince;
  delete next.waitingOn;
  delete next.leftRunning;
  delete next.leftAsked;
  writeRotation(filesDir, next);
}

/**
 * Issue 914: what a handoff leaves out of `left`: an item it doesn't name
 * by its id, or a helper with no handoff file of its own.
 */
export function leftRunningProblems(
  filesDir: string,
  text: string,
  left: readonly LeftRunning[],
): string[] {
  const problems: string[] = [];
  for (const l of left) {
    if (!namesId(text, l.id))
      problems.push(
        `It leaves out ${leftName(l)}, still running when this conversation ended. List it: what it was doing, its branch, and its handoff file.`,
      );
    if (
      l.kind === "helper" &&
      !fs.existsSync(helperHandoffFile(filesDir, l.id))
    )
      problems.push(
        `Helper ${l.id} has no handoff of its own yet. Write it to ${helperHandoffFile(filesDir, l.id)}.`,
      );
  }
  return problems;
}

export function writeRotation(filesDir: string, s: RotationState): void {
  writePrivate(rotationFile(filesDir), JSON.stringify(s, null, 2) + "\n");
}

/**
 * A launch's rotation state. A new conversation starts at 0. A resume of
 * the same one keeps its count and takes the current `after`.
 */
export function launchRotation(
  filesDir: string,
  conversation: string | undefined,
  after: number,
): RotationState {
  const prev = readRotation(filesDir);
  const same =
    prev && conversation !== undefined && prev.conversation === conversation;
  const s: RotationState = same
    ? { ...prev, after }
    : {
        ...(conversation !== undefined ? { conversation } : {}),
        compactions: 0,
        after,
      };
  if (after === 0) {
    delete s.due;
    delete s.dueAt;
  }
  writeRotation(filesDir, s);
  return s;
}

/**
 * One compaction that happened (SessionStart with source "compact"; never
 * PreCompact, which runs even when nothing is compacted). `input` is the
 * hook input: `session_id` and `trigger` (manual, auto) are read when present.
 * A different conversation than the one counted starts the count again.
 */
export function noteCompaction(
  filesDir: string,
  input: unknown,
  after: number,
  now: Date = new Date(),
): RotationState {
  const i = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const conversation =
    typeof i.session_id === "string" && i.session_id ? i.session_id : undefined;
  const prev = readRotation(filesDir);
  const fresh =
    !prev ||
    (conversation !== undefined &&
      prev.conversation !== undefined &&
      prev.conversation !== conversation);
  const s: RotationState = fresh
    ? { compactions: 0, after }
    : { ...prev, after };
  if (conversation !== undefined) s.conversation = conversation;
  s.compactions += 1;
  s.lastCompactAt = now.toISOString();
  const trigger =
    typeof i.trigger === "string"
      ? i.trigger
      : fresh
        ? undefined
        : prev?.pendingTrigger;
  if (trigger) s.lastTrigger = trigger.slice(0, 20);
  delete s.pendingTrigger;
  if (after > 0 && s.compactions >= after && !s.due) {
    s.due = "compactions";
    s.dueAt = now.toISOString();
  }
  writeRotation(filesDir, s);
  return s;
}

/**
 * PreCompact: keep its trigger (manual, auto) for the count. Nothing is
 * counted; a state for another conversation is left alone.
 */
export function notePendingCompaction(
  filesDir: string,
  conversation: string | undefined,
  trigger: unknown,
  after: number,
): void {
  if (typeof trigger !== "string") return;
  const prev = readRotation(filesDir);
  if (prev?.conversation && conversation && prev.conversation !== conversation)
    return;
  writeRotation(filesDir, {
    ...(prev ?? { compactions: 0, after }),
    ...(conversation ? { conversation } : {}),
    pendingTrigger: trigger.slice(0, 20),
  });
}

/** Mark a rotation due (its pull request merged), when the agent rotates. */
export function markDue(
  filesDir: string,
  reason: RotateReason,
  conversation?: string,
  now: Date = new Date(),
): boolean {
  const s = readRotation(filesDir);
  if (!s || s.after === 0 || s.due) return false;
  if (conversation && s.conversation && s.conversation !== conversation)
    return false;
  writeRotation(filesDir, { ...s, due: reason, dueAt: now.toISOString() });
  return true;
}

/**
 * D28 "Keep this conversation": the count starts again from 0 for the
 * conversation it has, and nothing is due. Returns false with no state.
 */
export function keepConversation(filesDir: string): boolean {
  const s = readRotation(filesDir);
  if (!s) return false;
  writeRotation(filesDir, {
    ...(s.conversation ? { conversation: s.conversation } : {}),
    compactions: 0,
    after: s.after,
  });
  return true;
}

/** D28: one more ask for the handoff, noted; `relaunch`: Relaunch now asked. */
export function noteAsked(
  filesDir: string,
  now: Date = new Date(),
  relaunch = false,
): RotationState | null {
  const s = readRotation(filesDir);
  if (!s) return null;
  const next: RotationState = {
    ...s,
    asked: (s.asked ?? 0) + 1,
    askedAt: now.toISOString(),
    ...(relaunch ? { relaunchWanted: true } : {}),
  };
  writeRotation(filesDir, next);
  return next;
}

/** D28: auto gave up asking; the callout's buttons take over. */
export function noteFellBack(filesDir: string): void {
  const s = readRotation(filesDir);
  if (s && !s.fellBack) writeRotation(filesDir, { ...s, fellBack: true });
}

/** D28: the limit the hook counts against, when the settings changed. */
export function syncAfter(filesDir: string, after: number): void {
  const s = readRotation(filesDir);
  if (s && s.after !== after) writeRotation(filesDir, { ...s, after });
}

/** Clear a rotation due for `reason` (a merge mark gh no longer confirms). */
export function clearDue(filesDir: string, reason: RotateReason): boolean {
  const s = readRotation(filesDir);
  if (!s || s.due !== reason) return false;
  const { due: _d, dueAt: _a, ...rest } = s;
  writeRotation(filesDir, rest);
  return true;
}

/** Whether the state says a rotation is due, for this conversation. */
export function dueFor(
  s: RotationState | null,
  conversation?: string,
): RotateReason | undefined {
  if (!s || s.after === 0) return undefined;
  if (conversation && s.conversation && s.conversation !== conversation)
    return undefined;
  if (s.due) return s.due;
  return s.compactions >= s.after ? "compactions" : undefined;
}

export type HandoffStatus = "ok" | "missing" | "invalid";

/** handoff.md in `filesDir`: missing, or checked. */
export function readHandoff(filesDir: string): {
  status: HandoffStatus;
  text?: string;
  problems: string[];
} {
  let text: string;
  try {
    text = fs.readFileSync(handoffFile(filesDir), "utf-8");
  } catch {
    return { status: "missing", problems: [] };
  }
  const r = checkHandoff(text);
  // Issue 914: a rotation that went ahead with background work running.
  const left = readRotation(filesDir)?.leftRunning ?? [];
  const problems = [
    ...r.problems,
    ...leftRunningProblems(filesDir, text, left),
  ];
  return {
    status: problems.length ? "invalid" : "ok",
    text,
    problems,
  };
}

/**
 * D28: an agent's effective rotation settings (rotate-settings.ts), when
 * the caller resolved them; without, the state's own limit and den#4's
 * rules apply.
 */
export interface RotationPolicy {
  /** 0: never rotates. */
  afterCompactions: number;
  onDue: "auto" | "ask" | "off";
  onPrMerged: boolean;
  /** Where each value comes from, in words ("persona planner"). */
  from?: { after_compactions: string; on_due: string; on_pr_merged: string };
}

/** An agent's rotation, as the Agents page and the CLI show it. */
export interface RotationInfo {
  /** D28: what happens when it is due, and where the settings come from. */
  onDue?: RotationPolicy["onDue"];
  from?: RotationPolicy["from"];
  /** D28: Den asked it for its handoff this many times (auto). */
  asked?: number;
  /** D28: auto fell back to ask (the handoff still failed after 2 asks). */
  fellBack?: boolean;
  /** D28: Relaunch now was asked before the handoff: Den relaunches once it passes. */
  relaunchWanted?: boolean;
  /** Why it rotates, when a trigger fired. */
  due?: RotateReason;
  compactions: number;
  /** 0: this agent never rotates. */
  after: number;
  handoff: HandoffStatus;
  /** What is wrong with handoff.md, when it is invalid. */
  problems?: string[];
  /** Due and handoff.md passes: Relaunch from handoff, not Resume. */
  ready: boolean;
  /** Issue 914: it waits on this many background items it left running. */
  waiting?: number;
}

/**
 * Agent `rec`'s rotation: null when it has no rotation state for its
 * current conversation (it never ran under 0.4.9, or the state is stale).
 */
export function rotationInfo(
  stateDir: string,
  rec: AgentRecord,
  policy?: RotationPolicy,
): RotationInfo | null {
  const files = agentFilesDir(stateDir, rec.id);
  const read = readRotation(files);
  if (!read) return null;
  if (
    read.conversation &&
    rec.resumeToken &&
    read.conversation !== rec.resumeToken
  )
    return null;
  // D28: the limit in force now, not the one the launch counted against.
  const s: RotationState = policy
    ? { ...read, after: policy.afterCompactions }
    : read;
  if (
    policy &&
    s.after > 0 &&
    s.compactions < s.after &&
    s.due === "compactions"
  ) {
    delete s.due;
  }
  if (policy && !policy.onPrMerged && s.due === "pr-merged") delete s.due;
  const merged = policy ? policy.onPrMerged : true;
  const due =
    dueFor(s) ??
    (s.after > 0 && merged && rec.outcome?.prMerged ? "pr-merged" : undefined);
  const h = due
    ? readHandoff(files)
    : { status: "missing" as const, problems: [] };
  return {
    ...(due ? { due } : {}),
    ...(policy ? { onDue: policy.onDue } : {}),
    ...(policy?.from ? { from: policy.from } : {}),
    ...(read.asked ? { asked: read.asked } : {}),
    ...(read.fellBack ? { fellBack: true } : {}),
    ...(read.relaunchWanted ? { relaunchWanted: true } : {}),
    compactions: s.compactions,
    after: s.after,
    handoff: h.status,
    ...(h.status === "invalid" ? { problems: h.problems } : {}),
    ready: Boolean(due) && h.status === "ok",
    ...(due && read.waitingSince && !read.leftRunning && read.waitingOn
      ? { waiting: read.waitingOn }
      : {}),
  };
}

/**
 * Move handoff.md aside (handoffs/<tag>.md) once Den relaunched from it, so
 * the next rotation needs a new one. Returns where it went.
 */
export function archiveHandoff(filesDir: string, tag: string): string {
  const dir = path.join(filesDir, HANDOFFS_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = tag.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  const to = path.join(dir, `${safe}.md`);
  fs.renameSync(handoffFile(filesDir), to);
  return to;
}

/** Why, in words: "3 compactions", "PR merged". */
export function reasonText(
  reason: RelaunchReason,
  compactions: number,
): string {
  if (reason === "manual") return "a relaunch from its last handoff";
  if (reason === "resume_failed")
    return "a resume with no conversation to continue";
  return reason === "pr-merged"
    ? "PR merged"
    : `${compactions} ${compactions === 1 ? "compaction" : "compactions"}`;
}

/**
 * Issue 658: the newest handoff on file for an agent: handoff.md when it
 * passes the check, else the newest kept one (handoffs/) that passes.
 * Null when there is none. `kept`: it is one of handoffs/ (already aside).
 */
export function newestHandoff(
  filesDir: string,
): { text: string; file: string; kept: boolean } | null {
  const h = readHandoff(filesDir);
  if (h.status === "ok")
    return { text: h.text!, file: handoffFile(filesDir), kept: false };
  const dir = path.join(filesDir, HANDOFFS_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return null;
  }
  const dated: { file: string; n: string; at: number }[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      dated.push({ file, n, at: fs.statSync(file).mtimeMs });
    } catch {
      /* gone meanwhile */
    }
  }
  dated.sort((a, b) => b.at - a.at || (a.n < b.n ? 1 : -1));
  for (const x of dated) {
    let text: string;
    try {
      text = fs.readFileSync(x.file, "utf-8");
    } catch {
      continue;
    }
    if (checkHandoff(text).ok) return { text, file: x.file, kept: true };
  }
  return null;
}

/**
 * Issue 658: the kept handoff a relaunch ended `conversation` with
 * (archiveHandoff's tag ends with it), the newest when several.
 */
export function keptHandoffOf(
  filesDir: string,
  conversation: string | undefined,
): string | null {
  const dir = path.join(filesDir, HANDOFFS_DIR);
  const end = `-${(conversation ?? "conversation").replace(/[^A-Za-z0-9._-]/g, "-")}.md`;
  try {
    const hits = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(end))
      .sort();
    return hits.length ? path.join(dir, hits[hits.length - 1]) : null;
  } catch {
    return null;
  }
}

/** What the hooks tell a session whose rotation is due. */
export function rotationInstruction(
  filesDir: string,
  reason: RotateReason,
  compactions: number,
): string {
  const why =
    reason === "pr-merged"
      ? "its pull request merged"
      : `it has compacted ${compactions === 1 ? "once" : `${compactions} times`}`;
  const left = readRotation(filesDir)?.leftRunning ?? [];
  return [
    `Den: this session is done, because ${why} (session rotation).`,
    `Write your handoff now, to ${handoffFile(filesDir)}, with these headings, each filled in:`,
    "## Objective, ## State, ## Open items, ## How to QA, ## Next step.",
    ...(left.length ? leftRunningLines(filesDir, left) : []),
    "Write plainly and explain every ID. Then end your turn.",
    "Den relaunches your role from it in a fresh conversation.",
  ].join("\n");
}

/** Issue 914: what the instruction says about background work left running. */
function leftRunningLines(
  filesDir: string,
  left: readonly LeftRunning[],
): string[] {
  return [
    "This background work is still running, and it ends with this conversation:",
    ...left.map(
      (l) =>
        `- ${leftName(l)}${l.branch ? `, branch ${l.branch}` : ""}` +
        (l.kind === "helper"
          ? `: its own handoff goes in ${helperHandoffFile(filesDir, l.id)} (ask it for one, or write it yourself)`
          : ": say what it was running and how to start it again"),
    ),
    "List each one under ## Open items by its ID: what it was doing, its branch, and its handoff file.",
  ];
}

function zoneOr(timeZone: string | undefined): string {
  return isTimeZone(timeZone)
    ? timeZone
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function utcOffset(now: Date, zone: string): string {
  const name =
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  return m ? `UTC${m[1]}${m[2]}:${m[3]}` : "UTC+00:00";
}

export function clockLine(now: Date, timeZone?: string): string {
  const zone = zoneOr(timeZone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const short = /^GMT/.test(parts.timeZoneName ?? "")
    ? ""
    : `${parts.timeZoneName} `;
  return `It is now ${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${short}(${utcOffset(now, zone)}, ${zone}).`;
}

const CLOCK_HINT =
  "Count any time or ETA from this, not from the times in the handoff or in older messages.";

/** The first prompt of a session relaunched from `handoff`. */
export function handoffPrompt(
  handoff: string,
  reason: RelaunchReason,
  compactions: number,
  /** Issue 914: background work the last session left running. */
  left: readonly LeftRunning[] = [],
  now: Date = new Date(),
  timeZone?: string,
): string {
  const clock = [clockLine(now, timeZone), CLOCK_HINT];
  const again = left.length
    ? [
        "Your last conversation ended with background work still running, and it stopped. The handoff lists it. Read each one's own handoff, then start each one again:",
        ...left.map((l) => `- ${leftName(l)}`),
      ]
    : [];
  // Issue 658: a person's relaunch, or a resume with nothing written.
  if (reason === "manual" || reason === "resume_failed")
    return [
      "Den relaunched you from the last handoff your role wrote.",
      ...clock,
      "Read it, then carry on from its Next step.",
      "",
      handoff.trim(),
    ].join("\n");
  return [
    `Den relaunched you from the handoff your last session wrote. That session ended after ${reasonText(reason, compactions)} (session rotation).`,
    ...clock,
    "Read it, then carry on from its Next step.",
    ...again,
    "",
    handoff.trim(),
  ].join("\n");
}

/**
 * Issue 658: the first prompt of a Resume that started fresh because its
 * conversation was never written, when a handoff is on file.
 */
export function resumeHandoffPrompt(
  handoff: string,
  now: Date = new Date(),
  timeZone?: string,
): string {
  return [
    "Den started you fresh: your last conversation was never written, so it could not be continued.",
    clockLine(now, timeZone),
    CLOCK_HINT,
    "Here is the last handoff your role wrote. Read it, then carry on from its Next step.",
    "",
    handoff.trim(),
  ].join("\n");
}
