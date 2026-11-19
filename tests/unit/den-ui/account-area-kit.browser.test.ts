/**
 * den-ui, issue 310: the Account area (account-area.js) in a browser, with
 * no product around it: a bare page links the kit's sheets and opens the
 * area with openAccountArea and a host that records what it's asked. The
 * approved Account area mock (v2) is the spec.
 *
 *   - the pop-up is 960 wide and 88vh high up to 760, the rail 240px; it opens on
 *     the asked section and puts ?account=<section> in the address
 *   - a section's row in the rail opens its pane and marks it
 *   - "/" jumps to the search; a search hides the sections with no match;
 *     Enter jumps to the first row that matches and flashes it; Esc
 *     clears the search first, then closes the area, takes ?account= out
 *     of the address and gives focus back to what opened it
 *   - Sign out everywhere asks first (the kit's danger dialog, the mock's
 *     words); Cancel does nothing; a device's Sign out calls the host
 *     with its id and name; a toast says so
 *   - a notification switch calls onToggle; a reject puts it back
 *   - at 390: the rail is a strip (✕, the search box, a select of the
 *     sections), each 44px; the select opens a section
 *   - ja words
 *
 * Chromium and WebKit; DEN_PW_WS connects to a Playwright server instead
 * of launching.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const ENGINES = ["chromium", "webkit"] as const;
type Engine = (typeof ENGINES)[number];
const browsers: Partial<Record<Engine, Browser>> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const ws = process.env.DEN_PW_WS;
    for (const e of ENGINES)
      browsers[e] = ws ? await pw[e].connect(ws) : await pw[e].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
});

const NOW = "2026-11-19T18:00:00.000Z";

const PAGE = (lang: string, section: string) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${["tokens", "base", "button", "switch", "dialog", "account-area"]
  .map((s) => `<link rel="stylesheet" href="/${s}.css">`)
  .join("")}</head>
<body><button id="open">Me</button>
<script type="module">
import { openAccountArea } from "/account-area.js";
window.calls = [];
window.toggleFails = false;
const data = {
  current: ${JSON.stringify(section)},
  lang: ${JSON.stringify(lang)},
  product: "Den",
  now: ${JSON.stringify(NOW)},
  zone: "UTC",
  settings: { href: "/settings" },
  profile: { name: "Sam Example", login: "sam", role: "Owner", how: "github",
    since: "2026-11-18T09:00:00.000Z", signOut: true, signOutEverywhere: true },
  access: { github: { login: "sam", linkedAt: "2026-11-12T09:00:00.000Z", unlink: true }, pair: true },
  devices: {
    list: [
      { id: "a1", name: "Safari on Mac", current: true, where: "Local network", lastSeenAt: ${JSON.stringify(NOW)} },
      { id: "b2", name: "Chrome on Linux", lastSeenAt: "2026-11-13T18:00:00.000Z" },
    ],
    waiting: [{ code: "K7QX-92MD", minutes: 10 }],
    pair: true, signOutEverywhere: true,
  },
  notifications: { items: [{ id: "waiting", label: "An agent needs me", help: "Allow, Deny or a question waiting for you.", on: true }] },
};
document.getElementById("open").addEventListener("click", (e) => {
  window.area = openAccountArea({
    ...data,
    opener: e.currentTarget,
    onSection: (s) => calls.push(["section", s]),
    onClosed: () => calls.push(["closed"]),
    onAction: (act, { id, name }) => {
      calls.push([act, id, name]);
      if (act === "device-signout") window.area.toast("Signed out " + name);
    },
    onToggle: (id, on) => {
      calls.push(["toggle", id, on]);
      return window.toggleFails ? Promise.reject(new Error("no")) : undefined;
    },
  });
});
window.ready = true;
</script></body></html>`;

async function open(
  engine: Engine,
  o: { lang?: string; width?: number; height?: number; section?: string } = {},
): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width: o.width ?? 1280, height: o.height ?? 800 },
    reducedMotion: "reduce",
    locale: o.lang ?? "en",
    hasTouch: (o.width ?? 1280) < 768,
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/" || u.pathname === "/page")
      return r.fulfill({
        contentType: "text/html",
        body: PAGE(o.lang ?? "en", o.section ?? "profile"),
      });
    const f = u.pathname.slice(1);
    if (/^[a-z-]+\.(js|css)$/.test(f) && fs.existsSync(path.join(SRC, f)))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(path.join(SRC, f), "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${ORIGIN}/page?x=1`);
  await p
    .waitForFunction(() => (window as { ready?: boolean }).ready === true)
    .catch((e: Error) => {
      throw new Error(`page not ready: ${errors.join("; ") || e.message}`);
    });
  await p.click("#open");
  await p.waitForSelector("dialog.den-aa-dlg[open]");
  return p;
}

const calls = (p: Page) =>
  p.evaluate(() => (window as unknown as { calls: unknown[] }).calls);
const box = (p: Page, sel: string) =>
  p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }, sel);
const shown = (p: Page) =>
  p.evaluate(() =>
    Array.from(document.querySelectorAll(".den-aa-pane"))
      .filter((x) => !(x as HTMLElement).hidden)
      .map((x) => x.getAttribute("data-section")),
  );
const address = (p: Page) =>
  p.evaluate(() => location.pathname + location.search);

for (const engine of ENGINES) {
  const skip = () => !browsers[engine];

  describe(`the Account area (${engine})`, () => {
    it("is 960 wide and 88vh high (704 at 800) with a 240px rail, open on the asked section, the section in the address", async () => {
      if (skip()) return;
      const p = await open(engine, { section: "devices" });
      expect(await box(p, "dialog.den-aa-dlg")).toEqual({ w: 960, h: 704 });
      const tall = await open(engine, { section: "devices", height: 1100 });
      expect(await box(tall, "dialog.den-aa-dlg")).toEqual({ w: 960, h: 760 });
      await tall.context().close();
      expect((await box(p, ".den-aa-rail"))!.w).toBe(240);
      expect(await shown(p)).toEqual(["devices"]);
      expect(await address(p)).toBe("/page?x=1&account=devices");
      // The phone's strip and select don't show on a desktop.
      expect(await p.isVisible(".den-aa-sel")).toBe(false);
      expect(await p.isVisible(".den-aa-close")).toBe(false);
      await p.context().close();
    });

    it("a section's row opens its pane and marks it", async () => {
      if (skip()) return;
      const p = await open(engine);
      await p.click('.den-aa-sec[data-section="access"]');
      expect(await shown(p)).toEqual(["access"]);
      expect(
        await p.getAttribute(
          '.den-aa-sec[data-section="access"]',
          "aria-current",
        ),
      ).toBe("true");
      expect(
        await p.getAttribute(
          '.den-aa-sec[data-section="profile"]',
          "aria-current",
        ),
      ).toBeNull();
      expect(await address(p)).toBe("/page?x=1&account=access");
      expect(await calls(p)).toEqual([["section", "access"]]);
      await p.context().close();
    });

    it("/ jumps to the search; a search hides other sections; Enter jumps and flashes; Esc clears, then closes", async () => {
      if (skip()) return;
      const p = await open(engine);
      await p.focus('.den-aa-sec[data-section="profile"]');
      await p.keyboard.press("/");
      expect(
        await p.evaluate(() =>
          document.activeElement?.classList.contains("den-aa-search-in"),
        ),
      ).toBe(true);
      await p.keyboard.type("chrome");
      const visible = await p.evaluate(() =>
        Array.from(document.querySelectorAll(".den-aa-sec"))
          .filter((x) => !(x as HTMLElement).hidden)
          .map((x) => x.getAttribute("data-section")),
      );
      expect(visible).toEqual(["devices"]);
      await p.keyboard.press("Enter");
      expect(await shown(p)).toEqual(["devices"]);
      expect(
        await p.evaluate(() =>
          document
            .querySelector(".den-aa-flash")
            ?.textContent?.includes("Chrome on Linux"),
        ),
      ).toBe(true);
      // Esc: the search first.
      await p.keyboard.press("Escape");
      expect(await p.inputValue(".den-aa-search-in")).toBe("");
      expect(await p.isVisible("dialog.den-aa-dlg")).toBe(true);
      // Then the area, the address without it, focus back on the opener.
      await p.keyboard.press("Escape");
      expect(await p.$("dialog.den-aa-dlg")).toBeNull();
      expect(await address(p)).toBe("/page?x=1");
      expect(await p.evaluate(() => document.activeElement?.id)).toBe("open");
      expect((await calls(p)).at(-1)).toEqual(["closed"]);
      await p.context().close();
    });

    it("Sign out everywhere asks first, in the mock's words; Cancel does nothing", async () => {
      if (skip()) return;
      const p = await open(engine);
      await p.click(
        '.den-aa-pane[data-section="profile"] [data-den-aa-act="signout-all"]',
      );
      const dlg = p.locator("dialog.dk-dlg");
      await dlg.waitFor();
      expect((await dlg.locator("h2").textContent())?.trim()).toBe(
        "Sign out everywhere?",
      );
      expect((await dlg.locator(".dk-msg").textContent())?.trim()).toBe(
        "This signs you out on every device and browser, this one included, and turns off your personal access tokens. You will need to sign in again on each device.",
      );
      expect(
        await dlg.locator('[data-dk="ok"]').getAttribute("class"),
      ).toContain("dk-danger");
      await dlg.locator('[data-dk="cancel"]').click();
      expect(await calls(p)).toEqual([]);
      await p.click(
        '.den-aa-pane[data-section="profile"] [data-den-aa-act="signout-all"]',
      );
      await p.locator('dialog.dk-dlg [data-dk="ok"]').click();
      await p.waitForFunction(
        () => (window as unknown as { calls: unknown[] }).calls.length > 0,
      );
      expect(await calls(p)).toEqual([["signout-all", null, null]]);
      await p.context().close();
    });

    it("a device's Sign out calls the host with its id and name; a toast says so", async () => {
      if (skip()) return;
      const p = await open(engine, { section: "devices" });
      await p.click('[data-den-aa-act="device-signout"][data-id="b2"]');
      expect(await calls(p)).toEqual([
        ["device-signout", "b2", "Chrome on Linux"],
      ]);
      expect((await p.textContent(".den-aa-toast"))?.trim()).toBe(
        "Signed out Chrome on Linux",
      );
      await p.context().close();
    });

    it("a notification switch calls onToggle; a reject puts it back", async () => {
      if (skip()) return;
      const p = await open(engine, { section: "notifications" });
      await p.click("#den-aa-n-waiting");
      expect(await calls(p)).toEqual([["toggle", "waiting", false]]);
      await p.evaluate(() => {
        (window as unknown as { toggleFails: boolean }).toggleFails = true;
      });
      await p.click("#den-aa-n-waiting");
      await p.waitForFunction(
        () =>
          !(document.getElementById("den-aa-n-waiting") as HTMLInputElement)
            .checked,
      );
      expect(await p.isChecked("#den-aa-n-waiting")).toBe(false);
      await p.context().close();
    });

    it("at 390: a strip with ✕, the search and a select, each 44px; the select opens a section", async () => {
      if (skip()) return;
      const p = await open(engine, { width: 390 });
      expect((await box(p, "dialog.den-aa-dlg"))!.w).toBe(374);
      expect(await p.isVisible(".den-aa-nav")).toBe(false);
      expect(await p.isVisible(".den-aa-sel")).toBe(true);
      for (const sel of [".den-aa-sel", ".den-aa-close", ".den-aa-search"])
        expect((await box(p, sel))!.h).toBeGreaterThanOrEqual(44);
      await p.selectOption(".den-aa-sel", "devices");
      expect(await shown(p)).toEqual(["devices"]);
      expect(await address(p)).toBe("/page?x=1&account=devices");
      await p.click(".den-aa-close");
      expect(await p.$("dialog.den-aa-dlg")).toBeNull();
      await p.context().close();
    });

    it("speaks ja", async () => {
      if (skip()) return;
      const p = await open(engine, { lang: "ja" });
      expect(
        (await p.textContent('.den-aa-sec[data-section="devices"]'))?.trim(),
      ).toBe("デバイスとセッション");
      await p.context().close();
    });
  });
}
