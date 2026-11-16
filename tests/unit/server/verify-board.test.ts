/**
 * Issue 211: the Verify page's All environments tab (S1b, direction A's
 * board), pure HTML from GET /api/verify/overview, in en's words.
 *
 *   every environment across, every layer down; each cell a button whose
 *   name says layer, environment, state and counts; a state is a mark and
 *   a word, never colour alone; a layer with no checks here is "Not set
 *   up"; a code scan not re-run here says where it was scanned, not
 *   "Passed"; the panel lists the cell's checks with their recent results
 */
import { describe, expect, it } from "@jest/globals";
import {
  boardView,
  cellOf,
  tabsView,
} from "../../../src/ui/server/public/verify-page.js";
import { installEnShell } from "./helpers/en-catalog.js";

installEnShell();

const row = (
  module: string,
  layer: string,
  states: Record<string, string>,
  over: Record<string, unknown> = {},
) => ({
  module,
  layer,
  kind: "integration",
  mark: "declared-read-only",
  dependsOn: [],
  states,
  recent: { local: [], staging: [], production: [] },
  from: {},
  ...over,
});

const ov = {
  ok: true,
  project: "north",
  modules: 5,
  envOrder: ["local", "staging", "production"],
  activity: [],
  envs: [
    {
      env: "staging",
      answer: "failed",
      counts: {},
      failures: [],
      blocked: [],
      run: { runId: "r-s" },
    },
    {
      env: "local",
      answer: "ready",
      counts: {},
      failures: [],
      blocked: [],
      run: { runId: "r-l" },
    },
    {
      env: "production",
      answer: "notrun",
      counts: {},
      failures: [],
      blocked: [],
    },
  ],
  checks: [
    row(
      "web/checkout",
      "web",
      { local: "passed", staging: "blocked", production: "off" },
      { dependsOn: ["api"], kind: "synthetic" },
    ),
    row(
      "api/orders",
      "api",
      { local: "passed", staging: "failed", production: "off" },
      {
        recent: {
          local: ["passed", "passed"],
          staging: ["passed", "passed", "failed"],
          production: [],
        },
      },
    ),
    row("api/users", "api", {
      local: "passed",
      staging: "passed",
      production: "off",
    }),
    row(
      "code/deps",
      "code",
      { local: "passed", staging: "passed", production: "none" },
      {
        kind: "security",
        mark: "reads-code-only",
        from: {
          local: { commit: "a1b2c3d", runId: "r-l" },
          staging: { commit: "9f8e7d6", runId: "r-old" },
        },
      },
    ),
  ],
};

describe("issue 211: S1b the board", () => {
  it("environments across in the install's order, layers down, each cell a button that names itself", () => {
    const html = boardView(ov, {});
    expect(html.indexOf('data-vf-env="local"')).toBeLessThan(
      html.indexOf('data-vf-env="staging"'),
    );
    expect(html.indexOf(">web<")).toBeLessThan(html.indexOf(">api<"));
    expect(html).toContain('aria-label="api on Staging: Failed, 1 failed"');
    expect(html).toContain('aria-label="api on Local: Passed, 2 of 2 passed"');
    expect(html).toContain('aria-label="web on Staging: Blocked, 1 blocked"');
    // A mark and a word in every cell: never colour alone.
    expect(html).toMatch(
      /data-vf-cell="staging\|api"[^>]*>[\s\S]*?vf-mk[\s\S]*?Failed/,
    );
  });

  it("a layer with no checks on an environment is Not set up, and not a button", () => {
    const html = boardView(ov, {});
    expect(html).toContain("Not set up");
    expect(html).not.toContain('data-vf-cell="production|api"');
  });

  it("a code scan not re-run on an environment says where it was scanned, not Passed", () => {
    const stg = cellOf(ov, "staging", "code");
    expect(stg.word).toBe("Scanned at 9f8e7d6");
    // Re-run in local's latest run: an ordinary pass.
    expect(cellOf(ov, "local", "code").word).toBe("Passed");
    expect(cellOf(ov, "production", "code").word).toBe("Not run yet");
  });

  it("the panel: the cell's checks, each with its recent results, and Close", () => {
    const html = boardView(ov, { open: { env: "staging", layer: "api" } });
    expect(html).toMatch(/<h2[^>]*id="vf-panel-h"[^>]*>api on Staging<\/h2>/);
    expect(html).toContain("<code>api/orders</code>");
    expect(html).toContain("<code>api/users</code>");
    expect(html).toContain(
      'role="img" aria-label="Last 3 results: passed, passed, failed"',
    );
    expect(html).toContain("data-vf-close");
    // A failure reads its why (S4) in one click.
    expect(html).toContain('href="?why=staging"');
    // The open cell says so.
    expect(html).toMatch(
      /data-vf-cell="staging\|api"[^>]*aria-expanded="true"/,
    );
  });

  it("a check that waits on a layer says so in the panel; one with no results yet says that", () => {
    const html = boardView(ov, { open: { env: "staging", layer: "web" } });
    expect(html).toContain("Waits for api to pass");
    expect(html).toContain("No results here yet.");
  });

  it("the tabs: Answer and All environments, the open one pressed", () => {
    expect(tabsView("board")).toMatch(
      /data-vf-tab="board" aria-pressed="true">All environments/,
    );
    expect(tabsView("board")).toMatch(
      /data-vf-tab="answer" aria-pressed="false">Answer/,
    );
    expect(tabsView("answer")).toMatch(
      /data-vf-tab="answer" aria-pressed="true"/,
    );
  });
});
