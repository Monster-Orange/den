/**
 * Issue 1407: after "Restart N agents at their next idle", the page shows
 * each agent's own answer, never a fixed "N agents restart" line:
 * restarting now, after its turn, waiting on a background job (what it
 * runs and how long) or can't tell. Those that wait on the person get
 * Restart now (ending the job), and two or more get Restart all now.
 * Every line is a message key (en/es/ja).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { restartResultHtml } from "../../../src/ui/server/public/settings-registry.js";
import {
  followRestarts,
  mergeLive,
  restartLine,
  waitsOnPerson,
} from "../../../src/ui/server/public/restart-result.js";

const t = (k: string, v?: Record<string, unknown>) =>
  `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`;

const plan = [
  { id: "ana", workspace: "north", state: "now" },
  { id: "bo", workspace: "north", state: "turn" },
  {
    id: "cy",
    workspace: "south",
    state: "job",
    job: { command: "npm run dev", minutes: 12 },
  },
  { id: "di", workspace: "south", state: "unknown" },
];

describe("issue 1407: the page shows each agent's answer", () => {
  it("a line per agent, in its own words", () => {
    const h = restartResultHtml(plan, t);
    expect(h).toContain("[rs.now:ana]");
    expect(h).toContain("[rs.turn:bo]");
    expect(h).toContain("[rs.job:cy|npm run dev|12]");
    expect(h).toContain("[rs.unknown:di]");
    expect(h).not.toMatch(/restart at their next idle/);
  });

  it("Restart now for each that waits on the person; Restart all now for two or more", () => {
    const h = restartResultHtml(plan, t);
    expect(h).toContain('data-rs-now="cy" data-rs-ws="south"');
    expect(h).toContain('data-rs-now="di" data-rs-ws="south"');
    expect(h).not.toContain('data-rs-now="ana"');
    expect(h).not.toContain('data-rs-now="bo"');
    expect(h).toContain("[rs.nowJob]");
    expect(h).toContain("[rs.nowBtn]");
    expect(h.match(/data-rs-all/g)).toHaveLength(1);
    expect(h).toContain("[rs.all:2]");
  });

  it("one that waits: no Restart all; none: a plain line", () => {
    const h = restartResultHtml(plan.slice(0, 3), t);
    expect(h).not.toContain("data-rs-all");
    expect(restartResultHtml([], t)).toContain("[rs.none]");
  });

  it("a command's text is escaped", () => {
    const h = restartResultHtml(
      [
        {
          id: "cy",
          workspace: "south",
          state: "job",
          job: { command: "<b>x</b>", minutes: 1 },
        },
      ],
      (k: string, v?: Record<string, unknown>) => `${k} ${v?.cmd ?? ""}`,
    );
    expect(h).not.toContain("<b>");
    expect(h).toContain("&lt;b&gt;");
  });

  it("every key is in en, es and ja", () => {
    const root = path.join(__dirname, "../../../src/ui/server/public");
    const keys = [
      "rs.now",
      "rs.turn",
      "rs.job",
      "rs.unknown",
      "rs.nowJob",
      "rs.nowBtn",
      "rs.all",
      "rs.none",
      "rs.done",
      "rs.failed",
      "rs.bar",
      "rs.barBtn",
      "rs.allName",
      "rs.timedOut",
    ];
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const src = fs.readFileSync(path.join(root, f), "utf-8");
      for (const k of keys)
        expect({ f, k, has: src.includes(`"${k}"`) }).toEqual({
          f,
          k,
          has: true,
        });
    }
  });
});

describe("issue 1407 part 2: the page follows each agent live and clears", () => {
  it("restarted and a wait that ran out have their own lines; a timed-out one waits on the person", () => {
    expect(restartLine({ id: "ana", state: "restarted" }, t)).toBe(
      "[rs.done:ana]",
    );
    expect(restartLine({ id: "bo", state: "timedOut", minutes: 30 }, t)).toBe(
      "[rs.timedOut:bo|30]",
    );
    expect(waitsOnPerson({ state: "timedOut" })).toBe(true);
    expect(waitsOnPerson({ state: "failed" })).toBe(true);
    expect(waitsOnPerson({ state: "restarted" })).toBe(false);
    const h = restartResultHtml(
      [{ id: "bo", workspace: "north", state: "timedOut", minutes: 30 }],
      t,
    );
    expect(h).toContain('data-rs-now="bo" data-rs-ws="north"');
  });

  it("mergeLive: the server's rows replace the page's for the same agents; one the server no longer lists has cleared", () => {
    const shown = [
      { id: "ana", workspace: "north", state: "now" },
      { id: "bo", workspace: "north", state: "turn" },
      { id: "cy", workspace: "south", state: "job" },
    ];
    const live = [
      { id: "bo", workspace: "north", state: "timedOut", minutes: 30 },
      { id: "cy", workspace: "south", state: "restarted" },
      // Another run's agent: not this page's.
      { id: "di", workspace: "south", state: "turn" },
    ];
    expect(mergeLive(shown, live)).toEqual([
      { id: "bo", workspace: "north", state: "timedOut", minutes: 30 },
      { id: "cy", workspace: "south", state: "restarted" },
    ]);
    expect(mergeLive(shown, [])).toEqual([]);
  });

  it("followRestarts polls while rows remain, hands each list over, and stops when it is empty", async () => {
    const answers = [
      { agents: [{ id: "ana", workspace: "north", state: "turn" }] },
      { agents: [{ id: "ana", workspace: "north", state: "restarted" }] },
      { agents: [] },
    ];
    const seen: unknown[] = [];
    let calls = 0;
    const done = new Promise<void>((resolve) => {
      followRestarts({
        api: async (m: string, p: string) => {
          expect([m, p]).toEqual(["GET", "/api/agents/restart-status"]);
          return answers[Math.min(calls++, answers.length - 1)];
        },
        everyMs: 5,
        onRows: (rows: unknown[]) => {
          seen.push(rows);
        },
        onEnd: resolve,
      });
    });
    await done;
    expect(calls).toBe(3);
    expect(seen).toEqual(answers.map((a) => a.agents));
  });

  it("followRestarts stops when told, and on a failed read keeps going", async () => {
    let calls = 0;
    const f = followRestarts({
      api: async () => {
        calls++;
        if (calls === 1) throw new Error("offline");
        return { agents: [{ id: "ana", workspace: "north", state: "turn" }] };
      },
      everyMs: 5,
      onRows: () => undefined,
    });
    while (calls < 3) await new Promise((r) => setTimeout(r, 5));
    f.stop();
    const at = calls;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(at);
  });
});
