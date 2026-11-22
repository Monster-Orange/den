/**
 * Issue 310: Den draws the kit's Account area, on the real page and its
 * real routes (the demo distribution, helpers/agents-page-server.ts). The
 * approved Account area mock (v2), on the kit's markup (account-area.js):
 *
 *   - the rail foot's account entry opens the Account area (a button, not
 *     a link into Settings), on Profile, with ?account=profile in the
 *     address
 *   - ?account=devices opens it on any page, on Devices and sessions:
 *     this browser marked This device
 *   - Settings › Access starts with "Your account →", which opens it too
 *   - "Install settings →" at the rail's foot goes to Settings › Access
 *   - Esc closes it and takes ?account= out of the address
 *
 * Chromium and WebKit; DEN_PW_WS connects to a Playwright server instead
 * of launching. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";

jest.setTimeout(60_000);

const ENGINES = ["chromium", "webkit"] as const;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const ws = process.env.DEN_PW_WS;
    for (const e of ENGINES)
      browsers[e] = ws
        ? await pw[e].connect(ws, { exposeNetwork: "<loopback>" })
        : await pw[e].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

async function open(e: (typeof ENGINES)[number]): Promise<Page> {
  const ctx = await browsers[e]!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  return ctx.newPage();
}

const area = (p: Page) => p.locator("dialog.den-aa-dlg[open]");
const shown = (p: Page) =>
  p.evaluate(() =>
    Array.from(document.querySelectorAll(".den-aa-pane"))
      .filter((x) => !(x as HTMLElement).hidden)
      .map((x) => x.getAttribute("data-aa-pane")),
  );

describe.each(ENGINES)("issue 310 in %s: Den's Account area", (e) => {
  it("the rail foot's account entry opens it on Profile, with the section in the address", async () => {
    if (!browsers[e] || !s) return;
    const p = await open(e);
    await p.goto(`${s.base}/`);
    const entry = p.locator("#den-ident");
    await entry.waitFor({ timeout: 20_000 });
    expect(await entry.evaluate((el) => el.tagName)).toBe("BUTTON");
    expect(await entry.getAttribute("href")).toBeNull();
    await entry.click();
    await area(p).waitFor({ timeout: 10_000 });
    expect(await shown(p)).toEqual(["profile"]);
    expect(new URL(p.url()).searchParams.get("account")).toBe("profile");
    // The rail: the sections Den has, in the mock's order, and the
    // cross-link to Settings.
    expect(
      await p
        .locator(".den-aa-row")
        .evaluateAll((els) => els.map((x) => x.textContent?.trim())),
    ).toEqual(["Profile", "Access and security", "Devices and sessions"]);
    expect(await p.getAttribute(".den-aa-cross", "href")).toBe(
      "/settings#access",
    );
    // Esc closes it and takes the section out of the address.
    await p.keyboard.press("Escape");
    await area(p).waitFor({ state: "detached" });
    expect(new URL(p.url()).searchParams.get("account")).toBeNull();
    await p.context().close();
  });

  it("?account=devices opens it on any page, this browser marked This device", async () => {
    if (!browsers[e] || !s) return;
    const p = await open(e);
    await p.goto(`${s.base}/logs?account=devices`);
    await area(p).waitFor({ timeout: 20_000 });
    expect(await shown(p)).toEqual(["devices"]);
    const mine = p
      .locator('.den-aa-pane[data-aa-pane="devices"] .den-aa-item')
      .filter({ hasText: "This device" });
    expect(await mine.count()).toBe(1);
    await p.context().close();
  });

  it("signing out another device: its row goes, and the toast names it (mock B4)", async () => {
    if (!browsers[e] || !s) return;
    const other = await open(e);
    await other.goto(`${s.base}/logs`);
    const p = await open(e);
    await p.goto(`${s.base}/logs?account=devices`);
    await area(p).waitFor({ timeout: 20_000 });
    const row = p
      .locator('.den-aa-pane[data-aa-pane="devices"] .den-aa-item')
      .filter({ hasNotText: "This device" })
      .first();
    const name = (await row.locator("b").first().textContent())!.trim();
    const before = await p
      .locator(
        '.den-aa-pane[data-aa-pane="devices"] [data-aa-act="sign-out-device"]',
      )
      .count();
    await row.locator('[data-aa-act="sign-out-device"]').click();
    const toast = p.locator(".den-toast");
    await toast.waitFor({ timeout: 10_000 });
    expect((await toast.textContent())?.trim()).toBe(`Signed out ${name}.`);
    await p.waitForFunction(
      (n) =>
        document.querySelectorAll(
          '.den-aa-pane[data-aa-pane="devices"] [data-aa-act="sign-out-device"]',
        ).length === n,
      before - 1,
    );
    // No address on screen: the place, or nothing.
    const text = await area(p).textContent();
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).not.toMatch(/::1\b/);
    await other.context().close();
    await p.context().close();
  });

  it("Settings › Access starts with Your account →, which opens it", async () => {
    if (!browsers[e] || !s) return;
    const p = await open(e);
    await p.goto(`${s.base}/settings#access`);
    const link = p.locator("#set-account-link");
    await link.waitFor({ timeout: 20_000 });
    expect((await link.textContent())?.trim()).toBe("Your account →");
    await link.click();
    await area(p).waitFor({ timeout: 10_000 });
    expect(await shown(p)).toEqual(["profile"]);
    await p.context().close();
  });
});
