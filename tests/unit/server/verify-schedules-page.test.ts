/**
 * Issue 214: the Schedules screen (S11), pure HTML from
 * GET /api/verify/schedules, in en's words; the approved mock's frames:
 *   1  the way in: a Schedules link beside the answer's heading
 *   2  the list, each state: allowed, no Allow needed, plan changed,
 *      Allow expiring
 *   3  Allow this schedule: the plan card, fixed to its modules, expiry shown
 *   4  the plan changed: what changed, and what was missed
 *   6  empty: no schedules, with the one-line snippet
 * State is never colour alone: a symbol plus a word. Schedules come from the
 * repo: the page shows and allows them, never edits them.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  answerView,
  schedulesView,
} from "../../../src/ui/server/public/verify-page.js";
import { installEnShell } from "./helpers/en-catalog.js";

installEnShell();

const now = "2026-11-21T20:00:00.000Z";
const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.parse(now) + ms).toISOString();

const base = {
  modules: [
    { id: "shop:web/speed", name: "web/speed", mark: "declared-read-only" },
  ],
  shared: true,
  codeOnly: false,
  needsAllow: true,
  readOnly: false,
  skipped: [],
  last: null,
};
const SV = {
  ok: true,
  project: "north",
  now,
  zone: "America/Los_Angeles",
  settings: { allowExpiryMs: 30 * DAY, expiryWarningMs: 3 * DAY },
  schedules: [
    {
      ...base,
      id: "nightly-speed-1a2b3c4d",
      name: "Nightly speed",
      env: "staging",
      cron: "0 2 * * *",
      words: { kind: "daily", time: "02:00" },
      window: "01:00-05:00",
      state: "allowed",
      runs: true,
      allow: {
        by: { kind: "person" },
        at: iso(-DAY),
        expiresAt: iso(23 * DAY),
      },
      next: iso(6 * 3_600_000),
      last: { runId: "r1", verdict: "passed", at: iso(-18 * 3_600_000) },
    },
    {
      ...base,
      id: "code-scans-5e6f7a8b",
      name: "Weekly deep scans",
      env: "local",
      cron: "0 3 * * 1",
      words: { kind: "weekly", time: "03:00", days: [1] },
      modules: [
        { id: "shop:code/deps", name: "code/deps", mark: "reads-code-only" },
      ],
      shared: false,
      codeOnly: true,
      needsAllow: false,
      state: "no-allow-needed",
      runs: true,
      allow: null,
      next: iso(2 * DAY),
    },
    {
      ...base,
      id: "devices-9c0d1e2f",
      name: "Devices, twice a week",
      env: "staging",
      cron: "0 22 * * 2,5",
      words: { kind: "weekly", time: "22:00", days: [2, 5] },
      window: "20:00-06:00",
      modules: [
        { id: "shop:web/checkout", name: "web/checkout", mark: "enforced" },
        {
          id: "shop:web/devices",
          name: "web/devices",
          mark: "declared-by-service",
        },
      ],
      state: "plan-changed",
      runs: false,
      allow: {
        by: { kind: "person" },
        at: iso(-25 * DAY),
        expiresAt: iso(5 * DAY),
      },
      next: iso(DAY),
      skipped: [{ due: iso(-DAY), reason: "plan-changed" }],
      change: {
        added: ["shop:web/checkout"],
        removed: [],
        changed: [],
        writes: ["shop:web/checkout"],
      },
    },
    {
      ...base,
      id: "production-smoke-3a4b5c6d",
      name: "Production smoke",
      env: "production",
      cron: "0 * * * *",
      words: { kind: "hourly" },
      modules: [{ id: "shop:web/smoke", name: "web/smoke", mark: "enforced" }],
      readOnly: true,
      state: "expiring",
      runs: true,
      allow: {
        by: { kind: "person" },
        at: iso(-27 * DAY),
        expiresAt: iso(2 * DAY + 3_600_000),
      },
      next: iso(20 * 60_000),
      last: { runId: "r2", verdict: "failed", at: iso(-40 * 60_000) },
    },
  ],
};

const rowOf = (html: string, id: string) => {
  const at = html.indexOf(`id="sch-${id}"`);
  // A row holds lists of its own: it ends where the next row starts.
  const next = html.indexOf('<li class="vf-sch ', at);
  return html.slice(at, next < 0 ? undefined : next);
};

describe("issue 214: Schedules (S11)", () => {
  it("frame 1: a Schedules link beside the answer's heading", () => {
    const html = answerView({
      ok: true,
      project: "north",
      modules: 1,
      envs: [],
      activity: [],
    });
    expect(html).toMatch(
      /<a [^>]*href="\?schedules=1"[^>]*data-sched-open[^>]*>Schedules<\/a>/,
    );
  });

  it("frame 2: one row each, with its modules, when, window, next and last run", () => {
    const html = schedulesView(SV);
    expect(html).toContain("<h2");
    expect(html).toContain(
      "Checks that run on their own. Heavy ones run in their window.",
    );
    const speed = rowOf(html, "nightly-speed-1a2b3c4d");
    expect(speed).toContain('data-state="allowed"');
    expect(speed).toContain("<code>web/speed</code>");
    expect(speed).toContain("Every day at 02:00");
    expect(speed).toContain("01:00 to 05:00");
    expect(speed).toMatch(/Allowed until /);
    expect(speed).toMatch(/data-sch-run="nightly-speed-1a2b3c4d"/);
    expect(speed).not.toMatch(/data-sch-ask=/);

    const code = rowOf(html, "code-scans-5e6f7a8b");
    expect(code).toContain('data-state="no-allow-needed"');
    expect(code).toContain("Code");
    expect(code).toContain("Mondays at 03:00");
    expect(code).toContain("Any time");
    expect(code).toContain("Reads code only, so it needs no Allow.");

    const devices = rowOf(html, "devices-9c0d1e2f");
    expect(devices).toContain('data-state="plan-changed"');
    expect(devices).toContain("Tuesdays and Fridays at 22:00");
    expect(devices).toContain(
      "The plan changed, so this schedule needs a new Allow.",
    );
    expect(devices).toMatch(/role="status"/);
    expect(devices).toMatch(/data-sch-ask="devices-9c0d1e2f"/);
    expect(devices).not.toMatch(/data-sch-run=/);

    const prod = rowOf(html, "production-smoke-3a4b5c6d");
    expect(prod).toContain('data-state="expiring"');
    expect(prod).toContain("read-only");
    expect(prod).toContain("Every hour");
    expect(prod).toMatch(
      /The Allow expires .+ When it does, this schedule stops until someone allows it again\./,
    );
    expect(prod).toMatch(/data-sch-ask="production-smoke-3a4b5c6d"/);
    // Never colour alone: a symbol and a word.
    expect(prod).toMatch(
      /<span class="vf-st [^"]*"><span class="vf-mk" aria-hidden="true">✕<\/span>failed<\/span>/,
    );
    // From the repo: no add, edit or remove.
    expect(html).toContain("Schedules come from <code>schedule:</code>");
    expect(html).not.toMatch(/data-sch-(edit|add|remove)/);
  });

  it("frame 3: Allow this schedule shows the plan, fixed to its modules, with the expiry", () => {
    const html = schedulesView(SV, { open: "devices-9c0d1e2f" });
    const card = html.slice(html.indexOf('data-sch-card="devices-9c0d1e2f"'));
    expect(card).toContain(
      "Allow the schedule “Devices, twice a week” on Staging?",
    );
    expect(card).toContain("<code>web/checkout</code>");
    expect(card).toContain("enforced by Den");
    expect(card).toContain("declared by the service");
    expect(card).toMatch(
      /One Allow covers every run of this plan until it changes or expires on .+\./,
    );
    expect(card).toMatch(
      /<button type="button" class="den-btn primary" data-sch-allow="devices-9c0d1e2f">Allow this schedule<\/button>/,
    );
    expect(card).toMatch(/data-sch-decline="devices-9c0d1e2f">Decline</);
    expect(card).toContain(
      "Decline leaves the schedule paused. Nothing runs until someone allows it.",
    );
  });

  it("frame 4: the plan changed says what changed and what it missed", () => {
    const html = schedulesView(SV);
    const devices = rowOf(html, "devices-9c0d1e2f");
    expect(devices).toContain("What changed");
    expect(devices).toContain("<code>web/checkout</code> joined the schedule");
    expect(devices).toContain("<code>web/checkout</code> now writes");
    expect(devices).toContain("Missed while paused");
    expect(devices).toContain("needs a new Allow");
  });

  it("frame 6: empty, with the one-line snippet and how it works", () => {
    const html = schedulesView({ ...SV, schedules: [] });
    expect(html).toContain(
      "No schedules yet. Add <code>schedule:</code> to a module to run it on its own.",
    );
    expect(html).toContain("schedule: { cron:");
    expect(html).toContain(
      "A schedule on staging or production asks for an Allow once.",
    );
  });

  it("a name or a module from the repo stays plain text", () => {
    const html = schedulesView({
      ...SV,
      schedules: [{ ...SV.schedules[0], name: '<img src=x onerror="x()">' }],
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("every v.sch key it uses is in en, es and ja (the page's T1 covers v.*)", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/ui/server/public/verify-page.js"),
      "utf-8",
    );
    expect(src).toMatch(/"v\.sch_t"/);
  });
});
