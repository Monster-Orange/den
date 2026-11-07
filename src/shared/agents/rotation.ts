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
import { checkHandoff } from "./handoff.js";
import { agentFilesDir, writePrivate, type AgentRecord } from "./records.js";

export const ROTATION_FILE = "rotation.json";
export const HANDOFF_FILE = "handoff.md";
export const HANDOFFS_DIR = "handoffs";

/** Why a session rotates. */
export type RotateReason = "compactions" | "pr-merged";

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
  reason: RotateReason;
  /** Compactions of the conversation that ended. */
  compactions: number;
  /** The conversation that ended (its resume token). */
  conversation?: string;
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
  return s;
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
  return { status: r.ok ? "ok" : "invalid", text, problems: r.problems };
}

/** An agent's rotation, as the Agents page and the CLI show it. */
export interface RotationInfo {
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
}

/**
 * Agent `rec`'s rotation: null when it has no rotation state for its
 * current conversation (it never ran under 0.4.9, or the state is stale).
 */
export function rotationInfo(
  stateDir: string,
  rec: AgentRecord,
): RotationInfo | null {
  const files = agentFilesDir(stateDir, rec.id);
  const s = readRotation(files);
  if (!s) return null;
  if (s.conversation && rec.resumeToken && s.conversation !== rec.resumeToken)
    return null;
  const due =
    dueFor(s) ??
    (s.after > 0 && rec.outcome?.prMerged ? "pr-merged" : undefined);
  const h = due
    ? readHandoff(files)
    : { status: "missing" as const, problems: [] };
  return {
    ...(due ? { due } : {}),
    compactions: s.compactions,
    after: s.after,
    handoff: h.status,
    ...(h.status === "invalid" ? { problems: h.problems } : {}),
    ready: Boolean(due) && h.status === "ok",
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
export function reasonText(reason: RotateReason, compactions: number): string {
  return reason === "pr-merged"
    ? "PR merged"
    : `${compactions} ${compactions === 1 ? "compaction" : "compactions"}`;
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
      : `it has compacted ${compactions} times`;
  return [
    `Den: this session is done, because ${why} (session rotation).`,
    `Write your handoff now, to ${handoffFile(filesDir)}, with these headings, each filled in:`,
    "## Objective, ## State, ## Open items, ## How to QA, ## Next step.",
    "Write plainly and explain every ID. Then end your turn.",
    "Den relaunches your role from it in a fresh conversation.",
  ].join("\n");
}

/** The first prompt of a session relaunched from `handoff`. */
export function handoffPrompt(
  handoff: string,
  reason: RotateReason,
  compactions: number,
): string {
  return [
    `Den relaunched you from the handoff your last session wrote. That session ended after ${reasonText(reason, compactions)} (session rotation).`,
    "Read it, then carry on from its Next step.",
    "",
    handoff.trim(),
  ].join("\n");
}
