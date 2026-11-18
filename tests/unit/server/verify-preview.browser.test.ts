/**
 * Issue 440: Checks says it is a preview until Den's own checks are on
 * it, in Chromium and WebKit, on the real web server.
 *
 *   the rail's Checks row carries the kit's Preview tag, and its name and
 *   tooltip read "Checks · Preview"
 *   the page opens with a notice: the Preview tag and one line saying
 *   what isn't there yet
 *   both in en, es and ja; at 390 px nothing scrolls sideways
 *
 * The overview is a fixed answer (context route). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
const browsers = new Map<Engine, Browser>();
let s: AgentsPageServer | null = null;

const OVERVIEW = {
  ok: true,
  project: "north",
  modules: 0,
  envOrder: ["local"],
  activity: [],
  envs: [],
  checks: [],
};

beforeAll(async () => {
  const pw = await import("playwright");
  for (const engine of ENGINES) {
    try {
      browsers.set(
        engine,
        process.env.DEN_PW_WS
          ? await pw[engine].connect(process.env.DEN_PW_WS, {
              exposeNetwork: "<loopback>",
            })
          : await pw[engine].launch(),
      );
    } catch (err) {
      if (process.env.DEN_SKIP_BROWSER_TESTS === "1") continue;
      throw err;
    }
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [...browsers.values()],
    after: () => s?.stop(),
  });
}, 60_000);

const WORDS = {
  en: {
    tag: "Preview",
    name: "Checks · Preview",
    line: "Checks isn't finished",
  },
  es: {
    tag: "Vista previa",
    name: "Comprobaciones · Vista previa",
    line: "Comprobaciones no está terminado",
  },
  ja: {
    tag: "プレビュー",
    name: "チェック · プレビュー",
    line: "チェックはまだ完成していません",
  },
} as const;

describe.each(ENGINES)("issue 440: Checks is a preview, in %s", (engine) => {
  it.each(["en", "es", "ja"] as const)(
    "in %s: the rail's tag and the page's notice, and nothing sideways at 390 px",
    async (lang) => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: lang });
      for (const width of [1440, 390]) {
        const ctx = await browsers.get(engine)!.newContext({
          viewport: { width, height: 900 },
        });
        await ctx.route(/\/api\/verify\/overview/, (r) =>
          r.fulfill({
            contentType: "application/json",
            body: JSON.stringify(OVERVIEW),
          }),
        );
        const p = await ctx.newPage();
        try {
          await p.goto(signInUrl(s!.stateDir, s!.base, "/verify"));
          await p.waitForSelector('#verify-body[aria-busy="false"]');
          const w = WORDS[lang];
          const row = p.locator('a.den-ni[data-nav="verify"]');
          expect(await row.getAttribute("data-nav-kind")).toBe("preview");
          expect(await row.getAttribute("aria-label")).toBe(w.name);
          expect(
            (await row.locator(".den-ni-kind").textContent())?.trim(),
          ).toBe(w.tag);
          const note = p.locator("#verify-preview");
          expect(await note.getAttribute("role")).toBe("note");
          const text = (await note.textContent()) ?? "";
          expect(text).toContain(w.tag);
          expect(text).toContain(w.line);
          if (width === 390)
            expect(
              await p.evaluate(() => document.documentElement.scrollWidth),
            ).toBe(390);
        } finally {
          await ctx.close();
        }
      }
    },
    90_000,
  );
});
