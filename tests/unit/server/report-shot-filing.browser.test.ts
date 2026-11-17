/**
 * Issue 403: a filed report's screenshot. Filing never saves the
 * screenshot to the person's computer (no browser download), in Chromium
 * and WebKit. The masked PNG goes with the send, to Den's server, which
 * keeps it (and sends it to Hub when the person agrees).
 *
 * Every /api/report call is answered by the test (never the real `gh`,
 * never a real Hub). The demo distribution. Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

jest.setTimeout(60_000);

const ENGINES = ["chromium", "webkit"] as const;
type Engine = (typeof ENGINES)[number];
const browsers: Partial<Record<Engine, Browser>> = {};
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  const pw = await import("playwright");
  for (const e of ENGINES)
    try {
      const ws = process.env.DEN_PW_WS;
      browsers[e] = ws
        ? await pw[e].connect(ws, { exposeNetwork: "<loopback>" })
        : await pw[e].launch();
    } catch (err) {
      if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
    }
  s = await startAgentsPageServer();
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

interface Fake {
  sent: Record<string, unknown>[];
  /** GET /api/report/shot-share's answer (null: the route 404s). */
  share: Record<string, unknown> | null;
}

async function page(engine: Engine, fake: Fake): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: "reduce",
    acceptDownloads: true,
  });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const json = (r: Route, status: number, body: unknown) =>
    r.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  await p.route("**/api/report**", async (r) => {
    const u = new URL(r.request().url());
    const body = r.request().postDataJSON?.() ?? null;
    if (u.pathname === "/api/report")
      return json(r, 200, {
        ok: true,
        enabled: true,
        repos: [{ repo: "acme-eng/engine" }],
        github: { signedIn: true, deviceFlow: false },
        maxPerHour: 5,
        sentThisHour: 0,
      });
    if (u.pathname === "/api/report/diagnostics")
      return json(r, 200, { ok: true, sections: { Den: "acme 9.9.9" } });
    if (u.pathname === "/api/report/preview")
      return json(r, 200, {
        ok: true,
        title: "Pane drops",
        body: "**Kind:** bug\n\nIt drops.",
        repo: "acme-eng/engine",
      });
    if (u.pathname === "/api/report/shot-share")
      return fake.share
        ? json(r, 200, fake.share)
        : json(r, 404, { ok: false });
    if (u.pathname === "/api/report/send") {
      fake.sent.push(body);
      return json(r, 200, {
        ok: true,
        url: "https://github.com/acme-eng/engine/issues/42",
        repo: "acme-eng/engine",
        added: false,
      });
    }
    return json(r, 404, { ok: false });
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  return p;
}

const dlg = (p: Page) => p.locator("dialog.fb-dlg");

async function toReview(p: Page) {
  await p.keyboard.press("ControlOrMeta+Shift+F");
  await dlg(p).locator("canvas[data-shot]").waitFor();
  await dlg(p).locator('[data-f="title"]').fill("Pane drops");
  await dlg(p).locator('[data-f="description"]').fill("It drops.");
  await dlg(p).locator('[data-act="next"]').click();
  await dlg(p).locator('[data-act="review"]').click();
  await dlg(p)
    .locator("[data-preview]")
    .getByText("Pane drops")
    .first()
    .waitFor();
}

describe.each(ENGINES)(
  "issue 403: filing a report's screenshot (%s)",
  (engine) => {
    const skip = () => !browsers[engine];

    it("filing never downloads the screenshot", async () => {
      if (skip()) return;
      const fake: Fake = { sent: [], share: null };
      const p = await page(engine, fake);
      let downloads = 0;
      p.on("download", () => downloads++);
      await toReview(p);
      await dlg(p).locator('[data-act="send"]').click();
      await dlg(p).getByRole("heading", { name: "Report sent" }).waitFor();
      // Long enough for the old after-send save to have fired.
      await p.waitForTimeout(800);
      expect(downloads).toBe(0);
      expect(await dlg(p).locator("[data-saved]").count()).toBe(0);
      expect(fake.sent).toHaveLength(1);
      await p.context().close();
    });
  },
);
