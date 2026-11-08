/**
 * The hand-back check (den#5, handback.ts) and its Stop hook
 * (guardrails/stop-hook.ts): a hand-back names URL, machine, branch, what
 * changed, what to click and decisions; every ID is explained; each
 * decision is a numbered yes/no question.
 */
import { describe, expect, it } from "@jest/globals";
import {
  bareIds,
  checkHandback,
  idsInNames,
  isGlossed,
  looksLikeHandback,
} from "../../../src/shared/agents/handback.js";
import {
  knownArgs,
  stopDecision,
} from "../../../src/shared/agents/guardrails/stop-hook.js";

const GOOD = `Done: the hooks are in.

## Hand-back
- URL: https://localhost:7443/workspaces/north
- Machine: the build laptop
- Branch: feat/AG-14-hooks
- What changed: agents can't poll with sleep any more. The plain-writing rule (R12) is in every persona.
- What to click: open Agents, start a planner, and ask it to wait on a build.
- Decisions:
  1. Ship it in the next patch?
  2. Turn the hooks on for your own pack too?
`;

describe("checkHandback", () => {
  it("passes a complete, plain hand-back", () => {
    expect(checkHandback(GOOD)).toEqual({ ok: true, problems: [] });
  });

  it("accepts URL: none for work with no page, with or without a reason", () => {
    const url = "- URL: https://localhost:7443/workspaces/north\n";
    for (const v of [
      "none",
      "None",
      "none — this work has no page",
      "none: a CLI change",
    ])
      expect([v, checkHandback(GOOD.replace(url, `- URL: ${v}\n`))]).toEqual([
        v,
        { ok: true, problems: [] },
      ]);
  });

  it("still fails an empty or missing URL, or one that is neither none nor a link", () => {
    const url = "- URL: https://localhost:7443/workspaces/north\n";
    expect(checkHandback(GOOD.replace(url, "- URL:\n")).problems).toEqual([
      '"URL:" is empty. Fill it in.',
    ]);
    expect(checkHandback(GOOD.replace(url, "")).problems).toEqual([
      'Missing "URL:". Add it.',
    ]);
    expect(
      checkHandback(GOOD.replace(url, "- URL: the north page\n")).problems,
    ).toEqual([
      '"URL:" has no link. Give the full address, with http:// or https://, or say none if this work has no page.',
    ]);
  });

  it("accepts labels in bold, as headings, and Decisions: none", () => {
    const text = [
      "## Hand-back",
      "**URL:** https://x.example/a",
      "**Machine:** laptop",
      "### Branch",
      "main",
      "- What changed: a button",
      "- What to click: the button",
      "- Decisions: none",
    ].join("\n");
    expect(checkHandback(text).problems).toEqual([]);
  });

  it.each([
    "URL",
    "Machine",
    "Branch",
    "What changed",
    "What to click",
    "Decisions",
  ])("rejects a hand-back with no %s", (part) => {
    const text = GOOD.split("\n")
      .filter((l) => !l.startsWith(`- ${part}:`))
      .filter((l) => part !== "Decisions" || !/^\s+\d\./.test(l))
      .join("\n");
    const r = checkHandback(text);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain(`Missing "${part}:". Add it.`);
  });

  it("rejects an empty part, and a URL with no link", () => {
    const r = checkHandback(
      GOOD.replace("- Machine: the build laptop", "- Machine:").replace(
        "https://localhost:7443/workspaces/north",
        "the Agents page",
      ),
    );
    expect(r.problems).toEqual([
      `"URL:" has no link. Give the full address, with http:// or https://, or say none if this work has no page.`,
      `"Machine:" is empty. Fill it in.`,
    ]);
  });

  it("rejects a bare ID, and names it", () => {
    const r = checkHandback(
      GOOD.replace("agents can't poll", "#5 is done and agents can't poll"),
    );
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      `"#5" is not explained. Say what it is, e.g. "#5 (what it is)".`,
    ]);
  });

  it("rejects decisions that are not numbered yes/no questions", () => {
    const text = GOOD.replace(
      "  1. Ship it in the next patch?\n  2. Turn the hooks on for your own pack too?",
      [
        "  - Ship it in the next patch?",
        "  2. Ship it in the next patch.",
        "  3. Which pack gets the hooks?",
        "  4. Ship now or wait a week?",
      ].join("\n"),
    );
    expect(checkHandback(text).problems).toEqual([
      `Decision "Ship it in the next patch?" is not numbered. Number it: 1., 2., …`,
      `Decision "Ship it in the next patch." is not a question. End it with "?".`,
      `Decision "Which pack gets the hooks?" is not a yes/no question. Ask it so yes or no answers it.`,
      `Decision "Ship now or wait a week?" is not a yes/no question. Ask it so yes or no answers it.`,
    ]);
  });

  it("an empty Decisions part is rejected", () => {
    const text = GOOD.replace(
      /- Decisions:\n[\s\S]*$/,
      "- Decisions:\n- What changed: again\n",
    );
    expect(checkHandback(text).problems).toContain(
      "Decisions is empty. List each as a numbered yes/no question, or say none.",
    );
  });
});

describe("gloss: what explains an ID", () => {
  const glossed = (line: string, id: string) => {
    const i = line.indexOf(id);
    return isGlossed(line, i, i + id.length);
  };

  it("a. a parenthetical of two or more words right after it", () => {
    expect(glossed("see #5 (the hooks issue)", "#5")).toBe(true);
    expect(glossed("see #5 (hooks)", "#5")).toBe(false);
    expect(glossed("see #5 (R12)", "#5")).toBe(false);
  });

  it("b. a colon or a spaced dash, then two or more words", () => {
    expect(glossed("R12: speak plainly", "R12")).toBe(true);
    expect(glossed("R12 - speak plainly", "R12")).toBe(true);
    expect(glossed("R12 — speak plainly", "R12")).toBe(true);
    expect(glossed("R12: done", "R12")).toBe(false);
  });

  it("c. inside a parenthetical of IDs only, right after a word", () => {
    expect(glossed("the plain-writing rule (R12)", "R12")).toBe(true);
    expect(glossed("the hooks issues (#5, #6)", "#6")).toBe(true);
    expect(glossed("(R12) first", "R12")).toBe(false);
    expect(glossed("the rule (R12 again)", "R12")).toBe(false);
  });

  it("d. once glossed, later mentions are explained", () => {
    expect(bareIds("#5 (the hooks issue) is done.\nSo #5 ships.")).toEqual([]);
    expect(bareIds("#5 ships.\nIt is #5 (the hooks issue).")).toEqual(["#5"]);
  });

  it("finds both ID shapes, and skips code, links and the Branch part", () => {
    expect(bareIds("AG-14 and KB-4.1 and #12 and R3")).toEqual([
      "AG-14",
      "KB-4.1",
      "#12",
      "R3",
    ]);
    expect(bareIds("run `make R12` or see https://x.example/#12")).toEqual([]);
    expect(bareIds("```\nAG-14\n```\nfine", new Set<number>())).toEqual([]);
    expect(
      checkHandback(GOOD.replace("feat/AG-14-hooks", "AG-14")).problems,
    ).toEqual([]);
  });
});

describe("the Stop hook", () => {
  it("with no Hand-back heading, checks the whole message for bare IDs only", () => {
    expect(looksLikeHandback(GOOD)).toBe(true);
    expect(looksLikeHandback("All done, see AG-14.")).toBe(false);
    const out = stopDecision({
      last_assistant_message: "All done, see AG-14.",
    });
    const o = JSON.parse(out) as { decision: string; reason: string };
    expect(o.decision).toBe("block");
    expect(o.reason).toMatch(/"AG-14" is not explained/);
    // No parts are asked for outside a hand-back.
    expect(o.reason).not.toMatch(/Missing/);
    expect(
      stopDecision({
        last_assistant_message:
          "All done. AG-14 (resume a stopped agent) works now.",
      }),
    ).toBe("");
    expect(
      stopDecision({ last_assistant_message: "All done, nothing to add." }),
    ).toBe("");
  });

  it("a bare ID outside a hand-back is still let through the second time", () => {
    expect(
      stopDecision({
        last_assistant_message: "All done, see AG-14.",
        stop_hook_active: true,
      }),
    ).toBe("");
  });

  it("lets a good hand-back end the turn", () => {
    expect(stopDecision({ last_assistant_message: GOOD })).toBe("");
  });

  it("blocks a bad one with what to fix, in Claude Code's decision format", () => {
    const out = stopDecision({
      last_assistant_message: GOOD.replace("- Machine: the build laptop\n", ""),
      stop_hook_active: false,
    });
    const o = JSON.parse(out) as { decision: string; reason: string };
    expect(o.decision).toBe("block");
    expect(o.reason).toMatch(/Missing "Machine:"/);
  });

  it("never blocks twice in a row (stop_hook_active), or on bad input", () => {
    const bad = GOOD.replace("- Machine: the build laptop\n", "");
    expect(
      stopDecision({ last_assistant_message: bad, stop_hook_active: true }),
    ).toBe("");
    expect(stopDecision(null)).toBe("");
    expect(stopDecision({})).toBe("");
  });
});

describe("Den's own names are not IDs", () => {
  // A Den named "t2" is "T2", and its server agent greets with it.
  const greeting = "Let's set up T2. Where are your repos?";

  it("the ID-shaped words in Den's names are known, and never flagged", () => {
    expect(idsInNames(["T2", "north", undefined])).toEqual(["T2"]);
    expect(idsInNames(["Acme", "web"])).toEqual([]);
    expect(
      stopDecision({ last_assistant_message: greeting }, null, ["T2"]),
    ).toBe("");
    // Another ID in the same message is still flagged.
    const out = stopDecision(
      { last_assistant_message: `${greeting} See AG-14.` },
      null,
      ["T2"],
    );
    const reason = (JSON.parse(out) as { reason: string }).reason;
    expect(reason).toMatch(/"AG-14" is not explained/);
    expect(reason).not.toMatch(/T2/);
  });

  it("the hook reads them from its --known arguments", () => {
    expect(
      knownArgs([
        "--files",
        "/x",
        "--after",
        "3",
        "--known",
        "T2",
        "--known",
        "Q4",
      ]),
    ).toEqual(["T2", "Q4"]);
  });
});
