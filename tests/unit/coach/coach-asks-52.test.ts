/**
 * Issue 52, Coach slice T-c (TUNE-5, the counted parts): an agent's asks
 * to a person, checked against the plain-writing rule (R12) as the
 * hand-back check reads it; how long the person's answer took; and the
 * health of its messages to other agents (the same text sent twice, sends
 * that got no reply). Read from the agent's own transcripts, read-only.
 * Each finding keeps up to three samples, each short and with secrets
 * taken out, so a person can check it.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  askMetrics,
  askProblems,
  mineAsks,
  type AskStats,
} from "../../../src/shared/coach/asks.js";
import { coachFindings } from "../../../src/shared/coach/findings.js";
import { coachWindow, type CoachReport } from "../../../src/shared/coach/breakdown.js";
import {
  FINDING_DEFAULTS,
  checkCoachConfig,
} from "../../../src/shared/coach/settings.js";

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function transcript(lines: object[], sub = false): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-coach-asks-"));
  tmp.push(d);
  const dir = sub ? path.join(d, "s1", "subagents") : d;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "s1.jsonl");
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}

let n = 0;
const toolUse = (at: number, name: string, input: object) => ({
  type: "assistant",
  timestamp: iso(at),
  message: {
    id: `m${++n}`,
    content: [{ type: "tool_use", id: `tu${n}`, name, input }],
  },
});
const toolResult = (at: number, id: string, err = false) => ({
  type: "user",
  timestamp: iso(at),
  message: {
    content: [{ type: "tool_result", tool_use_id: id, is_error: err }],
  },
});
const prompt = (at: number, text: string) => ({
  type: "user",
  timestamp: iso(at),
  message: { content: text },
});

describe("askProblems: an ask read against R12", () => {
  it("passes a plain ask with a numbered yes/no decision", () => {
    expect(
      askProblems("The gate is green.\n1. Ship the fix to main today?"),
    ).toEqual([]);
  });
  it("passes a plain question with no decision in it", () => {
    expect(askProblems("The login page is up. Can you open it?")).toEqual([]);
  });
  it("flags a bare ID, and passes a glossed one", () => {
    expect(askProblems("Should I merge #931 now?").join(" ")).toMatch(/#931/);
    expect(
      askProblems("1. Merge #931 (the npm environment fix) now?"),
    ).toEqual([]);
  });
  it("flags a sentence longer than the limit", () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(askProblems(`${long}.`).join(" ")).toMatch(/long/i);
    expect(askProblems(`${long}.`, 50)).toEqual([]);
  });
  it("flags a decision that offers a choice or isn't numbered", () => {
    expect(askProblems("Ship it now or wait for the bed?").join(" ")).toMatch(
      /yes\/no/,
    );
    expect(
      askProblems("Two things.\nShip it now?\nAnd tag it too?").join(" "),
    ).toMatch(/number/i);
  });
  it("flags a caveat section", () => {
    expect(
      askProblems("1. Ship it?\n\n## Caveats\nIt may break.").join(" "),
    ).toMatch(/caveat/i);
  });
});

describe("mineAsks: asks and messages from one transcript", () => {
  it("reads an ask_human call and the person's next prompt as its answer", async () => {
    const t0 = NOW - DAY;
    const f = transcript([
      toolUse(t0, "mcp__lair__ask_human", { question: "1. Ship it today?" }),
      prompt(t0 + 2 * MIN, '<cross-session-message from="x">peer</cross-session-message>'),
      prompt(t0 + 30 * MIN, "yes"),
    ]);
    const s = await mineAsks(f, {});
    expect(s.asks).toHaveLength(1);
    expect(s.asks[0]).toMatchObject({
      tool: "ask_human",
      text: "1. Ship it today?",
      problems: [],
    });
    expect(s.asks[0].answeredAt).toBe(t0 + 30 * MIN);
  });

  it("reads AskUserQuestion's questions, answered by its tool result", async () => {
    const t0 = NOW - DAY;
    const f = transcript([
      toolUse(t0, "AskUserQuestion", {
        questions: [{ question: "Use the new page?" }, { question: "Turn on #12?" }],
      }),
      toolResult(t0 + 5 * MIN, `tu${n}`),
    ]);
    const s = await mineAsks(f, {});
    expect(s.asks).toHaveLength(1);
    expect(s.asks[0].tool).toBe("AskUserQuestion");
    expect(s.asks[0].answeredAt).toBe(t0 + 5 * MIN);
    // The options are the tool's own: only the questions' words are read.
    expect(s.asks[0].problems.join(" ")).toMatch(/#12/);
  });

  it("reads sends to other agents, the same text twice, and replies", async () => {
    const t0 = NOW - DAY;
    const f = transcript([
      toolUse(t0, "SendMessage", { to: "Den Builder", message: "Item 52: started." }),
      toolUse(t0 + MIN, "SendMessage", { to: "Den Builder", message: "item 52:   started." }),
      toolUse(t0 + 2 * MIN, "SendMessage", { to: "Reviewer B", message: "Diff ready." }),
      prompt(
        t0 + 10 * MIN,
        '<cross-session-message from="uds:/tmp/a.sock" from-name="lair-den:Den Builder">ok</cross-session-message>',
      ),
    ]);
    const s = await mineAsks(f, {});
    expect(s.sends.map((x) => x.to)).toEqual([
      "Den Builder",
      "Den Builder",
      "Reviewer B",
    ]);
    expect(s.sends[0].hash).toBe(s.sends[1].hash);
    expect(s.received).toEqual([
      { at: t0 + 10 * MIN, from: "lair-den:Den Builder" },
    ]);
  });

  it("skips lines before `since`, and reads no asks from a subagent", async () => {
    const old = NOW - 10 * DAY;
    const f = transcript([
      toolUse(old, "mcp__lair__ask_human", { question: "Old?" }),
      toolUse(NOW - DAY, "mcp__lair__ask_human", { question: "New?" }),
    ]);
    const s = await mineAsks(f, { since: NOW - 7 * DAY });
    expect(s.asks.map((a) => a.text)).toEqual(["New?"]);
    const sub = transcript(
      [toolUse(NOW - DAY, "mcp__lair__ask_human", { question: "Sub?" })],
      true,
    );
    expect((await mineAsks(sub, {})).asks).toEqual([]);
  });

  it("keeps each ask short and takes secrets out of it", async () => {
    const f = transcript([
      toolUse(NOW - DAY, "mcp__lair__ask_human", {
        question: `Use token ghp_${"a".repeat(36)} for it? ${"x".repeat(400)}`,
      }),
    ]);
    const [a] = (await mineAsks(f, {})).asks;
    expect(a.text).not.toMatch(/ghp_a{36}/);
    expect(a.text.length).toBeLessThanOrEqual(300);
  });
});

describe("askMetrics: the counts over a window", () => {
  it("counts asks a day, the R12 pass rate, the median wait and message health", () => {
    const t0 = NOW - DAY;
    const s: AskStats = {
      asks: [
        { at: t0, tool: "ask_human", text: "a", problems: [], answeredAt: t0 + 10 * MIN },
        { at: t0, tool: "ask_human", text: "b", problems: ["x"], answeredAt: t0 + 30 * MIN },
        { at: t0, tool: "ask_human", text: "c", problems: [], answeredAt: t0 + 90 * MIN },
        { at: t0, tool: "ask_human", text: "d", problems: ["y"] },
      ],
      sends: [
        { at: t0, to: "Den Builder", hash: "h1", text: "s" },
        { at: t0 + MIN, to: "Den Builder", hash: "h1", text: "s" },
        { at: t0 + 2 * MIN, to: "Reviewer B", hash: "h2", text: "r" },
      ],
      received: [{ at: t0 + 5 * MIN, from: "lair-den:Den Builder" }],
    };
    expect(askMetrics([s], 2)).toEqual({
      asks: 4,
      asks_per_day: 2,
      ask_r12_pass_pct: 50,
      ask_wait_min: 30,
      asks_unanswered: 1,
      sends: 3,
      sends_repeated: 1,
      sends_no_reply: 1,
    });
  });
});

function report(asks: AskStats): CoachReport {
  return {
    version: 1,
    ranAt: iso(NOW),
    window: coachWindow(NOW, 7),
    agents: [
      {
        agent: "a1",
        workspace: "shop",
        persona: "builder",
        runtime: "den-claude",
        conversations: { inWindow: 1, total: 1, byWhy: {} },
        transcripts: 1,
        asks: { metrics: askMetrics([asks], 7), stats: asks },
      },
    ],
    totals: {} as CoachReport["totals"],
    totalsPerDay: {},
    cost: { model: null, tokens: 0 },
  };
}

describe("T-c findings", () => {
  const t0 = NOW - DAY;
  const bad = (i: number) => ({
    at: t0 + i * MIN,
    tool: "ask_human" as const,
    text: `Merge #${900 + i} now?`,
    problems: [`"#${900 + i}" is not explained.`],
    answeredAt: t0 + i * MIN + 5 * MIN,
  });

  it("finds asks that fail R12, with up to three samples", () => {
    const f = coachFindings(
      report({ asks: [0, 1, 2, 3].map(bad), sends: [], received: [] }),
      FINDING_DEFAULTS,
    );
    const r12 = f.find((x) => x.kind === "ask_r12");
    expect(r12).toBeDefined();
    expect(r12!.id).toBe("ask_r12:a1");
    expect(r12!.evidence).toMatchObject({ asks: 4, ask_r12_pass_pct: 0 });
    expect(r12!.samples).toHaveLength(3);
    expect(r12!.samples![0]).toMatchObject({ text: "Merge #900 now?" });
    expect(r12!.samples![0].problems[0]).toMatch(/#900/);
  });

  it("needs enough asks to tell", () => {
    const f = coachFindings(
      report({ asks: [bad(0)], sends: [], received: [] }),
      FINDING_DEFAULTS,
    );
    expect(f.find((x) => x.kind === "ask_r12")).toBeUndefined();
  });

  it("finds a slow wait for answers, and repeated or unanswered sends", () => {
    const slow = [0, 1, 2].map((i) => ({
      at: t0,
      tool: "ask_human" as const,
      text: "1. Ship it?",
      problems: [],
      answeredAt: t0 + (300 + i) * MIN,
    }));
    const sends = Array.from({ length: 6 }, (_, i) => ({
      at: t0 + i * MIN,
      to: "Den Builder",
      hash: "same",
      text: "Item 52: started.",
    }));
    const f = coachFindings(
      report({ asks: slow, sends, received: [] }),
      FINDING_DEFAULTS,
    );
    const kinds = f.map((x) => x.kind).sort();
    expect(kinds).toEqual(["ask_wait", "msg_no_reply", "msg_repeat"]);
    expect(f.find((x) => x.kind === "msg_repeat")!.samples![0].text).toBe(
      "Item 52: started.",
    );
  });

  it("has its thresholds in agents.coach.findings, each settable", () => {
    const s = checkCoachConfig({
      findings: { ask_r12_pass_pct: 90, min_asks: 1, ask_wait_min: 60 },
    });
    expect(s.findings.ask_r12_pass_pct).toBe(90);
    expect(s.findings.min_asks).toBe(1);
    expect(s.findings.sends_repeated).toBe(FINDING_DEFAULTS.sends_repeated);
  });
});
