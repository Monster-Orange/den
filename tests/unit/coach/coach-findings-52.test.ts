/**
 * Issue 52, Coach slice T-b (TUNE-3): findings that need no judging, read
 * from a run's counts. Each names its agent, carries its evidence (the
 * numbers) and a proposal, and is never applied (no Apply in this phase).
 * Dismiss records the reason, and a dismissed finding stays out of the
 * open list on later runs. Thresholds are settings with permissive
 * defaults.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import type {
  CoachAgentRow,
  CoachReport,
} from "../../../src/shared/coach/breakdown.js";
import {
  coachFindings,
  dismissFinding,
  openFindings,
  readDismissals,
} from "../../../src/shared/coach/findings.js";
import {
  COACH_DEFAULTS,
  FINDING_DEFAULTS,
  checkCoachConfig,
} from "../../../src/shared/coach/settings.js";
import type { UsageMetrics } from "../../../src/shared/usage/report.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const state = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-coach-f-"));
  tmp.push(d);
  return d;
};

const METRICS: UsageMetrics = {
  calls: 100,
  cache_read_B: 0.1,
  output_M: 0.1,
  avg_context_k_main: 50,
  top15_share_pct: 0,
  reread_share_pct: 0,
  compactions: 0,
  polls: 0,
  denials: 0,
  tool_error_pct: 0,
  prompts: 10,
  correction_pct: 0,
  subagent_opus_pct: 0,
  long_session_context_k: 50,
  never_ending_reread_pct: 0,
};

function row(
  over: Partial<CoachAgentRow> = {},
  m: Partial<UsageMetrics> = {},
): CoachAgentRow {
  return {
    agent: "builder",
    workspace: "shop",
    persona: "builder",
    runtime: "den-claude",
    conversations: { inWindow: 1, total: 1, byWhy: { start: 1 } },
    transcripts: 1,
    metrics: { ...METRICS, ...m },
    perDay: {},
    models: { main: { "claude-opus-5-5": 100 }, subagent: {} },
    ...over,
  };
}

function report(rows: CoachAgentRow[]): CoachReport {
  return {
    version: 1,
    ranAt: "2026-11-22T12:00:00.000Z",
    window: {
      from: "2026-11-15T12:00:00.000Z",
      to: "2026-11-22T12:00:00.000Z",
      days: 7,
    },
    agents: rows,
    totals: METRICS,
    totalsPerDay: {},
    cost: { model: null, tokens: 0 },
  };
}

const kinds = (r: CoachReport) =>
  coachFindings(r, FINDING_DEFAULTS).map((f) => [f.kind, f.agent]);

describe("the counted findings", () => {
  it("a quiet agent has none", () => {
    expect(kinds(report([row()]))).toEqual([]);
  });

  it("subagents mostly on Opus, with enough calls to tell", () => {
    const busy = row(
      {
        models: {
          main: {},
          subagent: { "claude-opus-5-5": 40, "claude-sonnet-5-5": 10 },
        },
      },
      { subagent_opus_pct: 80 },
    );
    const few = row(
      {
        agent: "few",
        models: { main: {}, subagent: { "claude-opus-5-5": 3 } },
      },
      { subagent_opus_pct: 100 },
    );
    const f = coachFindings(report([busy, few]), FINDING_DEFAULTS);
    expect(f.map((x) => [x.kind, x.agent])).toEqual([
      ["subagent_opus", "builder"],
    ]);
    expect(f[0].evidence).toEqual({
      subagent_opus_pct: 80,
      subagent_calls: 50,
    });
    expect(f[0].proposal).toMatch(/subagent_model/);
  });

  it("polling, per day", () => {
    expect(kinds(report([row({ perDay: { polls_per_day: 30 } })]))).toEqual([
      ["polling", "builder"],
    ]);
    expect(kinds(report([row({ perDay: { polls_per_day: 5 } })]))).toEqual([]);
  });

  it("past its rotation limit without rotating", () => {
    expect(
      kinds(report([row({ current: { compactions: 5, after: 3 } })])),
    ).toEqual([["no_rotation", "builder"]]);
    expect(
      kinds(report([row({ current: { compactions: 3, after: 3 } })])),
    ).toEqual([]);
    // after 0: it never rotates, by its own setting.
    expect(
      kinds(report([row({ current: { compactions: 9, after: 0 } })])),
    ).toEqual([]);
  });

  it("repeated denials, per day", () => {
    expect(kinds(report([row({ perDay: { denials_per_day: 8 } })]))).toEqual([
      ["denials", "builder"],
    ]);
  });

  it("a transcript over the size limit", () => {
    expect(
      kinds(report([row({ transcriptBytes: 2 * 1024 * 1024 * 1024 })])),
    ).toEqual([["transcript_size", "builder"]]);
  });

  it("an agent with no numbers has none", () => {
    expect(
      kinds(
        report([
          row({ metrics: undefined, why: "no conversation in the window" }),
        ]),
      ),
    ).toEqual([]);
  });

  it("each has a stable id, a plain title, and names the window", () => {
    const f = coachFindings(
      report([row({ perDay: { polls_per_day: 30 } })]),
      FINDING_DEFAULTS,
    )[0];
    expect(f.id).toBe("polling:builder");
    expect(f.title).toBe("builder (shop) polls 30 times a day.");
    expect(f.window).toEqual({
      from: "2026-11-15T12:00:00.000Z",
      to: "2026-11-22T12:00:00.000Z",
      days: 7,
    });
  });

  it("thresholds come from the settings", () => {
    const strict = { ...FINDING_DEFAULTS, polls_per_day: 3 };
    expect(
      coachFindings(
        report([row({ perDay: { polls_per_day: 5 } })]),
        strict,
      ).map((f) => f.kind),
    ).toEqual(["polling"]);
  });
});

describe("Dismiss", () => {
  it("records the reason, who and when; the finding leaves the open list for good", () => {
    const st = state();
    const r = report([row({ perDay: { polls_per_day: 30 } })]);
    const all = coachFindings(r, FINDING_DEFAULTS);
    expect(openFindings(st, all)).toHaveLength(1);
    const d = dismissFinding(
      st,
      "polling:builder",
      "It waits on CI by design.",
      "person",
      "2026-11-22T13:00:00.000Z",
    );
    expect(d).toEqual({ ok: true });
    expect(readDismissals(st)).toEqual([
      {
        id: "polling:builder",
        reason: "It waits on CI by design.",
        by: "person",
        at: "2026-11-22T13:00:00.000Z",
      },
    ]);
    expect(openFindings(st, all)).toEqual([]);
    expect(
      fs.statSync(path.join(st, "coach", "dismissed.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("needs a finding id of the right shape; a reason is kept to 500 characters (mock v4 asks none)", () => {
    const st = state();
    expect(dismissFinding(st, "../x", "why", "person")).toMatchObject({
      ok: false,
      code: "bad_id",
    });
    expect(
      dismissFinding(st, "polling:builder", "x".repeat(501), "person"),
    ).toMatchObject({ ok: false, code: "reason_too_long" });
    expect(readDismissals(st)).toEqual([]);
  });

  it("a second dismissal of the same finding replaces the first", () => {
    const st = state();
    dismissFinding(
      st,
      "polling:builder",
      "one",
      "person",
      "2026-11-22T13:00:00.000Z",
    );
    dismissFinding(
      st,
      "polling:builder",
      "two",
      "person",
      "2026-11-22T14:00:00.000Z",
    );
    expect(readDismissals(st).map((d) => d.reason)).toEqual(["two"]);
  });
});

describe("agents.coach.findings settings", () => {
  it("default to permissive thresholds", () => {
    expect(FINDING_DEFAULTS).toEqual({
      subagent_opus_pct: 50,
      min_subagent_calls: 20,
      polls_per_day: 20,
      denials_per_day: 5,
      transcript_mb: 1024,
      // Slice T-c: asks and agent messages.
      ask_r12_pass_pct: 80,
      min_asks: 3,
      ask_wait_min: 240,
      sends_repeated: 3,
      sends_no_reply_pct: 50,
      min_sends: 5,
      sentence_words: 25,
    });
    expect(checkCoachConfig(undefined).findings).toEqual(FINDING_DEFAULTS);
    expect(COACH_DEFAULTS.findings).toEqual(FINDING_DEFAULTS);
  });

  it("take a partial map, and refuse a bad or unknown one, naming the key", () => {
    expect(
      checkCoachConfig({ findings: { polls_per_day: 50 } }).findings
        .polls_per_day,
    ).toBe(50);
    expect(() => checkCoachConfig({ findings: { polls_per_day: -1 } })).toThrow(
      /agents\.coach\.findings\.polls_per_day/,
    );
    expect(() => checkCoachConfig({ findings: { pols: 1 } })).toThrow(
      /agents\.coach\.findings\.pols/,
    );
    expect(() => checkCoachConfig({ findings: 3 })).toThrow(
      /agents\.coach\.findings/,
    );
  });
});
