/**
 * D32: an agent's helpers (Claude Code's Agent and Workflow subagents),
 * read from Claude Code's own files, read-only.
 *
 * The fixture (tests/fixtures/claude-helpers/real-shape) is a real
 * helper's meta and transcript, scrubbed: every key, type, entry and
 * block type, stop reason and built-in tool name is as Claude Code wrote
 * it; every other string is a placeholder. Each case copies it into a
 * temp projects dir and changes only what the case is about. The parent's
 * notifications and the workflow file follow the shapes Claude Code
 * writes (<task-notification> in a user turn; wf_*.json with
 * workflowProgress). Invented names only.
 */
import { afterAll, beforeEach, describe, expect, it } from "@jest/globals";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readClaudeHelperTranscript,
  readClaudeHelpers,
  resetHelperCache,
  summarizeToolInput,
} from "../../../src/shared/agents/claude-helpers.js";
import { helperCounts } from "../../../src/shared/agents/helpers.js";

const FIX = path.resolve(__dirname, "../../fixtures/claude-helpers/real-shape");
const REAL_ID = "a1f0c0ffee0000001";
const realMeta = JSON.parse(
  fs.readFileSync(path.join(FIX, `agent-${REAL_ID}.meta.json`), "utf-8"),
) as Record<string, unknown>;
const realLines = fs
  .readFileSync(path.join(FIX, `agent-${REAL_ID}.jsonl`), "utf-8")
  .split("\n")
  .filter(Boolean);
/** The fixture's own clock: its first and last timestamps. */
const T0 = Date.parse("2026-01-05T09:00:00.000Z");
const T_LAST = Math.max(
  ...realLines.map((l) => Date.parse(JSON.parse(l).timestamp ?? "") || 0),
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-helpers-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
let transcript = "";
let sub = "";

beforeEach(() => {
  resetHelperCache();
  const dir = path.join(tmp, `p${++n}`, "-work-north");
  fs.mkdirSync(dir, { recursive: true });
  transcript = path.join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
  fs.writeFileSync(transcript, "");
  sub = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
  fs.mkdirSync(sub, { recursive: true });
});

/** A helper from the real shape: its meta changed by `meta`, its lines by `lines`. */
function helper(
  id: string,
  meta: Record<string, unknown> | null | string,
  lines: (l: string[]) => string[] = (l) => l,
): void {
  if (meta !== null)
    fs.writeFileSync(
      path.join(sub, `agent-${id}.meta.json`),
      typeof meta === "string"
        ? meta
        : JSON.stringify({ ...realMeta, ...meta }, null, 2),
    );
  fs.writeFileSync(
    path.join(sub, `agent-${id}.jsonl`),
    lines(realLines.map((l) => l.split(REAL_ID).join(id))).join("\n") + "\n",
  );
}
/** The fixture without its finished answer: it is mid-turn. */
const midTurn = (l: string[]) => l.slice(0, -2);
/** The real meta less key `k` (JSON drops an undefined value). */
const without = (k: string): Record<string, unknown> => ({ [k]: undefined });

/** What the parent's transcript gets: a task notification, as Claude Code writes it. */
function notify(toolUseId: string, status: string): void {
  const content = `<task-notification>\n<task-id>t-${toolUseId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/work/out.txt</output-file>\n<status>${status}</status>\n<summary>Agent finished</summary>\n</task-notification>`;
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      parentUuid: "p1",
      isSidechain: false,
      type: "user",
      message: { role: "user", content },
      uuid: crypto.randomUUID(),
      timestamp: new Date(T_LAST).toISOString(),
    }) + "\n",
  );
}
/** A foreground helper's answer: the tool result for its Agent call. */
function toolResult(toolUseId: string, isError: boolean): void {
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: toolUseId,
            type: "tool_result",
            content: [{ type: "text", text: "done" }],
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
      timestamp: new Date(T_LAST).toISOString(),
    }) + "\n",
  );
}

const read = (o: Parameters<typeof readClaudeHelpers>[1] = {}) =>
  readClaudeHelpers(transcript, { now: T_LAST + 60_000, ...o });
const one = (id: string, o?: Parameters<typeof readClaudeHelpers>[1]) =>
  read(o).find((h) => h.id === id)!;

describe("the real shape", () => {
  it("reads description, type, model, branch, worktree, background, depth and times", () => {
    helper(REAL_ID, {});
    expect(one(REAL_ID)).toMatchObject({
      id: REAL_ID,
      description: "Write the north report",
      type: "general-purpose",
      model: "sonnet",
      branch: `worktree-agent-${REAL_ID}`,
      worktree: `/work/north/.claude/worktrees/agent-${REAL_ID}`,
      background: true,
      depth: 1,
      startedAt: T0,
      lastActivityAt: T_LAST,
      durationMs: T_LAST - T0,
      lastTool: "Bash",
    });
  });

  it("no helpers folder, or an empty one: none", () => {
    fs.rmSync(sub, { recursive: true });
    expect(read()).toEqual([]);
    expect(readClaudeHelpers(path.join(tmp, "nowhere.jsonl"))).toEqual([]);
  });
});

describe("status, strongest evidence first", () => {
  it("the agent's notification: completed is done, failed is failed, killed is stopped", () => {
    for (const [st, want] of [
      ["completed", "done"],
      ["failed", "failed"],
      ["killed", "stopped"],
    ] as const) {
      const id = `n${st}`;
      helper(id, { ...without("finished"), toolUseId: `toolu_${st}` }, midTurn);
      notify(`toolu_${st}`, st);
      expect([st, one(id).status, one(id).statusFrom]).toEqual([
        st,
        want,
        `the agent's notification (${st})`,
      ]);
    }
  });

  it("the agent's transcript is read on as it grows: a later notification changes it", () => {
    helper(
      "grow",
      { ...without("finished"), toolUseId: "toolu_grow" },
      midTurn,
    );
    expect(one("grow").status).toBe("running");
    notify("toolu_grow", "completed");
    expect(one("grow").status).toBe("done");
  });

  it("a foreground helper is done when its result is back (failed on an error); a background one's launch result doesn't count", () => {
    helper(
      "fg",
      {
        ...without("finished"),
        requestShape: "foreground",
        toolUseId: "toolu_fg",
      },
      midTurn,
    );
    helper(
      "fgx",
      {
        ...without("finished"),
        requestShape: "foreground",
        toolUseId: "toolu_fgx",
      },
      midTurn,
    );
    helper("bg", { ...without("finished"), toolUseId: "toolu_bg" }, midTurn);
    toolResult("toolu_fg", false);
    toolResult("toolu_fgx", true);
    toolResult("toolu_bg", false);
    expect(one("fg").status).toBe("done");
    expect(one("fgx").status).toBe("failed");
    expect(one("bg").status).toBe("running");
  });

  it("finished in the meta is done; stopped by the person wins over everything", () => {
    helper("fin", {}, midTurn);
    helper("stop", { stoppedByUser: true, toolUseId: "toolu_s" });
    notify("toolu_s", "completed");
    expect(one("fin")).toMatchObject({
      status: "done",
      statusFrom: "its meta (finished)",
    });
    expect(one("stop")).toMatchObject({
      status: "stopped",
      statusFrom: "stopped by the person",
    });
  });

  it("no word from anyone: a finished answer gone quiet is done; mid-turn is running while recent, then idle", () => {
    helper("quiet", without("finished"));
    helper("busy", without("finished"), midTurn);
    expect(one("quiet")).toMatchObject({
      status: "done",
      statusFrom: "its last answer",
    });
    // An answer that just ended may be followed by more (under 30 s).
    expect(one("quiet", { now: T_LAST + 10_000 })).toMatchObject({
      status: "running",
      statusFrom: "recent activity",
    });
    expect(one("busy")).toMatchObject({
      status: "running",
      statusFrom: "recent activity",
    });
    const later = T_LAST + 11 * 60_000;
    expect(one("busy", { now: later })).toMatchObject({ status: "idle" });
    // agents.helpers.active_minutes is a setting.
    expect(
      one("busy", { now: later, settings: { activeMinutes: 30 } }).status,
    ).toBe("running");
  });

  it("an agent that isn't running has no running helpers", () => {
    helper("orphan", without("finished"), midTurn);
    expect(one("orphan", { agentLive: false })).toMatchObject({
      status: "stopped",
      statusFrom: "its agent isn't running",
    });
  });

  it("a running helper's duration runs to now; an ended one's to its last activity", () => {
    helper("busy", without("finished"), midTurn);
    const now = T_LAST + 60_000;
    const h = one("busy", { now });
    expect(h.durationMs).toBe(now - T0);
    helper("fin", {});
    expect(one("fin", { now }).durationMs).toBe(T_LAST - T0);
  });
});

describe("workflows", () => {
  function workflow(
    agents: Record<string, unknown>[],
    status = "completed",
  ): void {
    const dir = path.join(transcript.replace(/\.jsonl$/, ""), "workflows");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "wf_0a1b2c3d-4e5.json"),
      JSON.stringify({
        runId: "wf_0a1b2c3d-4e5",
        timestamp: new Date(T0).toISOString(),
        workflowName: "north-review",
        status,
        startTime: T0,
        phases: [{ title: "Review", detail: "…" }],
        workflowProgress: [
          { type: "workflow_phase", index: 0, title: "Review" },
          ...agents.map((a, i) => ({
            type: "workflow_agent",
            index: i,
            label: `review:${i}`,
            phaseIndex: 0,
            phaseTitle: "Review",
            model: "claude-haiku-5-5",
            startedAt: T0,
            queuedAt: T0,
            attempt: 1,
            lastToolName: "Grep",
            promptPreview: "…",
            tokens: 10,
            toolCalls: 2,
            durationMs: 4200,
            ...a,
          })),
        ],
        futureField: { anything: true },
      }),
    );
  }

  it("a workflow agent: its run, phase and label; error is failed, done is done; the run's own toolUseId notification doesn't decide it", () => {
    helper(
      "w1",
      { ...without("finished"), toolUseId: "toolu_wf", description: undefined },
      midTurn,
    );
    helper("w2", { ...without("finished"), toolUseId: "toolu_wf" }, midTurn);
    workflow([
      { agentId: "w1", state: "error" },
      { agentId: "w2", state: "done" },
    ]);
    notify("toolu_wf", "completed");
    expect(one("w1")).toMatchObject({
      status: "failed",
      statusFrom: "its workflow",
      description: "review:0",
      workflow: {
        runId: "wf_0a1b2c3d-4e5",
        name: "north-review",
        phase: "Review",
        label: "review:0",
      },
      durationMs: 4200,
    });
    expect(one("w2").status).toBe("done");
  });

  it("an agent still at start in a killed run is stopped", () => {
    helper("w3", without("finished"), midTurn);
    workflow([{ agentId: "w3", state: "start" }], "killed");
    expect(one("w3")).toMatchObject({
      status: "stopped",
      statusFrom: "its workflow (killed)",
    });
  });
});

describe("format drift", () => {
  it("no meta: the bare id, its model from its own transcript; a broken meta the same; unknown fields ignored", () => {
    helper("bare", null);
    helper("broken", "{ not json");
    helper("odd", {
      description: 42,
      spawnDepth: "two",
      someNewThing: { x: 1 },
      model: undefined,
      pickedEffortModel: "claude-opus-5-5",
    });
    const bare = one("bare");
    expect(bare.description).toBeUndefined();
    expect(bare.type).toBeUndefined();
    expect(bare.model).toBe("claude-sonnet-5-5");
    expect(one("broken").id).toBe("broken");
    const odd = one("odd");
    expect(odd.description).toBeUndefined();
    expect(odd.depth).toBe(1);
    expect(odd.model).toBe("claude-opus-5-5");
  });

  it("a helper's helpers: parentId and depth", () => {
    helper("top", {});
    helper("kid", { spawnDepth: 2, parentAgentId: "top" });
    expect(one("kid")).toMatchObject({ depth: 2, parentId: "top" });
  });

  it("a meta with no transcript yet still lists; junk files are ignored", () => {
    fs.writeFileSync(
      path.join(sub, "agent-early.meta.json"),
      JSON.stringify(realMeta),
    );
    fs.writeFileSync(path.join(sub, "notes.txt"), "x");
    fs.writeFileSync(path.join(sub, "agent-../x.jsonl".replace("/", "_")), "x");
    const ids = read().map((h) => h.id);
    expect(ids).toContain("early");
    expect(ids).not.toContain("notes");
  });

  it("running first, then the newest; counts for a badge", () => {
    helper("old", {});
    helper("busy", without("finished"), midTurn);
    const hs = read();
    expect(hs[0].id).toBe("busy");
    expect(helperCounts(hs)).toEqual({ running: 1, total: 2 });
  });
});

describe("a helper's transcript", () => {
  it("the prompt, its words, tool calls summarized, their results; never thinking or bookkeeping", () => {
    helper(REAL_ID, {});
    const t = readClaudeHelperTranscript(transcript, REAL_ID, {
      now: T_LAST + 60_000,
    })!;
    expect(t.helper.id).toBe(REAL_ID);
    const kinds = t.items.map((i) => i.kind);
    expect(kinds[0]).toBe("prompt");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("result");
    expect(t.items.find((i) => i.kind === "tool")).toMatchObject({
      tool: "Bash",
      text: "make test",
    });
    expect(t.items.at(-1)).toMatchObject({
      kind: "text",
      text: "Lorem ipsum dolor sit amet.",
    });
    expect(JSON.stringify(t)).not.toMatch(/"thinking"|signature/);
    expect(t.omitted).toBe(0);
  });

  it("the last lines only, saying how many were left out", () => {
    helper(REAL_ID, {});
    const t = readClaudeHelperTranscript(transcript, REAL_ID, { limit: 2 })!;
    expect(t.items).toHaveLength(2);
    expect(t.omitted).toBeGreaterThan(0);
  });

  it("an unknown or unsafe id: null", () => {
    helper(REAL_ID, {});
    expect(readClaudeHelperTranscript(transcript, "nope")).toBeNull();
    expect(readClaudeHelperTranscript(transcript, "../../etc")).toBeNull();
  });

  it("tool inputs in a few words", () => {
    expect(summarizeToolInput("Read", { file_path: "/a/b.ts" })).toBe(
      "/a/b.ts",
    );
    expect(
      summarizeToolInput("Bash", {
        command: "a\n  b",
        description: "List files",
      }),
    ).toBe("List files");
    // A search: what it looks for first (the gate saw "manifests", its path).
    expect(
      summarizeToolInput("Grep", { pattern: "TODO", path: "manifests" }),
    ).toBe("TODO in manifests");
    expect(summarizeToolInput("Glob", { pattern: "**/*.yml" })).toBe(
      "**/*.yml",
    );
    expect(summarizeToolInput("X", { foo: 1, bar: 2 })).toBe("X(foo, bar)");
    expect(summarizeToolInput("X", {})).toBe("X");
  });
});

describe("read-only", () => {
  it("never writes in Claude Code's folder", () => {
    helper(REAL_ID, {});
    helper("busy", without("finished"), midTurn);
    notify("toolu_FIXTURE01", "completed");
    const snap = () => {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else {
            const st = fs.statSync(p);
            out.push(
              `${p} ${st.size} ${st.mtimeMs} ${crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex")}`,
            );
          }
        }
      };
      walk(path.dirname(transcript));
      return out.sort();
    };
    const before = snap();
    read();
    readClaudeHelperTranscript(transcript, REAL_ID);
    expect(snap()).toEqual(before);
  });
});
