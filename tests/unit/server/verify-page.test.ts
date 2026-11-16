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
    for (const k of ["agent", "person", "den"]) keys.add(`v.actor_${k}`);
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
