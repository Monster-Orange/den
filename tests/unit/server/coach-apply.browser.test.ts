/**
 * Issue 110, Coach Apply in a browser, on a real server (mock v3, in Hub,
 * Den project). A Coach report with one finding that has a proposal, and
 * the persona it names, are written into the server's state folder:
 *   - Apply shows dots in its button while Den asks; then the row says
 *     Waiting for Allow, and nothing in the persona has changed;
 *   - the bell shows one card: who asks, the finding, Change, Why,
 *     Reversible, then Allow and Deny (44 px, stacked, on a phone);
 *   - Allow there, and the row says Applied without a reload;
 *   - at 390 px nothing in the findings or the card is under 44 px tall,
 *     and the page never scrolls sideways.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
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

const W = {
  from: "2026-11-15T12:00:00.000Z",
  to: "2026-11-22T12:00:00.000Z",
  days: 7,
};
const ID = "subagent_opus:opus-agent";

/** One finding with a proposal, and the persona it names (no project). */
function seed(stateDir: string, persona: string) {
  const dir = path.join(stateDir, "personas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${persona}.md`),
    [
      "---",
      `name: ${persona}`,
      "role: sde",
      "category: engineering",
      "description: Builds.",
      "runtime: den-claude",
      "model_version: latest",
      "permission_mode: ask",
      "---",
      "",
      "Build it.",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const latest = path.join(stateDir, "coach", "latest.json");
  fs.mkdirSync(path.dirname(latest), { recursive: true });
  fs.writeFileSync(
    latest,
    JSON.stringify({
      version: 1,
      ranAt: W.to,
      window: W,
      agents: [],
      totals: { calls: 0, output_M: 0, compactions: 0 },
      totalsPerDay: {},
      cost: { model: null, tokens: 0 },
      findings: [
        {
          id: ID,
          kind: "subagent_opus",
          agent: "opus-agent",
          workspace: "local",
          title: "t",
          evidence: { subagent_opus_pct: 87, subagent_calls: 140 },
          proposal: "p",
          window: W,
          persona,
        },
      ],
    }),
    { mode: 0o600 },
  );
  fs.rmSync(path.join(stateDir, "coach", "applies.json"), { force: true });
}

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

/** The Coach tab at `width`; Apply's request waits for `release`. */
async function open(width: number, persona: string) {
  seed(s!.stateDir, persona);
  const ctx = await browser!.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    ...(width < 600 ? { hasTouch: true, isMobile: true } : {}),
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  await p.route("**/api/coach/apply", async (r: Route) => {
    await gate;
    await r.continue();
  });
  await signInPage(p, s!.stateDir, s!.base, "/server-agent?tab=coach");
  await p
    .locator('[data-note="coach-findings-table"]')
    .waitFor({ state: "attached", timeout: 20_000 });
  return { p, release };
}

/** The shell's Allow dialog opens for a new held write: put it off. */
async function later(p: Page) {
  const btn = p.locator("#den-ap-later");
  try {
    await btn.waitFor({ state: "visible", timeout: 5_000 });
    await btn.click();
  } catch {
    /* no dialog this time */
  }
}

/** Every visible button or link in `sel` that is under 44 px tall. */
async function under44(p: Page, sel: string) {
  return p.evaluate((q) => {
    const out: string[] = [];
    for (const root of document.querySelectorAll(q))
      for (const el of root.querySelectorAll("button, a, [role=button]")) {
        const b = el.getBoundingClientRect();
        if (b.width && b.height && b.height < 44)
          out.push(`${el.textContent?.trim()} ${b.height}`);
      }
    return out;
  }, sel);
}

describe("Coach Apply", () => {
  for (const width of [1440, 390])
    it(`at ${width}: dots in Apply, Waiting for Allow, the bell's card, Allow, then Applied`, async () => {
      if (!browser) return;
      const persona = `opus-user-${width}`;
      const { p, release } = await open(width, persona);
      const scope =
        width < 600
          ? '[data-note="coach-finding-cards"]'
          : '[data-note="coach-findings-table"]';
      const apply = p.locator(`${scope} [data-act="coach-apply"]`);
      await expect(apply.textContent()).resolves.toBe("Apply");
      expect(
        await p.locator(`${scope} [data-note="coach-change"]`).textContent(),
      ).toContain(
        `Proposed change: Set ${persona}’s subagent model to Sonnet.`,
      );
      if (width < 600) expect(await under44(p, scope)).toEqual([]);
      await apply.click();
      await expect(apply.getAttribute("aria-busy")).resolves.toBe("true");
      expect(await apply.isDisabled()).toBe(true);
      release();
      await p
        .locator(`${scope} [data-apply-state="waiting"]`)
        .waitFor({ timeout: 15_000 });
      expect(await p.locator(`${scope} [data-act="coach-apply"]`).count()).toBe(
        0,
      );
      expect(
        await p.locator(`${scope} [data-act="coach-dismiss"]`).count(),
      ).toBe(0);
      const file = path.join(s!.stateDir, "personas", `${persona}.md`);
      expect(fs.readFileSync(file, "utf-8")).not.toMatch(/subagent_model/);
      await later(p);
      // Open the bell from the row.
      await p.locator(`${scope} [data-act="coach-bell"]`).click();
      const card = p.locator("[data-bell-coach]");
      await card.waitFor({ timeout: 15_000 });
      const text = (await card.textContent()) ?? "";
      for (const words of [
        `asks to change ${persona}`,
        "From the Coach finding “opus-agent runs its subagents on Opus”.",
        `Set ${persona}’s subagent model to Sonnet.`,
        "87% of 140 subagent calls ran on Opus",
        `Yes: set it back in ${persona}’s persona.`,
      ])
        expect(text).toContain(words);
      if (width < 600) {
        expect(await under44(p, "[data-bell-coach]")).toEqual([]);
        const [a, d] = await Promise.all(
          ["allow", "deny"].map((b) =>
            card.locator(`[data-bell="${b}"]`).boundingBox(),
          ),
        );
        expect(d!.y).toBeGreaterThan(a!.y);
        // The whole card fits one phone screen: Allow and Deny on it.
        expect(d!.y + d!.height).toBeLessThanOrEqual(844);
      }
      await card.locator('[data-bell="allow"]').click();
      await p.keyboard.press("Escape");
      await p
        .locator(`${scope} [data-apply-state="applied"]`)
        .waitFor({ timeout: 15_000 });
      expect(fs.readFileSync(file, "utf-8")).toMatch(
        /^subagent_model: sonnet$/m,
      );
      const doc = await p.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      expect(doc.sw).toBeLessThanOrEqual(doc.cw);
      expect(errors).toEqual([]);
      await p.context().close();
    }, 90_000);
});
