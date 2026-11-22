/**
 * Issue 52, Coach slice T-a (TUNE-1): the per-agent breakdown, read-only.
 * Each agent's numbers come from every conversation it had in the window
 * (not only its current one), under the weekly report's metric names,
 * each count also per day, and the window named. Off by default
 * (`agents.coach.enabled`). A counted run uses no model, and says so.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  conversationsFile,
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import {
  COACH_DEFAULTS,
  FINDING_DEFAULTS,
  checkCoachConfig,
} from "../../../src/shared/coach/settings.js";
import {
  coachBreakdown,
  coachWindow,
  mapLimited,
} from "../../../src/shared/coach/breakdown.js";
import { runCoach } from "../../../src/shared/coach/run.js";
import {
  readCoachReport,
  writeCoachReport,
  coachRunsDir,
} from "../../../src/shared/coach/store.js";
import {
  readAgentsConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";
import type { UsageSource } from "../../../src/shared/usage/sources.js";
import type { TranscriptStats } from "../../../src/shared/usage/transcript.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const state = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-coach-"));
  tmp.push(d);
  return d;
};

function rec(id: string, over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    workspace: "shop",
    persona: "builder",
    runtime: "den-claude",
    session: { host: "local", id: `s-${id}` },
    sessionName: `shop-${id}`,
    startedAt: iso(NOW - 30 * DAY),
    ...over,
  } as AgentRecord;
}

function stats(
  file: string,
  over: Partial<TranscriptStats> = {},
): TranscriptStats {
  return {
    file,
    subagent: false,
    calls: 10,
    tokens: {
      input: 100,
      output: 2_000,
      cacheRead: 400_000,
      cacheWrite: 10_000,
    },
    models: { "claude-opus-5-5": 10 },
    tools: { Bash: 4 },
    toolErrors: { Bash: 1 },
    denials: 1,
    polls: 2,
    sleepSeconds: 0,
    compactions: 1,
    prompts: 4,
    corrections: 1,
    interrupts: 0,
    agentSpawns: 0,
    activeSeconds: 600,
    prMerges: [],
    first: NOW - DAY,
    last: NOW - DAY + 1000,
    ...over,
  };
}

/** A source whose files are `<id>.jsonl` (and a subagent's), mined from `by`. */
function fakeSource(
  by: Record<string, TranscriptStats>,
  read: string[] = [],
): UsageSource {
  return {
    id: "fake",
    runtimes: ["den-claude"],
    root: () => "/fake",
    agentFiles: (t) => Object.keys(by).filter((f) => f.startsWith(`${t}`)),
    files: () => Object.keys(by),
    mine: async (f, o) => {
      read.push(f);
      const s = by[f];
      // A file with nothing at or after `since` counts nothing.
      return o?.since !== undefined && (s.last ?? 0) < o.since
        ? stats(f, {
            calls: 0,
            first: undefined,
            last: undefined,
            compactions: 0,
            prompts: 0,
          })
        : s;
    },
  };
}

describe("agents.coach settings", () => {
  it("are off by default, over a 7-day window", () => {
    expect(COACH_DEFAULTS).toEqual({
      enabled: false,
      window_days: 7,
      keep_runs: 100,
      findings: FINDING_DEFAULTS,
    });
    expect(checkCoachConfig(undefined)).toEqual(COACH_DEFAULTS);
    expect(checkCoachConfig({ enabled: true, window_days: 14 })).toEqual({
      enabled: true,
      window_days: 14,
      keep_runs: 100,
      findings: FINDING_DEFAULTS,
    });
  });

  it("refuse a bad value, naming the key", () => {
    expect(() => checkCoachConfig({ enabled: "yes" })).toThrow(
      /agents\.coach\.enabled/,
    );
    expect(() => checkCoachConfig({ window_days: 0 })).toThrow(
      /agents\.coach\.window_days/,
    );
    expect(() => checkCoachConfig({ window_days: 2.5 })).toThrow(
      /agents\.coach\.window_days/,
    );
    expect(() => checkCoachConfig({ keep_runs: -1 })).toThrow(
      /agents\.coach\.keep_runs/,
    );
    expect(() => checkCoachConfig({ enabld: true })).toThrow(
      /agents\.coach\.enabld/,
    );
    expect(() => checkCoachConfig([])).toThrow(/agents\.coach/);
  });
});

describe("the window", () => {
  it("is named: from, to and how many days", () => {
    expect(coachWindow(NOW, 7)).toEqual({
      from: iso(NOW - 7 * DAY),
      to: iso(NOW),
      days: 7,
    });
  });
});

describe("the per-agent breakdown", () => {
  it("reads every conversation in the window, not only the current one", async () => {
    const st = state();
    // c1 then c2 (a Start fresh three days ago), both in the window.
    writeRecord(st, rec("a", { resumeToken: "c1" }));
    writeRecord(st, rec("a", { resumeToken: "c2" }));
    const read: string[] = [];
    const src = fakeSource(
      {
        "c1.jsonl": stats("c1.jsonl", {
          first: NOW - 5 * DAY,
          last: NOW - 4 * DAY,
        }),
        "c2.jsonl": stats("c2.jsonl"),
        "c2/subagents/x.jsonl": stats("c2/subagents/x.jsonl", {
          subagent: true,
          models: { "claude-sonnet-5-5": 6, "claude-opus-5-5": 2 },
        }),
      },
      read,
    );
    const r = await coachBreakdown([rec("a", { resumeToken: "c2" })], {
      stateDir: st,
      now: NOW,
      days: 7,
      source: () => src,
    });
    expect(read.sort()).toEqual([
      "c1.jsonl",
      "c2.jsonl",
      "c2/subagents/x.jsonl",
    ]);
    const a = r.agents[0];
    expect(a.conversations).toMatchObject({ inWindow: 2, total: 2 });
    expect(a.transcripts).toBe(3);
    expect(a.metrics?.calls).toBe(30);
    expect(a.metrics?.compactions).toBe(3);
    expect(a.perDay?.calls_per_day).toBe(round2(30 / 7));
    expect(a.perDay?.compactions_per_day).toBe(round2(3 / 7));
    expect(a.models).toEqual({
      main: { "claude-opus-5-5": 20 },
      subagent: { "claude-sonnet-5-5": 6, "claude-opus-5-5": 2 },
    });
    expect(a.metrics?.subagent_opus_pct).toBe(25);
  });

  it("T-c: reads asks from the main transcripts only, when the source can", async () => {
    const st = state();
    writeRecord(st, rec("a", { resumeToken: "c2" }));
    const asked: string[] = [];
    const src: UsageSource = {
      ...fakeSource({
        "c2.jsonl": stats("c2.jsonl"),
        "c2/subagents/x.jsonl": stats("c2/subagents/x.jsonl", {
          subagent: true,
        }),
      }),
      asks: async (f, o) => {
        asked.push(f);
        expect(o?.maxWords).toBe(30);
        return {
          asks: [
            {
              at: NOW - DAY,
              tool: "ask_human",
              text: "1. Ship it?",
              problems: [],
            },
          ],
          sends: [],
          received: [],
        };
      },
    };
    const r = await coachBreakdown([rec("a", { resumeToken: "c2" })], {
      stateDir: st,
      now: NOW,
      days: 7,
      source: () => src,
      sentenceWords: 30,
    });
    expect(asked).toEqual(["c2.jsonl"]);
    expect(r.agents[0].asks?.stats?.asks).toHaveLength(1);
    expect(r.agents[0].asks?.metrics).toMatchObject({
      asks: 1,
      ask_r12_pass_pct: 100,
    });
  });

  it("T-c: a saved report holds no ask or send text beyond the finding samples", async () => {
    const st = state();
    writeRecord(st, rec("a", { resumeToken: "c2" }));
    const asks = Array.from({ length: 6 }, (_, i) => ({
      at: NOW - DAY + i,
      tool: "ask_human" as const,
      text: `secret-ask-${i} about #${900 + i}?`,
      problems: [`"#${900 + i}" is not explained.`],
    }));
    const src: UsageSource = {
      ...fakeSource({ "c2.jsonl": stats("c2.jsonl") }),
      asks: async () => ({
        asks,
        sends: [{ at: NOW - DAY, to: "B", hash: "h", text: "secret-send-0" }],
        received: [],
        prompts: [{ at: NOW - DAY, text: "secret-prompt-0" }],
      }),
    };
    const r = await runCoach({
      stateDir: st,
      settings: COACH_DEFAULTS,
      now: NOW,
      records: () => [rec("a", { resumeToken: "c2" })],
      source: () => src,
      rotateAfter: () => 3,
    });
    expect(r.findings?.find((f) => f.kind === "ask_r12")?.samples).toHaveLength(
      3,
    );
    const saved = [
      path.join(st, "coach", "latest.json"),
      ...fs
        .readdirSync(coachRunsDir(st))
        .map((f) => path.join(coachRunsDir(st), f)),
    ].map((f) => fs.readFileSync(f, "utf-8"));
    for (const text of [...saved, JSON.stringify(r)]) {
      expect(text).not.toMatch(/secret-send|secret-prompt|secret-ask-[345]/);
      expect(text.match(/secret-ask-\d/g)?.length ?? 0).toBeLessThanOrEqual(3);
    }
  });

  it("skips a conversation that ended before the window", async () => {
    const st = state();
    writeRecord(st, rec("a", { resumeToken: "old" }));
    // Pretend "old" ended 20 days ago.
    fs.writeFileSync(
      conversationsFile(st, "a"),
      JSON.stringify([
        {
          id: "old",
          from: iso(NOW - 25 * DAY),
          to: iso(NOW - 20 * DAY),
          why: "start",
        },
        { id: "new", from: iso(NOW - 20 * DAY), why: "fresh" },
      ]),
    );
    const read: string[] = [];
    const src = fakeSource(
      { "old.jsonl": stats("old.jsonl"), "new.jsonl": stats("new.jsonl") },
      read,
    );
    const r = await coachBreakdown([rec("a", { resumeToken: "new" })], {
      stateDir: st,
      now: NOW,
      days: 7,
      source: () => src,
    });
    expect(read).toEqual(["new.jsonl"]);
    expect(r.agents[0].conversations).toMatchObject({ inWindow: 1, total: 2 });
  });

  it("says why an agent has no numbers", async () => {
    const st = state();
    const r = await coachBreakdown(
      [rec("x", { runtime: "codex", resumeToken: "c1" }), rec("y")],
      { stateDir: st, now: NOW, days: 7, source: () => undefined },
    );
    expect(r.agents.map((a) => [a.agent, a.why])).toEqual([
      ["x", "no usage source reads codex"],
      ["y", "no conversation in the window"],
    ]);
  });

  it("totals every agent, names its window, and states its own cost (none: it's counted)", async () => {
    const st = state();
    writeRecord(st, rec("a", { resumeToken: "c1" }));
    writeRecord(st, rec("b", { resumeToken: "d1" }));
    const src = fakeSource({
      "c1.jsonl": stats("c1.jsonl"),
      "d1.jsonl": stats("d1.jsonl"),
    });
    const r = await coachBreakdown(
      [rec("a", { resumeToken: "c1" }), rec("b", { resumeToken: "d1" })],
      {
        stateDir: st,
        now: NOW,
        days: 7,
        source: () => src,
      },
    );
    expect(r.window).toEqual(coachWindow(NOW, 7));
    expect(r.ranAt).toBe(iso(NOW));
    expect(r.totals.calls).toBe(20);
    expect(r.totalsPerDay.calls_per_day).toBe(round2(20 / 7));
    expect(r.cost).toEqual({ model: null, tokens: 0 });
  });

  it("keeps counts only: no file names or titles in the report", async () => {
    const st = state();
    writeRecord(st, rec("a", { resumeToken: "c1" }));
    const src = fakeSource({
      "c1.jsonl": stats("c1.jsonl", { title: "secret plan" }),
    });
    const r = await coachBreakdown([rec("a", { resumeToken: "c1" })], {
      stateDir: st,
      now: NOW,
      days: 7,
      source: () => src,
    });
    const text = JSON.stringify(r);
    expect(text).not.toContain("c1.jsonl");
    expect(text).not.toContain("secret plan");
  });
});

describe("the saved report", () => {
  it("is written 0600 as the latest and as a run, and reads back", async () => {
    const st = state();
    const r = await coachBreakdown([], {
      stateDir: st,
      now: NOW,
      days: 7,
      source: () => undefined,
    });
    writeCoachReport(st, r, 100);
    expect(readCoachReport(st)).toEqual(r);
    const runs = fs.readdirSync(coachRunsDir(st));
    expect(runs).toHaveLength(1);
    expect(fs.statSync(path.join(coachRunsDir(st), runs[0])).mode & 0o777).toBe(
      0o600,
    );
  });

  it("keeps only keep_runs runs, dropping the oldest", async () => {
    const st = state();
    for (let i = 0; i < 5; i++) {
      const r = await coachBreakdown([], {
        stateDir: st,
        now: NOW + i * 1000,
        days: 7,
        source: () => undefined,
      });
      writeCoachReport(st, r, 3);
    }
    const runs = fs.readdirSync(coachRunsDir(st)).sort();
    expect(runs).toHaveLength(3);
    expect(readCoachReport(st)?.ranAt).toBe(iso(NOW + 4000));
  });

  it("no report yet reads as null", () => {
    expect(readCoachReport(state())).toBeNull();
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

describe("agents.coach in the org config", () => {
  it("reads with its defaults, and a bad value throws naming the key", () => {
    expect(readAgentsConfig({ agents: {} } as DenConfig, {}).coach).toEqual(
      COACH_DEFAULTS,
    );
    expect(
      readAgentsConfig(
        { agents: { coach: { enabled: true } } } as DenConfig,
        {},
      ).coach?.enabled,
    ).toBe(true);
    expect(() =>
      readAgentsConfig(
        { agents: { coach: { window_days: "week" } } } as DenConfig,
        {},
      ),
    ).toThrow(/agents\.coach\.window_days/);
  });
});

describe("mapLimited (reading transcripts a few at a time)", () => {
  it("keeps at most `limit` running at once, and the results in order", async () => {
    let now = 0;
    let most = 0;
    const out = await mapLimited(
      Array.from({ length: 20 }, (_, i) => i),
      8,
      async (i) => {
        now++;
        most = Math.max(most, now);
        await new Promise((r) => setTimeout(r, 1));
        now--;
        return i * 2;
      },
    );
    expect(most).toBe(8);
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
    expect(await mapLimited([], 8, async (x) => x)).toEqual([]);
  });
});
