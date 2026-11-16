/**
 * Issue 95: a page built on the UI kit alone, served with
 *
 *   Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
 *
 * No inline script or style, no eval: the page's own code is a file. It
 * mounts the shell (DenUI.mount, the same shellHtml Den renders with),
 * collapses the rail, opens the ☰ drawer at phone width, sets the version
 * chip, opens What's new, shows the update pill, and files a report
 * through the simple adapter ("Filed as #N"), then reopens Report with no
 * adapter (Copy report only). Any CSP violation fails the test.
 *
 * DEN_PW_WS: Den's own Playwright server instead of a local browser;
 * DEN_HELPERS_BROWSER=webkit runs it in WebKit.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:";
let browser: Browser | null = null;

/** What the page's code puts on window. */
type KitWin = {
  filed: unknown[];
  DenUI: {
    configure(o: object): void;
    version: { set(label: string): void; unread(on: boolean): void };
    whatsNew: { load(): Promise<unknown>; close(): void };
    update: { set(o: object): void; hide(): void };
    report: { open(): Promise<unknown> };
  };
};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine = (
      ["webkit", "firefox"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
        : "chromium"
    ) as "chromium" | "webkit" | "firefox";
    const ws = process.env.DEN_PW_WS;
    browser = ws
      ? await pw[engine].connect(ws, { exposeNetwork: "<loopback>" })
      : await pw[engine].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser] });
});

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kit</title>
<link rel="stylesheet" href="/kit/tokens.css">
<link rel="stylesheet" href="/kit/base.css">
<link rel="stylesheet" href="/kit/shell.css">
<link rel="stylesheet" href="/kit/whatsnew.css">
<link rel="stylesheet" href="/kit/report.css">
<link rel="stylesheet" href="/kit/update-pill.css">
</head>
<body class="den-has-shell"><div id="shell"></div>
<main id="den-content"><h1>Acme</h1></main>
<script type="module" src="/app.js"></script>
</body></html>`;

/** The page's own code: a file, as the CSP wants. */
const APP = `
import DenUI from "/kit/kit.js";
window.filed = [];
DenUI.configure({
  lang: "en",
  product: { name: "Acme" },
  adapter: {
    changelog: async () => [
      { version: "2.0.0", date: "2026-01-02", sections: { Added: [{ text: "Wings" }] } },
      { version: "1.0.0", date: "2026-01-01", sections: { Added: [{ text: "Legs" }] } },
    ],
    fileReport: async (p) => { window.filed.push(p); return { number: 42, url: "https://issues.example.test/42" }; },
  },
  report: { screenshot: false },
});
const model = {
  product: { name: "Acme", version: "2.0.0" },
  groups: [{ id: "work", label: "Work" }],
  nav: [
    { id: "home", label: "Home", href: "/", group: "work", icon: "home", current: true },
    { id: "logs", label: "Logs", href: "/logs", group: "work", icon: "logs", pin: "logs" },
  ],
  slots: { account: '<span id="who">me</span>' },
};
window.shell = DenUI.mount(document.getElementById("shell"), {
  ...model,
  hydrate: { onCollapse: (on) => window.shell.setCollapsed(on) },
});
window.DenUI = DenUI;
window.ready = true;
`;

async function open(width: number): Promise<{ p: Page; bad: string[] }> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  const bad: string[] = [];
  p.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()))
      bad.push(m.text());
  });
  p.on("pageerror", (e) => bad.push(`pageerror: ${e.message}`));
  await p.exposeFunction("cspBad", (s: string) => bad.push(s));
  await p.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { cspBad: (s: string) => void }).cspBad(
        `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`,
      ),
    );
  });
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    const headers = { "Content-Security-Policy": CSP };
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", headers, body: PAGE });
    if (u.pathname === "/app.js")
      return r.fulfill({ contentType: "text/javascript", headers, body: APP });
    const f = u.pathname.replace(/^\/kit\//, "");
    const file = path.join(SRC, f);
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        headers,
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, headers, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(() => (window as { ready?: boolean }).ready === true);
  return { p, bad };
}

const click = (p: Page, sel: string) => p.locator(sel).first().click();

describe("a kit page under script-src 'self'; style-src 'self'", () => {
  it("runs the shell, version chip, What's new, update pill and Report with no violation", async () => {
    if (!browser) return;
    const { p, bad } = await open(1280);
    // The shell, drawn by the kit and styled by shell.css (not inline).
    await expect(p.locator(".den-top").isVisible()).resolves.toBe(true);
    expect(
      await p.locator(".den-top").evaluate((e) => getComputedStyle(e).display),
    ).not.toBe("inline");
    await click(p, '[data-act="collapse"]');
    expect(
      await p.evaluate(() =>
        document.body.classList.contains("den-rail-collapsed"),
      ),
    ).toBe(true);
    // The version chip, then What's new from the adapter's changelog.
    await p.evaluate(async () => {
      const D = (window as unknown as KitWin).DenUI;
      D.version.set("v2.0.0");
      D.version.unread(true);
      await D.whatsNew.load();
    });
    await click(p, "#version-pill");
    await p.locator("#cl-overlay.open").waitFor();
    await expect(p.locator("#cl-body").innerText()).resolves.toContain("Wings");
    await p.evaluate(() =>
      (window as unknown as KitWin).DenUI.whatsNew.close(),
    );
    // The update pill.
    await p.evaluate(() =>
      (window as unknown as KitWin).DenUI.update.set({ version: "2.1.0" }),
    );
    await p.locator(".den-upd").first().waitFor();
    await p.evaluate(() => (window as unknown as KitWin).DenUI.update.hide());
    // Report: the top bar's button, the simple adapter, "Filed as #42".
    await click(p, ".den-top [data-den-report]");
    await p.locator("dialog.fb-dlg").waitFor();
    await p.locator('input[data-f="title"]').fill("Flicker");
    await p.locator('textarea[data-f="description"]').fill("It flickers");
    for (const act of ["next", "review", "send"]) {
      const b = p.locator(`dialog.fb-dlg [data-act="${act}"]`);
      await b.waitFor();
      await b.click();
    }
    await expect(p.locator("dialog.fb-dlg").innerText()).resolves.toContain(
      "Filed as #42",
    );
    // Its link, and the Open issue button.
    expect(
      await p
        .locator('dialog.fb-dlg a[href="https://issues.example.test/42"]')
        .count(),
    ).toBeGreaterThan(0);
    expect(
      await p.evaluate(() => (window as unknown as KitWin).filed.length),
    ).toBe(1);
    expect(bad).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("without fileReport, Report offers Copy report only", async () => {
    if (!browser) return;
    const { p, bad } = await open(1280);
    await p.evaluate(() =>
      (window as unknown as KitWin).DenUI.configure({
        adapter: {},
        report: { screenshot: false },
      }),
    );
    await p.evaluate(() => (window as unknown as KitWin).DenUI.report.open());
    await p.locator('input[data-f="title"]').fill("Flicker");
    await p.locator('textarea[data-f="description"]').fill("It flickers");
    for (const act of ["next", "review"])
      await click(p, `dialog.fb-dlg [data-act="${act}"]`);
    await p.locator('dialog.fb-dlg [data-act="copy"]').waitFor();
    await expect(
      p.locator('dialog.fb-dlg [data-act="send"]').count(),
    ).resolves.toBe(0);
    expect(bad).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("opens the ☰ drawer at phone width with no violation", async () => {
    if (!browser) return;
    const { p, bad } = await open(390);
    await click(p, "#den-menu-btn");
    expect(
      await p.evaluate(() => document.body.classList.contains("den-rail-open")),
    ).toBe(true);
    await expect(p.locator(".den-scrim").count()).resolves.toBe(1);
    await p.keyboard.press("Escape");
    expect(
      await p.evaluate(() => document.body.classList.contains("den-rail-open")),
    ).toBe(false);
    expect(bad).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("catches a violation (the check is live)", async () => {
    if (!browser) return;
    const { p, bad } = await open(1280);
    // An injected <style> is what the policy forbids.
    await p.evaluate(() => {
      const s = document.createElement("style");
      s.textContent = "body { color: red }";
      document.head.appendChild(s);
    });
    await p.waitForTimeout(200);
    expect(bad.join("\n")).toMatch(/style-src/);
    await p.context().close();
  }, 60_000);
});
