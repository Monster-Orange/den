/**
 * Issue 1434, in Den itself: a button held through Den's shell
 * (denShell.busyAction, denShell.holdDots) keeps the keyboard's focus
 * while it waits and after. The shell holds it at once, before the kit
 * has loaded, with aria-busy and aria-disabled (never disabled, which
 * drops focus to <body>), and a second press does nothing. On a real Den
 * page, in Chromium and WebKit.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const browsers: Record<string, Browser> = {};
let s: AgentsPageServer | null = null;
const PROBE = "/api/held-focus-probe";

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = await launchBrowser(kind);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
}, 60_000);

/** A signed-in Den page with a probe button; answer() ends its request. */
async function open(b: Browser): Promise<{ p: Page; answer: () => void }> {
  const ctx = await b.newContext({ reducedMotion: "reduce" });
  // What's new off: it would take the keyboard these tests check.
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  let answer = () => {};
  const waiting = new Promise<void>((res) => (answer = res));
  await p.route(`**${PROBE}`, async (r) => {
    await waiting;
    await r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await signInPage(p, s!.stateDir, s!.base, "/settings");
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  return { p, answer: () => answer() };
}

/** A button on the page that holds itself through the shell's `how`. */
const probe = (p: Page, how: "busyAction" | "holdDots") =>
  p.evaluate(
    ({ url, how }) => {
      type Fn = (...a: unknown[]) => unknown;
      const shell = (
        window as unknown as {
          denShell: { busyAction: Fn; holdDots: Fn; api: Fn };
        }
      ).denShell;
      const w = window as unknown as { clicks: number };
      w.clicks = 0;
      const b = document.createElement("button");
      b.id = "probe";
      b.textContent = "Link ticked projects";
      document.body.prepend(b);
      b.addEventListener("click", () => {
        w.clicks++;
        const run = (headers?: Record<string, string>) =>
          shell.api("POST", url, {}, { headers: headers ?? {} });
        if (how === "busyAction")
          void shell.busyAction("link", run, { button: b });
        else {
          const release = shell.holdDots(b) as () => void;
          void (run() as Promise<unknown>).finally(release);
        }
      });
      b.focus();
    },
    { url: PROBE, how },
  );

const active = (p: Page) => p.evaluate(() => document.activeElement?.id ?? "");
const clicks = (p: Page) =>
  p.evaluate(() => (window as unknown as { clicks: number }).clicks);

for (const engine of ["chromium", "webkit"]) {
  describe(`issue 1434 in Den: a held button keeps focus (${engine})`, () => {
    for (const how of ["busyAction", "holdDots"] as const)
      it(`denShell.${how}: focus stays during the hold and after; a second press does nothing`, async () => {
        const b = browsers[engine];
        if (!b) return;
        const { p, answer } = await open(b);
        await probe(p, how);
        expect(await active(p)).toBe("probe");
        await p.keyboard.press("Enter");
        // At once (the shell's own hold, before the kit may have loaded).
        expect(
          await p.$eval("#probe", (el) => [
            el.getAttribute("aria-busy"),
            el.getAttribute("aria-disabled"),
            (el as HTMLButtonElement).disabled,
          ]),
        ).toEqual(["true", "true", false]);
        expect(await active(p)).toBe("probe");
        await p.keyboard.press("Enter");
        await p.keyboard.press("Space");
        expect(await clicks(p)).toBe(1);
        answer();
        await p.waitForSelector("#probe:not([aria-busy])");
        expect(await p.getAttribute("#probe", "aria-disabled")).toBeNull();
        expect(await active(p)).toBe("probe");
        await p.context().close();
      }, 60_000);
  });
}
