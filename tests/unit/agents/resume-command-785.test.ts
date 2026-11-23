/**
 * Issue 785: an agent reports only its conversation's id (with the folder
 * and a rising sequence); Den builds the resume command itself from its
 * runtime's own template and the binary it already launches for it. So
 * nothing an agent writes reaches its startup command but that one id,
 * held to a strict pattern: no flag, no space, no quote, no slash.
 */
import { describe, expect, it } from "@jest/globals";
import {
  acceptResumeReport,
  resumeArgv,
  resumeCommandFor,
  resumeReportProblem,
  resumeTemplateProblem,
  type ResumeReport,
} from "../../../src/shared/agents/resume-command.js";

const CODEX = ["{bin}", "resume", "{conversation}"];
const BIN = "/opt/tools/bin/codex";
const report = (o: Partial<ResumeReport> = {}): ResumeReport => ({
  conversation: "019a-77f2.c:1_x",
  cwd: "/work/north",
  seq: 1,
  ...o,
});

describe("issue 785: what an agent may report", () => {
  it("an id of letters, digits and . _ : -, starting with a letter or digit", () => {
    expect(resumeReportProblem(report())).toBeNull();
    expect(resumeReportProblem(report({ conversation: "a" }))).toBeNull();
    expect(
      resumeReportProblem(report({ conversation: "a".repeat(128) })),
    ).toBeNull();
  });

  it("refused: a space, a quote, a slash, a control character, a shell sign", () => {
    for (const conversation of [
      "a b",
      "it's",
      'a"b',
      "a/b",
      "..\\b",
      "a\nb",
      "a\u001b[31m",
      "a\u0000",
      "a;rm",
      "$(id)",
      "a`b`",
      "a|b",
    ])
      expect(resumeReportProblem(report({ conversation }))).toMatch(
        /conversation id must be/,
      );
  });

  it("refused: an id that would read as a flag, or is empty or too long", () => {
    for (const conversation of [
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "-",
      "+x",
      "+",
      ".hidden",
      "",
      "a".repeat(129),
    ])
      expect(resumeReportProblem(report({ conversation }))).toMatch(
        /conversation id must be/,
      );
  });

  it("refused: words in place of an id (a command, a list)", () => {
    for (const conversation of [["codex", "resume"], 7, null, undefined])
      expect(
        resumeReportProblem(report({ conversation: conversation as never })),
      ).toMatch(/conversation id must be/);
  });

  it("its folder must be absolute; its sequence a whole number above 0", () => {
    expect(resumeReportProblem(report({ cwd: "work/north" }))).toMatch(
      /folder/,
    );
    for (const seq of [0, -1, 1.5, NaN, "2" as never])
      expect(resumeReportProblem(report({ seq }))).toMatch(/sequence/);
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

describe("issue 785: Den builds the command from its runtime's template", () => {
  it("the runtime's binary first, the id in its one slot, nothing else", () => {
    expect(resumeArgv(CODEX, BIN, "019a")).toEqual([BIN, "resume", "019a"]);
  });

  it("a template: {bin} first, exactly one {conversation} on its own", () => {
    expect(resumeTemplateProblem(CODEX)).toBeNull();
    expect(
      resumeTemplateProblem(["{bin}", "--resume", "{conversation}"]),
    ).toBeNull();
    for (const bad of [
      ["codex", "resume", "{conversation}"],
      ["{bin}", "resume"],
      ["{bin}", "{conversation}", "{conversation}"],
      ["{bin}", "--id={conversation}"],
      [],
    ])
      expect(resumeTemplateProblem(bad)).not.toBeNull();
  });

  it("resumes only in the folder it was reported for", () => {
    expect(resumeCommandFor(report(), "/work/north", CODEX, BIN)).toEqual({
      argv: [BIN, "resume", "019a-77f2.c:1_x"],
    });
    expect(resumeCommandFor(report(), "/work/north/", CODEX, BIN)).toEqual({
      argv: [BIN, "resume", "019a-77f2.c:1_x"],
    });
    expect(resumeCommandFor(report(), "/work/south", CODEX, BIN)).toEqual({
      problem: expect.stringMatching(
        /reported for \/work\/north, not \/work\/south/,
      ),
    });
  });

  it("whatever was reported, the command is the template's: a bad id is refused, never passed", () => {
    for (const conversation of ["--yolo", "x --yolo", "bash -c id"]) {
      const got = resumeCommandFor(
        report({ conversation }),
        "/work/north",
        CODEX,
        BIN,
      );
      expect(got).toEqual({
        problem: expect.stringMatching(/conversation id must be/),
      });
    }
  });

  it("none reported, or no template: says so", () => {
    expect(resumeCommandFor(undefined, "/work/north", CODEX, BIN)).toEqual({
      problem: "it reported no conversation to resume",
    });
    expect(resumeCommandFor(report(), "/work/north", undefined, BIN)).toEqual({
      problem: "its runtime has no resume command",
    });
  });
});

describe("issue 785: a catalog entry's resume template", () => {
  it("Codex and Gemini declare one; Grok none (it can't resume)", async () => {
    const { BUILTIN_CATALOG } =
      await import("../../../src/shared/agents/catalog.js");
    const of = (id: string) => BUILTIN_CATALOG.find((e) => e.id === id);
    // Codex's notify is Den's report command (codex-notify-785.test.ts).
    expect(of("codex")?.resume).toEqual({
      argv: ["{bin}", "-c", "notify={report}", "resume", "{conversation}"],
    });
    // Gemini's id is Den's own (gemini-den-conversation-785.test.ts).
    expect(of("gemini")?.resume).toEqual({
      argv: ["{bin}", "--resume", "{conversation}"],
      conversation: "den",
      start: ["--session-id", "{conversation}"],
    });
    expect(of("grok")?.resume).toBeUndefined();
    for (const e of BUILTIN_CATALOG)
      if (e.resume) expect(resumeTemplateProblem(e.resume.argv)).toBeNull();
  });

  it("an added entry's template is held to the same rules", async () => {
    const { validateCatalog } =
      await import("../../../src/shared/agents/catalog.js");
    const entry = (resume: unknown) => ({
      id: "acme-cli",
      vendor: "Acme",
      name: "Acme CLI",
      bins: ["acme"],
      version: { args: ["--version"], identity: { output: "acme" } },
      dirs: [],
      launch: { argv: ["{bin}"] },
      resume,
    });
    expect(
      validateCatalog(
        [entry({ argv: ["{bin}", "resume", "{conversation}"] })],
        "t",
      )[0]?.resume,
    ).toEqual({ argv: ["{bin}", "resume", "{conversation}"] });
    for (const bad of [
      { argv: ["sh", "-c", "{conversation}"] },
      { argv: ["{bin}", "--id={conversation}"] },
      { argv: ["{bin}", "resume"] },
      { argv: ["{bin}", "{conversation}"], extra: 1 },
    ])
      expect(() => validateCatalog([entry(bad)], "t")).toThrow(/resume/);
  });

  it("a template keeps every word its launch has: a resume is never wider than a launch", async () => {
    const { validateCatalog } =
      await import("../../../src/shared/agents/catalog.js");
    const entry = (launch: string[], resume: string[]) => ({
      id: "acme-cli",
      vendor: "Acme",
      name: "Acme CLI",
      bins: ["acme"],
      version: { args: ["--version"], identity: { output: "acme" } },
      dirs: [],
      launch: { argv: launch },
      resume: { argv: resume },
    });
    expect(() =>
      validateCatalog(
        [
          entry(
            ["{bin}", "--sandbox", "read-only"],
            ["{bin}", "resume", "{conversation}"],
          ),
        ],
        "t",
      ),
    ).toThrow(/keeps every word of launch.argv/);
    expect(
      validateCatalog(
        [
          entry(
            ["{bin}", "--sandbox", "read-only"],
            ["{bin}", "--sandbox", "read-only", "resume", "{conversation}"],
          ),
        ],
        "t",
      )[0]?.resume?.argv,
    ).toEqual(["{bin}", "--sandbox", "read-only", "resume", "{conversation}"]);
  });
});
