/**
 * Issue 707: doctor's row for the server's warning lines on disk (kept
 * while the server runs as a service): where the file is, how large it
 * is against its cap, and the Setting that sets the cap.
 */
import * as fs from "fs";
import * as path from "path";
import type { OnboardCheck } from "./doctor-onboard.js";

export interface ServerLogFacts {
  /** The file (shared/server-log-file.ts serverLogPath). */
  path: string;
  /** Its size now, or null when there is none yet. */
  bytes: number | null;
  /** server_log.max_mb now. */
  maxMb: number;
  /** The CLI's name, for the config line. */
  cli: string;
}

export function serverLogLines(
  title: string,
  f: ServerLogFacts,
): { lines: string[]; check: OnboardCheck } {
  const size =
    f.bytes === null
      ? `none yet, up to ${f.maxMb} MB`
      : `${(f.bytes / (1024 * 1024)).toFixed(1)} MB of ${f.maxMb} MB`;
  const detail = `${f.path}: ${size}, then it rotates once to ${path.basename(f.path)}.1 (warnings while ${title} runs as a service; ${f.cli} config server_log.max_mb=${f.maxMb})`;
  return {
    lines: [
      "",
      `${title} doctor: warnings log`,
      "",
      `  ✓  ${f.path}`,
      `     ${size}, then it rotates once to ${path.basename(f.path)}.1`,
      `     warnings while ${title} runs as a service; ${f.cli} config server_log.max_mb=${f.maxMb}`,
    ],
    check: { id: "server_log", status: "ok", detail },
  };
}

/** The facts for this install's state folder and user.yml. */
export function serverLogFacts(
  file: string,
  maxBytes: number,
  cli: string,
): ServerLogFacts {
  let bytes: number | null = null;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    /* none yet */
  }
  return { path: file, bytes, maxMb: maxBytes / (1024 * 1024), cli };
}
