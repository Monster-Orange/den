/**
 * Issue 52, the Coach tab (public/coach-tab.js), as mock v2 draws it ("Coach
 * tab: what your agents used this week", in Hub). Pure: HTML from GET
 * /api/coach, with the strings' keys (no shell here, so t() gives the key).
 *
 *   - Off: the empty state with Open Settings, and Run now disabled;
 *   - Not run yet, Running (with its progress), Failed (over the report
 *     before), and a report: tiles, the table, the cards;
 *   - the table sorts by any column (output tokens first, largest first),
 *     marks the mock's amber values, and Per day changes counts only;
 *   - a row opens its detail: conversations newest first, the model mix;
 *   - an agent's name is shown as text, never as markup.
 */
import { describe, expect, it } from "@jest/globals";
import {
  COLUMNS,
  DEFAULT_SORT,
  cellValue,
  coachState,
  coachTabView,
  findingWords,
  fmtCell,
  isAmber,
  modelMix,
  nextSort,
  sortRows,
} from "../../../src/ui/server/public/coach-tab.js";

const W = {
  from: "2026-11-15T12:00:00.000Z",
  to: "2026-11-22T12:00:00.000Z",
  days: 7,
};

function row(agent: string, m: Record<string, number> = {}, over = {}) {
  const metrics = {
    calls: 100,
    output_M: 0.5,
    cache_read_B: 0.2,
    avg_context_k_main: 90,
    compactions: 1,
    rotations: 0,
    polls: 2,
    denials: 0,
    tool_error_pct: 1.5,
    correction_pct: 4,
    ...m,
  };
  return {
    agent,
    workspace: "shop",
    persona: "builder",
    runtime: "den-claude",
    conversations: {
      inWindow: 2,
      total: 3,
      byWhy: { start: 1, rotation: 1 },
      list: [
        { from: "2026-11-21T15:10:00.000Z", why: "rotation" },
        { from: "2026-11-16T10:05:00.000Z", why: "start", backfilled: true },
      ],
    },
    transcripts: 2,
    metrics,
    perDay: {
      calls_per_day: metrics.calls / 7,
      output_M_per_day: metrics.output_M / 7,
      compactions_per_day: metrics.compactions / 7,
      polls_per_day: metrics.polls / 7,
      rotations_per_day: 0,
    },
    models: {
      main: { "claude-opus-5-5": 90, "claude-sonnet-5-5": 10 },
      subagent: { "claude-haiku-5-5": 5 },
    },
    ...over,
  };
}

const REPORT = {
  version: 1,
  ranAt: "2026-11-22T17:14:00.000Z",
  window: W,
  agents: [
    row("builder", { output_M: 1.84, compactions: 9, polls: 41 }),
    row("tester", { output_M: 0.55, tool_error_pct: 8.9 }),
    row(
      "quiet",
      {},
      {
        metrics: undefined,
        perDay: undefined,
        why: "no conversation in the window",
      },
    ),
  ],
  totals: { calls: 300, output_M: 2.89, compactions: 11 },
  totalsPerDay: {
    calls_per_day: 42.9,
    output_M_per_day: 0.41,
    compactions_per_day: 1.6,
  },
  cost: { model: null, tokens: 0 },
};

const on = { enabled: true };
const data = (over = {}) => ({
  ok: true,
  settings: on,
  report: REPORT,
  running: false,
  progress: null,
  failed: null,
  findings: [],
  dismissed: [],
  ...over,
});

describe("the Coach tab's states (mock v2)", () => {
  it("off: the empty state with Open Settings, and Run now shown disabled", () => {
    const html = coachTabView(data({ settings: { enabled: false } }));
    expect(coachState(data({ settings: { enabled: false } }))).toBe("off");
    expect(html).toContain('data-note="coach-off"');
    expect(html).toContain("co.openSettings");
    expect(html).toMatch(/data-act="coach-run" disabled aria-disabled="true"/);
    expect(html).not.toContain("co-table");
  });

  it("not run yet: Run now, and the empty state", () => {
    const html = coachTabView(data({ report: null }));
    expect(html).toContain("co.none.h");
    expect(html).toContain('data-note="coach-none"');
    expect(html).toMatch(
      /class="den-btn primary" data-act="coach-run">co\.run</,
    );
  });

  it("running: its progress, and the button busy and disabled", () => {
    const html = coachTabView(
      data({ running: true, progress: { done: 4, total: 6 } }),
    );
    expect(html).toContain("co.running.sub");
    expect(html).toContain('aria-valuenow="67"');
    expect(html).toMatch(
      /disabled aria-disabled="true" aria-busy="true">co\.running</,
    );
    expect(html).toContain('data-note="coach-running"');
  });

  it("failed: the error, Run again, and the report before it, unchanged", () => {
    const html = coachTabView(
      data({
        failed: { at: "2026-11-22T17:14:00.000Z", error: "file locked" },
      }),
    );
    expect(html).toContain("co-bad");
    expect(html).toContain("file locked");
    expect(html).toContain("co.failed.before");
    expect(html).toContain("co.runAgain");
    expect(html).toContain('data-note="coach-before"');
    expect(html).toContain("co-table");
  });

  it("a report: the last run and what it cost, tiles, toolbar, table, cards", () => {
    const html = coachTabView(data());
    expect(html).toContain("co.last");
    expect(html).toContain("co.costNone");
    expect(html.match(/class="co-tl"/g)).toHaveLength(4);
    expect(html).toContain(
      'data-act="coach-counts" data-v="total" aria-pressed="true"',
    );
    expect(html.match(/<tr class="co-r/g)).toHaveLength(3);
    expect(html.match(/class="co-ac"/g)).toHaveLength(3);
    expect(html).toContain("co.foot");
  });
});

describe("the table", () => {
  it("has the mock's columns, in its order", () => {
    expect(COLUMNS.map((c) => c.key)).toEqual([
      "agent",
      "calls",
      "output_M",
      "cache_read_B",
      "avg_context_k_main",
      "compactions",
      "rotations",
      "conversations",
      "polls",
      "denials",
      "tool_error_pct",
      "correction_pct",
    ]);
  });

  it("sorts by output tokens, largest first, by default; agents with no numbers last", () => {
    expect(DEFAULT_SORT).toEqual({ key: "output_M", dir: "desc" });
    expect(sortRows(REPORT.agents).map((r) => r.agent)).toEqual([
      "builder",
      "tester",
      "quiet",
    ]);
    const html = coachTabView(data());
    expect(html).toMatch(
      /aria-sort="descending"><button[^>]*data-key="output_M"/,
    );
  });

  it("any header sorts; a second click turns it round; Agent sorts A to Z first", () => {
    expect(nextSort(DEFAULT_SORT, "output_M")).toEqual({
      key: "output_M",
      dir: "asc",
    });
    expect(nextSort(DEFAULT_SORT, "polls")).toEqual({
      key: "polls",
      dir: "desc",
    });
    expect(nextSort(DEFAULT_SORT, "agent")).toEqual({
      key: "agent",
      dir: "asc",
    });
    expect(
      sortRows(REPORT.agents, { key: "tool_error_pct", dir: "desc" }).map(
        (r) => r.agent,
      ),
    ).toEqual(["tester", "builder", "quiet"]);
  });

  it("marks 6+ compactions, 40+ polls and 8%+ tool errors amber, on the totals", () => {
    const [b, t] = REPORT.agents;
    expect(isAmber(b, "compactions")).toBe(true);
    expect(isAmber(b, "polls")).toBe(true);
    expect(isAmber(t, "tool_error_pct")).toBe(true);
    expect(isAmber(t, "compactions")).toBe(false);
    expect(coachTabView(data()).match(/class="co-hi"/g)).toHaveLength(3);
  });

  it("Per day changes the counts only, never percents or averages", () => {
    const [b] = REPORT.agents;
    expect(cellValue(b, "calls", true)).toBeCloseTo(100 / 7);
    expect(cellValue(b, "tool_error_pct", true)).toBe(1.5);
    expect(cellValue(b, "avg_context_k_main", true)).toBe(90);
    expect(cellValue(b, "conversations", true)).toBe(2);
    const html = coachTabView(data(), { perDay: true });
    expect(html).toContain('data-v="per_day" aria-pressed="true"');
  });

  it("formats tokens, percents and counts; no number shows a dash", () => {
    expect(fmtCell("output_M", 1.84)).toBe("1.84M");
    expect(fmtCell("cache_read_B", 0.612)).toBe("612M");
    expect(fmtCell("avg_context_k_main", 148)).toBe("148K");
    expect(fmtCell("tool_error_pct", 4.2)).toBe("4.2%");
    expect(fmtCell("calls", 3412)).toBe("3,412");
    expect(fmtCell("calls", null)).toBe("—");
  });
});

describe("a row's detail", () => {
  it("opens under the table: conversations newest first, kinds, model mix, Close", () => {
    const html = coachTabView(data(), { open: "builder" });
    expect(html).toContain(
      'class="co-r sel" data-act="coach-open" data-agent="builder" tabindex="0" role="button" aria-expanded="true"',
    );
    expect(html).toContain('class="co-det"');
    const kinds = [...html.matchAll(/class="co-kd[^"]*">([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(kinds).toEqual(["co.kind.rotation", "co.kind.start"]);
    expect(html).toContain('co-kd rot"');
    expect(html).toContain("co.approx");
    expect(html).toContain("co.mix.h");
    expect(html).toContain('data-act="coach-close"');
    expect(html).toContain("co-has-detail");
  });

  it("mock v6: the subagent mix says the Coach flags it below, when it does", () => {
    const opus = {
      id: "subagent_opus:builder",
      kind: "subagent_opus",
      agent: "builder",
      workspace: "shop",
      title: "builder (shop) runs subagents on Opus.",
      evidence: { subagent_opus_pct: 87 },
      proposal: "Run its subagents on Sonnet.",
      window: W,
    };
    const det = (findings: unknown[]) => {
      const html = coachTabView(data({ settings: SETTINGS, findings }), {
        open: "builder",
      });
      return html.slice(html.indexOf('class="co-det"'));
    };
    expect(det([opus])).toContain("co.mix.flagged");
    expect(det([])).not.toContain("co.mix.flagged");
    expect(
      det([{ ...opus, agent: "tester", id: "subagent_opus:tester" }]),
    ).not.toContain("co.mix.flagged");
  });

  it("the model mix is by family, in percent of calls", () => {
    expect(
      modelMix({ "claude-opus-5-5": 90, "claude-sonnet-5-5": 10 }),
    ).toEqual({
      opus: 90,
      sonnet: 10,
      haiku: 0,
      other: 0,
    });
    expect(modelMix({})).toBeNull();
  });
});

describe("agents' names are text", () => {
  it("escapes a name in the table, the cards and the detail", () => {
    const evil = row('<img src=x onerror="alert(1)">');
    const html = coachTabView(data({ report: { ...REPORT, agents: [evil] } }), {
      open: evil.agent,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("escapes a failed run's error", () => {
    const html = coachTabView(
      data({ failed: { at: "2026-11-22T17:14:00.000Z", error: "<b>x</b>" } }),
    );
    expect(html).not.toContain("<b>x</b>");
  });
});

const FINDINGS = [
  {
    id: "polling:tester",
    kind: "polling",
    agent: "tester",
    workspace: "shop",
    title: "tester (shop) polls 96 times a day.",
    evidence: { polls_per_day: 96 },
    proposal: "Point it to running long work in the background.",
    window: W,
  },
  {
    id: "no_rotation:builder",
    kind: "no_rotation",
    agent: "builder",
    workspace: "shop",
    title: "builder (shop) is at 9 compactions.",
    evidence: { compactions: 9, after: 3 },
    proposal: "Relaunch it from its handoff.",
    window: W,
  },
];
const SETTINGS = {
  enabled: true,
  findings: { polls_per_day: 20, denials_per_day: 5 },
};

describe("findings (mock v6)", () => {
  const withF = (over = {}) =>
    data({ settings: SETTINGS, findings: FINDINGS, ...over });

  it("sit under the table: heading, count, the three columns, a Dismiss each", () => {
    const html = coachTabView(withF());
    expect(html.indexOf("co-table")).toBeLessThan(html.indexOf("co-findings"));
    expect(html).toContain("co.f.h");
    expect(html).toContain("co.f.count");
    for (const k of ["co.f.col.finding", "co.f.col.agent", "co.f.col.why"])
      expect(html).toContain(k);
    expect(html.match(/data-act="coach-dismiss"/g)).toHaveLength(4); // table + phone cards
    expect(html).not.toMatch(/Apply/);
  });

  it("are sorted by their agent's output tokens, largest first", () => {
    const html = coachTabView(withF());
    const ids = [...html.matchAll(/<tr class="co-fr" data-id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(ids).toEqual(["no_rotation:builder", "polling:tester"]);
  });

  it("say what was found and why from the kind and its numbers, with the line it passed", () => {
    expect(findingWords(FINDINGS[0], SETTINGS.findings)).toEqual({
      title: "co.f.polling.t",
      why: "co.f.polling.why",
      vars: { agent: "tester", n: 96, line: 20 },
    });
    expect(findingWords(FINDINGS[1], SETTINGS.findings)).toEqual({
      title: "co.f.no_rotation.t",
      why: "co.f.no_rotation.why",
      vars: { agent: "builder", n: 9, line: 3 },
    });
  });

  it("a kind the page doesn't know shows the run's own words, as text", () => {
    const odd = {
      ...FINDINGS[0],
      id: "odd:tester",
      kind: "odd",
      title: "<b>odd</b>",
      proposal: "p",
    };
    const html = coachTabView(withF({ findings: [odd] }));
    expect(html).toContain("&lt;b&gt;odd&lt;/b&gt;");
    expect(html).not.toContain("<b>odd</b>");
  });

  it("none: the box, and no Dismiss", () => {
    const html = coachTabView(withF({ findings: [] }));
    expect(html).toContain("co.f.none");
    expect(html).not.toContain('data-act="coach-dismiss"');
    expect(html).not.toContain("co.f.dismissedN");
  });

  it("dismissed ones: 'N dismissed · Show'; open, each with its date and Undo", () => {
    const dismissed = [
      {
        id: "denials:planner",
        reason: "",
        by: "person",
        at: "2026-11-22T17:20:00.000Z",
      },
    ];
    let html = coachTabView(withF({ dismissed }));
    expect(html).toContain("co.f.dismissedN");
    expect(html).toContain(
      'data-act="coach-dismissed-toggle" aria-expanded="false"',
    );
    expect(html).not.toContain('data-act="coach-undismiss"');
    html = coachTabView(withF({ dismissed }), { dismissedOpen: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("co.f.denials.t");
    expect(html).toContain("planner");
    expect(html).toContain("co.f.dismissedAt");
    expect(html).toContain(
      'data-act="coach-undismiss" data-id="denials:planner"',
    );
  });

  it("a Dismiss that failed: the red line under the table (Undo is the kit's toast)", () => {
    const html = coachTabView(withF(), { dismissFailed: "polling:tester" });
    expect(html).toContain("co.f.fail");
    expect(html).toMatch(/class="co-fail"[^>]*role="alert"/);
    expect(html).not.toContain("co-toast");
  });

  it("phone: one card per finding, each with a full-width Dismiss", () => {
    const html = coachTabView(withF());
    expect(html.match(/class="co-fc"/g)).toHaveLength(2);
    expect(html).toMatch(/class="den-btn co-fdis-wide"/);
  });

  it("a failed run still shows the report before it, and its findings", () => {
    const html = coachTabView(
      withF({ failed: { at: "2026-11-22T17:14:00.000Z", error: "locked" } }),
    );
    expect(html).toContain("co-findings");
  });

  it("off: the status says Off, Run now drawn disabled", () => {
    const html = coachTabView(data({ settings: { enabled: false } }));
    expect(html).toMatch(/<b>co\.off\.status<\/b><small>co\.off\.sub<\/small>/);
  });
});
