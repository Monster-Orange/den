/**
 * Issue 110, Coach Apply on the Coach tab (mock v3, in Hub, Den project:
 * "Coach Apply: a finding's change waits for a person's Allow"). One test
 * per rule in the mock's rules table:
 *   - Apply shows only on a finding with a proposal, beside Dismiss; one
 *     with none says so in its reason and has Dismiss only;
 *   - the change in words under the reason, before Apply;
 *   - waiting: the chip and its line with Open the bell; no Apply, no
 *     Dismiss;
 *   - applied: the chip and who, when and what is now true;
 *   - denied: the chip, who and when, Nothing was changed; Apply again;
 *   - failed: the chip, the reason (as text), Try again;
 *   - phone: the same, as cards, full-width buttons;
 *   - a state change is read out (the live line).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  applyLiveText,
  coachTabView,
} from "../../../src/ui/server/public/coach-tab.js";

const g = globalThis as unknown as { window?: unknown };
const had = g.window;
beforeAll(() => {
  g.window = {
    denShell: {
      t: (k: string, v?: Record<string, unknown>) =>
        `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`,
    },
  };
});
afterAll(() => {
  g.window = had;
});

const W = {
  from: "2026-11-15T12:00:00.000Z",
  to: "2026-11-22T12:00:00.000Z",
  days: 7,
};
const REPORT = {
  version: 1,
  ranAt: "2026-11-22T17:14:00.000Z",
  window: W,
  agents: [],
  totals: { calls: 0, output_M: 0, compactions: 0 },
  totalsPerDay: {},
  cost: { model: null, tokens: 0 },
};
const OPUS = {
  id: "subagent_opus:builder",
  kind: "subagent_opus",
  agent: "builder",
  workspace: "shop",
  title: "t",
  evidence: { subagent_opus_pct: 87, subagent_calls: 140 },
  proposal: "p",
  window: W,
  persona: "builder",
  apply: {
    action: "persona_update",
    args: { id: "builder", project: "shop", subagentModel: "sonnet" },
    change: "Set builder's subagent model to Sonnet.",
    reversible: "Set it back in builder's persona.",
  },
};
const POLL = {
  id: "polling:tester",
  kind: "polling",
  agent: "tester",
  workspace: "shop",
  title: "t",
  evidence: { polls_per_day: 96 },
  proposal: "p",
  window: W,
};
const view = (findings: unknown[], o = {}) =>
  coachTabView(
    {
      ok: true,
      settings: { enabled: true, findings: { subagent_opus_pct: 50 } },
      report: REPORT,
      running: false,
      progress: null,
      failed: null,
      findings,
      dismissed: [],
    },
    o,
  );
const rowOf = (html: string, id: string) => {
  const i = html.indexOf(`<tr class="co-fr" data-id="${id}"`);
  return html.slice(i, html.indexOf("</tr>", i));
};
const cardOf = (html: string, id: string) => {
  const i = html.indexOf(`<div class="co-fc" data-id="${id}"`);
  return html.slice(i, html.indexOf("</div><!--fc-->", i));
};
const at = "2026-11-23T00:02:00.000Z";

describe("Apply shows (mock v3, rule 1)", () => {
  it("only on a finding with a proposal, primary, beside Dismiss", () => {
    const html = view([OPUS, POLL]);
    const r = rowOf(html, OPUS.id);
    expect(r).toMatch(
      /<button type="button" class="den-btn primary sm co-fap" data-act="coach-apply" data-id="subagent_opus:builder">\[co\.ap\.apply\]<\/button>/,
    );
    expect(r.indexOf('data-act="coach-apply"')).toBeLessThan(
      r.indexOf('data-act="coach-dismiss"'),
    );
    const p = rowOf(html, POLL.id);
    expect(p).not.toContain("coach-apply");
    expect(p).toContain('data-act="coach-dismiss"');
    expect(p).toContain("[co.ap.none]");
  });
});

describe("the change, in words (rule 2)", () => {
  it("under the reason, before Apply, naming the agent and the setting", () => {
    const r = rowOf(view([OPUS]), OPUS.id);
    expect(r).toContain(
      "[co.ap.proposed:[co.ap.change.subagent_opus:builder]]",
    );
    expect(r.indexOf("[co.f.subagent_opus.why")).toBeLessThan(
      r.indexOf("[co.ap.proposed"),
    );
    expect(r.indexOf("[co.ap.proposed")).toBeLessThan(
      r.indexOf('data-act="coach-apply"'),
    );
  });
});

describe("waiting (rules 3, 4)", () => {
  it("the chip replaces Apply and Dismiss; its line says nothing changed, with Open the bell", () => {
    const html = view([
      { ...OPUS, applied: { state: "waiting", approval: "a1", at } },
    ]);
    const r = rowOf(html, OPUS.id);
    expect(r).toContain('<span class="co-chip wait">[co.ap.waiting]</span>');
    expect(r).not.toContain('data-act="coach-apply"');
    expect(r).not.toContain('data-act="coach-dismiss"');
    expect(r).toContain("[co.ap.waiting.line]");
    expect(r).toMatch(
      /<button type="button" class="co-link" data-act="coach-bell">\[co\.ap\.openBell\]<\/button>/,
    );
  });
});

describe("the ending states (rules 5–7)", () => {
  it("applied: the chip, who allowed it, when, and what is now true", () => {
    const r = rowOf(
      view([
        {
          ...OPUS,
          applied: {
            state: "applied",
            approval: "a1",
            at,
            decidedAt: at,
            by: "Pat",
          },
        },
      ]),
      OPUS.id,
    );
    expect(r).toContain('<span class="co-chip ok">[co.ap.applied]</span>');
    expect(r).toContain("[co.ap.applied.by:Pat|");
    expect(r).toContain("[co.ap.now.subagent_opus:");
    expect(r).not.toContain('data-act="coach-apply"');
  });
  it("applied with no name known: when only", () => {
    const r = rowOf(
      view([
        {
          ...OPUS,
          applied: { state: "applied", approval: "a1", at, decidedAt: at },
        },
      ]),
      OPUS.id,
    );
    expect(r).toContain("[co.ap.applied.at:");
  });
  it("denied: the chip, who and when, Nothing was changed; Apply again and Dismiss", () => {
    const r = rowOf(
      view([
        {
          ...OPUS,
          applied: {
            state: "denied",
            approval: "a1",
            at,
            decidedAt: at,
            by: "Pat",
          },
        },
      ]),
      OPUS.id,
    );
    expect(r).toContain('<span class="co-chip bad">[co.ap.denied]</span>');
    expect(r).toContain("[co.ap.denied.by:Pat|");
    expect(r).toMatch(/data-act="coach-apply"[^>]*>\[co\.ap\.again\]/);
    expect(r).toContain('data-act="coach-dismiss"');
  });
  it("failed: the chip, the reason as text; Try again and Dismiss", () => {
    const r = rowOf(
      view([
        {
          ...OPUS,
          applied: {
            state: "failed",
            approval: "a1",
            at,
            decidedAt: at,
            reason: "<b>locked</b>",
          },
        },
      ]),
      OPUS.id,
    );
    expect(r).toContain('<span class="co-chip bad">[co.ap.failed]</span>');
    expect(r).toContain("[co.ap.failed.line:&lt;b&gt;locked&lt;/b&gt;]");
    expect(r).not.toContain("<b>locked</b>");
    expect(r).toMatch(/data-act="coach-apply"[^>]*>\[co\.ap\.retry\]/);
  });
  it("failed with no reason: the plain line", () => {
    const r = rowOf(
      view([{ ...OPUS, applied: { state: "failed", approval: "a1", at } }]),
      OPUS.id,
    );
    expect(r).toContain("[co.ap.failed.none]");
  });
  it("an Apply that couldn't be asked: the red line, read out", () => {
    const html = view([OPUS], { applyFailed: OPUS.id });
    expect(html).toMatch(/class="co-fail" role="alert">\[co\.ap\.fail:/);
  });
});

describe("phone (rule 9)", () => {
  it("cards: the change, Apply and Dismiss full width; waiting shows the chip and its line", () => {
    let c = cardOf(view([OPUS, POLL]), OPUS.id);
    expect(c).toContain("[co.ap.proposed:");
    expect(c).toMatch(
      /class="den-btn primary co-fdis-wide" data-act="coach-apply"/,
    );
    expect(c).toMatch(/class="den-btn co-fdis-wide" data-act="coach-dismiss"/);
    c = cardOf(
      view([{ ...OPUS, applied: { state: "waiting", approval: "a1", at } }]),
      OPUS.id,
    );
    expect(c).toContain("[co.ap.waiting]");
    expect(c).toContain("[co.ap.waiting.line]");
    expect(c).not.toContain("coach-apply");
  });
});

describe("read out when it changes", () => {
  it("says the new state with the finding's title; nothing when unchanged", () => {
    const before = [
      { ...OPUS, applied: { state: "waiting", approval: "a1", at } },
    ];
    const after = [
      { ...OPUS, applied: { state: "denied", approval: "a1", at } },
    ];
    expect(applyLiveText(before, after, {})).toBe(
      "[co.ap.live.denied:[co.f.subagent_opus.t:builder|87|140|]]",
    );
    expect(applyLiveText(after, after, {})).toBe("");
  });
});
