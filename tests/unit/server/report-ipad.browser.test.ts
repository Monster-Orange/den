import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

jest.setTimeout(60_000);

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine =
      process.env.DEN_HELPERS_BROWSER === "webkit" ? "webkit" : "chromium";
    browser = await launchBrowser(pw[engine]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

const IPADS: [number, number][] = [
  [1366, 1024],
  [1024, 1366],
  [1180, 820],
  [820, 1180],
];

async function tablet(width: number, height: number): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height },
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const json = (r: Route, body: unknown) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  await p.route("**/api/report**", async (r) => {
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
      return json(r, { ok: true, sections: { Den: "acme 9.9.9" } });
    return json(r, { ok: false });
  });
  expect(await s!.settings({ language: "en" })).toBe(200);
  await signInPage(p, s!.stateDir, s!.base, "/settings");
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  return p;
}

const dlg = (p: Page) => p.getByRole("dialog", { name: "Report an issue" });

async function openWithShot(p: Page) {
  await p.locator("[data-den-report]:visible").tap();
  await dlg(p).waitFor();
  await dlg(p).locator("canvas[data-shot]").waitFor({ timeout: 20_000 });
  await dlg(p).locator('[data-f="title"]').fill("Pane drops");
  await dlg(p).locator('[data-f="description"]').fill("It drops.");
}

describe("Report on a tablet with touch", () => {
  for (const [w, h] of IPADS)
    it(`at ${w}x${h}, Next is on screen without scrolling`, async () => {
      if (skip()) return;
      const p = await tablet(w, h);
      await openWithShot(p);
      const next = await dlg(p)
        .getByRole("button", { name: "Next: Include" })
        .boundingBox();
      expect(next).not.toBeNull();
      expect(next!.y).toBeGreaterThanOrEqual(0);
      expect(next!.y + next!.height).toBeLessThanOrEqual(h);
      await p.context().close();
    });

  it("with the on-screen keyboard up, Next stays above it", async () => {
    if (skip()) return;
    const p = await tablet(1366, 1024);
    await p.evaluate(() => {
      const vv = new EventTarget() as EventTarget & {
        height: number;
        offsetTop: number;
      };
      vv.height = innerHeight;
      vv.offsetTop = 0;
      Object.defineProperty(window, "visualViewport", { value: vv });
    });
    await openWithShot(p);
    const line = 1024 - 398;
    await p.evaluate((h) => {
      const vv = window.visualViewport as unknown as EventTarget & {
        height: number;
      };
      vv.height = h;
      vv.dispatchEvent(new Event("resize"));
    }, line);
    const next = await dlg(p)
      .getByRole("button", { name: "Next: Include" })
      .boundingBox();
    expect(next).not.toBeNull();
    expect(next!.y).toBeGreaterThanOrEqual(0);
    expect(next!.y + next!.height).toBeLessThanOrEqual(line);
    await p.context().close();
  });

  it("a swipe on the screenshot scrolls the dialog instead of masking", async () => {
    if (skip()) return;
    const p = await tablet(1366, 1024);
    await openWithShot(p);
    expect(
      await dlg(p)
        .locator("canvas[data-shot]")
        .evaluate((c) => getComputedStyle(c).touchAction),
    ).toMatch(/pan-y/);
    await p.context().close();
  });

  it("masks on touch only after Mask an area is picked", async () => {
    if (skip()) return;
    const p = await tablet(1366, 1024);
    await openWithShot(p);
    const drag = async () => {
      const b = (await dlg(p).locator("canvas[data-shot]").boundingBox())!;
      await dlg(p)
        .locator("canvas[data-shot]")
        .dispatchEvent("pointerdown", {
          pointerId: 1,
          pointerType: "touch",
          clientX: b.x + 20,
          clientY: b.y + 20,
        });
      await dlg(p)
        .locator("canvas[data-shot]")
        .dispatchEvent("pointerup", {
          pointerId: 1,
          pointerType: "touch",
          clientX: b.x + 120,
          clientY: b.y + 90,
        });
    };
    const hidden = () =>
      dlg(p)
        .getByText(/^\d+ areas? hidden$/)
        .textContent();
    await drag();
    expect(await hidden()).toBe("0 areas hidden");
    await dlg(p).getByRole("button", { name: "Mask an area" }).tap();
    expect(
      await dlg(p)
        .getByRole("button", { name: "Mask an area" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      await dlg(p)
        .locator("canvas[data-shot]")
        .evaluate((c) => getComputedStyle(c).touchAction),
    ).toBe("none");
    await drag();
    expect(await hidden()).toBe("1 area hidden");
    await p.context().close();
  });

  it("every control in the first step is at least 44px tall", async () => {
    if (skip()) return;
    const p = await tablet(1366, 1024);
    await openWithShot(p);
    const small = await dlg(p).evaluate((d) =>
      [
        ...d.querySelectorAll(
          "button, select, input[type=text], input:not([type]), input[type=number]",
        ),
      ]
        .map((x) => [
          (x as HTMLElement).dataset.act ??
            (x as HTMLElement).dataset.f ??
            x.tagName,
          Math.round(x.getBoundingClientRect().height),
        ])
        .filter(([, hgt]) => (hgt as number) > 0 && (hgt as number) < 44),
    );
    expect(small).toEqual([]);
    await p.context().close();
  });
});
