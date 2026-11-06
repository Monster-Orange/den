/**
 * The agent record (AG-2a): what an agent is and where it runs, kept in the
 * distribution's state dir so the CLI and the web server (AG-4a) see the
 * same agents, and so an agent outlives the session it runs in.
 *
 *   agents/<id>.json        the record (0600, its directory 0700)
 *   agent-files/<id>/       files its runtime wrote (0600): its MCP config
 *
 * A record never holds the env or the argv: the role prompt, tokens and
 * anything else a launch passes stay out of it. An agent id is unique in a
 * distribution.
 */
import * as fs from "fs";
import * as path from "path";
import { WORKSPACE_NAME_RE } from "../agent-actor.js";
import type { SessionRef } from "../sessions/types.js";

export interface AgentRecord {
  id: string;
  persona: string;
  runtime: string;
  model?: string;
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
}

/** An agent id: the same rules as a workspace or session name. */
export const AGENT_ID_RE = WORKSPACE_NAME_RE;

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
