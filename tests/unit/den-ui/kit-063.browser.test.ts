/**
 * den-ui 0.6.3: kit bugs a host product's first end-to-end run on 0.6.2
 * found, each on a bare page built from the kit's own files (no product
 * around it), in Chromium and WebKit.
 *
 * 1. Report: ⌘↵ (Ctrl+Enter) is the form's primary button on Write and on
 *    Include, as in every other pop-up: Write → Include → Review. On
 *    Review it sends nothing: nothing is sent without the person's click.
 * 2. The page's main (#den-content) fills the window under the top bar:
 *    shell.css makes the body a column at least the window's height, and
 *    the main takes what is left, so a short page's last row can reach
 *    the window's bottom at every width (375 px stacked too).
 * 3. The top bar is pinned: on a host whose body scrolls, scrolled down a
 *    long page, the bar's top is 0 and the rail still starts under it.
 * 4. reportButtonHtml({ label, prefill }): a row's own "Report this"
 *    button, its words and name; a click opens Report filled from it.
 *
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

const STYLES = ["tokens", "fonts", "base", "shell", "report", "dialog"];

/** A kit page: the shell, and a main holding `main`. */
const PAGE = (main: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${STYLES.map((s) => `<link rel="stylesheet" href="/kit/${s}.css">`).join("\n")}
<style>body { margin: 0; }</style>
</head>
<body class="den-has-shell"><div class="den-shell" id="den-shell"></div>
<main id="den-content">${main}</main>
<script type="module" src="/app.js"></script>
</body></html>`;

const APP = `
import DenUI from "/kit/kit.js";
DenUI.configure({
  lang: "en",
  product: { name: "Acme" },
  adapter: { fileReport: async (p) => { window.filed.push(p); return { number: 7, url: "https://issues.example.test/7" }; } },
  report: { screenshot: false },
});
window.filed = [];
DenUI.mount(document.getElementById("den-shell"), {
  product: { name: "Acme", version: "1.0.0" },
  groups: [{ id: "work", label: "Work" }],
  nav: [{ id: "home", label: "Home", href: "/", group: "work", icon: "home", current: true }],
});
window.DenUI = DenUI;
window.ready = true;
`;

async function open(
  b: Browser,
  vp: { width: number; height: number },
  main = "<p>Short.</p>",
): Promise<Page> {
  const ctx = await b.newContext({ viewport: vp, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE(main) });
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

const step = (p: Page) =>
  p.locator("dialog.fb-dlg").evaluate((d) => (d as HTMLElement).dataset.step);

const PRIMARY = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";

for (const engine of ["chromium", "webkit"]) {
  describe(`den-ui 0.6.3 kit fixes (${engine})`, () => {
    it("Report: ⌘↵ goes Write → Include → Review, and never sends", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, { width: 1280, height: 800 });
      await p.evaluate(() => {
        void (
          window as unknown as { DenUI: { report: { open(): unknown } } }
        ).DenUI.report.open();
      });
      await p.locator("dialog.fb-dlg[open]").waitFor();
      // A plain Enter in the description is still a new line.
      const desc = p.locator('dialog.fb-dlg textarea[data-f="description"]');
      await desc.fill("a");
      await desc.press("Enter");
      await expect(step(p)).resolves.toBe("write");
      const title = p.locator('dialog.fb-dlg input[data-f="title"]');
      await title.fill("Flicker");
      await title.press(PRIMARY);
      await expect(step(p)).resolves.toBe("include");
      // From the heading Include focuses, as from any field: Control+Enter
      // in every engine (the shortcut is ⌘ or Ctrl).
      await p.locator("dialog.fb-dlg h2").press("Control+Enter");
      await expect(step(p)).resolves.toBe("review");
      await p.locator("dialog.fb-dlg h2").press(PRIMARY);
      await p.waitForTimeout(200);
      await expect(step(p)).resolves.toBe("review");
      expect(
        await p.evaluate(() => (window as unknown as { filed: [] }).filed),
      ).toHaveLength(0);
      await p.context().close();
    });

    for (const vp of [
      { width: 375, height: 812 },
      { width: 1280, height: 800 },
    ])
      it(`the main fills the window under the top bar at ${vp.width}`, async () => {
        const b = browsers[engine];
        if (!b) return;
        const p = await open(b, vp);
        const m = await p.evaluate(() => {
          const main = document.getElementById("den-content")!;
          return {
            bottom: Math.round(main.getBoundingClientRect().bottom),
            scrollH: document.scrollingElement!.scrollHeight,
            inner: innerHeight,
          };
        });
        expect(m.bottom).toBe(m.inner);
        expect(m.scrollH).toBe(m.inner);
        // A long page still runs past the window and ends with its main.
        const long = await open(
          b,
          vp,
          '<div style="height:3000px">Long.</div>',
        );
        const l = await long.evaluate(() => {
          const se = document.scrollingElement!;
          const main = document.getElementById("den-content")!;
          return {
            end: Math.round(main.getBoundingClientRect().bottom + se.scrollTop),
            scrollH: se.scrollHeight,
          };
        });
        expect(l.end).toBe(l.scrollH);
        await p.context().close();
        await long.context().close();
      });

    for (const width of [1280, 375])
      for (const host of ["body scrolls", "html, body { height: 100% }"])
        it(`the top bar stays at the top of a long page at ${width} (${host})`, async () => {
          const b = browsers[engine];
          if (!b) return;
          const p = await open(
            b,
            { width, height: 800 },
            '<div style="height:5000px">Long.</div>',
          );
          if (host !== "body scrolls")
            await p.evaluate((css) => {
              const st = document.createElement("style");
              st.textContent = css;
              document.head.append(st);
            }, host);
          // Nothing of the page sits under the bar at the top.
          const first = await p.evaluate(
            () =>
              document.getElementById("den-content")!.getBoundingClientRect()
                .top,
          );
          expect(first).toBe(48);
          await p.evaluate(() => {
            window.scrollTo(0, 3000);
            document.body.scrollTop = 3000;
          });
          const m = await p.evaluate(() => ({
            scrolled: document.scrollingElement!.scrollTop,
            bodyScrolled: document.body.scrollTop,
            bar: document.querySelector(".den-top")!.getBoundingClientRect()
              .top,
            barH: document.querySelector(".den-top")!.getBoundingClientRect()
              .height,
            rail: document.querySelector(".den-rail")!.getBoundingClientRect()
              .top,
            // What is drawn at the top-left of the window: the bar.
            atTop: !!document
              .elementFromPoint(innerWidth - 4, 4)
              ?.closest(".den-top"),
          }));
          expect(Math.max(m.scrolled, m.bodyScrolled)).toBeGreaterThan(2000);
          expect(m.bar).toBe(0);
          expect(m.rail).toBe(m.barH);
          expect(m.atTop).toBe(true);
          await p.context().close();
        });

    it("a row's own Report button: its words, and Report opens filled from it", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, { width: 1280, height: 800 });
      await p.evaluate(() => {
        const D = (
          window as unknown as {
            DenUI: {
              report: { button(o: object): string };
            };
          }
        ).DenUI;
        const row = document.createElement("div");
        row.id = "row";
        row.innerHTML = D.report.button({
          label: 'Report "this" <row>',
          prefill: {
            kind: "bug",
            title: 'Row "7" & <b>',
            description: "It said no.",
          },
        });
        document.getElementById("den-content")!.append(row);
      });
      const btn = p.locator("#row [data-den-report]");
      await expect(btn.locator("span").textContent()).resolves.toBe(
        'Report "this" <row>',
      );
      await expect(btn.getAttribute("aria-label")).resolves.toBe(
        'Report "this" <row>',
      );
      await btn.click();
      await p.locator("dialog.fb-dlg[open]").waitFor();
      await expect(
        p.locator('dialog.fb-dlg input[data-f="title"]').inputValue(),
      ).resolves.toBe('Row "7" & <b>');
      await expect(
        p.locator('dialog.fb-dlg textarea[data-f="description"]').inputValue(),
      ).resolves.toBe("It said no.");
      await p.context().close();
    });
  });
}
