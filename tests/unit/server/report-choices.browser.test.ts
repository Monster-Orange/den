/**
 * Issue 81, FB-1a's Diagnostics: "Each section has an (i) saying how it's
 * used, plus Include all / Include none, and the choices can be
 * remembered." Include all / none is in report-dialog.browser.test.ts;
 * here are the (i) and its use line on every section (en, es, ja), and
 * Remember my choices: kept in this browser across a reload, and
 * forgotten when it is unticked.
 *
 * Chromium and WebKit. Every /api/report call is answered by the test
 * (never the real `gh`). The demo distribution
 * (helpers/agents-page-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, BrowserContext, Locator, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { en, es, ja } from "../../../packages/den-ui/src/strings.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

jest.setTimeout(60_000);

type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
const CATALOG = { en, es, ja } as Record<string, Record<string, string>>;

const browsers: Partial<Record<Engine, Browser>> = {};
let s: AgentsPageServer | null = null;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES)
      browsers[e] = process.env.DEN_PW_WS
        ? await pw[e].connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await pw[e].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await s?.settings({ language: "en" }).catch(() => 0);
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

const skip = () => !browsers.chromium || !browsers.webkit;

const json = (r: Route, body: unknown) =>
  r.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

async function context(engine: Engine): Promise<BrowserContext> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  await ctx.route("**/api/report**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/report")
      return json(r, {
        ok: true,
        enabled: true,
        repos: [{ repo: "acme-eng/engine" }],
        github: { signedIn: true, deviceFlow: true },
        maxPerHour: 5,
        sentThisHour: 0,
      });
    if (u.pathname === "/api/report/diagnostics")
      return json(r, {
        ok: true,
        sections: { Den: "acme 9.9.9", Machine: "os: Linux" },
      });
    if (u.pathname === "/api/report/preview")
      return json(r, {
        ok: true,
        title: "Pane drops",
        body: "**Kind:** bug\n**Title:** Pane drops",
        repo: "acme-eng/engine",
      });
    if (u.pathname === "/api/report/drafts")
      return json(r, { ok: true, drafts: [] });
    return json(r, { ok: true });
  });
  return ctx;
}

const dlg = (p: Page): Locator => p.locator(".fb-dlg[open]");

/** A fresh page, the form open, on its Include step. */
async function include(ctx: BrowserContext, first = false): Promise<Page> {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(
    first ? signInUrl(s!.stateDir, s!.base, "/agents") : s!.base + "/agents",
  );
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  await p.keyboard.press("ControlOrMeta+Shift+F");
  await dlg(p).waitFor();
  await dlg(p).locator('[data-f="title"]').fill("Pane drops");
  await dlg(p).locator('[data-act="next"]').click();
  await dlg(p).locator("[data-sec]").first().waitFor();
  return p;
}

/** Each section's name → ticked, and the Redact and Remember boxes. */
async function choices(p: Page) {
  return dlg(p).evaluate((d) => ({
    sections: Object.fromEntries(
      [...d.querySelectorAll<HTMLInputElement>("[data-sec]")].map((c) => [
        c.dataset.sec!,
        c.checked,
      ]),
    ),
    redact: d.querySelector<HTMLInputElement>('[data-f="redact"]')!.checked,
    remember: d.querySelector<HTMLInputElement>('[data-f="remember"]')!.checked,
  }));
}

describe("issue 81: the (i) on each section, and Remember my choices", () => {
  it.each(ENGINES)(
    "%s: every section has its (i) and its use line, in en, es and ja",
    async (engine) => {
      if (skip()) return;
      for (const lang of ["en", "es", "ja"] as const) {
        expect(await s!.settings({ language: lang })).toBe(200);
        const ctx = await context(engine);
        try {
          const p = await include(ctx, true);
          await p.waitForFunction(
            (l) => document.documentElement.lang === l,
            lang,
          );
          const secs = await dlg(p).evaluate((d) =>
            [...d.querySelectorAll("details")].map((x) => {
              const i = x.querySelector("summary .fb-i");
              const r = i?.getBoundingClientRect();
              return {
                name: x.querySelector("[data-sec]")?.getAttribute("data-sec"),
                i: !!r && r.width > 0 && r.height > 0,
                tip: i?.getAttribute("title") ?? "",
                said: i?.getAttribute("aria-label") ?? "",
                use: x.querySelector(".fb-fine")?.textContent?.trim() ?? "",
              };
            }),
          );
          expect(secs.map((x) => x.name).sort()).toEqual(
            ["Browser", "Den", "Machine", "Page"].sort(),
          );
          for (const x of secs) {
            // The (i) shows, and says in words how it is used: the
            // product's name filled in, never a {placeholder}.
            expect([x.name, x.i]).toEqual([x.name, true]);
            expect(x.tip).not.toBe("");
            expect(x.tip).not.toMatch(/[{}]/);
            expect(x.said).toBe(x.tip);
            // Its use line: the catalog's, in the page's language.
            expect(x.use).toBe(CATALOG[lang]![`kit.report.use.${x.name}`]);
          }
        } finally {
          await ctx.close();
        }
      }
      expect(await s!.settings({ language: "en" })).toBe(200);
    },
    120_000,
  );

  it.each(ENGINES)(
    "%s: remembered across a reload when ticked; forgotten when unticked",
    async (engine) => {
      if (skip()) return;
      expect(await s!.settings({ language: "en" })).toBe(200);
      const ctx = await context(engine);
      try {
        // Nothing remembered: every section in, redaction on, not ticked.
        let p = await include(ctx, true);
        expect(await choices(p)).toEqual({
          sections: { Den: true, Machine: true, Browser: true, Page: true },
          redact: true,
          remember: false,
        });
        // Leave Machine out and redaction off, remember, go on.
        await dlg(p).locator('[data-sec="Machine"]').uncheck();
        await dlg(p).locator('[data-f="redact"]').uncheck();
        await dlg(p).locator('[data-f="remember"]').check();
        await dlg(p).locator('[data-act="review"]').click();
        await dlg(p).locator("[data-preview]").waitFor();
        await p.close();
        // A new page: the same choices.
        p = await include(ctx);
        expect(await choices(p)).toEqual({
          sections: { Den: true, Machine: false, Browser: true, Page: true },
          redact: false,
          remember: true,
        });
        // Unticked: forgotten.
        await dlg(p).locator('[data-f="remember"]').uncheck();
        await dlg(p).locator('[data-act="review"]').click();
        await dlg(p).locator("[data-preview]").waitFor();
        await p.close();
        p = await include(ctx);
        expect(await choices(p)).toEqual({
          sections: { Den: true, Machine: true, Browser: true, Page: true },
          redact: true,
          remember: false,
        });
        await p.close();
      } finally {
        await ctx.close();
      }
    },
    90_000,
  );

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
