/**
 * Issue 52, the Coach tab on the platform agent's page, in a browser (mock
 * v4, approved). GET /api/coach is answered with a fixed report, so the
 * page's own code is what's checked:
 *   - Terminal | Coach tabs; ?tab=coach opens the Coach;
 *   - the table sorts on a header click (aria-sort), and a whole-row click
 *     opens the detail; Close puts focus back on the row;
 *   - Dismiss shows dots in its button, then the kit's Undo toast; Undo
 *     sends the dismissal back;
 *   - a phone shows cards, never the table, and full-width Dismiss.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({ fresh: true });
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const W = {
  from: "2026-11-15T12:00:00.000Z",
  to: "2026-11-22T12:00:00.000Z",
  days: 7,
};
const row = (agent: string, output_M: number, compactions: number) => ({
  agent,
  workspace: "shop",
  persona: "builder",
  runtime: "den-claude",
  conversations: {
    inWindow: 1,
    total: 1,
    byWhy: { start: 1 },
    list: [{ from: "2026-11-21T15:10:00.000Z", why: "start" }],
  },
  transcripts: 1,
  metrics: {
    calls: 100,
    output_M,
    cache_read_B: 0.1,
    avg_context_k_main: 80,
    compactions,
    rotations: 0,
    polls: 3,
    denials: 0,
    tool_error_pct: 1,
    correction_pct: 2,
  },
  perDay: { calls_per_day: 14.3, output_M_per_day: output_M / 7 },
  models: { main: { "claude-opus-5-5": 10 }, subagent: {} },
});

function coachBody(dismissed: { id: string; at: string }[]) {
  const all = [
    {
      id: "polling:tester",
      kind: "polling",
      agent: "tester",
      workspace: "shop",
      title: "t",
      evidence: { polls_per_day: 96 },
      proposal: "p",
      window: W,
    },
  ];
  const gone = new Set(dismissed.map((d) => d.id));
  return {
    ok: true,
    settings: { enabled: true, findings: { polls_per_day: 20 } },
    report: {
      version: 1,
      ranAt: "2026-11-22T17:14:00.000Z",
      window: W,
      agents: [row("builder", 1.84, 9), row("tester", 0.55, 2)],
      totals: { calls: 200, output_M: 2.39, compactions: 11 },
      totalsPerDay: { calls_per_day: 28.6 },
      cost: { model: null, tokens: 0 },
    },
    running: false,
    progress: null,
    failed: null,
    findings: all.filter((f) => !gone.has(f.id)),
    dismissed: dismissed.map((d) => ({ ...d, reason: "", by: "person" })),
  };
}

/** Stub the Coach's routes: a fixed report; Dismiss waits for `release`. */
async function stub(p: Page) {
  const dismissed: { id: string; at: string }[] = [];
  const posts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  await p.route("**/api/coach", (r: Route) =>
    r.fulfill({ json: coachBody(dismissed) }),
  );
  await p.route("**/api/coach/dismiss", async (r: Route) => {
    posts.push(`dismiss ${r.request().postData()}`);
    await gate;
    dismissed.push({ id: "polling:tester", at: "2026-11-22T17:20:00.000Z" });
    await r.fulfill({ json: { ok: true } });
  });
  await p.route("**/api/coach/undismiss", async (r: Route) => {
    posts.push(`undismiss ${r.request().postData()}`);
    dismissed.splice(0);
    await r.fulfill({ json: { ok: true } });
  });
  return { posts, release };
}

async function open(path: string, width = 1440, clock = false) {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  if (clock) await p.clock.install();
  const h = await stub(p);
  await signInPage(p, s!.stateDir, s!.base, path);
  return { p, ...h };
}

describe("the Coach tab", () => {
  it("Terminal and Coach tabs; ?tab=coach opens the Coach; the table sorts and a row opens", async () => {
    if (!browser) return;
    const { p } = await open("/server-agent");
    await expect(
      p.locator("#sa-tab-terminal").getAttribute("aria-selected"),
    ).resolves.toBe("true");
    await p.locator("#sa-tab-coach").click();
    await p.locator('[data-note="coach-table"]').waitFor();
    expect(new URL(p.url()).searchParams.get("tab")).toBe("coach");
    expect(await p.locator("#sa-body").isHidden()).toBe(true);
    const names = await p
      .locator('[data-note="coach-table"] tr[data-agent]')
      .evaluateAll((rs) => rs.map((r) => r.getAttribute("data-agent")));
    expect(names).toEqual(["builder", "tester"]);
    await p.locator('[data-act="coach-sort"][data-key="agent"]').click();
    await expect(
      p.locator("th[aria-sort]").getAttribute("aria-sort"),
    ).resolves.toBe("ascending");
    // A click anywhere on the row opens its detail.
    await p.locator('tr[data-agent="tester"]').click();
    await p.locator('[data-note="coach-detail"]').waitFor();
    await p.locator('[data-note="coach-close"]').click();
    await expect(
      p.evaluate(() => document.activeElement?.getAttribute("data-agent")),
    ).resolves.toBe("tester");
    await p.context().close();
  });

  it("Dismiss: dots in the button, then the kit's Undo toast; Undo takes it back", async () => {
    if (!browser) return;
    const { p, posts, release } = await open(
      "/server-agent?tab=coach",
      1440,
      true,
    );
    const btn = p.locator(
      '[data-note="coach-findings-table"] [data-act="coach-dismiss"]',
    );
    await btn.click();
    await expect(btn.getAttribute("aria-busy")).resolves.toBe("true");
    expect(await btn.isDisabled()).toBe(true);
    release();
    const toast = p.locator("[data-toast-words]");
    await p.clock.runFor(100);
    await toast.waitFor();
    // The finding's own title (co.f.polling.t), with its agent's name.
    await expect(
      toast.locator("[data-toast-msg]").textContent(),
    ).resolves.toContain("tester");
    await toast.hover();
    await p.clock.runFor(12_000);
    expect(await toast.isVisible()).toBe(true);
    expect(await p.locator('[data-note="coach-no-findings"]').count()).toBe(1);
    expect(posts[0]).toBe('dismiss {"id":"polling:tester"}');
    await p.locator("[data-toast-undo]").click();
    await p.locator('[data-note="coach-findings-table"]').waitFor();
    expect(posts[1]).toBe('undismiss {"id":"polling:tester"}');
    // Undo runs once: the kit says Undone. and takes the button away.
    expect(await p.locator("[data-toast-undo]").count()).toBe(0);
    await expect(p.locator("[data-toast-msg]").textContent()).resolves.toBe(
      "Undone.",
    );
    // Dismissed again and left alone, the toast goes after its 8 s.
    await p
      .locator('[data-note="coach-findings-table"] [data-act="coach-dismiss"]')
      .click();
    await p.locator("[data-toast-undo]").waitFor();
    await p.mouse.move(0, 0);
    await p.clock.runFor(9_000);
    expect(await p.locator("[data-toast-msg]").count()).toBe(0);
    await p.context().close();
  });

  it("a phone shows cards, never the table, and a full-width Dismiss", async () => {
    if (!browser) return;
    const { p } = await open("/server-agent?tab=coach", 390);
    await p.locator('[data-note="coach-cards"]').waitFor();
    expect(await p.locator('[data-note="coach-table"]').isVisible()).toBe(
      false,
    );
    const box = await p
      .locator('[data-note="coach-finding-cards"] [data-act="coach-dismiss"]')
      .boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const doc = await p.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(doc.sw).toBeLessThanOrEqual(doc.cw);
    expect(errors).toEqual([]);
    await p.context().close();
  });
});
