/**
 * Issue 110 (Coach Apply), slice 1: a counted finding carries its proposal
 * as a held write: the action and the args a person's Apply asks
 * POST /api/approvals to hold. Nothing changes until the person allows it
 * in the approval dialog, as any held write. In this slice, a subagents-on-
 * Opus finding proposes persona_update (subagentModel: sonnet) on the
 * agent's persona in its project. The other kinds have no Apply yet.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type {
  CoachAgentRow,
  CoachReport,
} from "../../../src/shared/coach/breakdown.js";
import { coachFindings } from "../../../src/shared/coach/findings.js";
import { FINDING_DEFAULTS } from "../../../src/shared/coach/settings.js";
import type { UsageMetrics } from "../../../src/shared/usage/report.js";
import {
  checkPersonaUpdate,
  createPersona,
  resolveAgentsDeps,
  runPersonaUpdate,
} from "../../../src/ui/cli/agent-ops.js";
import { parsePersona } from "../../../src/shared/agents/personas.js";
import { cleanupRigs, rig } from "../agents/helpers/rig.js";

afterEach(cleanupRigs);

const METRICS = {
  calls: 100,
  compactions: 0,
  polls: 0,
  denials: 0,
  prompts: 10,
  subagent_opus_pct: 0,
} as UsageMetrics;

function row(over: Partial<CoachAgentRow>, m: Partial<UsageMetrics> = {}) {
  return {
    agent: "builder",
    workspace: "north",
    persona: "copy-checker",
    runtime: "den-claude",
    conversations: { inWindow: 1, total: 1, byWhy: { start: 1 } },
    transcripts: 1,
    metrics: { ...METRICS, ...m },
    perDay: {},
    models: { main: {}, subagent: {} },
    ...over,
  } as CoachAgentRow;
}

const report = (rows: CoachAgentRow[]) =>
  ({
    version: 1,
    ranAt: "2026-11-22T12:00:00.000Z",
    window: { from: "a", to: "b", days: 7 },
    agents: rows,
    totals: METRICS,
    totalsPerDay: {},
    cost: { model: null, tokens: 0 },
  }) as CoachReport;

const opusRow = row(
  { models: { main: {}, subagent: { "claude-opus-5-5": 40 } } },
  { subagent_opus_pct: 100 },
);

describe("a finding's proposal", () => {
  it("subagents on Opus: persona_update on its persona, in its project, to Sonnet", () => {
    const [f] = coachFindings(report([opusRow]), FINDING_DEFAULTS);
    expect(f.persona).toBe("copy-checker");
    expect(f.apply).toEqual({
      action: "persona_update",
      args: { id: "copy-checker", project: "north", subagentModel: "sonnet" },
      change: "Set copy-checker's subagent model to Sonnet.",
      reversible: "Set it back in copy-checker's persona.",
    });
  });

  it("the other kinds have no Apply yet; an agent with no persona has none", () => {
    const f = coachFindings(
      report([
        row({ agent: "poller", perDay: { polls_per_day: 99 } }),
        row({ ...opusRow, agent: "nameless", persona: "" }),
      ]),
      FINDING_DEFAULTS,
    );
    expect(f.map((x) => [x.kind, x.agent, x.apply ?? null])).toEqual([
      ["polling", "poller", null],
      ["subagent_opus", "nameless", null],
    ]);
  });

  it("is a held write Den's own check takes, and changes nothing until it runs", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    createPersona(d, {
      displayName: "Copy checker",
      role: "reviewer",
      category: "marketing",
      description: "Checks copy.",
      instructions: "Read the changed copy.",
      runtime: "den-claude",
      version: "latest",
      permission: "ask",
      allowedCommands: [],
    });
    const file = path.join(r.stateDir, "personas", "copy-checker.md");
    const before = fs.readFileSync(file, "utf-8");
    const [f] = coachFindings(report([opusRow]), FINDING_DEFAULTS);
    // What the approval dialog checks when the person's Apply asks.
    const c = checkPersonaUpdate(d, f.apply!.args);
    if (!c.ok) throw new Error(c.error);
    expect(c.summary).toBe("change persona copy-checker: subagentModel");
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    // The person's Allow runs it.
    await runPersonaUpdate(d, c.args);
    expect(
      parsePersona(fs.readFileSync(file, "utf-8"), file)!.subagentModel,
    ).toBe("sonnet");
  });
});
