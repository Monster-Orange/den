/**
 * Issue 770: agent status (working, blocked, idle) from the screen, by
 * herdr's rule files (Apache-2.0) and a port of its rule engine, for the
 * runtimes whose hooks don't say it.
 *
 *   1. Codex: recorded screens of it working, waiting on an approval and
 *      at an empty prompt are Working, Blocked and Idle.
 *   2. The same for Gemini and for Grok, each with its own screens.
 *   3. Claude Code's rule set classes its screens (the hooks-off path; the
 *      real captures from issue 664 for Idle and Blocked). Hooks winning
 *      is in tests/unit/server/attention-screen-770.test.ts.
 *   4. The engine's regions and matchers, one test each, and priority.
 *   5. skip_state_update (a transcript viewer on screen).
 *   6. No rule: null (Den's bell and output signals decide), and no
 *      fixture of a working or idle screen is ever classed Blocked.
 *   7. Each shipped runtime points at its rule set.
 *   8. No network: rules come from the vendored files.
 *   9. Every file that says it came from herdr carries its Apache-2.0
 *      header and is listed in THIRD_PARTY_NOTICES.
 *
 * The screens are in tests/fixtures/agent-screens (README there says how
 * they were made) and tests/fixtures/claude-code-screens.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import * as path from "node:path";
import {
  clearRuleSets,
  RULE_SET_IDS,
  ruleSet,
  screenInput,
  screenStatus,
} from "../../../src/shared/agents/detect/index.js";
import {
  compileRuleSet,
  detect,
  parseRuleSet,
  region,
  rustRegex,
} from "../../../src/shared/agents/detect/engine.js";
import { BUILTIN_CATALOG } from "../../../src/shared/agents/catalog.js";
import { statusRulesOf } from "../../../src/shared/agents/runtimes.js";

const FIX = path.join(process.cwd(), "tests", "fixtures");
const screen = (rel: string) => fs.readFileSync(path.join(FIX, rel), "utf-8");
const stateOf = (rules: string, rel: string) =>
  screenStatus(rules, screen(rel))?.state ?? null;

afterEach(() => {
  jest.restoreAllMocks();
});

describe("1. Codex", () => {
  it.each([
    ["agent-screens/codex/working.raw", "working"],
    ["agent-screens/codex/working-no-title.raw", "working"],
    ["agent-screens/codex/blocked-approval.raw", "blocked"],
    ["agent-screens/codex/blocked-approval-no-title.raw", "blocked"],
    ["agent-screens/codex/idle.raw", "idle"],
    ["agent-screens/codex/idle-after-turn.raw", "idle"],
  ])("%s is %s", (rel, want) => {
    expect(stateOf("codex", rel)).toBe(want);
  });

  it("idle at its prompt with no window title: Den's own rule (input_prompt_idle)", () => {
    const d = screenStatus(
      "codex",
      screen("agent-screens/codex/idle-no-title.raw"),
    );
    expect(d).toMatchObject({ state: "idle", rule: "input_prompt_idle" });
    // Its approval dialog has a "› 1. Yes" line too: still Blocked.
    expect(
      stateOf("codex", "agent-screens/codex/blocked-approval-no-title.raw"),
    ).toBe("blocked");
  });
});

describe("2. Gemini and Grok", () => {
  it.each([
    ["agent-screens/gemini/working.raw", "working"],
    ["agent-screens/gemini/blocked-allow.raw", "blocked"],
    ["agent-screens/gemini/blocked-apply.raw", "blocked"],
    ["agent-screens/gemini/idle.raw", "idle"],
    ["agent-screens/gemini/idle-after-turn.raw", "idle"],
  ])("gemini: %s is %s", (rel, want) => {
    expect(stateOf("gemini", rel)).toBe(want);
  });

  it.each([
    ["agent-screens/grok/working.raw", "working"],
    ["agent-screens/grok/blocked-permission.raw", "blocked"],
    ["agent-screens/grok/blocked-question.raw", "blocked"],
    ["agent-screens/grok/idle.raw", "idle"],
    ["agent-screens/grok/idle-no-title.raw", "idle"],
  ])("grok: %s is %s", (rel, want) => {
    expect(stateOf("grok", rel)).toBe(want);
  });
});

describe("3. Claude Code's rule set (hooks off)", () => {
  it.each([
    ["agent-screens/claude/working.raw", "working"],
    ["claude-code-screens/3-tool-dialog.raw", "blocked"],
    ["claude-code-screens/3b-tool-dialog-redraw.raw", "blocked"],
    ["claude-code-screens/1-trust.raw", "blocked"],
    ["claude-code-screens/2-input-prompt.raw", "idle"],
    ["claude-code-screens/2b-input-prompt-after-turn.raw", "idle"],
    ["claude-code-screens/4-after-no.raw", "idle"],
  ])("%s is %s", (rel, want) => {
    expect(stateOf("claude", rel)).toBe(want);
  });
});

/** One rule set from TOML text, compiled. */
const rules = (toml: string) => compileRuleSet(parseRuleSet(toml));
const input = (screen: string, oscTitle = "", oscProgress = "") => ({
  screen,
  oscTitle,
  oscProgress,
});

describe("4. the engine", () => {
  it("region osc_title reads the terminal title, not the screen", () => {
    const r = rules(
      'id = "t"\n[[rules]]\nid = "a"\nstate = "working"\nregion = "osc_title"\ncontains = ["busy"]\n',
    );
    expect(detect(r, input("busy", ""))).toBeNull();
    expect(detect(r, input("", "Busy · demo"))?.state).toBe("working");
    // From session output: the last OSC 0/2 title, and OSC 9;4 progress.
    const i = screenInput(
      "\x1b]0;first\x07text\x1b]2;second\x1b\\\x1b]9;4;1;-1\x07",
    );
    expect(i.oscTitle).toBe("second");
    expect(i.oscProgress).toBe("4;1;-1");
    expect(i.screen).toBe("text");
  });

  it("region bottom_non_empty_lines(n) is the last n non-empty lines", () => {
    const s = "one\n\ntwo\n\nthree\n\n";
    expect(region(input(s), "bottom_non_empty_lines(2)")).toBe(
      "two\n\nthree\n\n",
    );
    const r = rules(
      'id = "t"\n[[rules]]\nid = "a"\nstate = "idle"\nregion = "bottom_non_empty_lines(2)"\ncontains = ["one"]\n',
    );
    expect(detect(r, input(s))).toBeNull();
    expect(detect(r, input("one\nx"))?.state).toBe("idle");
  });

  it("contains: every string, case-insensitive", () => {
    const r = rules(
      'id = "t"\n[[rules]]\nid = "a"\nstate = "blocked"\ncontains = ["Allow", "COMMAND?"]\n',
    );
    expect(detect(r, input("allow command?"))?.state).toBe("blocked");
    expect(detect(r, input("allow it"))).toBeNull();
  });

  it("regex: Rust syntax (inline flags, \\A, \\z, \\x{…}) on the region", () => {
    const r = rules(
      'id = "t"\n[[rules]]\nid = "a"\nstate = "working"\nregex = [\'(?m)^[\\x{2800}-\\x{28FF}] go\\z\']\n',
    );
    expect(detect(r, input("x\n⠙ go"))?.state).toBe("working");
    expect(detect(r, input("x\n⠙ go\nmore"))).toBeNull();
    expect(rustRegex("\\Aab").test("ab")).toBe(true);
    expect(rustRegex("\\Aab").test("xab")).toBe(false);
    expect(rustRegex("(?i)YES").test("yes")).toBe(true);
    expect(() => rustRegex("(?x)a")).toThrow(/inline flag/);
  });

  it("line_regex: each pattern matches some one line", () => {
    const r = rules(
      'id = "t"\n[[rules]]\nid = "a"\nstate = "blocked"\nline_regex = [\'^yes$\']\n',
    );
    expect(detect(r, input("no\nyes\n"))?.state).toBe("blocked");
    expect(detect(r, input("no yes"))).toBeNull();
  });

  it("any: at least one nested gate", () => {
    const r = rules(
      'id = "t"\n[[rules]]\nid = "a"\nstate = "blocked"\nany = [{ contains = ["y/n"] }, { contains = ["proceed?"] }]\n',
    );
    expect(detect(r, input("proceed?"))?.state).toBe("blocked");
    expect(detect(r, input("[y/n]"))?.state).toBe("blocked");
    expect(detect(r, input("nothing"))).toBeNull();
  });

  it("all: every nested gate", () => {
    const r = rules(
      'id = "t"\n[[rules]]\nid = "a"\nstate = "blocked"\nall = [{ contains = ["proceed?"] }, { any = [{ contains = ["yes"] }] }]\n',
    );
    expect(detect(r, input("proceed? yes"))?.state).toBe("blocked");
    expect(detect(r, input("proceed?"))).toBeNull();
  });

  it("not: no nested gate may match", () => {
    const r = rules(
      'id = "t"\n[[rules]]\nid = "a"\nstate = "idle"\ncontains = ["shortcuts"]\nnot = [{ contains = ["esc:cancel"] }]\n',
    );
    expect(detect(r, input("ctrl+.:shortcuts"))?.state).toBe("idle");
    expect(detect(r, input("esc:cancel ctrl+.:shortcuts"))).toBeNull();
  });

  it("priority: the higher rule wins when two match, the first on a tie", () => {
    const toml = (pa: number, pb: number) =>
      `id = "t"\n[[rules]]\nid = "a"\nstate = "working"\npriority = ${pa}\ncontains = ["x"]\n[[rules]]\nid = "b"\nstate = "blocked"\npriority = ${pb}\ncontains = ["x"]\n`;
    expect(detect(rules(toml(10, 20)), input("x"))?.rule).toBe("b");
    expect(detect(rules(toml(20, 10)), input("x"))?.rule).toBe("a");
    expect(detect(rules(toml(10, 10)), input("x"))?.rule).toBe("a");
  });

  it("a bad rule file is refused, never half read", () => {
    expect(() =>
      parseRuleSet(
        'id = "t"\n[[rules]]\nid = "a"\nregion = "nowhere"\ncontains = ["x"]\n',
      ),
    ).toThrow(/unknown region/);
    expect(() =>
      parseRuleSet('id = "t"\n[[rules]]\nid = "a"\nstate = "idle"\n'),
    ).toThrow(/positive matcher/);
    expect(() =>
      parseRuleSet(
        'id = "t"\n[[rules]]\nid = "a"\ncolour = "red"\ncontains = ["x"]\n',
      ),
    ).toThrow(/unknown key colour/);
  });

  it("every shipped rule set reads and compiles", () => {
    for (const id of RULE_SET_IDS)
      expect(ruleSet(id).set.rules.length).toBeGreaterThan(0);
  });
});

describe("5. skip_state_update", () => {
  it("a transcript viewer on screen says: leave the state as it was", () => {
    const d = screenStatus(
      "codex",
      screen("agent-screens/codex/viewer-transcript.raw"),
    );
    expect(d).toMatchObject({ skipStateUpdate: true, state: "unknown" });
    const r = rules(
      'id = "t"\n[[rules]]\nid = "v"\nstate = "unknown"\nskip_state_update = true\npriority = 5\ncontains = ["q to quit"]\n',
    );
    expect(detect(r, input("q to quit"))?.skipStateUpdate).toBe(true);
  });
});

/** Every fixture screen, with the state its file name says. */
function allFixtures(): { rel: string; rules: string; want: string }[] {
  const out: { rel: string; rules: string; want: string }[] = [];
  for (const rt of ["codex", "gemini", "grok", "claude"]) {
    const dir = path.join(FIX, "agent-screens", rt);
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".raw")))
      out.push({
        rel: `agent-screens/${rt}/${f}`,
        rules: rt,
        want: f.split("-")[0].replace(/\.raw$/, ""),
      });
  }
  for (const f of fs
    .readdirSync(path.join(FIX, "claude-code-screens"))
    .filter((f) => f.endsWith(".raw")))
    out.push({
      rel: `claude-code-screens/${f}`,
      rules: "claude",
      want: /^[13]/.test(f) ? "blocked" : "idle",
    });
  return out;
}

describe("6. no rule, and no false Blocked", () => {
  it("a screen no rule matches is null: today's bell and output signals decide", () => {
    for (const id of RULE_SET_IDS)
      expect(
        screenStatus(id, screen("agent-screens/none/shell.raw")),
      ).toBeNull();
    expect(
      screenStatus(undefined, screen("agent-screens/none/shell.raw")),
    ).toBeNull();
  });

  it("no working, idle or viewer screen is ever classed Blocked, by any rule set", () => {
    const wrong: string[] = [];
    for (const f of allFixtures()) {
      if (f.want === "blocked") continue;
      for (const id of RULE_SET_IDS)
        if (stateOf(id, f.rel) === "blocked") wrong.push(`${f.rel} by ${id}`);
    }
    expect(wrong).toEqual([]);
  });

  it("each fixture is the state its name says, by its own rule set", () => {
    const wrong = allFixtures()
      .filter((f) => f.want !== "viewer")
      .filter((f) => stateOf(f.rules, f.rel) !== f.want)
      .map((f) => `${f.rel}: ${stateOf(f.rules, f.rel)}, not ${f.want}`);
    expect(wrong).toEqual([]);
  });
});

describe("7. the runtime catalog points at the rule sets", () => {
  it("every shipped runtime has a rule set, and it loads", () => {
    const missing = BUILTIN_CATALOG.filter((e) => !e.statusRules).map(
      (e) => e.id,
    );
    expect(missing).toEqual([]);
    for (const e of BUILTIN_CATALOG) {
      expect(RULE_SET_IDS).toContain(e.statusRules);
      expect(() => ruleSet(e.statusRules!)).not.toThrow();
    }
  });

  it("statusRulesOf names each runtime's set (Claude Code's is claude)", () => {
    expect(statusRulesOf("den-claude")).toBe("claude");
    expect(statusRulesOf("codex")).toBe("codex");
    expect(statusRulesOf("gemini")).toBe("gemini");
    expect(statusRulesOf("grok")).toBe("grok");
    expect(statusRulesOf("generic")).toBeUndefined();
    expect(statusRulesOf("no-such")).toBeUndefined();
  });
});

describe("8. no network", () => {
  it("rules are read from the vendored files with every network call stubbed out", () => {
    const boom = () => {
      throw new Error("network used");
    };
    const calls = [
      jest.spyOn(http, "request").mockImplementation(boom),
      jest.spyOn(http, "get").mockImplementation(boom),
      jest.spyOn(https, "request").mockImplementation(boom),
      jest.spyOn(https, "get").mockImplementation(boom),
      jest.spyOn(net, "connect").mockImplementation(boom),
      jest.spyOn(net, "createConnection").mockImplementation(boom),
    ];
    const realFetch = globalThis.fetch;
    const fetchStub = jest.fn(boom);
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    try {
      clearRuleSets();
      expect(stateOf("codex", "agent-screens/codex/blocked-approval.raw")).toBe(
        "blocked",
      );
      expect(stateOf("grok", "agent-screens/grok/working.raw")).toBe("working");
      for (const c of calls) expect(c).not.toHaveBeenCalled();
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("no source file in detect/ reaches for the network", () => {
    const dir = path.join(process.cwd(), "src", "shared", "agents", "detect");
    const src = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"))
      .join("\n");
    expect(src).not.toMatch(/\bfetch\(|node:https?|node:net|from "https?"/);
  });
});

describe("9. Apache-2.0 attribution", () => {
  const root = process.cwd();
  const notices = () =>
    fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES"), "utf-8");

  function walk(d: string): string[] {
    return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  }

  it("each file from herdr has the header and a THIRD_PARTY_NOTICES entry", () => {
    const files = walk(path.join(root, "src", "shared", "agents", "detect"));
    const fromHerdr = files.filter((f) =>
      /Origin: herdr \(/.test(fs.readFileSync(f, "utf-8")),
    );
    // The rule files and the engine port at least.
    expect(fromHerdr.length).toBeGreaterThanOrEqual(5);
    const n = notices();
    const bad: string[] = [];
    for (const f of fromHerdr) {
      const rel = path.relative(root, f).split(path.sep).join("/");
      const head = fs.readFileSync(f, "utf-8").slice(0, 1200);
      if (!head.includes("SPDX-License-Identifier: Apache-2.0"))
        bad.push(`${rel}: no SPDX line`);
      if (!head.includes("Copyright (c) the herdr authors"))
        bad.push(`${rel}: no copyright line`);
      if (!/Apache License,\s*(?:[#*]\s*)?Version 2\.0/.test(head))
        bad.push(`${rel}: no license name`);
      if (!/(Not modified|Modified) by Den/.test(head))
        bad.push(`${rel}: doesn't say whether Den changed it`);
      if (!n.includes(rel)) bad.push(`${rel}: not in THIRD_PARTY_NOTICES`);
    }
    expect(bad).toEqual([]);
  });

  it("THIRD_PARTY_NOTICES names herdr, its license and the license's text, and ships", () => {
    const n = notices();
    expect(n).toMatch(/herdr/);
    expect(n).toMatch(/Copyright \(c\) the herdr authors/);
    expect(n).toMatch(/Apache License\s+Version 2\.0, January 2004/);
    expect(n).toMatch(
      /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/,
    );
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf-8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("THIRD_PARTY_NOTICES");
  });
});
