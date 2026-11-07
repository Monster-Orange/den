/**
 * The session-rotation metric (den#4), measured on a fixture by `<cli> usage
 * report`'s own numbers (report.ts weeklyMetrics):
 *
 *   long_session_context_k   the highest average context per call of any
 *                            main session (input, cache reads and writes,
 *                            over its calls), in thousands of tokens
 *   never_ending_reread_pct  the share of cache reads from main sessions
 *                            that compacted more often than the rotation
 *                            limit (agents.rotate.after_compactions, 3)
 *
 * The fixture models how a Claude Code session grows. A session is runs of
 * 40 calls between compactions. A run starts at a 40k baseline plus 40k for
 * each compaction before it (what the summaries and re-read files carry),
 * and each call adds 2k.
 *
 *   Before: 15 never-ending sessions (16 compactions each) and 127 that end
 *   within 3 compactions. The same shape as the field report: the long
 *   sessions average about 400k per call (field: 365–510k), and they hold
 *   about 59% of the re-reads (field: 59%).
 *   After: the same work, but each long session rotates after its third
 *   compaction and relaunches from its handoff at the baseline.
 *   Target: under 150k per call, and under 15% of re-reads.
 *
 * Invented transcripts only, written to a temp dir.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentFilesDir,
  writeRecord,
} from "../../../src/shared/agents/records.js";
import {
  launchRotation,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import {
  weeklyMetrics,
  type AgentUsageRow,
} from "../../../src/shared/usage/report.js";
import {
  mineTranscript,
  type TranscriptStats,
} from "../../../src/shared/usage/transcript.js";
import { cmdUsage } from "../../../src/ui/cli/usage-command.js";
import { token, writeUsageFixture } from "./fixture.js";

const BASE = 40_000;
const CARRY = 40_000;
const STEP = 2_000;
const RUN = 40;
const T0 = Date.parse("2026-11-01T09:00:00.000Z");

let dir = "";
let file = 0;
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-rotm-")));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A transcript of `runs` runs (runs - 1 compactions). */
function session(runs: number): string {
  const f = path.join(dir, `s${++file}.jsonl`);
  const lines: string[] = [];
  let at = T0;
  for (let j = 0; j < runs; j++) {
    if (j)
      lines.push(
        JSON.stringify({
          type: "system",
          subtype: "compact_boundary",
          timestamp: new Date((at += 1000)).toISOString(),
        }),
      );
    for (let k = 0; k < RUN; k++) {
      const context = BASE + CARRY * j + STEP * k;
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: new Date((at += 1000)).toISOString(),
          message: {
            id: `m${file}-${j}-${k}`,
            model: "claude-opus-5-5",
            usage: {
              input_tokens: 10,
              output_tokens: 200,
              cache_creation_input_tokens: 1_000,
              cache_read_input_tokens: context - 1_010,
            },
            content: [{ type: "text", text: "working" }],
          },
        }),
      );
    }
  }
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

/** 16 compactions in one session, or rotated after each third. */
const LONG_RUNS = 17;
const LONG = 15;
const SHORT = 127;

async function mine(files: string[]): Promise<TranscriptStats[]> {
  return Promise.all(files.map((f) => mineTranscript(f)));
}

describe("session rotation's metric, on the fixture", () => {
  let before: ReturnType<typeof weeklyMetrics>;
  let after: ReturnType<typeof weeklyMetrics>;

  beforeAll(async () => {
    const short = Array.from({ length: SHORT }, () => session(4));
    const long = Array.from({ length: LONG }, () => session(LONG_RUNS));
    // Rotated: a new conversation every 4 runs (after 3 compactions).
    const rotated: string[] = [];
    for (let i = 0; i < LONG; i++)
      for (let left = LONG_RUNS; left > 0; left -= 4)
        rotated.push(session(Math.min(4, left)));
    const shortStats = await mine(short);
    before = weeklyMetrics([...shortStats, ...(await mine(long))]);
    after = weeklyMetrics([...shortStats, ...(await mine(rotated))]);
  }, 60_000);

  it("before: never-ending sessions run at 365–510k per call and hold about 59% of re-reads", () => {
    expect(before.long_session_context_k).toBeGreaterThanOrEqual(365);
    expect(before.long_session_context_k).toBeLessThanOrEqual(510);
    expect(before.long_session_context_k).toBe(399);
    expect(before.never_ending_reread_pct).toBe(59);
  });

  it("after: under 150k per call, and under 15% of re-reads from never-ending sessions", () => {
    expect(after.long_session_context_k).toBeLessThan(150);
    expect(after.long_session_context_k).toBe(139);
    expect(after.never_ending_reread_pct).toBeLessThan(15);
    expect(after.never_ending_reread_pct).toBe(0);
    // The same calls, fewer tokens re-read.
    expect(after.calls).toBe(before.calls);
    expect(after.cache_read_B).toBeLessThan(before.cache_read_B);
  });

  it("the limit is the report's: 3 compactions is not never-ending; past agents.rotate.after_compactions is", async () => {
    const [three] = await mine([session(4)]);
    expect(three.compactions).toBe(3);
    expect(weeklyMetrics([three]).never_ending_reread_pct).toBe(0);
    expect(weeklyMetrics([three], undefined, 2).never_ending_reread_pct).toBe(
      100,
    );
  });
});

describe("`usage agents` and session rotation", () => {
  it("reports each agent's compactions and rotations, and marks a merged PR's rotation due", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "den-rotu-")),
    );
    try {
      const f = writeUsageFixture(root);
      const env = { HOME: root, CLAUDE_CONFIG_DIR: path.join(root, "claude") };
      // agent-1 merged its pull request; agent-2 was relaunched once.
      launchRotation(agentFilesDir(f.stateDir, "agent-1"), token(1), 3);
      launchRotation(agentFilesDir(f.stateDir, "agent-2"), token(2), 3);
      writeRecord(f.stateDir, {
        ...f.records[1],
        rotations: [
          {
            at: "2026-11-05T12:00:00.000Z",
            reason: "compactions",
            compactions: 3,
          },
        ],
      });
      const out: string[] = [];
      const run = (args: string[]) =>
        cmdUsage(args, {
          stateDir: () => f.stateDir,
          env,
          out: (l) => out.push(l),
          err: () => undefined,
          rotateAfter: () => ({ afterCompactions: 3 }),
          // gh confirms agent-1's merge.
          prState: async () => "MERGED",
        });
      expect(await run(["agents", "--json"])).toBe(0);
      const rows = (JSON.parse(out.join("\n")) as { agents: AgentUsageRow[] })
        .agents;
      expect(rows.find((r) => r.agent === "agent-1")).toMatchObject({
        compactions: 1,
        rotations: 0,
      });
      expect(rows.find((r) => r.agent === "agent-2")?.rotations).toBe(1);
      expect(readRotation(agentFilesDir(f.stateDir, "agent-1"))?.due).toBe(
        "pr-merged",
      );
      expect(readRotation(agentFilesDir(f.stateDir, "agent-2"))?.due).toBe(
        undefined,
      );
      out.length = 0;
      expect(await run(["agents"])).toBe(0);
      expect(out[0]).toMatch(/COMPACTIONS\s+ROTATIONS$/);
      out.length = 0;
      expect(await run(["report", "--json"])).toBe(0);
      const m = JSON.parse(out.join("\n")) as Record<string, number>;
      expect(m.rotations).toBe(1);
      expect(typeof m.long_session_context_k).toBe("number");
      expect(typeof m.never_ending_reread_pct).toBe("number");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
