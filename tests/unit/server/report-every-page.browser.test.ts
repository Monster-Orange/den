/**
 * FB (den#81), Done when line 1: every page shows a Report button with no
 * menu opened: in the rail on a wide screen, in the top bar on a phone.
 * The page list is read from the server's own routes (index.ts), so a new
 * page that isn't swept here fails. The config-invalid page too: a report
 * matters most when Den can't start right.
 *
 * The demo distribution (helpers/agents-page-server.ts) and the 422 frame
 * server (helpers/error-frame-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";

jest.setTimeout(60_000);

/** Every page the server serves, swept below. */
const PAGES = [
  "/",
  "/settings",
  "/server-agent",
  "/graph",
  "/agents",
  "/tests",
  "/services",
  "/environments",
  "/release",
  "/edge",
  "/logs",
  "/local-dev",
];
/** Served pages that aren't Den's own: the test runner's HTML report. */
const NOT_DEN = ["/report"];

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let bad: FrameServer | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  bad = await startFrameServer({
    prefix: "den-report-422-",
    denConfig: "environments: [local]\norgs:\n  acme:\n    sources: nope\n",
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
  await bad?.stop();
  removeFrameTmp(bad);
});

const skip = () => !browser;

/**
 * The Report buttons a person can see now, with nothing opened: the
 * rail's (data-act="report") and the top bar's and footers'
 * ([data-den-report]).
 */
function visibleReports(p: Page): Promise<string[]> {
  return p.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-den-report], [data-act="report"]',
      ),
    ]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        if (r.right <= 0 || r.bottom <= 0) return false;
        if (r.left >= innerWidth || r.top >= innerHeight) return false;
        const cs = getComputedStyle(b);
        if (cs.visibility === "hidden" || Number(cs.opacity) === 0)
          return false;
        // Not inside a menu or pop-up that is closed or would need opening.
        return !b.closest(
          '[hidden], [role="menu"], dialog:not([open]), .den-drawer',
        );
      })
      .map(
        (b) =>
          `${b.closest(".den-rail") ? "rail" : b.closest(".den-top") ? "top" : "page"}`,
      ),
  );
}

async function sweep(base: string, route: string, width: number, auth = true) {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  try {
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const st = document.createElement("style");
        st.textContent = "#cl-overlay{display:none!important}";
        document.head.appendChild(st);
      });
    });
    await p.goto(auth ? signInUrl(s!.stateDir, base, route) : base + route);
    await p.waitForSelector(".den-top");
    await p.waitForFunction(
      () => !!document.querySelector('[data-den-report], [data-act="report"]'),
      undefined,
      { timeout: 10_000 },
    );
    return { url: new URL(p.url()).pathname, where: await visibleReports(p) };
  } finally {
    await ctx.close();
  }
}

describe("FB: a visible Report button on every page, no menu opened", () => {
  it("the list is every page the server serves", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "ui", "server", "index.ts"),
      "utf-8",
    );
    const served = new Set<string>();
    for (const m of src.matchAll(
      /pathname === "(\/[a-z-]*)"\s*\|\|\s*pathname === "\/[a-z-]+\.html"/g,
    ))
      served.add(m[1]!);
    served.add("/");
    if (/pathname === "\/logs"\)/.test(src)) served.add("/logs");
    if (/pathname === "\/report" \|\|/.test(src)) served.add("/report");
    expect([...served].sort()).toEqual([...PAGES, ...NOT_DEN].sort());
  });

  it.each(PAGES)("%s, at 1440 (the rail) and 390 (the top bar)", async (r) => {
    if (skip()) return;
    const wide = await sweep(s!.base, r, 1440);
    expect(wide.where).toContain("rail");
    const phone = await sweep(s!.base, r, 390);
    expect(phone.where).toContain("top");
  });

  it("the config-invalid page", async () => {
    if (skip()) return;
    const wide = await sweep(bad!.base, "/", 1440, false);
    expect(wide.where.length).toBeGreaterThan(0);
    const phone = await sweep(bad!.base, "/", 390, false);
    expect(phone.where.length).toBeGreaterThan(0);
  });
});
