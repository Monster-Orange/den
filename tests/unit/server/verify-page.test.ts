/**
 * Issue 209: the Verify page's views (public/verify-page.js), pure HTML
 * from /api/verify/overview's JSON, in en's words.
 *
 *   T1  every v.* key the page uses is in en, es and ja
 *   T3  environments come worst first, and a failed card offers See why
 *   T4  answer → See why → Open report: the report is the second click
 *   S7  a project with no checks shows how to add one
 *   S8  nothing ran is never green
 *   S9  an agent's run says the agent started it and a person allowed it
 *   441 an imported environment ("bed"): the tag's answer, clause counts,
 *       failed first, then couldn't run and needs you; its why view has a
 *       clauses table per check; a runner's text stays plain text
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import {
  answerView,
  whyView,
  worstFirst,
} from "../../../src/ui/server/public/verify-page.js";
import { installEnShell } from "./helpers/en-catalog.js";

installEnShell();

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

function catalogs(): Record<string, Record<string, string>> {
  const window: Record<string, unknown> = {};
  const ctx = vm.createContext({
    window,
    document: {
      getElementById: () => null,
      documentElement: { lang: "en" },
      addEventListener: () => {},
    },
    Intl,
  });
  for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
    try {
      vm.runInContext(read(f), ctx);
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  }
  return window.denMessages as Record<string, Record<string, string>>;
}

const at = "2026-11-15T14:10:00Z";
const ov = {
  ok: true,
  project: "north",
  modules: 3,
  envOrder: ["local", "staging", "production"],
  envs: [
    {
      env: "local",
      answer: "ready",
      counts: {
        passed: 3,
        failed: 0,
        error: 0,
        blocked: 0,
        notrun: 0,
        total: 3,
      },
      failures: [],
      blocked: [],
    },
    {
      env: "production",
      answer: "nothing",
      nothing: "none-here",
      counts: {
        passed: 0,
        failed: 0,
        error: 0,
        blocked: 0,
        notrun: 0,
        total: 0,
      },
      failures: [],
      blocked: [],
    },
    {
      env: "staging",
      answer: "failed",
      counts: {
        passed: 1,
        failed: 1,
        error: 0,
        blocked: 1,
        notrun: 0,
        total: 3,
      },
      run: {
        runId: "r-stage",
        endedAt: at,
        verdict: "failed",
        scope: "all",
        startedBy: { kind: "agent", name: "Release helper" },
        allowedBy: { kind: "person" },
        commit: "e4f5a6b9",
        checks: 3,
      },
      failures: [
        {
          module: "api/orders",
          state: "failed",
          message: "POST /orders returned 500",
          runId: "r-stage",
          report: true,
        },
      ],
      blocked: [{ module: "web/checkout", blockedBy: "api" }],
    },
  ],
  checks: [
    {
      module: "api/orders",
      layer: "api",
      kind: "integration",
      dependsOn: [],
      states: { local: "passed", staging: "failed", production: "off" },
    },
  ],
  activity: [
    {
      runId: "r-stage",
      env: "staging",
      verdict: "failed",
      startedAt: at,
      endedAt: at,
      startedBy: { kind: "agent", name: "Release helper" },
      allowedBy: { kind: "person" },
      checks: 3,
    },
  ],
};

describe("issue 209: the Verify page", () => {
  it("T1: every v.* key the page uses is in en, es and ja", () => {
    const src = read("verify-page.js");
    const keys = new Set(
      [...src.matchAll(/"(v\.[a-z0-9_]+(?:\.[a-z0-9_]+)*)"/g)].map((m) => m[1]),
    );
    for (const k of ["agent", "person", "den", "runner"])
      keys.add(`v.actor_${k}`);
    for (const k of [
      "smoke",
      "integration",
      "synthetic",
      "security",
      "performance",
    ])
      keys.add(`v.k_${k}`);
    keys.add("n.verify");
    expect(keys.size).toBeGreaterThan(40);
    const m = catalogs();
    for (const lang of ["en", "es", "ja"]) {
      const missing = [...keys].filter((k) => !(k in m[lang]));
      expect([lang, missing]).toEqual([lang, []]);
    }
  });

  it('T2: the nav\'s Verify item is "Checks" at /verify; Tests stays for the older kinds', () => {
    const shell = read("shell.js");
    const item = (id: string) =>
      new RegExp(
        `id: "${id}",\\s*label: "(n\\.[\\w.]+)",[^}]*?href: "([^"]+)"`,
      ).exec(shell);
    expect(item("verify")?.slice(1)).toEqual(["n.verify", "/verify"]);
    expect(item("tests")?.slice(1)).toEqual(["n.tests", "/test-runs"]);
    const m = catalogs();
    expect([m.en["n.verify"], m.es["n.verify"], m.ja["n.verify"]]).toEqual([
      "Checks",
      "Comprobaciones",
      "チェック",
    ]);
  });

  it("T3: worst first, and only a failed card offers See why", () => {
    expect(worstFirst(ov.envs).map((e) => e.env)).toEqual([
      "staging",
      "production",
      "local",
    ]);
    const html = answerView(ov);
    const order = [...html.matchAll(/data-env="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["staging", "production", "local"]);
    const why = [...html.matchAll(/data-why="(\w+)"/g)].map((m) => m[1]);
    expect(why).toEqual(["staging"]);
    expect(html).toContain("See why");
    expect(html).toContain("Staging is not ready: api/orders failed.");
  });

  it("T4: See why shows the first failure and its report, one click from the answer", () => {
    const html = whyView(ov, "staging");
    expect(html).toContain('role="alert"');
    expect(html).toContain("POST /orders returned 500");
    expect(html).toMatch(
      /href="\/api\/verify\/runs\/r-stage\/report\?project=north&amp;module=api%2Forders"/,
    );
    expect(html).toContain("web/checkout");
    // A blocked check points at the layer that blocked it.
    expect(html).toMatch(
      /because they wait on the api layer:<ul>[\s\S]*?web\/checkout/,
    );
  });

  it("S8: nothing ran is never green", () => {
    const html = answerView(ov);
    const prod =
      /<section[^>]*data-env="production"[^>]*>[\s\S]*?<\/section>/.exec(
        html,
      )![0];
    expect(prod).not.toMatch(/vf-ok/);
    expect(prod).toContain("Nothing ran");
  });

  it("S9: an agent's run names the agent and says a person allowed it", () => {
    const html = answerView(ov);
    expect(html).toContain("Started by Release helper (agent).");
    expect(html).toContain("Allowed by a person.");
    expect(html).toContain("Commit e4f5a6b.");
  });

  it("S7: a project with no checks shows how to add one, and links the older tests", () => {
    const html = answerView({ ...ov, modules: 0, envs: [], checks: [] });
    expect(html).toContain("verify:");
    expect(html).toContain('href="/test-runs"');
    expect(html).not.toMatch(/vf-ok/);
  });
});

const bed = {
  env: "bed",
  answer: "failed",
  imported: true,
  counts: { passed: 1, failed: 1, error: 0, blocked: 1, notrun: 0, total: 3 },
  run: {
    runId: "v1.2.3-dev.5",
    tag: "v1.2.3-dev.5",
    startedAt: "2026-11-15T14:06:00Z",
    endedAt: at,
    verdict: "failed",
    scope: "imported",
    startedBy: { kind: "runner" },
    commit: "4e1b9a2c",
    checks: 3,
  },
  failures: [],
  blocked: [],
  clauses: {
    passed: 2,
    failed: 1,
    error: 0,
    needsPerson: 1,
    cantRun: 1,
    total: 5,
  },
  clauseFailures: [
    {
      check: "gate/327",
      clause: "the bell row names the prompt",
      result: "failed",
      note: "webkit: page row <b>not</b> found",
    },
  ],
  needsPerson: [
    {
      check: "gate/327",
      clause: "answering the prompt clears the wait",
      result: "needs-person",
      note: "answering a permission prompt is a person's act",
    },
  ],
  cantRun: [
    {
      check: "gate/406",
      clause: "the person signs in on a second device",
      result: "cant-run",
      note: "needs second device",
    },
  ],
  gateChecks: [
    {
      module: "gate/327",
      state: "failed",
      clauses: [
        {
          clause: "the bell row names the prompt",
          result: "failed",
          note: "webkit: page row <b>not</b> found",
          ms: 94000,
        },
        { clause: "stopping clears it", result: "passed", ms: 1346 },
        {
          clause: "answering the prompt clears the wait",
          result: "needs-person",
          note: "answering a permission prompt is a person's act",
        },
      ],
    },
    {
      module: "gate/330",
      state: "passed",
      clauses: [{ clause: "the row opens", result: "passed", ms: 12 }],
    },
    {
      module: "gate/406",
      state: "blocked",
      clauses: [
        {
          clause: "the person signs in on a second device",
          result: "cant-run",
          note: "needs second device",
        },
      ],
    },
  ],
};
const withBed = {
  ...ov,
  envOrder: [...ov.envOrder, "bed"],
  envs: [...ov.envs, bed],
};

describe("issue 441: gate results on an imported environment", () => {
  const cardOf = (html: string, env: string) =>
    new RegExp(`<section[^>]*data-env="${env}"[^>]*>[\\s\\S]*?</section>`).exec(
      html,
    )![0];

  it("the card says the tag's answer, where it came from, and the clause counts", () => {
    const c = cardOf(answerView(withBed), "bed");
    expect(c).toContain("data-imported");
    expect(c).toContain("<b>v1.2.3-dev.5</b> failed on bed: 1 clause failed.");
    expect(c).toContain("Commit 4e1b9a2.");
    expect(c).toContain("From an outside runner.");
    expect(c).toContain("3 checks, 5 clauses.");
    const counts = [
      ...c.matchAll(/<li data-count="([a-z-]+)"><b[^>]*>(\d+)<\/b>/g),
    ].map((m) => [m[1], m[2]]);
    expect(counts).toEqual([
      ["passed", "2"],
      ["failed", "1"],
      ["needs-person", "1"],
      ["cant-run", "1"],
    ]);
  });

  it("failed first, then couldn't run, then needs you, each naming its issue", () => {
    const c = cardOf(answerView(withBed), "bed");
    const heads = [...c.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) =>
      m[1]!.replace(/&#39;/g, "'"),
    );
    expect(heads).toEqual([
      "Failed (1)",
      "Couldn't run (1)",
      "Needs you (1)",
      "Checks on this tag",
    ]);
    expect(c).toContain("issue 327");
    expect(c).toContain("needs second device");
    // A runner's note is untrusted text: never markup.
    expect(c).toContain("webkit: page row &lt;b&gt;not&lt;/b&gt; found");
    expect(c).not.toContain("<b>not</b>");
  });

  it("each check on the tag is one row, the whole row opening its clauses", () => {
    const c = cardOf(answerView(withBed), "bed");
    const rows = [
      ...c.matchAll(
        /<a class="vf-row" href="([^"]+)" data-why="bed" data-check="[^"]+">/g,
      ),
    ].map((m) => m[1]);
    expect(rows).toEqual([
      "?why=bed#gate-327",
      "?why=bed#gate-330",
      "?why=bed#gate-406",
    ]);
    expect(c).toContain("1 of 3 clauses passed, 1 needs you");
    expect(c).toContain("1 of 1 clause passed");
  });

  it("a passing tag says so, and an empty imported environment is not run yet", () => {
    const pass = {
      ...bed,
      answer: "ready",
      clauses: { ...bed.clauses, failed: 0, cantRun: 0 },
      clauseFailures: [],
      cantRun: [],
    };
    const c = cardOf(answerView({ ...withBed, envs: [pass] }), "bed");
    expect(c).toContain(
      "<b>v1.2.3-dev.5</b> passed on bed: every clause that ran passed.",
    );
    expect(c).toContain("vf-ok");
    expect(c).not.toContain("Failed (");
    const none = {
      env: "bed",
      answer: "notrun",
      imported: true,
      counts: bed.counts,
      failures: [],
      blocked: [],
    };
    const n = cardOf(answerView({ ...withBed, envs: [none] }), "bed");
    expect(n).toContain("bed has not been checked yet.");
    expect(n).not.toMatch(/vf-ok/);
  });

  it("a project with no declared checks but an import still shows the card", () => {
    const html = answerView({ ...withBed, modules: 0, envs: [bed] });
    expect(html).toContain('data-env="bed"');
    expect(html).not.toContain('data-answer="empty"');
  });

  it("the why view: the lists, then a clauses table per check with result, clause, note and time", () => {
    const html = whyView(withBed, "bed");
    const heads = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'"),
    );
    expect(heads).toEqual([
      "Failed (1)",
      "Couldn't run (1)",
      "Needs you (1)",
      "gate/327 on v1.2.3-dev.5",
      "gate/330 on v1.2.3-dev.5",
      "gate/406 on v1.2.3-dev.5",
    ]);
    expect(html).toContain('id="gate-327"');
    const t327 = /<section[^>]*id="gate-327"[\s\S]*?<\/section>/.exec(html)![0];
    const rows = [...t327.matchAll(/<tr data-result="([a-z-]+)">/g)].map(
      (m) => m[1],
    );
    expect(rows).toEqual(["failed", "passed", "needs-person"]);
    expect(t327).toContain("94 s");
    expect(t327).toContain("1.3 s");
    expect(t327).toContain("Needs you");
    expect(t327).toContain("webkit: page row &lt;b&gt;not&lt;/b&gt; found");
    expect(html).toContain("Commit 4e1b9a2.");
  });

  it("the activity names the outside runner and the tag it sent", () => {
    const html = answerView({
      ...withBed,
      activity: [
        {
          runId: "v1.2.3-dev.5",
          env: "bed",
          verdict: "failed",
          startedAt: at,
          endedAt: at,
          startedBy: { kind: "runner" },
          checks: 3,
        },
      ],
    });
    expect(html).toContain("An outside runner");
    expect(html).toContain("sent its results for v1.2.3-dev.5 on bed.");
  });
});
