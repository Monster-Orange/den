/**
 * Issue 52, Coach slice T-d (TUNE-5, the judged parts): a person's repeated
 * asks, asks an agent should have decided itself, and messages that pass a
 * person's request on as the agent's own. Counted rules pick the items;
 * the cheap model judges them, within a token budget, and every judgement
 * keeps its evidence and the model's reason. Off unless
 * agents.coach.judge.enabled: judging sends the samples to the model's
 * provider. The report states what judging cost.
 */
import { describe, expect, it } from "@jest/globals";
import {
  claudeArgs,
  judgeCandidates,
  judgeReport,
  type ModelRun,
} from "../../../src/shared/coach/judge.js";
import { askMetrics, type AskStats } from "../../../src/shared/coach/asks.js";
import {
  coachWindow,
  type CoachAgentRow,
  type CoachReport,
} from "../../../src/shared/coach/breakdown.js";
import {
  COACH_DEFAULTS,
  JUDGE_DEFAULTS,
  checkCoachConfig,
} from "../../../src/shared/coach/settings.js";

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const t0 = NOW - DAY;

function row(agent: string, stats: AskStats): CoachAgentRow {
  return {
    agent,
    workspace: "shop",
    persona: "builder",
    runtime: "den-claude",
    conversations: { inWindow: 1, total: 1, byWhy: {} },
    transcripts: 1,
    asks: { metrics: askMetrics([stats], 7), stats },
  };
}
function report(...agents: CoachAgentRow[]): CoachReport {
  return {
    version: 1,
    ranAt: new Date(NOW).toISOString(),
    window: coachWindow(NOW, 7),
    agents,
    totals: {} as CoachReport["totals"],
    totalsPerDay: {},
    cost: { model: null, tokens: 0 },
    findings: [],
  };
}

const sample = report(
  row("a1", {
    asks: [
      {
        at: t0,
        tool: "ask_human",
        text: "1. Rename the button to Save?",
        problems: [],
      },
    ],
    sends: [
      { at: t0, to: "Builder", hash: "h1", text: "Diff ready for review." },
      {
        at: t0 + MIN,
        to: "Builder",
        hash: "h2",
        text: "The person asked me to merge it now, please do.",
      },
    ],
    received: [],
    prompts: [
      {
        at: t0 - 2 * DAY,
        text: "Make the bell rows open on a click anywhere.",
      },
      { at: t0 - DAY, text: "Use the local time zone everywhere." },
      {
        at: t0,
        text: "I asked before: the bell rows still don't open on a click.",
      },
    ],
  }),
  row("a2", {
    asks: [],
    sends: [],
    received: [],
    prompts: [
      {
        at: t0 - 3 * DAY,
        text: "Bell rows should open when clicked anywhere on them.",
      },
    ],
  }),
);

describe("judgeCandidates: the counted rules pick what the model judges", () => {
  it("picks a prompt with repeat words, with the person's closest earlier prompts across agents", () => {
    const c = judgeCandidates(sample, 40);
    const rep = c.filter((x) => x.kind === "repeat_ask");
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({
      agent: "a1",
      text: expect.stringMatching(/still/),
    });
    expect(rep[0].context[0]).toMatch(/bell rows/i);
    expect(rep[0].context.join(" ")).not.toMatch(/time zone/);
  });
  it("picks each ask for the trivial check, and sends that pass on a person's request", () => {
    const c = judgeCandidates(sample, 40);
    expect(
      c.filter((x) => x.kind === "trivial_ask").map((x) => x.text),
    ).toEqual(["1. Rename the button to Save?"]);
    expect(c.filter((x) => x.kind === "relay").map((x) => x.text)).toEqual([
      "to Builder: The person asked me to merge it now, please do.",
    ]);
  });
  it("picks at most max_items", () => {
    expect(judgeCandidates(sample, 2)).toHaveLength(2);
  });
});

describe("judgeReport: the model judges within the budget", () => {
  const yesToAll: ModelRun = async (prompt) => {
    const ids = [...prompt.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
    return {
      text: JSON.stringify(
        ids.map((id) => ({
          id,
          yes: true,
          why: "It restates the earlier ask.",
        })),
      ),
      tokens: 1000,
    };
  };

  it("adds a finding per agent and kind, each with samples and the model's reason, and states its cost", async () => {
    const r = structuredClone(sample);
    const calls: string[] = [];
    await judgeReport(r, { ...JUDGE_DEFAULTS, enabled: true }, async (p, o) => {
      calls.push(o.model);
      return yesToAll(p, o);
    });
    const kinds = (r.findings ?? []).map((f) => f.id).sort();
    expect(kinds).toEqual(["relay:a1", "repeat_ask:a1", "trivial_ask:a1"]);
    const rep = r.findings!.find((f) => f.kind === "repeat_ask")!;
    expect(rep.samples![0].text).toMatch(/still/);
    expect(rep.samples![0].problems).toEqual(["It restates the earlier ask."]);
    expect(calls.every((m) => m === JUDGE_DEFAULTS.model)).toBe(true);
    expect(r.cost).toEqual({
      model: JUDGE_DEFAULTS.model,
      tokens: 1000 * calls.length,
    });
  });

  it("stops before a call that would pass the budget, and says how many it skipped", async () => {
    const r = structuredClone(sample);
    let n = 0;
    const res = await judgeReport(
      r,
      { ...JUDGE_DEFAULTS, enabled: true, budget_tokens: 1500 },
      async (p, o) => {
        n++;
        return yesToAll(p, o);
      },
    );
    expect(n).toBe(1);
    expect(res.skipped).toBeGreaterThan(0);
    expect(r.cost.tokens).toBe(1000);
  });

  it("drops a verdict it can't read, and a 'no', with no finding", async () => {
    const r = structuredClone(sample);
    await judgeReport(r, { ...JUDGE_DEFAULTS, enabled: true }, async (p) => {
      const ids = [...p.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
      return {
        text: `Here you go: ${JSON.stringify([
          { id: ids[0], yes: false, why: "fine" },
          { id: "made-up", yes: true },
        ])}`,
        tokens: 10,
      };
    });
    expect(r.findings).toEqual([]);
  });

  it("calls no model when judging is off", async () => {
    const r = structuredClone(sample);
    let n = 0;
    await judgeReport(r, JUDGE_DEFAULTS, async () => {
      n++;
      return { text: "[]", tokens: 0 };
    });
    expect(n).toBe(0);
    expect(r.cost).toEqual({ model: null, tokens: 0 });
  });
});

describe("judging sends no secrets", () => {
  it("takes a planted token out of every sample before the model's input", async () => {
    const token = `ghp_${"Z".repeat(36)}`;
    const r = report(
      row("a1", {
        asks: [
          {
            at: t0,
            tool: "ask_human",
            text: `1. Use ${token} for the deploy?`,
            problems: [],
          },
        ],
        sends: [
          {
            at: t0,
            to: "B",
            hash: "h",
            text: `The person asked me to use ${token}.`,
          },
        ],
        received: [],
        prompts: [
          { at: t0 - DAY, text: `Deploy with ${token} please.` },
          { at: t0, text: `I asked again: deploy with ${token}.` },
        ],
      }),
    );
    const inputs: string[] = [];
    await judgeReport(r, { ...JUDGE_DEFAULTS, enabled: true }, async (p) => {
      inputs.push(p);
      return { text: "[]", tokens: 1 };
    });
    expect(inputs.length).toBeGreaterThan(0);
    for (const p of inputs) expect(p).not.toContain(token);
  });
});

describe("agents.coach.judge settings", () => {
  it("are off by default, on the cheap model, within a token budget", () => {
    expect(JUDGE_DEFAULTS).toEqual({
      enabled: false,
      model: "haiku",
      budget_tokens: 200_000,
      max_items: 40,
    });
    expect(COACH_DEFAULTS.judge).toEqual(JUDGE_DEFAULTS);
  });
  it("take a partial map, and refuse a bad value naming the key", () => {
    expect(checkCoachConfig({ judge: { enabled: true } }).judge).toEqual({
      ...JUDGE_DEFAULTS,
      enabled: true,
    });
    expect(() => checkCoachConfig({ judge: { model: "" } })).toThrow(
      /agents\.coach\.judge\.model/,
    );
    expect(() => checkCoachConfig({ judge: { budget_tokens: -1 } })).toThrow(
      /agents\.coach\.judge\.budget_tokens/,
    );
    expect(() => checkCoachConfig({ judge: { nope: 1 } })).toThrow(
      /agents\.coach\.judge\.nope/,
    );
  });
});

describe("claudeArgs: the runtime's CLI, with nothing but the prompt", () => {
  it("runs print mode on the model, with no tools, no MCP servers, no settings and no saved session", () => {
    const a = claudeArgs("haiku");
    expect(a).toEqual(
      expect.arrayContaining([
        "-p",
        "--model",
        "haiku",
        "--output-format",
        "json",
        "--strict-mcp-config",
        "--no-session-persistence",
      ]),
    );
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
  });
});

describe("runCoach with judging on", () => {
  it("judges before it strips the evidence, and saves the judged findings and the cost", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const { writeRecord } =
      await import("../../../src/shared/agents/records.js");
    const { runCoach } = await import("../../../src/shared/coach/run.js");
    const { readCoachReport } =
      await import("../../../src/shared/coach/store.js");
    const st = fs.mkdtempSync(path.join(os.tmpdir(), "den-coach-judge-"));
    try {
      const rec = {
        id: "a1",
        workspace: "shop",
        persona: "builder",
        runtime: "den-claude",
        session: { host: "local", id: "s-a1" },
        sessionName: "shop-a1",
        startedAt: new Date(NOW - 30 * DAY).toISOString(),
        resumeToken: "c1",
      } as unknown as import("../../../src/shared/agents/records.js").AgentRecord;
      writeRecord(st, rec);
      const stats = sample.agents[0].asks!.stats!;
      const r = await runCoach({
        stateDir: st,
        settings: {
          ...COACH_DEFAULTS,
          judge: { ...JUDGE_DEFAULTS, enabled: true },
        },
        now: NOW,
        records: () => [rec],
        rotateAfter: () => 3,
        source: () => ({
          id: "fake",
          runtimes: ["den-claude"],
          root: () => "/fake",
          agentFiles: () => ["c1.jsonl"],
          files: () => ["c1.jsonl"],
          mine: async (f) => ({
            file: f,
            subagent: false,
            calls: 1,
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            models: {},
            tools: {},
            toolErrors: {},
            denials: 0,
            polls: 0,
            sleepSeconds: 0,
            compactions: 0,
            prompts: 1,
            corrections: 0,
            interrupts: 0,
            agentSpawns: 0,
            activeSeconds: 0,
            prMerges: [],
            first: NOW - DAY,
            last: NOW - DAY,
          }),
          asks: async () => stats,
        }),
        judgeRun: async (p) => {
          const ids = [...p.matchAll(/"id":\s*"(repeat_ask[^"]*)"/g)].map(
            (m) => m[1],
          );
          return {
            text: JSON.stringify(
              ids.map((id) => ({ id, yes: true, why: "Restated." })),
            ),
            tokens: 42,
          };
        },
      });
      expect(r.findings?.map((f) => f.id)).toContain("repeat_ask:a1");
      const saved = readCoachReport(st)!;
      expect(saved.cost.model).toBe("haiku");
      expect(saved.cost.tokens).toBeGreaterThan(0);
      expect(saved.agents[0].asks?.stats).toBeUndefined();
    } finally {
      fs.rmSync(st, { recursive: true, force: true });
    }
  });
});
