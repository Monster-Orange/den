/**
 * Issue 785: resuming a runtime other than Claude (Codex, Gemini) from the
 * conversation its agent reported.
 *
 * The agent reports only its conversation's id, the folder it works in,
 * and a rising sequence (the newest is kept). Den builds the command
 * itself: the runtime's own template (its catalog entry's `resume.argv`)
 * with the binary Den already launches for it and the id in the one
 * `{conversation}` slot. So nothing an agent writes reaches its startup command
 * but that one id, and the id is held to a pattern no flag, space, quote,
 * slash or shell sign gets through: an agent can never widen the mode it
 * runs in by what it reports. Den never runs it through a shell.
 */
import * as path from "path";

/** One report: the conversation to resume, where, and its place in line. */
export interface ResumeReport {
  /** The runtime's own id for the conversation. */
  conversation: string;
  /** The folder it was reported in: it resumes there and nowhere else. */
  cwd: string;
  /** Rising per agent: a higher one replaces a lower one. */
  seq: number;
  /** When Den took it (ISO 8601). */
  at?: string;
}

/**
 * A conversation id: a letter or digit first (so it never reads as a flag or a
 * hidden name), then up to 127 letters, digits and . _ : -.
 */
export const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CONVERSATION_RULE =
  "its conversation id must be 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit";

/** What is wrong with a report, in words, or null when Den may keep it. */
export function resumeReportProblem(r: ResumeReport): string | null {
  if (
    typeof r.conversation !== "string" ||
    !CONVERSATION_ID.test(r.conversation)
  )
    return CONVERSATION_RULE;
  if (typeof r.cwd !== "string" || !path.isAbsolute(r.cwd))
    return "its folder must be an absolute path";
  if (!Number.isSafeInteger(r.seq) || r.seq < 1)
    return "its sequence must be a whole number above 0";
  return null;
}

/**
 * What is wrong with a runtime's resume template, or null: "{bin}" first
 * (the binary Den launches for that runtime), exactly one "{conversation}"
 * standing alone, no other word naming it, at most 16 words.
 */
export function resumeTemplateProblem(argv: readonly string[]): string | null {
  if (!argv.length || argv.length > 16)
    return "a resume template has 1 to 16 words";
  if (argv[0] !== "{bin}") return 'a resume template starts with "{bin}"';
  const slots = argv.filter((w) => w.includes("{conversation}"));
  if (slots.length !== 1 || !argv.includes("{conversation}"))
    return 'a resume template has exactly one "{conversation}", a word of its own';
  if (argv.slice(1).some((w) => w.includes("{bin}")))
    return 'a resume template names "{bin}" only first';
  return null;
}

/** The template's words: the binary first, the id in its slot. */
export function resumeArgv(
  template: readonly string[],
  bin: string,
  conversation: string,
): string[] {
  return template.map((w, i) =>
    i === 0 ? bin : w === "{conversation}" ? conversation : w,
  );
}

/** True when `next` should replace `prev`: a higher sequence, or none yet. */
export function acceptResumeReport(
  prev: ResumeReport | undefined,
  next: ResumeReport,
): boolean {
  return !prev || next.seq > prev.seq;
}

/**
 * The command to resume an agent working in `cwd` with, from its runtime's
 * `template` and `bin`: only when its report passes (checked again now)
 * and was made in that same folder. Else why not.
 */
export function resumeCommandFor(
  r: ResumeReport | undefined,
  cwd: string,
  template: readonly string[] | undefined,
  bin: string,
): { argv: string[] } | { problem: string } {
  if (!template || resumeTemplateProblem(template))
    return { problem: "its runtime has no resume command" };
  if (!r) return { problem: "it reported no conversation to resume" };
  const problem = resumeReportProblem(r);
  if (problem) return { problem };
  if (path.resolve(r.cwd) !== path.resolve(cwd))
    return {
      problem: `its conversation was reported for ${path.resolve(r.cwd)}, not ${path.resolve(cwd)}`,
    };
  return { argv: resumeArgv(template, bin, r.conversation) };
}
