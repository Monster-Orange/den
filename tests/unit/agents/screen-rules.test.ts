/**
 * Issue 770: agent state from screen rules (src/shared/agents/detect,
 * engine.ts and index.ts), for Codex, Gemini and Grok, and Claude with its
 * hooks off.
 *
 * Fixtures: tests/fixtures/agent-screens/<runtime>/<state>-<what>.txt (a
 * .json beside one gives its OSC title or progress), and the recorded
 * Claude screens in tests/fixtures/claude-code-screens. Each screen is
 * rendered as the engine reads it: escapes out, rows right-trimmed.
 */
import { describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import * as path from "path";
import {
  RULE_SETS,
  agentStatus,
  DETECT_LIMITS,
  detect,
  detectScreen,
  region,
  ruleSetProblems,
  toRegExp,
  type Detection,
  type RuleSet,
  type Screen,
} from "../../../src/shared/agents/detect/index.js";

const FIX = path.join(process.cwd(), "tests", "fixtures");
const SCREENS = path.join(FIX, "agent-screens");

/** A terminal capture as the engine reads it. */
function render(raw: string): string {
  const rows = raw
    .replace(
      new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"),
      "",
    )
    .split("\n")
    .map((l) => l.trimEnd());
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows.length ? `${rows.join("\n")}\n` : "";
}

interface Fixture {
  runtime: string;
  file: string;
  expect: string;
  screen: Screen;
}

function fixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const runtime of fs
    .readdirSync(SCREENS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort())
    for (const file of fs
      .readdirSync(path.join(SCREENS, runtime))
      .filter((f) => f.endsWith(".txt"))
      .sort()) {
      const j = path.join(SCREENS, runtime, file.replace(/\.txt$/, ".json"));
      const osc = fs.existsSync(j)
        ? (JSON.parse(fs.readFileSync(j, "utf8")) as Partial<Screen>)
        : {};
      out.push({
        runtime,
        file,
        expect: file.split(/[-.]/)[0],
        screen: {
          text: render(
            fs.readFileSync(path.join(SCREENS, runtime, file), "utf8"),
          ),
          ...osc,
        },
      });
    }
  return out;
}

/** The recorded Claude screens (issue 664) and what each one shows. */
const RECORDED_CLAUDE: [string, string][] = [
  ["1-trust.raw", "blocked"],
  ["1b-trust-yes-selected.raw", "blocked"],
  ["2-input-prompt.raw", "idle"],
  ["2b-input-prompt-after-turn.raw", "idle"],
  ["3-tool-dialog.raw", "blocked"],
  ["3b-tool-dialog-redraw.raw", "blocked"],
  ["4-after-no.raw", "idle"],
];
const recorded = (f: string): Screen => ({
  text: render(
    fs.readFileSync(path.join(FIX, "claude-code-screens", f), "utf8"),
  ),
});

const set = (rules: RuleSet["rules"]): RuleSet => ({ id: "t", rules });
const scr = (text: string, more: Partial<Screen> = {}): Screen => ({
  text,
  ...more,
});

describe("clauses 1-3: each runtime's fixtures are Working, Blocked and Idle", () => {
  const all = fixtures();

  it.each(["codex", "gemini", "grok"])(
    "%s has a working, a blocked and an idle fixture",
    (rt) => {
      expect(
        [
          ...new Set(all.filter((f) => f.runtime === rt).map((f) => f.expect)),
        ].sort(),
      ).toEqual(["blocked", "idle", "working"]);
    },
  );

  it.each(all.map((f) => [`${f.runtime}/${f.file}`, f] as const))(
    "%s",
    (_name, f) => {
      const d = detectScreen(f.runtime, f.screen)!;
      // A rule decides it: never the no-match fallback.
      expect([d.state, d.skip, d.fallback]).toEqual([f.expect, false, false]);
      expect(agentStatus({ screen: d })).toBe(f.expect);
    },
  );

  it.each(RECORDED_CLAUDE)(
    "recorded Claude, hooks off: %s is %s",
    (f, want) => {
      const d = detect(RULE_SETS.claude, recorded(f));
      expect([d.state, d.fallback]).toEqual([want, false]);
    },
  );

  it("with Claude's hooks on, hook status wins over the screen", () => {
    const blocked = detect(RULE_SETS.claude, recorded("3-tool-dialog.raw"));
    expect(agentStatus({ screen: blocked })).toBe("blocked");
    expect(agentStatus({ hook: "working", screen: blocked })).toBe("working");
    expect(agentStatus({ hook: "idle", screen: blocked })).toBe("idle");
  });
});

describe("clause 4: regions, matchers and priority", () => {
  it("osc_title and osc_progress read the OSC fields, not the screen", () => {
    const s = scr("Action Required\n", {
      oscTitle: "⠹ web",
      oscProgress: "4;1;-1",
    });
    expect(region(s, "osc_title")).toBe("⠹ web");
    expect(region(s, "osc_progress")).toBe("4;1;-1");
    expect(region(scr("x\n"), "osc_title")).toBe("");
  });

  it("bottom_non_empty_lines(n) is from the n-th filled line from the bottom, blanks kept", () => {
    const s = scr("one\ntwo\n\nthree\n\n");
    expect(region(s, "bottom_non_empty_lines(2)")).toBe("two\n\nthree\n\n");
    expect(region(s, "bottom_non_empty_lines(9)")).toBe(
      "one\ntwo\n\nthree\n\n",
    );
    expect(region(scr("\n\n"), "bottom_non_empty_lines(1)")).toBe("");
  });

  it("top_non_empty_lines(n) and the prompt-marker regions", () => {
    expect(region(scr("\na\nb\nc\n"), "top_non_empty_lines(2)")).toBe(
      "\na\nb\n",
    );
    const s = scr("• old\n› ask\n• answer\n› now\nhint\n");
    expect(region(s, "after_last_prompt_marker")).toBe("hint\n");
    expect(region(s, "before_current_prompt_marker")).toBe(
      "• old\n› ask\n• answer\n",
    );
    expect(region(s, "whole_recent_without_current_prompt_marker")).toBe("");
    // A block marker after the last prompt: no current prompt.
    const stale = scr("› ask\n• answer\n");
    expect(region(stale, "whole_recent_without_current_prompt_marker")).toBe(
      "› ask\n• answer\n",
    );
  });

  it("contains needs every string, ignoring case", () => {
    const r = set([
      { id: "a", state: "blocked", contains: ["Allow", "COMMAND"] },
    ]);
    expect(detect(r, scr("allow this command?\n")).rule).toBe("a");
    expect(detect(r, scr("allow this?\n")).rule).toBeNull();
  });

  it("regex: Rust's inline flags, \\A, \\z and \\x{…}; case kept without (?i)", () => {
    const r = set([
      {
        id: "z",
        state: "working",
        regex: ["(?m)^done\\s*\\z", "\\A[\\x{2800}-\\x{28FF}]"],
      },
    ]);
    expect(detect(r, scr("⠹ go\ndone\n")).rule).toBe("z");
    expect(detect(r, scr("⠹ go\ndone\nmore\n")).rule).toBeNull();
    expect(detect(r, scr("x ⠹ go\ndone\n")).rule).toBeNull();
    const c = set([{ id: "c", state: "idle", regex: ["Yes"] }]);
    expect(detect(c, scr("yes\n")).rule).toBeNull();
    const i = set([{ id: "i", state: "idle", regex: ["(?i)Yes"] }]);
    expect(detect(i, scr("yes\n")).rule).toBe("i");
  });

  it("line_regex: each pattern on some line", () => {
    const r = set([
      {
        id: "l",
        state: "blocked",
        line_regex: ["^\\s*1\\. Yes", "^\\s*2\\. No"],
      },
    ]);
    expect(detect(r, scr("  1. Yes\n  2. No\n")).rule).toBe("l");
    expect(detect(r, scr("  1. Yes 2. No\n")).rule).toBeNull();
  });

  it("any, all and not", () => {
    const r = set([
      {
        id: "g",
        state: "blocked",
        any: [{ contains: ["[y/n]"] }, { contains: ["yes (y)"] }],
        all: [{ contains: ["run"] }, { regex: ["npm"] }],
        not: [{ contains: ["cancelled"] }],
      },
    ]);
    expect(detect(r, scr("run npm test? [y/n]\n")).rule).toBe("g");
    expect(detect(r, scr("run npm test?\n")).rule).toBeNull();
    expect(detect(r, scr("run test? [y/n]\n")).rule).toBeNull();
    expect(detect(r, scr("run npm test? [y/n] cancelled\n")).rule).toBeNull();
  });

  it("the higher priority wins when two match; on a tie, the earlier rule", () => {
    const r = set([
      { id: "low", state: "working", priority: 100, contains: ["x"] },
      { id: "high", state: "blocked", priority: 900, contains: ["x"] },
      { id: "tie", state: "idle", priority: 900, contains: ["x"] },
    ]);
    expect(detect(r, scr("x\n"))).toMatchObject({
      rule: "high",
      state: "blocked",
    });
  });

  it("every vendored rule set is valid for this engine", () => {
    for (const s of Object.values(RULE_SETS))
      expect([s.id, ruleSetProblems(s)]).toEqual([s.id, []]);
    expect(
      ruleSetProblems(set([{ id: "r", region: "nowhere", contains: ["x"] }])),
    ).toEqual(["t.rules[0] r: no region nowhere"]);
  });
});

describe("clause 5: skip_state_update", () => {
  it("a transcript viewer on screen leaves the agent's state as it is", () => {
    const viewer = scr(
      "› old question\n• old answer\n↑/↓ to scroll · pgup/pgdn to page · home/end to jump · q to quit · esc to edit prev\n",
    );
    const d = detect(RULE_SETS.codex, viewer);
    expect([d.rule, d.skip]).toEqual(["transcript_viewer", true]);
    expect(agentStatus({ screen: d })).toBeUndefined();
  });
});

describe("clause 6: no match keeps today's behaviour; nothing working is Blocked", () => {
  it("a screen no rule matches is a fallback: the caller keeps the bell and output stopped", () => {
    const d = detect(RULE_SETS.gemini, scr("just some output\n"));
    expect([d.state, d.rule, d.fallback]).toEqual(["unknown", null, true]);
    expect(agentStatus({ screen: d })).toBeUndefined();
  });

  it("no working or idle fixture is classed Blocked, by any rule set", () => {
    const calm: [string, Screen][] = [
      ...fixtures()
        .filter((f) => f.expect !== "blocked")
        .map((f) => [`${f.runtime}/${f.file}`, f.screen] as [string, Screen]),
      ...RECORDED_CLAUDE.filter(([, s]) => s !== "blocked").map(
        ([f]) => [`claude-code-screens/${f}`, recorded(f)] as [string, Screen],
      ),
    ];
    const blocked: string[] = [];
    for (const [name, s] of calm)
      for (const rs of Object.values(RULE_SETS)) {
        const d: Detection = detect(rs, s);
        if (d.state === "blocked")
          blocked.push(`${name} by ${rs.id} (${d.rule})`);
      }
    expect(blocked).toEqual([]);
  });
});

describe("clause 8: rules come from the vendored files, never the network", () => {
  it("detection works with every network call refused", () => {
    const refuse = () => {
      throw new Error("no network in detection");
    };
    const spies = [
      jest.spyOn(globalThis, "fetch").mockImplementation(refuse),
      jest.spyOn(http, "request").mockImplementation(refuse),
      jest.spyOn(https, "request").mockImplementation(refuse),
      jest.spyOn(net, "connect").mockImplementation(refuse),
    ];
    try {
      for (const f of fixtures()) detectScreen(f.runtime, f.screen);
      expect(
        detectScreen(
          "codex",
          fixtures().find((f) => f.runtime === "codex")!.screen,
        ),
      ).toBeDefined();
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe("bounded work: big screens and bad patterns", () => {
  it("reads at most the last rows and KB it is given, so a huge screen stays fast", () => {
    const huge = scr(
      Array.from({ length: 20_000 }, (_, i) => `line ${i} (${i}s)`).join("\n") +
        "\n› Ask Codex to do anything\n",
    );
    const t0 = Date.now();
    for (const rs of Object.values(RULE_SETS)) detect(rs, huge);
    expect(Date.now() - t0).toBeLessThan(1000);
    // What a rule sees is the tail only.
    const r = set([{ id: "first", state: "idle", contains: ["line 0 "] }]);
    expect(detect(r, huge).rule).toBeNull();
    expect(detect(r, huge, { maxRows: 30_000, maxKb: 4096 }).rule).toBe(
      "first",
    );
    expect(DETECT_LIMITS.maxRows.default).toBeGreaterThanOrEqual(24);
  });

  it("a \\x{ with no closing brace is an error, never a hang", () => {
    expect(() => toRegExp("a\\x{2800")).toThrow(/x\{/);
    expect(
      ruleSetProblems(set([{ id: "b", state: "idle", regex: ["\\x{12"] }]))[0],
    ).toMatch(/b\.regex/);
  });
});
