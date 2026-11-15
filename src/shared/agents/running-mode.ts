/**
 * Drill (b), 0.4.48: the mode an agent actually runs in, read from its own
 * process (`--permission-mode <mode>` on its command line), not from its
 * record. A record can say one mode while the process was started in
 * another (it was written later, or by an older Den); the record alone
 * then hides the drift, and MODE-2 never applies the change.
 *
 * Only the mode is read: the command line is never kept, logged or
 * returned. Unknown (another runtime, no such flag, the process gone, no
 * `ps`): undefined, and callers fall back to the record.
 */
import { spawnSync } from "child_process";
import { intentOf, type PermissionIntent } from "./permissions.js";

/** A process's command line, or null (the seam tests replace). */
export type CommandLineOf = (pid: number) => string | null;

export const psCommandLine: CommandLineOf = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return r.status === 0 ? (r.stdout ?? "").trim() || null : null;
  } catch {
    return null;
  }
};

/** The intent a command line runs in, or undefined when it doesn't say. */
export function intentOfCommandLine(
  line: string | null,
): PermissionIntent | undefined {
  if (!line) return undefined;
  if (/(^|\s)--dangerously-skip-permissions(\s|$)/.test(line)) return "all";
  const m = /(?:^|\s)--permission-mode(?:=|\s+)([A-Za-z]+)(?:\s|$)/.exec(line);
  return m ? intentOf(m[1]) : undefined;
}

/**
 * The mode the process `pid` runs in, or undefined when unknown. Only a
 * command line that names the agent's own conversation (`token`, its
 * record's resumeToken) counts: a pid reused by another process, or a
 * session's pid that isn't the runtime itself, says nothing.
 */
export function runningIntent(
  pid: number,
  token: string | undefined,
  commandLineOf: CommandLineOf = psCommandLine,
): PermissionIntent | undefined {
  if (!token) return undefined;
  const line = commandLineOf(pid);
  if (!line || !line.split(/\s+/).includes(token)) return undefined;
  return intentOfCommandLine(line);
}
