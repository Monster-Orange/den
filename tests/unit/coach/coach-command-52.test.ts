/**
 * Issue 52: `<cli> coach run|show`, the Coach's read-only run by hand.
 * Off by default; on, it saves the report under the state dir and prints
 * it in short lines.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import { COACH_DEFAULTS } from "../../../src/shared/coach/settings.js";
import {
  coachRunsDir,
  readCoachReport,
} from "../../../src/shared/coach/store.js";
import { dismissFinding } from "../../../src/shared/coach/findings.js";
import { cmdCoach } from "../../../src/ui/cli/coach-command.js";
import type { UsageSource } from "../../../src/shared/usage/sources.js";
import type { TranscriptStats } from "../../../src/shared/usage/transcript.js";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const state = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-coach-cli-"));
  tmp.push(d);
  return d;
};

const rec = (id: string, token?: string): AgentRecord =>
  ({
    id,
    workspace: "shop",
    persona: "builder",
    runtime: "den-claude",
    session: { host: "local", id: `s-${id}` },
    sessionName: `shop-${id}`,
    startedAt: "2026-11-01T00:00:00.000Z",
    ...(token ? { resumeToken: token } : {}),
  }) as AgentRecord;

const stats = (file: string): TranscriptStats => ({
  file,
  subagent: false,
  calls: 14,
  tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  models: { "claude-sonnet-5-5": 14 },
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
});

const source: UsageSource = {
  id: "fake",
  runtimes: ["den-claude"],
  root: () => "/fake",
  agentFiles: (t) => [`${t}.jsonl`],
  files: () => [],
  mine: async (f) => stats(f),
};

function run(args: string[], st: string, enabled: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  const code = cmdCoach(args, {
    stateDir: () => st,
    now: () => NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    settings: () => ({ ...COACH_DEFAULTS, enabled }),
    source: () => source,
    rotateAfter: () => 3,
  });
  return code.then((c) => ({ code: c, out, err }));
}

describe("coach run", () => {
  it("refuses while the Coach is off, and saves nothing", async () => {
    const st = state();
    const r = await run(["run"], st, false);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /The Coach is off\. Turn it on with agents\.coach\.enabled: true/,
    );
    expect(fs.existsSync(coachRunsDir(st))).toBe(false);
  });

  it("on: saves the report and prints the window, its cost and each agent", async () => {
    const st = state();
    writeRecord(st, rec("builder", "c1"));
    writeRecord(st, rec("idle"));
    const r = await run(["run"], st, true);
    expect(r.code).toBe(0);
    expect(readCoachReport(st)?.agents.map((a) => a.agent)).toEqual([
      "builder",
      "idle",
    ]);
    const text = r.out.join("\n");
    expect(text).toContain("Coach, Nov 15 to Nov 22 (7 days).");
    expect(text).toContain("This run called no model: it only counts.");
    expect(text).toContain(
      "builder (shop): 14 calls (2 a day), 1 conversation,",
    );
    expect(text).toContain("idle (shop): no conversation in the window.");
  });

  it("--json prints the saved report", async () => {
    const st = state();
    writeRecord(st, rec("builder", "c1"));
    const r = await run(["run", "--json"], st, true);
    expect(JSON.parse(r.out.join("\n"))).toEqual(readCoachReport(st));
  });
});

describe("coach show", () => {
  it("with no report yet, says how to make one", async () => {
    const r = await run(["show"], state(), true);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /No Coach report yet\. Run .+ coach run first\./,
    );
  });

  it("prints the last run", async () => {
    const st = state();
    writeRecord(st, rec("builder", "c1"));
    await run(["run"], st, true);
    const r = await run(["show"], st, true);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("builder (shop): 14 calls");
  });

  it("an unknown command is a usage error", async () => {
    const r = await run(["apply"], state(), true);
    expect(r.code).toBe(2);
    expect(r.err[0]).toBe('✗ unknown coach command "apply"');
  });
});

describe("findings in the printed report", () => {
  it("none: says so", async () => {
    const st = state();
    writeRecord(st, rec("builder", "c1"));
    const r = await run(["run"], st, true);
    expect(r.out).toContain("No open findings.");
  });

  it("one: printed with its proposal and id; once dismissed, it stays out", async () => {
    const st = state();
    writeRecord(st, rec("builder", "c1"));
    const polling: UsageSource = {
      ...source,
      mine: async (f) => ({ ...stats(f), polls: 210 }),
    };
    const go = async (sub: string) => {
      const out: string[] = [];
      await cmdCoach([sub], {
        stateDir: () => st,
        now: () => NOW,
        out: (l) => out.push(l),
        err: () => {},
        settings: () => ({ ...COACH_DEFAULTS, enabled: true }),
        source: () => polling,
        rotateAfter: () => 3,
      });
      return out.join("\n");
    };
    const first = await go("run");
    expect(first).toContain("1 open finding");
    expect(first).toContain("- builder (shop) polls 30 times a day.");
    expect(first).toContain("(polling:builder)");
    dismissFinding(st, "polling:builder", "It waits on CI.", "person");
    expect(await go("show")).toContain("No open findings.");
    expect(await go("run")).toContain("No open findings.");
  });
});
