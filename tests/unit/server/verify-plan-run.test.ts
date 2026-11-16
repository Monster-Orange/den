/**
 * Issue 210: the Verify page's Plan and Allow (S2) and Running and
 * cancelled (S3) views, pure HTML from the routes' JSON, in en's words.
 *
 *   S2  an agent's ask names the agent, every module's mark and estimate,
 *       what can't run and why, Allow and Decline; local has Run only
 *   S3  progress with role="status", a queued module says what it waits
 *       for, Cancel asks once; cancelled is never a pass (T6)
 */
import { describe, expect, it } from "@jest/globals";
import {
  duration,
  planView,
  runView,
} from "../../../src/ui/server/public/verify-page.js";
import { installEnShell } from "./helpers/en-catalog.js";

installEnShell();

const mod = (name: string, layer: string, kind: string, mark: string) => ({
  id: `shop:${name}`,
  name,
  repo: "shop",
  layer,
  kind,
  mark,
  healthUrls: {},
});

const stagingPlan = {
  ok: true,
  project: "north",
  env: "staging",
  shared: true,
  allow: "needed",
  scope: "changed",
  modules: [
    {
      ...mod("api/smoke", "api", "smoke", "enforced"),
      adapter: "smoke",
      healthUrls: { staging: ["https://api.staging.example.test/health"] },
    },
    mod("api/orders", "api", "integration", "declared-read-only"),
    mod("code/deps", "code", "security", "reads-code-only"),
  ],
  cantRun: [
    {
      ...mod("web/devices", "web", "synthetic", "declared-by-service"),
      reason: "adapter-later",
      adapter: "device-farm",
    },
  ],
  layers: {},
  nothingToRun: false,
  estimates: { "shop:api/orders": 125_000 },
};

describe("issue 210: S2 Plan and Allow", () => {
  it("an agent's ask: who asks, each mark, the estimate, what can't run, Allow and Decline", () => {
    const html = planView({
      plan: stagingPlan,
      asker: "release-helper",
      state: "waiting",
      fixed: true,
    });
    expect(html).toContain("release-helper wants to run 3 checks on Staging.");
    for (const w of ["enforced", "declared read-only", "reads code only"])
      expect(html).toContain(w);
    expect(html).toContain("about 2 min");
    expect(html).toContain("About 2 min in total.");
    expect(html).toContain("1 check can&#39;t run");
    expect(html).toContain(
      "web/devices: its runner (device-farm) comes in a later Den.",
    );
    // The mock (direction C, frame 2a): the waiting tag first, then who asks.
    expect(html.indexOf("Waiting for your Allow")).toBeLessThan(
      html.indexOf("wants to run"),
    );
    expect(html).toMatch(/role="status">Waiting for your Allow/);
    expect(html).toContain('class="vf-av vf-av-agent"');
    // What they touch: hosts, speed, writes.
    expect(html).toContain("What they touch");
    expect(html).toMatch(
      /<dt>Hosts<\/dt><dd><code>api\.staging\.example\.test<\/code>/,
    );
    expect(html).toContain(
      "<dt>Speed</dt><dd>Den doesn&#39;t limit speed on a run yet.</dd>",
    );
    expect(html).toContain(
      "<dt>Writes</dt><dd>Every check says it sends safe reads only.</dd>",
    );
    // The order, in groups: smoke first, then each layer, code scans.
    expect(html).toContain("Smoke checks first");
    expect(html).toContain("api layer");
    expect(html).toContain(
      "code scans: they only read the code and never touch Staging",
    );
    expect(html).toContain('data-act="allow"');
    expect(html).toContain('data-act="decline"');
    expect(html).toContain("release-helper waits until you decide.");
    // The ask is fixed: no scope switch.
    expect(html).not.toContain("data-vf-scope");
  });

  it("writes: names the checks allowed to write, everything else reads", () => {
    const html = planView({
      plan: {
        ...stagingPlan,
        modules: stagingPlan.modules.map((m) =>
          m.name === "api/orders" ? { ...m, writes: true } : m,
        ),
      },
      state: "ready",
    });
    expect(html).toContain(
      "<dt>Writes</dt><dd>Allowed for api/orders only. Everything else sends safe reads only.</dd>",
    );
  });

  it("the person's own plan on staging: the scope switch, and Allow covers this run only", () => {
    const html = planView({ plan: stagingPlan, state: "ready", fixed: false });
    expect(html).toContain("Run 3 checks on Staging");
    expect(html).toContain('data-vf-scope="changed" aria-pressed="true"');
    expect(html).toContain('data-vf-scope="all" aria-pressed="false"');
    expect(html).toContain("Nothing runs until you Allow it.");
  });

  it("local needs no Allow: the button is Run", () => {
    const html = planView({
      plan: { ...stagingPlan, env: "local", shared: false, allow: "none" },
      state: "ready",
    });
    expect(html).toContain('data-act="run"');
    expect(html).not.toContain('data-act="allow"');
    expect(html).not.toContain('data-act="decline"');
  });

  it("declined and expired close the buttons; nothing to run says why", () => {
    for (const [state, text] of [
      ["declined", "Declined. Nothing ran."],
      ["expired", "This ask waited too long and expired. Nothing ran."],
    ]) {
      const html = planView({ plan: stagingPlan, state, fixed: true });
      expect(html).toContain(text);
      expect(html).not.toContain('data-act="allow"');
    }
    const none = planView({
      plan: {
        ...stagingPlan,
        modules: [],
        nothingToRun: true,
        reason: "unchanged",
      },
      state: "ready",
    });
    expect(none).toContain("Nothing to run on Staging");
    expect(none).toContain("Nothing changed since the last results.");
    expect(none).not.toContain('data-act="allow"');
  });
});

const run = (over: Record<string, unknown>) => ({
  ok: true,
  runId: "r-1",
  project: "north",
  env: "staging",
  scope: "changed",
  verdict: "running",
  exitCode: null,
  startedAt: "2026-11-15T14:00:00Z",
  startedBy: { kind: "agent", name: "release-helper" },
  allowedBy: { kind: "person" },
  live: true,
  modules: [
    {
      ...mod("api/smoke", "api", "smoke", "enforced"),
      state: "passed",
      ms: 900,
    },
    {
      ...mod("api/orders", "api", "integration", "declared-read-only"),
      state: "running",
      ms: 0,
    },
    {
      ...mod("web/checkout", "web", "synthetic", "declared-read-only"),
      state: "queued",
      waitsFor: "api",
      ms: 0,
    },
  ],
  ...over,
});

describe("issue 210: S3 Running and cancelled", () => {
  it("running: progress with role=status, what a queued check waits for, Cancel", () => {
    const html = runView(run({}), { now: Date.parse("2026-11-15T14:03:05Z") });
    expect(html).toContain("Running on Staging");
    expect(html).toMatch(
      /role="status">1 of 3 checks are done\. Nothing has failed yet\. 3 min so far\./,
    );
    expect(html).toContain('<progress class="vf-prog" max="3" value="1"');
    expect(html).toContain("waits for api to pass");
    expect(html).toContain("running now");
    expect(html).toContain("Started by release-helper");
    // The mock (frame 3a): Cancel run in the header; a finished check says done.
    expect(html).toMatch(
      /class="vf-head"><div><h2[^>]*>Running on Staging<\/h2><\/div><button[^>]*data-act="cancel"/,
    );
    // Still going: it never says when it finished.
    expect(html).not.toContain("Finished");
    expect(html).toMatch(/<code>api\/smoke<\/code>.*done/);
  });

  it("Cancel asks once before it stops anything", () => {
    const html = runView(run({}), { confirming: true });
    expect(html).toContain("Stop this run?");
    expect(html).toContain('data-act="cancel-yes"');
    expect(html).toContain('data-act="cancel-no"');
  });

  it("T6: cancelled is never a pass: no success tone, says who and how many stopped", () => {
    const html = runView(
      run({
        verdict: "cancelled",
        exitCode: 4,
        live: undefined,
        endedAt: "2026-11-15T14:05:00Z",
        cancelledBy: { kind: "person" },
        cancelledAt: "2026-11-15T14:05:00Z",
        modules: [
          {
            ...mod("api/smoke", "api", "smoke", "enforced"),
            state: "passed",
            ms: 900,
          },
          {
            ...mod("api/orders", "api", "integration", "declared-read-only"),
            state: "cancelled",
            ms: 2000,
          },
          {
            ...mod("web/checkout", "web", "synthetic", "declared-read-only"),
            state: "cancelled",
            ms: 0,
          },
        ],
      }),
    );
    expect(html).toMatch(/<h2 tabindex="-1">Cancelled<\/h2>/);
    expect(html).toContain("Cancelled by A person at");
    expect(html).toContain("1 finished and 2 were stopped.");
    expect(html).toContain("Cancelled is not a pass.");
    expect(html).toContain("stopped before it ran");
    expect(html).not.toMatch(/vf-badge vf-ok/);
    expect(html).not.toContain('data-act="cancel"');
  });

  it("a run Den lost at a restart says so, with no Cancel", () => {
    const html = runView(run({ live: false }));
    expect(html).toContain("This run stopped when Den restarted.");
    expect(html).not.toContain('data-act="cancel"');
  });

  it("durations read in the page's language", () => {
    expect(duration(45_000)).toBe("45 sec");
    expect(duration(185_000)).toBe("3 min");
  });
});
