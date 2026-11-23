/**
 * Issue 785, slice 1: a runtime's reported resume command, checked
 * strictly before Den ever runs it, and the newest report kept.
 *
 *   - the first word is a plain command found on PATH;
 *   - no apostrophes and no control characters;
 *   - at most 64 arguments and 8 KiB;
 *   - the working folder is part of its identity: a command reported for
 *     one folder never resumes in another;
 *   - a higher sequence replaces a lower one; an older or equal one is
 *     ignored.
 */
import { describe, expect, it } from "@jest/globals";
import {
  acceptResumeReport,
  RESUME_LIMITS,
  resumeCommandProblem,
  resumeCommandFor,
  type ResumeReport,
} from "../../../src/shared/agents/resume-command.js";

const PATH_ENV = "/opt/tools/bin:/usr/bin";
const onPath = new Set(["/opt/tools/bin/codex", "/usr/bin/gemini"]);
const deps = {
  pathEnv: PATH_ENV,
  isExecutable: (f: string) => onPath.has(f),
};
const report = (o: Partial<ResumeReport> = {}): ResumeReport => ({
  argv: ["codex", "resume", "019a-77"],
  cwd: "/work/north",
  seq: 1,
  ...o,
});

describe("issue 785: a reported resume command is checked strictly", () => {
  it("a plain command on PATH, in an absolute folder: no problem", () => {
    expect(resumeCommandProblem(report(), deps)).toBeNull();
    expect(
      resumeCommandProblem(
        report({ argv: ["gemini", "--resume", "latest"] }),
        deps,
      ),
    ).toBeNull();
  });

  it("the first word must be a plain command: no path, no shell", () => {
    for (const first of ["/opt/tools/bin/codex", "./codex", "sh -c", ""])
      expect(
        resumeCommandProblem(report({ argv: [first, "resume"] }), deps),
      ).toMatch(/not a plain command/);
  });

  it("the first word must be on PATH", () => {
    expect(
      resumeCommandProblem(report({ argv: ["grok", "--resume"] }), deps),
    ).toMatch(/grok is not on PATH/);
  });

  it("no apostrophes, in any word", () => {
    expect(
      resumeCommandProblem(report({ argv: ["codex", "resume", "it's"] }), deps),
    ).toMatch(/apostrophe/);
  });

  it("no control characters, in any word (newline, escape, NUL, DEL)", () => {
    for (const bad of ["a\nb", "a\u001b[31m", "a\u0000", "a\u007f"])
      expect(
        resumeCommandProblem(report({ argv: ["codex", bad] }), deps),
      ).toMatch(/control character/);
  });

  it(`at most ${RESUME_LIMITS.maxArgs} arguments`, () => {
    const at = ["codex", ...Array(RESUME_LIMITS.maxArgs).fill("x")];
    expect(resumeCommandProblem(report({ argv: at }), deps)).toBeNull();
    expect(resumeCommandProblem(report({ argv: [...at, "x"] }), deps)).toMatch(
      /more than 64 arguments/,
    );
  });

  it(`at most ${RESUME_LIMITS.maxBytes} bytes in all`, () => {
    // "codex" (5) + one space + the rest: exactly the limit, then one over.
    const fill = "y".repeat(RESUME_LIMITS.maxBytes - 6);
    expect(
      resumeCommandProblem(report({ argv: ["codex", fill] }), deps),
    ).toBeNull();
    expect(
      resumeCommandProblem(report({ argv: ["codex", fill + "y"] }), deps),
    ).toMatch(/over 8 KiB/);
    // Bytes, not characters: three-byte characters count three.
    const wide = "あ".repeat(Math.ceil((RESUME_LIMITS.maxBytes - 6) / 3) + 1);
    expect(
      resumeCommandProblem(report({ argv: ["codex", wide] }), deps),
    ).toMatch(/over 8 KiB/);
  });

  it("not a list of words, or an empty one: refused", () => {
    for (const argv of [[], "codex resume", [1, 2], null])
      expect(
        resumeCommandProblem(report({ argv: argv as never }), deps),
      ).toMatch(/a list of words/);
  });

  it("its folder must be absolute", () => {
    expect(resumeCommandProblem(report({ cwd: "work/north" }), deps)).toMatch(
      /folder/,
    );
  });

  it("its sequence must be a whole number above 0", () => {
    for (const seq of [0, -1, 1.5, NaN, "2" as never])
      expect(resumeCommandProblem(report({ seq }), deps)).toMatch(/sequence/);
  });
});

describe("issue 785: the newest report is kept", () => {
  it("a higher sequence replaces; an older or equal one is ignored", () => {
    const one = report({ seq: 4 });
    expect(acceptResumeReport(undefined, one)).toBe(true);
    expect(acceptResumeReport(one, report({ seq: 5 }))).toBe(true);
    expect(acceptResumeReport(one, report({ seq: 4 }))).toBe(false);
    expect(acceptResumeReport(one, report({ seq: 3 }))).toBe(false);
  });
});

describe("issue 785: the folder is part of its identity", () => {
  it("resumes only in the folder it was reported for", () => {
    expect(resumeCommandFor(report(), "/work/north", deps)).toEqual({
      argv: ["codex", "resume", "019a-77"],
    });
    // The same folder, written another way.
    expect(resumeCommandFor(report(), "/work/north/", deps)).toEqual({
      argv: ["codex", "resume", "019a-77"],
    });
    expect(resumeCommandFor(report(), "/work/south", deps)).toEqual({
      problem: expect.stringMatching(
        /reported for \/work\/north, not \/work\/south/,
      ),
    });
  });

  it("checked again when it runs: a command gone from PATH is refused", () => {
    expect(
      resumeCommandFor(report(), "/work/north", {
        ...deps,
        isExecutable: () => false,
      }),
    ).toEqual({ problem: expect.stringMatching(/codex is not on PATH/) });
  });

  it("none reported: says so", () => {
    expect(resumeCommandFor(undefined, "/work/north", deps)).toEqual({
      problem: "it reported no resume command",
    });
  });
});
