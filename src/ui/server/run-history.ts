/**
 * The server's test-run history (0.4.17): every `/api/run` from every
 * browser, kept in `<state>/run-history.jsonl`, one JSON line per start and
 * one per end. Workspaces' "Last test run" column reads each repo's latest
 * from it, so it fills in whoever ran it and survives a restart.
 *
 * The file is bounded: past MAX_LINES it keeps the newest KEEP_LINES.
 * Never throws: a history it can't read or write is an empty one.
 */
import * as fs from "fs";
import * as path from "path";

/** One test run, as its lines describe it. */
export interface RunEntry {
  id: string;
  pillar: string;
  env: string;
  /** The repos it tested (the pillar's sources), when known. */
  repos: string[];
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
}

type Line =
  | {
      t: "start";
      id: string;
      pillar: string;
      env: string;
      repos: string[];
      at: string;
    }
  | { t: "end"; id: string; at: string; exitCode: number };

export const MAX_LINES = 2000;
export const KEEP_LINES = 1000;

export function runHistoryFile(stateDir: string): string {
  return path.join(stateDir, "run-history.jsonl");
}

function append(stateDir: string, line: Line): void {
  const file = runHistoryFile(stateDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    const text = fs.readFileSync(file, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${lines.slice(-KEEP_LINES).join("\n")}\n`, {
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
    }
  } catch {
    /* no history: the column says "—" */
  }
}

/** A run began: its pillar, environment and the repos it tests. */
export function recordRunStart(
  stateDir: string,
  run: { id: string; pillar: string; env: string; repos: string[] },
  now = new Date(),
): void {
  append(stateDir, { t: "start", ...run, at: now.toISOString() });
}

/** A run ended with `exitCode`. */
export function recordRunEnd(
  stateDir: string,
  id: string,
  exitCode: number,
  now = new Date(),
): void {
  append(stateDir, { t: "end", id, at: now.toISOString(), exitCode });
}

/** Every run in the file, oldest first. */
export function readRuns(stateDir: string): RunEntry[] {
  let text = "";
  try {
    text = fs.readFileSync(runHistoryFile(stateDir), "utf-8");
  } catch {
    return [];
  }
  const byId = new Map<string, RunEntry>();
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let l: Partial<Line> & Record<string, unknown>;
    try {
      l = JSON.parse(raw) as typeof l;
    } catch {
      continue;
    }
    if (typeof l.id !== "string" || typeof l.at !== "string") continue;
    if (l.t === "start") {
      byId.set(l.id, {
        id: l.id,
        pillar: String(l.pillar ?? ""),
        env: String(l.env ?? ""),
        repos: Array.isArray(l.repos) ? l.repos.map(String) : [],
        startedAt: l.at,
      });
    } else if (l.t === "end") {
      const r = byId.get(l.id);
      if (r) {
        r.endedAt = l.at;
        r.exitCode = typeof l.exitCode === "number" ? l.exitCode : 1;
      }
    }
  }
  return [...byId.values()];
}

/**
 * Each repo's latest run. A run that never ended counts as running only
 * while this server runs it (`live`); one a restart cut off has no end and
 * is skipped for an earlier one.
 */
export function lastRunsByRepo(
  stateDir: string,
  live: ReadonlySet<string> = new Set(),
): Record<string, RunEntry & { running: boolean }> {
  const out: Record<string, RunEntry & { running: boolean }> = {};
  for (const r of readRuns(stateDir)) {
    const running = r.endedAt === undefined && live.has(r.id);
    if (r.endedAt === undefined && !running) continue;
    for (const repo of r.repos) {
      const cur = out[repo];
      if (!cur || cur.startedAt <= r.startedAt) out[repo] = { ...r, running };
    }
  }
  return out;
}
