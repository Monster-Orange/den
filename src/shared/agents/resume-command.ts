/**
 * Issue 785: the resume command a runtime reports for its agent, checked
 * strictly before Den ever runs it.
 *
 * Any runtime (Codex, Gemini, Grok, Claude) can say how to continue its
 * conversation: a list of words, the folder it was reported in, and a
 * rising sequence number, so Den keeps only the newest. Den never runs it
 * through a shell, and refuses one that breaks any rule below; a refused
 * one is logged and the agent starts fresh, with a note saying why.
 */
import * as path from "path";
import { findOnPath } from "../cli-command.js";

/** One report: what to run, where, and its place in the sequence. */
export interface ResumeReport {
  /** The command's words: the first is a plain command on PATH. */
  argv: string[];
  /** The folder it was reported in: it resumes there and nowhere else. */
  cwd: string;
  /** Rising per agent: a higher one replaces a lower one. */
  seq: number;
  /** When Den took it (ISO 8601). */
  at?: string;
}

/** The limits a reported command must keep within. */
export const RESUME_LIMITS = { maxArgs: 64, maxBytes: 8 * 1024 };

/** Where to look for its first word. */
export interface ResumeCommandDeps {
  pathEnv: string;
  isExecutable?: (file: string) => boolean;
}

/** A plain command: a name, no folder, no shell syntax. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * What is wrong with `r`, in words, or null when Den may run it. The
 * arguments count after the command (at most 64); the size is every word
 * in UTF-8 with a space between (at most 8 KiB).
 */
export function resumeCommandProblem(
  r: ResumeReport,
  deps: ResumeCommandDeps,
): string | null {
  const argv = r.argv as unknown;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((w) => typeof w === "string")
  )
    return "the resume command must be a list of words";
  const words = argv as string[];
  if (!Number.isSafeInteger(r.seq) || r.seq < 1)
    return "its sequence must be a whole number above 0";
  if (typeof r.cwd !== "string" || !path.isAbsolute(r.cwd))
    return "its folder must be an absolute path";
  for (const w of words) {
    if (w.includes("'")) return "a word has an apostrophe";
    if (CONTROL.test(w)) return "a word has a control character";
  }
  if (words.length - 1 > RESUME_LIMITS.maxArgs)
    return `it has more than ${RESUME_LIMITS.maxArgs} arguments`;
  if (Buffer.byteLength(words.join(" "), "utf8") > RESUME_LIMITS.maxBytes)
    return `it is over ${RESUME_LIMITS.maxBytes / 1024} KiB`;
  const first = words[0]!;
  if (!PLAIN.test(first))
    return `${JSON.stringify(first)} is not a plain command`;
  if (!findOnPath(first, deps.pathEnv, deps.isExecutable))
    return `${first} is not on PATH`;
  return null;
}

/** True when `next` should replace `prev`: a higher sequence, or none yet. */
export function acceptResumeReport(
  prev: ResumeReport | undefined,
  next: ResumeReport,
): boolean {
  return !prev || next.seq > prev.seq;
}

/**
 * The command to resume an agent working in `cwd` with: its report's
 * words, checked again now (PATH can change), and only when the report
 * was made in that same folder. Else why not.
 */
export function resumeCommandFor(
  r: ResumeReport | undefined,
  cwd: string,
  deps: ResumeCommandDeps,
): { argv: string[] } | { problem: string } {
  if (!r) return { problem: "it reported no resume command" };
  const problem = resumeCommandProblem(r, deps);
  if (problem) return { problem };
  if (path.resolve(r.cwd) !== path.resolve(cwd))
    return {
      problem: `its resume command was reported for ${path.resolve(r.cwd)}, not ${path.resolve(cwd)}`,
    };
  return { argv: [...r.argv] };
}
