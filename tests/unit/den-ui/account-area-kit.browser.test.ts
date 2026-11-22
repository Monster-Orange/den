/**
 * den-ui issue 310: the Account area in a browser, with no product around
 * it: a bare page loads the kit's tokens, base, button, dialog and
 * account-area looks and opens the pop-up with data, under
 * `script-src 'self'; style-src 'self'` (any violation fails). Playwright's
 * own headless Chromium.
 *
 *   - ?account=devices opens it on Devices and sessions; a rail row
 *     switches the pane and the address; closing drops ?account=
 *   - "/" goes to the search box; typing shows only the rows that match
 *     (across panes); Escape clears it first, the next Escape closes
 *   - Enter opens the first hit's section and flashes its row
 *   - Sign out everywhere asks first: Cancel sends nothing, the danger
 *     button sends "sign-out-all"
 *   - a notification switch flips at once and flips back when the host's
 *     promise rejects
 *   - 1280: 960 by up to 760, a 240 px rail; 390: the select shows, the
 *     rail rows don't, no sideways scroll, the select is 44 px tall
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'";
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser] });
});

const skip = () => !browser;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/button.css"><link rel="stylesheet" href="/dialog.css">
<link rel="stylesheet" href="/account-area.css"></head>
<body><main><button id="entry" type="button">Ada Example</button></main>
<script type="module" src="/page.js"></script></body></html>`;

const PAGE_JS = `
import { openAccountArea } from "/account-area.js";
window.acts = [];
window.reject = false;
const NOW = new Date().toISOString();
window.openIt = () => {
  window.area = openAccountArea({
    opener: document.getElementById("entry"),
    settingsHref: "/settings",
    profile: { name: "Ada Example", login: "ada", role: "Owner", how: "github",
      signOut: { url: "/auth/logout", csrf: "c" }, signOutAll: true },
    access: { github: { login: "ada", unlink: true }, pair: true,
      tokens: [{ id: "t1", name: "laptop cli", createdAt: NOW }], newToken: true },
    devices: { list: [
      { id: "d1", name: "Safari on Mac", lastSeen: NOW, current: true },
      { id: "d2", name: "Chrome on Linux", lastSeen: NOW } ],
      waiting: [{ code: "K7QX-92MD", minutes: 10 }], pair: true, signOutAll: true },
    notifications: [{ id: "rel", label: "New releases", on: false }],
    onAction: (act, id, button, extra) => {
      acts.push([act, id, extra && extra.on !== undefined ? extra.on : null]);
      if (act === "notify" && window.reject) return Promise.reject(new Error("no"));
    },
  });
};
document.getElementById("entry").addEventListener("click", openIt);
openIt();
window.ready = true;
`;

const SERVED = new Set([
  "tokens.css",
  "base.css",
  "button.css",
  "dialog.css",
  "account-area.css",
  "account-area.js",
  "dialog.js",
  "strings.js",
  "time.js",
]);

async function open(o: { width?: number; query?: string } = {}): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: o.width ?? 1280, height: 860 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    (window as unknown as { csp: string[] }).csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { csp: string[] }).csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    const headers = { "content-security-policy": CSP };
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", headers, body: PAGE });
    if (u.pathname === "/page.js")
      return r.fulfill({ contentType: "text/javascript", body: PAGE_JS });
    const f = u.pathname.slice(1);
    if (SERVED.has(f) && fs.existsSync(path.join(SRC, f)))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(path.join(SRC, f), "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${ORIGIN}/${o.query ?? ""}`);
  await p
    .waitForFunction(
      () => (window as { ready?: boolean }).ready === true,
      null,
      {
        timeout: 10_000,
      },
    )
    .catch((e: Error) => {
      throw new Error(`page not ready: ${errors.join("; ") || e.message}`);
    });
  return p;
}

async function done(p: Page) {
  expect(
    await p.evaluate(() => (window as unknown as { csp: string[] }).csp),
  ).toEqual([]);
  await p.context().close();
}

const shown = (p: Page) =>
  p.$$eval(".den-aa-pane:not([hidden])", (els) =>
    els.map((e) => (e as HTMLElement).dataset.aaPane),
  );
const acts = (p: Page) =>
  p.evaluate(() => (window as unknown as { acts: unknown[] }).acts);

describe("issue 310: the Account area in a browser", () => {
  it("?account= opens a section; the rail switches it and the address; close drops it", async () => {
    if (skip()) return;
    const p = await open({ query: "?x=1&account=devices" });
    expect(await shown(p)).toEqual(["devices"]);
    await p.click('.den-aa-row[data-aa-section="access"]');
    expect(await shown(p)).toEqual(["access"]);
    expect(new URL(p.url()).searchParams.get("account")).toBe("access");
    expect(new URL(p.url()).searchParams.get("x")).toBe("1");
    await p.click(".den-aa-x");
    await p.waitForFunction(() => !document.querySelector("dialog.den-aa-dlg"));
    expect(new URL(p.url()).searchParams.get("account")).toBeNull();
    expect(new URL(p.url()).searchParams.get("x")).toBe("1");
    await done(p);
  }, 60_000);

  it('"/" goes to search; a search shows only matching rows; Escape clears first, then closes', async () => {
    if (skip()) return;
    const p = await open();
    await p.focus('.den-aa-row[data-aa-section="profile"]');
    await p.keyboard.press("/");
    expect(
      await p.evaluate(() =>
        document.activeElement?.classList.contains("den-aa-search"),
      ),
    ).toBe(true);
    await p.keyboard.type("linux");
    expect(await shown(p)).toEqual(["devices"]);
    const visible = await p.$$eval(".den-aa-item:not([hidden]) b", (els) =>
      els.map((e) => e.textContent?.trim()),
    );
    expect(visible).toEqual(["Chrome on Linux"]);
    await p.keyboard.press("Escape");
    expect(await p.inputValue(".den-aa-search")).toBe("");
    expect(await shown(p)).toEqual(["profile"]);
    expect(await p.isVisible("dialog.den-aa-dlg")).toBe(true);
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => !document.querySelector("dialog.den-aa-dlg"));
    await done(p);
  }, 60_000);

  it("Enter opens the first hit's section and flashes its row", async () => {
    if (skip()) return;
    const p = await open();
    await p.fill(".den-aa-search", "laptop");
    await p.press(".den-aa-search", "Enter");
    expect(await shown(p)).toEqual(["access"]);
    expect(await p.inputValue(".den-aa-search")).toBe("");
    expect(await p.locator(".den-aa-flash").count()).toBe(1);
    await done(p);
  }, 60_000);

  it("Sign out everywhere asks first: Cancel sends nothing, the danger button sends it", async () => {
    if (skip()) return;
    const p = await open();
    await p.click('.den-aa-pane:not([hidden]) [data-aa-act="sign-out-all"]');
    await p.waitForSelector("dialog.dk-confirm[open]");
    expect(await p.textContent("dialog.dk-confirm")).toContain(
      "Sign out everywhere?",
    );
    await p.keyboard.press("Escape");
    await p.waitForFunction(
      () => !document.querySelector("dialog.dk-confirm[open]"),
    );
    expect(await acts(p)).toEqual([]);
    expect(await p.isVisible("dialog.den-aa-dlg")).toBe(true);
    await p.click('.den-aa-pane:not([hidden]) [data-aa-act="sign-out-all"]');
    await p.waitForSelector("dialog.dk-confirm[open]");
    await p.click("dialog.dk-confirm .dk-danger");
    await p.waitForFunction(
      () => (window as unknown as { acts: unknown[] }).acts.length === 1,
    );
    expect(await acts(p)).toEqual([["sign-out-all", null, null]]);
    await done(p);
  }, 60_000);

  it("Unlink GitHub asks first too: Cancel sends nothing, the danger button sends it", async () => {
    if (skip()) return;
    const p = await open({ query: "?account=access" });
    const u = '.den-aa-pane:not([hidden]) [data-aa-act="unlink"]';
    await p.click(u);
    await p.waitForSelector("dialog.dk-confirm[open]");
    expect(await p.textContent("dialog.dk-confirm")).toContain(
      "Unlink GitHub?",
    );
    await p.keyboard.press("Escape");
    await p.waitForFunction(
      () => !document.querySelector("dialog.dk-confirm[open]"),
    );
    expect(await acts(p)).toEqual([]);
    await p.click(u);
    await p.waitForSelector("dialog.dk-confirm[open]");
    await p.click("dialog.dk-confirm .dk-danger");
    await p.waitForFunction(
      () => (window as unknown as { acts: unknown[] }).acts.length === 1,
    );
    expect(await acts(p)).toEqual([["unlink", null, null]]);
    await done(p);
  }, 60_000);

  it("a notification switch flips at once, and back when the host refuses", async () => {
    if (skip()) return;
    const p = await open({ query: "?account=notifications" });
    const sw = '[data-aa-act="notify"][data-aa-id="rel"]';
    await p.click(sw);
    expect(await p.getAttribute(sw, "aria-checked")).toBe("true");
    await p.evaluate(
      () => ((window as unknown as { reject: boolean }).reject = true),
    );
    await p.click(sw);
    await p.waitForFunction(
      (s) => document.querySelector(s)?.getAttribute("aria-checked") === "true",
      sw,
    );
    expect(await acts(p)).toEqual([
      ["notify", "rel", true],
      ["notify", "rel", false],
    ]);
    await done(p);
  }, 60_000);

  it("1280: 960 wide, at most 760 tall, a 240 px rail", async () => {
    if (skip()) return;
    const p = await open();
    const box = await p.locator("dialog.den-aa-dlg").boundingBox();
    expect(Math.round(box!.width)).toBe(960);
    expect(box!.height).toBeLessThanOrEqual(760);
    const rail = await p.locator(".den-aa-rail").boundingBox();
    expect(Math.round(rail!.width)).toBe(240);
    await done(p);
  }, 60_000);

  it("390: the select shows, the rail rows don't, no sideways scroll, 44 px", async () => {
    if (skip()) return;
    const p = await open({ width: 390 });
    expect(await p.isVisible(".den-aa-select")).toBe(true);
    expect(await p.isVisible('.den-aa-row[data-aa-section="profile"]')).toBe(
      false,
    );
    const sel = await p.locator(".den-aa-select").boundingBox();
    expect(sel!.height).toBeGreaterThanOrEqual(44);
    await p.selectOption(".den-aa-select", "devices");
    expect(await shown(p)).toEqual(["devices"]);
    expect(
      await p.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await done(p);
  }, 60_000);
});
