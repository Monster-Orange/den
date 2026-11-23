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
import { writeFileAtomic } from "../atomic-write.js";

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
/**
 * Issue 441: each imported environment's newest import, by run id, in
 * <state>/verify/<project>/imports.json. Kept on import and remove, so the
 * overview reads an old import (or learns there is none) without a scan.
 */
function pointersFile(stateDir: string, project: string): string {
  return path.join(path.dirname(runsDir(stateDir, project)), "imports.json");
}

function readPointers(
  stateDir: string,
  project: string,
): Record<string, string> {
  try {
    const v: unknown = JSON.parse(
      fs.readFileSync(pointersFile(stateDir, project), "utf-8"),
    );
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writePointers(
  stateDir: string,
  project: string,
  all: Record<string, string>,
): void {
  const file = pointersFile(stateDir, project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(all, null, 2) + "\n");
}

export function writeRunRecord(stateDir: string, rec: RunRecord): void {
  if (!RUN_RE.test(rec.runId))
    throw new Error(`"${rec.runId}" is not a run's id`);
  const dir = path.join(runsDir(stateDir, rec.project), rec.runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "run.json");
  writeFileAtomic(file, JSON.stringify(rec, null, 2) + "\n");
  if (rec.source !== "import") return;
  const ptr = readPointers(stateDir, rec.project);
  const cur = ptr[rec.env];
  const was =
    cur && cur !== rec.runId ? readRunRecord(stateDir, rec.project, cur) : null;
  if (!was || rec.endedAt >= was.endedAt) {
    ptr[rec.env] = rec.runId;
    writePointers(stateDir, rec.project, ptr);
  }
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
  const rec = readRunRecord(stateDir, project, runId);
  fs.rmSync(dir, { recursive: true, force: true });
  const ptr = readPointers(stateDir, project);
  if (rec?.source === "import" && ptr[rec.env] === runId) {
    // The next newest import there (a scan, on a remove only), or none.
    const next = listRunRecords(
      stateDir,
      project,
      Number.MAX_SAFE_INTEGER,
    ).find((r) => r.env === rec.env && r.source === "import");
    if (next) ptr[rec.env] = next.runId;
    else delete ptr[rec.env];
    writePointers(stateDir, project, ptr);
  }
  return true;
}

/**
 * Issue 441: the overview's runs without parsing every record: the newest
 * `limit` by when their files were written (a stat, not a parse), newest
 * first by endedAt, then each of `imported`'s newest import through its
 * pointer when the limit hides it (an import can be megabytes). `read`
 * counts the records parsed: at most `limit` + imported.length.
 */
export function recentRuns(
  stateDir: string,
  project: string,
  limit: number,
  imported: readonly string[],
): { runs: RunRecord[]; read: number } {
  const dir = runsDir(stateDir, project);
  let ids: string[];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return { runs: [], read: 0 };
  }
  const byTime = ids
    .map((id) => {
      try {
        return { id, at: fs.statSync(path.join(dir, id, "run.json")).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { id: string; at: number } => x !== null)
    .sort((a, b) => b.at - a.at);
  const top: RunRecord[] = [];
  let read = 0;
  for (const { id } of byTime) {
    if (top.length >= limit) break;
    const rec = readRunRecord(stateDir, project, id);
    read++;
    if (rec) top.push(rec);
  }
  top.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  const ptr = readPointers(stateDir, project);
  for (const env of imported) {
    const id = ptr[env];
    if (!id || top.some((r) => r.runId === id)) continue;
    const rec = readRunRecord(stateDir, project, id);
    read++;
    if (rec) top.push(rec);
  }
  return { runs: top, read };
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
