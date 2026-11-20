/**
 * Issue 563: the bell line after the terminal host restarts reads as a
 * sentence in every case (no "(0): -"), in en, es and ja, and never uses
 * the word "Open" (issue 93: no row says Open).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  hostKeptAudit,
  hostRestartAudit,
  noteHostRestarted,
} from "../../../src/ui/server/agent-routes.js";

const PUB = path.resolve(__dirname, "../../../src/ui/server/public");

function note(resumed: string[], terminals: number) {
  const added: { text: string; msg: { key: string; vars: Record<string, unknown> } }[] = [];
  noteHostRestarted(
    { add: (n: never) => void added.push(n) } as never,
    "Den",
    resumed,
    terminals,
  );
  return added[0];
}

function catalog(file: string, key: string): string | null {
  const src = fs.readFileSync(path.join(PUB, file), "utf-8");
  const m = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*\\n?\\s*"([^"]*)"`).exec(src);
  return m ? m[1] : null;
}

const CASES: [string[], number][] = [
  [["a", "b"], 2],
  [["a"], 0],
  [[], 3],
  [[], 0],
];

describe("the bell line after the terminal host restarts", () => {
  it.each(CASES)("resumed %j, %i terminals: a sentence, no (0) or -, no Open", (resumed, t) => {
    const n = note(resumed, t);
    expect(n.text).not.toMatch(/\(0\)|: -|\bOpen\b/);
    for (const file of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const words = catalog(file, n.msg.key);
      expect([file, n.msg.key, words === null]).toEqual([file, n.msg.key, false]);
      const filled = words!.replace(/\{(\w+)\}/g, (_, k) => String(n.msg.vars[k]));
      expect(filled).not.toMatch(/\(0\)|: -\.|\bOpen\b|\bAbrir\b|開く/);
    }
  });
});

describe("issue 597: the bell names the agents cut mid-turn", () => {
  function noteCut(resumed: string[], terminals: number, cut: string[]) {
    const added: { text: string; msg: { key: string; vars: Record<string, unknown> } }[] = [];
    noteHostRestarted(
      { add: (n: never) => void added.push(n) } as never,
      "Den",
      resumed,
      terminals,
      cut,
    );
    return added[0];
  }

  it.each([2, 0])("with %i terminals: the cut agents are named in en, es and ja", (t) => {
    const n = noteCut(["a", "b", "c"], t, ["a", "c"]);
    expect(n.text).toMatch(/a, c/);
    expect(n.msg.vars.cut).toBe("a, c");
    for (const file of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const words = catalog(file, n.msg.key);
      expect([file, n.msg.key, words === null]).toEqual([file, n.msg.key, false]);
      expect(words).toContain("{cut}");
      expect(words).toContain("{names}");
    }
  });

  it("no agent cut: the line is as before", () => {
    expect(noteCut(["a"], 0, []).msg.key).toBe("bell.m.hostRestartedAgents");
  });
});

describe("issue 597: the audit row keeps the full lists, counts first", () => {
  it("40 resumed and one failed: every name, and the failed one, are kept", () => {
    const resumed = Array.from({ length: 40 }, (_, i) => `agent-with-a-long-name-${i}`);
    const a = hostRestartAudit({
      did: "restarted",
      why: "host code changed",
      from: 10,
      to: 11,
      waitedMs: 900_000,
      busy: resumed.slice(0, 5),
      resumed,
      failed: [{ agent: "agent-that-failed", why: "exited at once" }],
      terminals: 2,
    });
    expect(a.detail).toMatch(
      /^terminal host restarted \(pid 10 → 11\): resumed 40, failed 1, cut mid-turn 5; /,
    );
    expect(a.detail.length).toBeLessThanOrEqual(400);
    expect(a.agents.resumed).toEqual(resumed);
    expect(a.agents.cut).toEqual(resumed.slice(0, 5));
    expect(a.agents.failed).toEqual([{ agent: "agent-that-failed", why: "exited at once" }]);
  });

  it("a kept host: host kept: code unchanged", () => {
    expect(hostKeptAudit({ did: "kept", from: "1.0.0", to: "1.0.1" })).toBe(
      "host kept: code unchanged (1.0.0 → 1.0.1)",
    );
  });
});
