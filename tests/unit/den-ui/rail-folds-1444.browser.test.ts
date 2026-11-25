/**
 * Issue 1444: the rail's sections fold, in Chromium and WebKit. A plain
 * page with the kit's own CSS and kit.js (DenUI.mount), its default store
 * (localStorage). The whole header is the toggle: a click, Enter or Space
 * folds it, aria-expanded says which, the chevron turns, and a folded
 * header shows its entries' count. The state is kept across a reload. A
 * section holding the current page opens. At 390 wide the header is at
 * least 44 px tall. With DEN_1444_SHOTS set to a folder, it saves the
 * open and folded rail at 1280 and 375. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const browsers: Record<string, Browser> = {};
const SHOTS = process.env.DEN_1444_SHOTS;

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
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

const STYLES = ["tokens", "fonts", "base", "shell"];

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${STYLES.map((s) => `<link rel="stylesheet" href="/kit/${s}.css">`).join("\n")}
<style>body { margin: 0; }</style>
</head>
<body class="den-has-shell"><div class="den-shell" id="den-shell"></div>
<main id="den-content"><p>Content</p></main>
<script type="module" src="/app.js"></script>
</body></html>`;

/** Three sections; Tools has two counted entries (one waiting on you). */
const APP = `
import DenUI from "/kit/kit.js";
DenUI.configure({ lang: "en", product: { name: "Acme" } });
const groups = [
  { id: "work", label: "Work" },
  { id: "tools", label: "Tools" },
  { id: "more", label: "More" },
];
const nav = [
  { id: "home", label: "Home", href: "#home", group: "work", icon: "home", current: true },
  { id: "runs", label: "Runs", href: "#runs", group: "work", icon: "home" },
  { id: "logs", label: "Logs", href: "#logs", group: "tools", icon: "home", badge: { n: 2 } },
  { id: "jobs", label: "Jobs", href: "#jobs", group: "tools", icon: "home", badge: { n: 3, bad: true } },
  { id: "docs", label: "Docs", href: "#docs", group: "more", icon: "home" },
];
window.shell = DenUI.mount(document.getElementById("den-shell"), {
  product: { name: "Acme", version: "1.0.0", mark: { text: "A", label: "Acme" } },
  groups, nav,
  settings: { href: "#settings" },
  account: { name: "Ada Lovelace", login: "ada", href: "#account" },
});
window.ready = true;
`;

async function open(
  b: Browser,
  { width = 1280, height = 760, store = null as string[] | null } = {},
): Promise<Page> {
  const ctx = await b.newContext({ viewport: { width, height } });
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
  if (store)
    await p.addInitScript((ids) => {
      try {
        if (!sessionStorage.getItem("seeded")) {
          localStorage.setItem("den.rail.folded", JSON.stringify(ids));
          sessionStorage.setItem("seeded", "1");
        }
      } catch {
        /* no storage */
      }
    }, store);
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(
    () => (window as { ready?: boolean }).ready === true,
    undefined,
    { timeout: 10_000 },
  );
  return p;
}

interface Head {
  tag: string;
  expanded: string | null;
  controls: string | null;
  name: string | null;
  shown: string[];
  count: string | null;
  countBad: boolean;
  chevron: string;
  height: number;
}

/** A section's header and which of its entries show. */
const head = (p: Page, id: string): Promise<Head> =>
  p.evaluate((id) => {
    const g = document
      .querySelector(`[aria-labelledby="den-gh-${id}"]`)!
      .querySelector('[data-nav-role="group"]') as HTMLElement;
    const group = g.closest('[data-nav-role="rail-group"]')!;
    const bdg = g.querySelector("[data-den-fold-n]") as HTMLElement | null;
    const chev = g.querySelector("svg") as Element | null;
    return {
      tag: g.tagName,
      expanded: g.getAttribute("aria-expanded"),
      controls: g.getAttribute("aria-controls"),
      name: g.getAttribute("aria-label"),
      shown: [...group.querySelectorAll("[data-nav]")]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => (e as HTMLElement).dataset.nav!),
      count: bdg && bdg.getClientRects().length > 0 ? bdg.textContent : null,
      countBad: !!bdg && bdg.classList.contains("bad"),
      chevron: chev ? getComputedStyle(chev).transform : "",
      height: g.getBoundingClientRect().height,
    };
  }, id);

const stored = (p: Page) =>
  p.evaluate(() => JSON.parse(localStorage.getItem("den.rail.folded") || "[]"));

describe.each(["chromium", "webkit"])("rail sections fold (%s)", (name) => {
  const b = () => browsers[name]!;

  it("the whole header is a button that folds its section on a click", async () => {
    const p = await open(b());
    const before = await head(p, "tools");
    expect(before).toMatchObject({
      tag: "BUTTON",
      expanded: "true",
      controls: "den-gb-tools",
      name: "Hide Tools",
      shown: ["logs", "jobs"],
      count: null,
    });
    await p.click('[data-den-fold="tools"]');
    const after = await head(p, "tools");
    expect(after).toMatchObject({
      expanded: "false",
      name: "Show Tools, 5 inside",
      shown: [],
      count: "5",
      countBad: true,
    });
    expect(after.chevron).not.toBe(before.chevron);
    expect(await stored(p)).toEqual(["tools"]);
    // Folding moves nothing above the section.
    expect((await head(p, "work")).shown).toEqual(["home", "runs"]);
    await p.close();
  });

  it("Enter and Space fold and open it from the keyboard", async () => {
    const p = await open(b());
    await p.focus('[data-den-fold="more"]');
    await p.keyboard.press("Enter");
    expect((await head(p, "more")).expanded).toBe("false");
    expect((await head(p, "more")).count).toBeNull(); // nothing to count
    await p.keyboard.press("Space");
    expect(await head(p, "more")).toMatchObject({
      expanded: "true",
      shown: ["docs"],
    });
    const focused = await p.evaluate(() =>
      document.activeElement?.hasAttribute("data-den-fold"),
    );
    expect(focused).toBe(true);
    await p.close();
  });

  it("the arrows walk the headers and skip a folded section; one tab stop", async () => {
    const p = await open(b());
    const at = () =>
      p.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        return a.dataset.nav || a.getAttribute("data-den-fold");
      });
    const stops = () => p.$$eval('#den-rail [tabindex="0"]', (e) => e.length);
    expect(await stops()).toBe(1);
    await p.focus('[data-nav="home"]');
    await p.keyboard.press("ArrowDown");
    expect(await at()).toBe("runs");
    await p.keyboard.press("ArrowDown");
    expect(await at()).toBe("tools");
    await p.keyboard.press("Enter");
    expect((await head(p, "tools")).expanded).toBe("false");
    await p.keyboard.press("ArrowDown");
    expect(await at()).toBe("more");
    await p.keyboard.press("Home");
    expect(await at()).toBe("home");
    // End: the rail's last entry (its foot's), as before.
    await p.keyboard.press("End");
    expect(
      await p.evaluate(() => {
        const shown = [
          ...document.querySelectorAll("#den-rail [tabindex]"),
        ].filter((e) => e.getClientRects().length > 0);
        return document.activeElement === shown[shown.length - 1];
      }),
    ).toBe(true);
    expect(await stops()).toBe(1);
    await p.close();
  });

  it("is kept across a reload, and the current page's section opens", async () => {
    const p = await open(b(), { store: ["tools", "work"] });
    expect((await head(p, "tools")).expanded).toBe("false");
    expect(await head(p, "work")).toMatchObject({
      expanded: "true",
      shown: ["home", "runs"],
    });
    expect(await stored(p)).toEqual(["tools"]);
    await p.click('[data-den-fold="tools"]');
    await p.reload();
    await p.waitForFunction(() => (window as { ready?: boolean }).ready);
    expect((await head(p, "tools")).expanded).toBe("true");
    await p.close();
  });

  it("a repaint keeps the button and the fold", async () => {
    const p = await open(b(), { store: ["tools"] });
    await p.evaluate(() => {
      const w = window as unknown as {
        shell: { paint: (h: string, f?: boolean) => boolean };
      };
      const rail = document.getElementById("den-rail")!;
      w.shell.paint(rail.innerHTML, true);
    });
    expect(await head(p, "tools")).toMatchObject({
      tag: "BUTTON",
      expanded: "false",
      count: "5",
    });
    await p.close();
  });

  it("is at least 44 px tall in the phone drawer", async () => {
    const p = await open(b(), { width: 390, height: 760 });
    await p.click("#den-menu-btn");
    expect((await head(p, "tools")).height).toBeGreaterThanOrEqual(44);
    await p.close();
  });

  if (SHOTS)
    it("saves the open and folded rail at 1280 and 375", async () => {
      fs.mkdirSync(SHOTS, { recursive: true });
      for (const width of [1280, 375]) {
        const p = await open(b(), { width, height: 640 });
        if (width < 720) await p.click("#den-menu-btn");
        await p.screenshot({
          path: path.join(SHOTS, `${name}-${width}-open.png`),
        });
        await p.click('[data-den-fold="tools"]');
        await p.click('[data-den-fold="more"]');
        await p.mouse.move(0, 0);
        // The chevrons' turn ends before the picture.
        await p.waitForFunction(() =>
          document.getAnimations().every((a) => a.playState !== "running"),
        );
        await p.screenshot({
          path: path.join(SHOTS, `${name}-${width}-folded.png`),
        });
        await p.close();
      }
    });
});
