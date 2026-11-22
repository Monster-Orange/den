/**
 * Issue 209: each Verify run, kept so the page can say what happened and
 * who did it (VERIFY-SPEC section 8).
 *
 *   <state>/verify/<project>/runs/<runId>/run.json
 *
 * A record holds the run's verdict, each module's state and first failure
 * line, the last lines of each command's output (the report the page
 * opens), who started the run and who allowed it. Records are pointers'
 * targets, never copied into anything else.
 */
import * as fs from "fs";
import * as path from "path";
import type { ClauseRecord } from "./imports.js";
import type { ModuleRun, RunResult } from "./run.js";

/** Who did something to a run. */
export interface RunActor {
  /** Issue 441: "runner", an outside runner whose results were imported. */
  kind: "agent" | "person" | "den" | "runner";
  /** An agent's name; a person's is never stored here. */
  name?: string;
}

export interface ModuleRecord extends ModuleRun {
  /** The last lines of its command's output (its report). */
  tail?: string[];
  /** Issue 441: an imported gate check's clauses, in the runner's order. */
  clauses?: ClauseRecord[];
}

export interface RunRecord {
  runId: string;
  project: string;
  env: string;
  scope: string;
  verdict: RunResult["verdict"];
  exitCode: number;
  reason?: RunResult["reason"];
  /** ISO times. */
  startedAt: string;
  endedAt: string;
  startedBy?: RunActor;
  allowedBy?: RunActor;
  /** Issue 441: "import", a run an outside runner's results made. */
  source?: "import";
  /** Issue 214: a schedule's run, and which schedule. */
  trigger?: "schedule";
  schedule?: string;
  /** The commit the run checked (the first repo's), when known. */
  commit?: string | null;
  modules: ModuleRecord[];
}

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function runsDir(stateDir: string, project: string): string {
  if (!PROJECT_RE.test(project))
    throw new Error(`"${project}" is not a project's name`);
  return path.join(stateDir, "verify", project, "runs");
}

/** Keeps a run's record (replacing one with the same id). */
export function writeRunRecord(stateDir: string, rec: RunRecord): void {
  if (!RUN_RE.test(rec.runId))
    throw new Error(`"${rec.runId}" is not a run's id`);
  const dir = path.join(runsDir(stateDir, rec.project), rec.runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** One run's record, or null (no such run, or not one of ours). */
export function readRunRecord(
  stateDir: string,
  project: string,
  runId: string,
): RunRecord | null {
  if (!RUN_RE.test(runId)) return null;
  try {
    const v: unknown = JSON.parse(
      fs.readFileSync(
        path.join(runsDir(stateDir, project), runId, "run.json"),
        "utf-8",
      ),
    );
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as RunRecord)
      : null;
  } catch {
    return null;
  }
}

/** Issue 441: removes a run's record and its folder; false when there is none. */
export function removeRunRecord(
  stateDir: string,
  project: string,
  runId: string,
): boolean {
  if (!RUN_RE.test(runId)) return false;
  const dir = path.join(runsDir(stateDir, project), runId);
  if (!fs.existsSync(path.join(dir, "run.json"))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The project's runs, newest first (at most `limit`). */
export function listRunRecords(
  stateDir: string,
  project: string,
  limit = 50,
): RunRecord[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(runsDir(stateDir, project));
  } catch {
    return [];
  }
  return ids
    .map((id) => readRunRecord(stateDir, project, id))
    .filter((r): r is RunRecord => r !== null)
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
    .slice(0, Math.max(0, limit));
}
