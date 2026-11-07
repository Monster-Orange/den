/**
 * den#6: the `usage` plugin kind and its built-in source (Claude Code's
 * transcripts), joined to agent records on resumeToken, with outcomes (PR
 * opened or merged, tests green, wall-clock) kept in the record.
 *
 * The scorecard metric, measured on the fixture (fixture.ts): the share of
 * agent sessions with attributed tokens and outcome. Before: no record
 * carries either (0%). After: 10 of 11 (91%; the codex agent has no source).
 *
 * It reads locally and never sends: the usage modules import no network
 * code, and `usage` reads only the files it is pointed at.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listRecords } from "../../../src/shared/agents/records.js";
import { KIND_TIERS } from "../../../src/shared/plugins/manifest.js";
import {
  agentUsage,
  attributedPct,
  renderReport,
  weeklyMetrics,
} from "../../../src/shared/usage/report.js";
import {
  claudeCodeSource,
  sourceFor,
  usageSources,
} from "../../../src/shared/usage/sources.js";
import { mineTranscript } from "../../../src/shared/usage/transcript.js";
import { cmdUsage } from "../../../src/ui/cli/usage-command.js";
import { token, writeUsageFixture } from "./fixture.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-usage-")),
  );
  tmps.push(dir);
  const f = writeUsageFixture(dir);
  const env = { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, "claude") };
  return { dir, env, ...f };
}

describe("the usage plugin kind", () => {
  it("is a server-tier kind, with Claude Code's transcripts as Den's built-in source", () => {
    expect(KIND_TIERS.usage).toBe("server");
    expect(usageSources().map((s) => s.id)).toContain("claude-code");
    expect(sourceFor("den-claude")?.id).toBe("claude-code");
    expect(sourceFor("codex")).toBeUndefined();
  });

  it("reads $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects", () => {
    expect(claudeCodeSource.root({ HOME: "/h" })).toBe("/h/.claude/projects");
    expect(claudeCodeSource.root({ HOME: "/h", CLAUDE_CONFIG_DIR: "/c" })).toBe(
      "/c/projects",
    );
  });

  it("an agent's files are its conversation's and its subagents', by its token only", () => {
    const f = fixture();
    expect(
      claudeCodeSource.agentFiles(token(2), f.env).map((x) => path.basename(x)),
    ).toEqual([`${token(2)}.jsonl`, "agent-explore.jsonl"]);
    expect(claudeCodeSource.agentFiles("../etc", f.env)).toEqual([]);
  });

  it("the usage modules import no network code: it reads locally and never sends", () => {
    const dir = path.join(process.cwd(), "src", "shared", "usage");
    const files = fs.readdirSync(dir).filter((x) => x.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of [
      ...files.map((x) => path.join(dir, x)),
      path.join(process.cwd(), "src", "ui", "cli", "usage-command.ts"),
    ]) {
      const src = fs.readFileSync(file, "utf-8");
      expect([
        file,
        /from "(https?|net|dgram|tls|child_process)"|\bfetch\(|XMLHttpRequest|WebSocket/.test(
          src,
        ),
      ]).toEqual([file, false]);
    }
  });
});

describe("one transcript", () => {
  it("counts tokens once per message, tools, polls, compactions, prompts and corrections, and the outcome", async () => {
    const f = fixture();
    const [file] = claudeCodeSource.agentFiles(token(1), f.env);
    const s = await mineTranscript(file);
    expect(s.calls).toBe(5);
    expect(s.tokens).toEqual({
      input: 50,
      output: 1000,
      cacheRead: 200_000,
      cacheWrite: 5000,
    });
    expect(s.tools).toEqual({ Bash: 3 });
    expect(s.compactions).toBe(1);
    expect(s.prompts).toBe(1);
    expect(s).toMatchObject({
      prOpened: "https://github.com/acme/notes/pull/101",
      prMerged: true,
      testsGreen: true,
    });
    expect(s.last! - s.first!).toBe(900_000);
    const red = await mineTranscript(
      claudeCodeSource.agentFiles(token(5), f.env)[0],
    );
    expect(red.testsGreen).toBe(false);
    expect(red.toolErrors).toEqual({ Bash: 1 });
    const polled = await mineTranscript(
      claudeCodeSource.agentFiles(token(7), f.env)[0],
    );
    expect(polled).toMatchObject({
      polls: 1,
      sleepSeconds: 30,
      corrections: 1,
      prompts: 2,
    });
    expect(polled.testsGreen).toBeUndefined();
  });

  it("keeps counts, never text: no prompt or output reaches what it returns", async () => {
    const f = fixture();
    const s = await mineTranscript(
      claudeCodeSource.agentFiles(token(7), f.env)[0],
    );
    const out = JSON.stringify(s);
    expect(out).not.toMatch(/plan the release|stop polling|curl localhost/);
  });
});

describe("joined on resumeToken (the scorecard metric)", () => {
  it("before: no record carries tokens or an outcome (0%)", () => {
    const f = fixture();
    const recs = listRecords(f.stateDir);
    const before =
      recs.filter((r) => r.usage && r.outcome).length / recs.length;
    expect(before).toBe(0);
  });

  it("after: 10 of 11 agent sessions have attributed tokens and outcome (91%, at least 90%)", async () => {
    const f = fixture();
    const rows = await agentUsage(listRecords(f.stateDir), { env: f.env });
    expect(rows).toHaveLength(11);
    const pct = attributedPct(rows);
    expect(pct).toBe(91);
    expect(pct).toBeGreaterThanOrEqual(90);
    expect(rows.find((r) => r.agent === "coder")).toMatchObject({
      attributed: false,
      why: "no usage source reads codex",
    });
    // Its own 4 calls and its subagent's 2.
    expect(rows.find((r) => r.agent === "agent-2")?.usage?.calls).toBe(6);
    expect(rows.find((r) => r.agent === "agent-1")?.outcome).toEqual({
      wallClockMs: 900_000,
      prOpened: "https://github.com/acme/notes/pull/101",
      prMerged: true,
      testsGreen: true,
    });
  });

  it("`usage agents` saves each agent's usage and outcome in its record", async () => {
    const f = fixture();
    const out: string[] = [];
    expect(
      await cmdUsage(["agents", "--json"], {
        stateDir: () => f.stateDir,
        env: f.env,
        out: (l) => out.push(l),
        err: () => undefined,
      }),
    ).toBe(0);
    expect(JSON.parse(out.join("\n")).attributedPct).toBe(91);
    const recs = listRecords(f.stateDir);
    const after = recs.filter((r) => r.usage && r.outcome).length;
    expect(after).toBe(10);
    expect(recs.find((r) => r.id === "agent-3")?.outcome?.prOpened).toBe(
      "https://github.com/acme/notes/pull/103",
    );
  });
});

describe("the weekly report", () => {
  it("computes the numbers to move and writes <date>.json and .md, compared with the last", async () => {
    const f = fixture();
    const usageDir = path.join(f.stateDir, "usage");
    fs.mkdirSync(usageDir, { recursive: true });
    fs.writeFileSync(
      path.join(usageDir, "2026-11-01.json"),
      JSON.stringify({ polls: 4, attributed_pct: 0, calls: 10 }),
    );
    const out: string[] = [];
    // Its transcripts' files were written now: a window ending now holds them.
    expect(
      await cmdUsage(["report", "--days", "7"], {
        stateDir: () => f.stateDir,
        env: f.env,
        now: () => new Date(Date.now() + 1000),
        out: (l) => out.push(l),
        err: () => undefined,
      }),
    ).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/Compared with 2026-11-01/);
    expect(text).toMatch(/\| polls \| 1 \| 4 \| -3 better \|/);
    expect(text).toMatch(/\| attributed_pct \| 91 \|/);
    expect(text).toMatch(/nothing was sent anywhere/);
    const written = fs
      .readdirSync(usageDir)
      .filter((x) => x !== "2026-11-01.json");
    expect(written.some((x) => x.endsWith(".md"))).toBe(true);
    expect(written.some((x) => x.endsWith(".json"))).toBe(true);
  });

  it("subagents on Opus, context re-reads and corrections, as the miner reported them", async () => {
    const f = fixture();
    const stats = await Promise.all(
      claudeCodeSource.files(0, f.env).map((x) => mineTranscript(x)),
    );
    const m = weeklyMetrics(stats);
    expect(m.subagent_opus_pct).toBe(0);
    expect(m.polls).toBe(1);
    expect(m.correction_pct).toBe(9.1);
    expect(renderReport(m, "2026-11-07")).toMatch(
      /^# Agent usage, week to 2026-11-07/,
    );
  });

  it("--days must be a number of days (exit 2)", async () => {
    const err: string[] = [];
    expect(
      await cmdUsage(["report", "--days", "x"], {
        stateDir: () => "/nonexistent",
        out: () => undefined,
        err: (l) => err.push(l),
      }),
    ).toBe(2);
    expect(err.join("\n")).toMatch(/--days must be a number of days/);
  });
});
