/**
 * The shell's polls of /api/web/waiting (a device waiting to be let in)
 * and /api/approvals never stack up: while one is still open, the next
 * tick sends nothing. A refusal of the waiting list (401 or 403: a session
 * that may not read it, such as a test install's fixture person) stops
 * that poll for the page. Before this, a poll that never answered got a new request
 * every 3 s, so the page never settled.
 *
 * The shell also reads every refused answer in full, so a caller that
 * only looks at the status never leaves a request open (the fixture
 * person's refusals: src/shared/fixture-person.ts).
 *
 * The answers are faked at the page's network. Chromium; DEN_PW_WS
 * connects to a Playwright server instead of launching. The demo
 * distribution (helpers/agents-page-server.ts). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

jest.setTimeout(120_000);

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    browser = await launchBrowser(pw.chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

/** /settings, with `route` answering `path`; how many asks it got. */
async function watch(
  path: string,
  answer: (r: Route) => Promise<void> | void,
): Promise<{ p: Page; asks: () => number }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  const p = await ctx.newPage();
  let n = 0;
  await p.route(`**${path}*`, async (r) => {
    n++;
    await answer(r);
  });
  await p.goto(`${s!.base}/settings`, { waitUntil: "load" });
  return { p, asks: () => n };
}

const ROUTES = ["/api/web/waiting", "/api/approvals"];

describe("the shell's 3 s polls", () => {
  for (const route of ROUTES) {
    it(`${route}: no new ask while the last is still open`, async () => {
      if (!browser) return;
      const held: Route[] = [];
      const { p, asks } = await watch(route, (r) => {
        held.push(r); // never answered
      });
      await p.waitForTimeout(10_000);
      expect(asks()).toBe(1);
      for (const r of held) await r.abort().catch(() => undefined);
      await p.context().close();
    });
  }
  // A refused read whose caller only looks at the status: its body is read
  // all the same, so nothing stays open and the page settles. The reads a
  // test install's fixture person is refused, every one at once.
  it("refused reads are read in full: the page settles", async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    await signIn(ctx, s!.stateDir, s!.base);
    const p = await ctx.newPage();
    const refuse = (r: Route) =>
      r.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "fixture_scope" }),
      });
    for (const path of [
      "/api/web/waiting",
      "/api/web/sessions",
      "/api/web/fixture-person",
      "/api/web/owner",
      "/api/web/pair",
      "/api/sessions/helpers",
    ])
      await p.route(`**${path}*`, refuse);
    for (const page of ["/settings", "/agents"]) {
      await p.goto(`${s!.base}${page}`, { waitUntil: "load" });
      let settles = true;
      await p
        .waitForLoadState("networkidle", { timeout: 15_000 })
        .catch(() => (settles = false));
      expect({ page, settles }).toEqual({ page, settles: true });
    }
    await ctx.close();
  });

  // Approvals' 403 is a state the shell shows (sign in to approve), so
  // only the waiting list stops on a refusal.
  it("/api/web/waiting: a refusal stops it for the page", async () => {
    if (!browser) return;
    const { p, asks } = await watch("/api/web/waiting", (r) =>
      r.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "fixture_scope" }),
      }),
    );
    await p.waitForTimeout(10_000);
    expect(asks()).toBe(1);
    await p.context().close();
  });
});
