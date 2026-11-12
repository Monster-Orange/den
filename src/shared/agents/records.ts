/**
 * The agent record (AG-2a): what an agent is and where it runs, kept in the
 * distribution's state dir so the CLI and the web server (AG-4a) see the
 * same agents, and so an agent outlives the session it runs in.
 *
 *   agents/<id>.json        the record (0600, its directory 0700)
 *   agent-files/<id>/       files its runtime wrote (0600): its MCP config;
 *                           and its rotation state and handoff.md (den#4)
 *
 * A record never holds the env or the argv: the role prompt, tokens and
 * anything else a launch passes stay out of it. An agent id is unique in a
 * distribution.
 *
 * AG-14: a removed agent's record moves to removed-agents/<id>.json, so
 * Undo can bring it back; restoreRecord does, and purgeRemoved forgets
 * the ones older than the undo window. The runtime's own conversation
 * history is never touched.
 */
import * as fs from "fs";
import * as path from "path";
import { WORKSPACE_NAME_RE } from "../agent-actor.js";
import type { SessionRef } from "../sessions/types.js";
import type { RotationEntry } from "./rotation.js";
import type { PermissionIntent } from "./permissions.js";

export interface AgentRecord {
  id: string;
  persona: string;
  runtime: string;
  model?: string;
  /**
   * den#3: the model its subagents ran on when it last started, and where
   * that came from (no model: inherit, the runtime decided). Only for a
   * runtime that takes one (Runtime.subagentModel).
   */
  subagents?: { model?: string; from: "persona" | "org" | "default" };
  workspace: string;
  cwd: string;
  /** The session it runs in now (or last ran in). */
  session: SessionRef;
  /** `<dist>-<ws>:<id>`. */
  sessionName: string;
  /** ISO 8601. */
  startedAt: string;
  /** Set by `agents stop`; cleared by a resume. */
  stoppedAt?: string;
  /** Set when a resume started its current session. */
  resumedAt?: string;
  /** The runtime's handle for resume (den-claude: the conversation id). */
  resumeToken?: string;
  /**
   * AG-17.1: brought in from a conversation started outside Den (when);
   * Den's token, hooks and guards apply from then on.
   */
  broughtInAt?: string;
  /**
   * The runtime was launched on resumeToken at least once (0.4.8). A
   * resume then always tries the runtime's own resume first, never a new
   * conversation under the same id (which the runtime refuses once the
   * conversation exists).
   */
  launched?: boolean;
  /**
   * The workspaces beyond its own its MCP served when it started
   * (agents.<id>.grants then). A resume keeps them, never more than the
   * config still allows (AG-14).
   */
  grants?: string[];
  /** When its session was seen to end on its own (AG-14: "Exited"). */
  endedAt?: string;
  /** That session's exit code, when the host said it. */
  exitCode?: number;
  /**
   * Set when its session was gone after Den or the machine restarted
   * (AG-14.3: "Interrupted"); cleared by a resume or a start.
   */
  interruptedAt?: string;
  /** What its run came to (den#6), filled in by `<cli> usage`. */
  outcome?: AgentOutcome;
  /** Its tokens, from the runtime's own transcript (den#6). */
  usage?: AgentUsage;
  /**
   * Each time Den relaunched it from its handoff (den#4, session
   * rotation), oldest first.
   */
  rotations?: RotationEntry[];
  /**
   * The name a person gave it (AG-4b: double-click its tab), shown in the
   * Agents tab, its tabs, ⌘K and the agent lists; the id never changes.
   * checkDisplayName says what one may be.
   */
  displayName?: string;
  /** When displayName was given (ISO 8601): the latest rename wins (AG-4b). */
  displayNameAt?: string;
  /**
   * D59: whether it resumes on its own after a restart, set on this agent
   * (over its persona's `resume_on_restart` and `standing`); unset: the
   * persona's.
   */
  resumeOnRestart?: boolean;
  /**
   * D24: the name Den last gave its runtime session (Claude Code's
   * `--name`, peerSessionName), so reading it back is never taken for a
   * rename.
   */
  peerName?: string;
  /**
   * The model version it runs (AG-12.3): "latest" (the model's newest), or
   * a pinned version. Absent: before AG-12, `model` as given.
   */
  version?: string;
  /** The permission intent it was started with (AG-13), when one was set. */
  permission?: PermissionIntent;
  /**
   * The extra allowed commands it was started with (AG-13.4: plain
   * prefixes; its role's preset comes on top), when set for it.
   */
  allow?: string[];
  /**
   * What it was started with that differs from its persona (AG-10.9):
   * the list tags it. Start fresh and Relaunch keep the choices.
   */
  overrides?: Override[];
  /**
   * AG-18: each persona change, oldest first: from, to, when, and who (a
   * person's sign-in, or "cli").
   */
  personaChanges?: PersonaChange[];
  /**
   * AG-18: a persona change waiting for this agent's turn to end. The wait
   * lives in the server's memory, so a restart drops it; the upkeep at
   * start clears this and audits the cancel (cancelStalePersonaChanges).
   */
  pendingPersona?: { to: string; since: string; by?: string };
}

/** One persona change of an agent (AG-18). */
export interface PersonaChange {
  from: string;
  to: string;
  at: string;
  by?: string;
}

/** A setting a session can override for one launch (AG-10.9). */
export type Override = "runtime" | "model" | "version" | "permission" | "allow";
export const OVERRIDES: readonly Override[] = [
  "runtime",
  "model",
  "version",
  "permission",
  "allow",
];

/** The longest name a person may give an agent (AG-4b). */
export const MAX_DISPLAY_NAME = 40;

/**
 * A name given to an agent, checked (AG-4b): a string, trimmed, at most
 * MAX_DISPLAY_NAME characters, with no control or format characters (no
 * newline, no bidi override). Blank (or null) clears it: null. Anything
 * else throws, saying why.
 */
export function checkDisplayName(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw new Error("name must be a string, or null");
  const name = v.trim();
  if (!name) return null;
  if ([...name].length > MAX_DISPLAY_NAME)
    throw new Error(`name must be at most ${MAX_DISPLAY_NAME} characters`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name))
    throw new Error("name can't have control characters");
  return name;
}

/** What an agent's run came to (den#6). Read locally; never sent. */
export interface AgentOutcome {
  /** The pull request it opened, when it opened one. */
  prOpened?: string;
  /** That pull request merged in the run. */
  prMerged?: boolean;
  /**
   * The pull request gh said is MERGED (0.4.10): a merge confirmed once
   * stays, and is not asked again.
   */
  prMergeConfirmed?: string;
  /** The last test run it made passed (true) or failed (false). */
  testsGreen?: boolean;
  /** From its start to its last activity, in milliseconds. */
  wallClockMs?: number;
}

/** An agent's token counts (den#6), summed over its transcripts. */
export interface AgentUsage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  compactions: number;
}

/** An agent id: the same rules as a workspace or session name. */
export const AGENT_ID_RE = WORKSPACE_NAME_RE;

/**
 * AG-10.10b: the agent id a Name gives, so the name works in the CLI too:
 * lowercase, spaces to "-", only id characters, at most 64. Null when
 * nothing of it is left ("!!!"). The page's nameSlug is the same rule.
 */
export function nameSlug(name: string): string | null {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-._]+$/, "");
  return s && AGENT_ID_RE.test(s) ? s : null;
}

export function agentsDir(stateDir: string): string {
  return path.join(stateDir, "agents");
}

export function agentFilesDir(stateDir: string, id: string): string {
  return path.join(stateDir, "agent-files", id);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Write `content` to `file`, owner-only from the start, atomically. */
export function writePrivate(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function recordFile(stateDir: string, id: string): string {
  if (!AGENT_ID_RE.test(id)) throw new Error(`"${id}" is not an agent id`);
  return path.join(agentsDir(stateDir), `${id}.json`);
}

export function writeRecord(stateDir: string, rec: AgentRecord): void {
  writePrivate(
    recordFile(stateDir, rec.id),
    JSON.stringify(rec, null, 2) + "\n",
  );
}

export function readRecord(stateDir: string, id: string): AgentRecord | null {
  if (!AGENT_ID_RE.test(id)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(recordFile(stateDir, id), "utf-8"),
    ) as AgentRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Where removed records wait for Undo (AG-14.1b). */
export function removedDir(stateDir: string): string {
  return path.join(stateDir, "removed-agents");
}

/** How long a removed record can be brought back. */
export const UNDO_KEEP_MS = 60 * 60 * 1000;

/**
 * Forget agent `id` (its record moves aside for Undo). True when there
 * was one. Its files and the runtime's history stay.
 */
export function removeRecord(stateDir: string, id: string): boolean {
  const from = recordFile(stateDir, id);
  if (!fs.existsSync(from)) return false;
  ensureDir(removedDir(stateDir));
  const to = path.join(removedDir(stateDir), `${id}.json`);
  fs.renameSync(from, to);
  // Its mtime is when it was removed: purgeRemoved goes by it.
  const now = new Date();
  fs.utimesSync(to, now, now);
  return true;
}

/**
 * Bring a removed record back (Undo). False when there is none to bring
 * back, or an agent of that id exists again.
 */
export function restoreRecord(stateDir: string, id: string): boolean {
  if (!AGENT_ID_RE.test(id)) return false;
  const from = path.join(removedDir(stateDir), `${id}.json`);
  const to = recordFile(stateDir, id);
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  ensureDir(agentsDir(stateDir));
  fs.renameSync(from, to);
  return true;
}

/** Forget removed records older than `keepMs` for good. */
export function purgeRemoved(
  stateDir: string,
  keepMs = UNDO_KEEP_MS,
  now = Date.now(),
): void {
  let names: string[];
  try {
    names = fs.readdirSync(removedDir(stateDir));
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith(".json") || !AGENT_ID_RE.test(n.slice(0, -5))) continue;
    const f = path.join(removedDir(stateDir), n);
    try {
      if (now - fs.statSync(f).mtimeMs > keepMs) fs.unlinkSync(f);
    } catch {
      /* gone already */
    }
  }
}

export function listRecords(stateDir: string): AgentRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(agentsDir(stateDir));
  } catch {
    return [];
  }
  const out: AgentRecord[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".json")) continue;
    const rec = readRecord(stateDir, n.slice(0, -".json".length));
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Write a runtime's files, each 0600 and only inside `dir`: a runtime
 * names where in its own directory, never elsewhere.
 */
export function writeRuntimeFiles(
  dir: string,
  files: Record<string, string> | undefined,
): void {
  for (const [file, content] of Object.entries(files ?? {})) {
    const abs = path.resolve(file);
    if (!abs.startsWith(path.resolve(dir) + path.sep))
      throw new Error(`a runtime file must be inside ${dir}: ${file}`);
    writePrivate(abs, content);
  }
}
