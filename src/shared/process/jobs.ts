/**
 * 0.4.48: the jobs an agent left running after its turn ended (a gate it
 * started in the background, a dev server). Den's "after its turn" waits
 * for them too: a restart must never kill a running gate.
 *
 * A job is a process under the agent's session whose command the runtime
 * names as its own command shell (Runtime.jobPattern); its MCP servers and
 * anything else under it are not. Read from `ps` once per look.
 */
import { execFileSync } from "child_process";

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Every process on this machine: pid, parent and command. [] when ps fails. */
export function readProcesses(): ProcessRow[] {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 5_000,
    });
    const rows: ProcessRow[] = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) rows.push({ pid: +m[1], ppid: +m[2], command: m[3] });
    }
    return rows;
  } catch {
    return [];
  }
}

/** The processes under `root` (not itself) whose command matches `job`. */
export function jobsUnder(
  root: number,
  job: RegExp,
  rows: readonly ProcessRow[],
): ProcessRow[] {
  const kids = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    const k = kids.get(r.ppid);
    if (k) k.push(r);
    else kids.set(r.ppid, [r]);
  }
  const out: ProcessRow[] = [];
  const seen = new Set<number>([root]);
  const todo = [root];
  while (todo.length) {
    for (const r of kids.get(todo.pop()!) ?? []) {
      if (seen.has(r.pid)) continue;
      seen.add(r.pid);
      if (job.test(r.command)) out.push(r);
      todo.push(r.pid);
    }
  }
  return out;
}
