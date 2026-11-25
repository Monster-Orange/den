import * as path from "path";

export interface ResumeReport {
  conversation: string;
  cwd: string;
  seq: number;
  at?: string;
}

export const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CONVERSATION_RULE =
  "its conversation id must be 1 to 128 letters, digits, '.', '_', ':' or '-', starting with a letter or digit";

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

export function resumeArgv(
  template: readonly string[],
  bin: string,
  conversation: string,
): string[] {
  return template.map((w, i) =>
    i === 0 ? bin : w === "{conversation}" ? conversation : w,
  );
}

export function conversationHeldElsewhere(
  rec: { id: string },
  conversation: string,
  records: readonly {
    id: string;
    resumeToken?: string;
    resumeReport?: { conversation?: unknown };
  }[],
): boolean {
  return records.some(
    (o) =>
      o.id !== rec.id &&
      (o.resumeReport?.conversation === conversation ||
        o.resumeToken === conversation),
  );
}

export function acceptResumeReport(
  prev: ResumeReport | undefined,
  next: ResumeReport,
): boolean {
  return !prev || next.seq > prev.seq;
}

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
