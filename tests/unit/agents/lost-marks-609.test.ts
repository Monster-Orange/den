/**
 * Issue 609: an attention mark Den never took leaves a trace. The hook
 * writes one line to the agent's own files dir (agent-hooks-lost.jsonl:
 * the agent, the event, the reason); `doctor` reads every agent's and
 * shows a row per agent with marks lost in the last day: how many, and
 * the last reason. In en, es and ja.
 * Temp dirs and a fake fetch; no real runtime runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sendAttention } from "../../../src/shared/agents/guardrails/attention-hook.js";
import {
  LOST_FILE,
  LOST_WORDS,
  lostFiles,
  lostMarkLines,
  recordLost,
} from "../../../src/shared/agents/guardrails/lost-marks.js";
import { loadPersonas } from "../../../src/shared/agents/personas.js";
import { getRuntime } from "../../../src/shared/agents/runtimes.js";
import type { LaunchInput } from "../../../src/shared/agents/runtime.js";

const ENV = { DEN_ACTOR_TOKEN: "den_at_TESTONLY_609" };
const EV = { event: "finished", text: "", hooked: true } as const;

let root = "";
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "den-609b-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("issue 609: why a mark was lost", () => {
  it("Den's refusal or no answer: the hook says which", async () => {
    const why: string[] = [];
    expect(
      await sendAttention("http://127.0.0.1:1", EV, {
        env: ENV,
        fetch: async () => new Response("{}", { status: 403 }),
        onMiss: (r) => why.push(r),
      }),
    ).toBe(false);
    expect(
      await sendAttention("http://127.0.0.1:1", EV, {
        env: ENV,
        fetch: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        onMiss: (r) => why.push(r),
      }),
    ).toBe(false);
    expect(why).toEqual(["refused (HTTP 403)", "no answer"]);
  });
});

describe("issue 609: a lost mark leaves a trace", () => {
  it("one line per lost mark, in the state folder", () => {
    const file = path.join(root, "a", LOST_FILE);
    recordLost(file, {
      agent: "planner",
      event: "waiting",
      reason: "no answer",
      at: new Date("2026-11-19T10:00:00Z"),
    });
    recordLost(file, {
      agent: "planner",
      event: "finished",
      reason: "refused (HTTP 403)",
      at: new Date("2026-11-19T10:05:00Z"),
    });
    const rows = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toEqual([
      {
        ts: "2026-11-19T10:00:00.000Z",
        agent: "planner",
        event: "waiting",
        reason: "no answer",
      },
      {
        ts: "2026-11-19T10:05:00.000Z",
        agent: "planner",
        event: "finished",
        reason: "refused (HTTP 403)",
      },
    ]);
  });

  it("never throws, even where it can't write", () => {
    expect(() =>
      recordLost("/nonexistent-609/x/y.jsonl", {
        agent: "a",
        event: "waiting",
        reason: "no answer",
      }),
    ).not.toThrow();
  });

  it("doctor: a row per agent with marks lost in the last day, the count and the last reason", () => {
    const file = path.join(root, "d", LOST_FILE);
    const at = (iso: string) => new Date(iso);
    recordLost(file, {
      agent: "old",
      event: "waiting",
      reason: "no answer",
      at: at("2026-11-17T10:00:00Z"),
    });
    for (const [t, r] of [
      ["2026-11-19T09:00:00Z", "no answer"],
      ["2026-11-19T09:30:00Z", "refused (HTTP 403)"],
    ])
      recordLost(file, {
        agent: "planner",
        event: "waiting",
        reason: r,
        at: at(t),
      });
    recordLost(file, {
      agent: "tester",
      event: "finished",
      reason: "no answer",
      at: at("2026-11-19T08:00:00Z"),
    });
    const now = at("2026-11-19T10:00:00Z");
    const out = lostMarkLines(file, { now, lang: "en", title: "Den" });
    expect(out.checks.map((c) => c.id)).toEqual([
      "attention_lost:planner",
      "attention_lost:tester",
    ]);
    expect(out.checks.every((c) => c.status === "warn")).toBe(true);
    expect(out.checks[0].detail).toBe(
      "planner: 2 attention marks lost in the last day; the last: refused (HTTP 403)",
    );
    expect(out.checks[1].detail).toBe(
      "tester: 1 attention mark lost in the last day; the last: no answer",
    );
    expect(out.lines.join("\n")).toContain("planner: 2 attention marks lost");
    // Nothing lost lately: no row, no lines.
    expect(
      lostMarkLines(file, {
        now: at("2026-11-21T10:00:00Z"),
        lang: "en",
        title: "Den",
      }),
    ).toEqual({ lines: [], checks: [] });
    expect(
      lostMarkLines(path.join(root, "none.jsonl"), {
        now,
        lang: "en",
        title: "Den",
      }),
    ).toEqual({ lines: [], checks: [] });
  });

  it("doctor finds every agent's file under the state dir", () => {
    const state = path.join(root, "state-scan");
    for (const id of ["a1", "a2", "a3"])
      fs.mkdirSync(path.join(state, "agent-files", id), { recursive: true });
    for (const id of ["a1", "a3"])
      recordLost(path.join(state, "agent-files", id, LOST_FILE), {
        agent: id,
        event: "waiting",
        reason: "no answer",
      });
    expect(
      lostFiles(state)
        .map((f) => path.basename(path.dirname(f)))
        .sort(),
    ).toEqual(["a1", "a3"]);
    expect(lostFiles(path.join(root, "no-state"))).toEqual([]);
    expect(
      lostMarkLines(lostFiles(state), { lang: "en", title: "Den" }).checks,
    ).toHaveLength(2);
  });

  it("es and ja have every en line, with the same placeholders", () => {
    const ph = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const en = LOST_WORDS.en;
    for (const lang of ["es", "ja"] as const) {
      const tr = LOST_WORDS[lang];
      expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en) as (keyof typeof en)[])
        expect([lang, k, ph(tr[k])]).toEqual([lang, k, ph(en[k])]);
    }
  });

  it("at launch: the attention hook is told where to record, and for which agent", () => {
    const persona = loadPersonas([]).get("planner")!;
    const inp: LaunchInput = {
      persona,
      workspace: { name: "north", dir: root },
      agentId: persona.id,
      worktree: root,
      mcp: {
        name: "acme",
        command: ["/x/acme", "mcp"],
        env: {},
        scope: "north",
      },
      filesDir: path.join(root, "files", persona.id),
      stateDir: path.join(root, "state"),
      env: {},
      bin: "/nowhere/claude",
      attention: { base: "http://localhost:4100" },
    };
    const out = getRuntime("den-claude")!.launch(inp);
    const { hooks } = JSON.parse(
      out.files![path.join(inp.filesDir, "settings.json")],
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const cmd = hooks.Notification[0].hooks[0].command;
    expect(cmd).toContain(
      `--lost ${path.join(root, "files", persona.id, LOST_FILE)}`,
    );
    expect(cmd).toContain(`--agent ${persona.id}`);
  });
});
