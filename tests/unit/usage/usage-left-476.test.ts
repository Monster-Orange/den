/**
 * Issue 476: how much usage is left, as Den can count it. Tokens used in
 * the session window and the week, from transcripts, against caps that are
 * Settings (user.yml `usage:`; 0 = no cap, the default). Never the
 * provider's real quota, which Den can't read. Coach reuses this reader.
 */
import { describe, expect, it } from "@jest/globals";
import {
  leftPct,
  readUsageLeft,
  usageCaps,
} from "../../../src/shared/usage/left.js";
import type { TranscriptStats } from "../../../src/shared/usage/transcript.js";
import type { UsageSource } from "../../../src/shared/usage/sources.js";

const stats = (input: number, output: number): TranscriptStats =>
  ({
    file: "x",
    subagent: false,
    calls: 1,
    tokens: { input, output, cacheRead: 999_999, cacheWrite: 0 },
    models: {},
    tools: {},
    toolErrors: {},
    denials: 0,
    polls: 0,
    sleepSeconds: 0,
    compactions: 0,
    prompts: 0,
    corrections: 0,
    interrupts: 0,
    agentSpawns: 0,
    activeSeconds: 0,
    prMerges: [],
  }) as TranscriptStats;

/** A source whose one file holds `tokens` inside any window from `fromMs` on. */
const source = (
  perWindow: (since: number) => TranscriptStats,
  fail = false,
): UsageSource => ({
  id: "fake",
  runtimes: ["den-claude"],
  root: () => "/nowhere",
  agentFiles: () => [],
  files: () => {
    if (fail) throw new Error("unreadable");
    return ["a.jsonl"];
  },
  mine: async (_f, o) => perWindow(o?.since ?? 0),
});

describe("usage caps", () => {
  it("are off by default; bad values are off", () => {
    expect(usageCaps({})).toEqual({
      sessionTokens: 0,
      sessionHours: 5,
      weeklyTokens: 0,
    });
    expect(
      usageCaps({
        usage: {
          session_token_cap: 2_000_000,
          session_hours: 0,
          weekly_token_cap: -4,
        },
      }),
    ).toEqual({ sessionTokens: 2_000_000, sessionHours: 5, weeklyTokens: 0 });
  });
});

describe("usage left", () => {
  it("no cap is all left; a cap gives the share left, never below 0", () => {
    expect(leftPct(5_000, 0)).toBe(100);
    expect(leftPct(250, 1000)).toBe(75);
    expect(leftPct(1500, 1000)).toBe(0);
  });

  it("counts input, output and cache writes in each window, not cache reads", async () => {
    const now = Date.parse("2026-11-22T20:00:00Z");
    const week = now - 7 * 24 * 3600_000;
    const src = source((since) =>
      since <= week ? stats(600_000, 200_000) : stats(150_000, 50_000),
    );
    const left = await readUsageLeft(
      { sessionTokens: 1_000_000, sessionHours: 5, weeklyTokens: 2_000_000 },
      { sources: [src], now },
    );
    expect(left).toEqual({ sessionLeftPct: 80, weeklyLeftPct: 60 });
  });

  it("transcripts it can't read: null, so the caller fails closed", async () => {
    const left = await readUsageLeft(
      { sessionTokens: 1000, sessionHours: 5, weeklyTokens: 0 },
      { sources: [source(() => stats(0, 0), true)], now: Date.now() },
    );
    expect(left).toBeNull();
  });

  it("with no caps it reads nothing and reports all left", async () => {
    const left = await readUsageLeft(usageCaps({}), {
      sources: [source(() => stats(0, 0), true)],
      now: Date.now(),
    });
    expect(left).toEqual({ sessionLeftPct: 100, weeklyLeftPct: 100 });
  });
});
