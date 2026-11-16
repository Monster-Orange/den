/**
 * den-ui 0.6.5: focus goes back to what opened a pop-up when it closes, in
 * WebKit too. Safari doesn't focus a button on a click, so the browser's
 * own dialog restore went to the body: Report, the ask-and-tell dialogs
 * and What's new now remember their opener and focus it again.
 *
 * The page keeps a click from focusing a button, as Safari on macOS does.
 * On a bare page built from the kit's own files, in Chromium and WebKit.
 * DEN_PW_WS: Den's own Playwright server instead of a local browser.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

const STYLES = [
  "tokens",
  "fonts",
  "base",
  "shell",
  "report",
  "dialog",
  "whatsnew",
];

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${STYLES.map((s) => `<link rel="stylesheet" href="/kit/${s}.css">`).join("\n")}
<style>body { margin: 0; }</style>
</head>
<body class="den-has-shell"><div class="den-shell" id="den-shell"></div>
<main id="den-content">
<p><button type="button" id="host-report">File it</button>
<button type="button" id="host-ask">Delete</button>
<button type="button" id="host-news">News</button></p>
</main>
<script type="module" src="/app.js"></script>
</body></html>`;

// Safari on macOS doesn't focus a button on a click (WebKit elsewhere,
// and Chromium, do): the page does the same here, so the browser's own
// restore has only the body to go back to, in every engine.
const APP = `
document.addEventListener("mousedown", (e) => {
  if (e.target.closest && e.target.closest("button") && !e.target.closest("dialog")) e.preventDefault();
}, true);
import DenUI from "/kit/kit.js";
import { askConfirm } from "/kit/dialog.js";
DenUI.configure({
  lang: "en",
  product: { name: "Acme" },
  adapter: { fileReport: async () => ({ number: 7, url: "https://issues.example.test/7" }) },
  report: { screenshot: false },
});
DenUI.mount(document.getElementById("den-shell"), {
  product: { name: "Acme", version: "1.0.0", mark: { text: "A", label: "Acme" } },
  groups: [{ id: "work", label: "Work" }],
  nav: [{ id: "home", label: "Home", href: "/", group: "work", icon: "home", current: true }],
});
DenUI.whatsNew.setEntries([{ version: "1.0.0", date: "2026-11-16", sections: { Added: [{ text: "A thing" }] } }]);
document.getElementById("host-report").addEventListener("click", () => { void DenUI.report.open(); });
document.getElementById("host-ask").addEventListener("click", () => { window.answer = askConfirm({ title: "Delete it?" }); });
document.getElementById("host-news").addEventListener("click", () => DenUI.whatsNew.open());
window.ready = true;
`;

async function open(b: Browser): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    if (u.pathname === "/app.js")
      return r.fulfill({ contentType: "text/javascript", body: APP });
    const f = u.pathname.replace(/^\/kit\//, "");
    const file = path.join(SRC, f);
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: f.endsWith(".css")
          ? "text/css"
          : f.endsWith(".woff2")
            ? "font/woff2"
            : "text/javascript",
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(() => (window as { ready?: boolean }).ready === true);
  return p;
}

/** The focused element: its id, else its tag. */
const focused = (p: Page) =>
  p.evaluate(() => {
    const a = document.activeElement;
    return a ? a.id || a.tagName.toLowerCase() : null;
  });

const report = (p: Page) => p.locator("dialog.fb-dlg");

for (const engine of ["chromium", "webkit"]) {
  describe(`den-ui 0.6.5 focus goes back to the opener (${engine})`, () => {
    it("Report from a host button: Esc", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.locator("#host-report").click();
      await p.locator("dialog.fb-dlg[open]").waitFor();
      await p.keyboard.press("Escape");
      await report(p).waitFor({ state: "detached" });
      await expect(focused(p)).resolves.toBe("host-report");
      await p.context().close();
    });

    it("Report with typed text: Esc, then Discard", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.locator("#host-report").click();
      await p.locator("dialog.fb-dlg[open]").waitFor();
      await p.locator('dialog.fb-dlg input[data-f="title"]').fill("Flicker");
      await p.keyboard.press("Escape");
      await p.locator('dialog.fb-dlg [data-act="discard"]').click();
      await report(p).waitFor({ state: "detached" });
      await expect(focused(p)).resolves.toBe("host-report");
      await p.context().close();
    });

    it("Report from the top bar's own Report button: Cancel", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.evaluate(() =>
        document
          .querySelector("#den-shell [data-den-report]")
          ?.setAttribute("id", "bar-report"),
      );
      await p.locator("#bar-report").click();
      await p.locator("dialog.fb-dlg[open]").waitFor();
      await p.locator('dialog.fb-dlg [data-act="cancel"]').click();
      await report(p).waitFor({ state: "detached" });
      await expect(focused(p)).resolves.toBe("bar-report");
      await p.context().close();
    });

    it("askConfirm from a host button: Esc", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.locator("#host-ask").click();
      await p.locator("dialog.dk-dlg[open]").waitFor();
      await p.keyboard.press("Escape");
      await p.locator("dialog.dk-dlg").waitFor({ state: "detached" });
      await expect(
        p.evaluate(() => (window as unknown as { answer: unknown }).answer),
      ).resolves.toBe(false);
      await expect(focused(p)).resolves.toBe("host-ask");
      await p.context().close();
    });

    it("What's new from a host button: Esc", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await p.locator("#host-news").click();
      await p.locator("#cl-overlay.open").waitFor();
      await p.keyboard.press("Escape");
      await p.locator("#cl-overlay.open").waitFor({ state: "detached" });
      await expect(focused(p)).resolves.toBe("host-news");
      await p.context().close();
    });
  });
}
