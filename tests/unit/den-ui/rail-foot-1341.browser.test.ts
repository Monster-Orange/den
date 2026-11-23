/**
 * Issue 1341: the kit's rail keeps its foot (a host's foot entries,
 * Settings, the account row, Collapse) in view when the groups are taller
 * than the window. The groups scroll in their own area; the foot stays put
 * at the rail's bottom, expanded, collapsed and in the ☰ drawer. In a
 * window the groups fit, nothing changes: the rail doesn't scroll and the
 * foot sits at the rail's bottom edge, inside its 10 px padding.
 *
 * A plain page with the kit's own CSS and kit.js, in Chromium and WebKit.
 * Invented names only.
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

/** Five groups of 2 to 7 items (25 in all), the issue's case; ?more:
 *  twice that (a collapsed rail's icon rows overflow too); ?few: one. */
const APP = `
import DenUI from "/kit/kit.js";
const q = new URLSearchParams(location.search);
DenUI.configure({ lang: "en", product: { name: "Acme" } });
const five = [7, 6, 5, 5, 2];
const sizes = q.has("few") ? [2] : q.has("more") ? [...five, ...five] : five;
const groups = sizes.map((_, g) => ({ id: "g" + g, label: "Group " + (g + 1) }));
const nav = sizes.flatMap((n, g) =>
  Array.from({ length: n }, (_, i) => ({
    id: "n" + g + "-" + i, label: "Page " + (g + 1) + "." + (i + 1),
    href: "#p" + g + "-" + i, group: "g" + g, icon: "home", current: g === 0 && i === 0,
  })));
const model = {
  product: { name: "Acme", version: "1.0.0", mark: { text: "A", label: "Acme" } },
  groups, nav,
  foot: [{ id: "help", label: "Help", href: "#help", icon: "home" }],
  settings: { href: "#settings" },
  account: { name: "Ada Lovelace", login: "ada", href: "#account" },
};
window.shell = DenUI.mount(document.getElementById("den-shell"), model);
window.ready = true;
`;

async function open(
  b: Browser,
  { width = 1280, height = 700, query = "" } = {},
): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width, height },
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
  await p.goto(`${ORIGIN}/${query}`);
  await p.waitForFunction(
    () => (window as { ready?: boolean }).ready === true,
    undefined,
    { timeout: 10_000 },
  );
  return p;
}

interface Box {
  top: number;
  bottom: number;
}
interface Look {
  vh: number;
  rail: Box & { scrolls: boolean };
  foot: { name: string; top: number; bottom: number }[];
  last: Box;
}

/** The rail, each foot entry's box, and the last group item's box. */
const look = (p: Page): Promise<Look> =>
  p.evaluate(() => {
    const rail = document.querySelector(".den-rail") as HTMLElement;
    const rr = rail.getBoundingClientRect();
    const grow = rail.querySelector(".den-rail-grow") as HTMLElement;
    // Every entry after the spacer, in document order: the foot.
    const foot = [...rail.querySelectorAll(".den-ni, .den-acct, a, button")]
      .filter(
        (el) =>
          grow.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
      .filter((el) => !el.parentElement?.closest(".den-ni, .den-acct"))
      // Hidden here (the drawer has no Collapse): no box to keep in view.
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          name:
            (el as HTMLElement).dataset.nav ??
            (el as HTMLElement).dataset.act ??
            el.className,
          top: r.top,
          bottom: r.bottom,
        };
      });
    const items = [...rail.querySelectorAll(".den-rail-group .den-ni")];
    const lr = items[items.length - 1].getBoundingClientRect();
    return {
      vh: window.innerHeight,
      rail: {
        top: rr.top,
        bottom: rr.bottom,
        scrolls: rail.scrollHeight > rail.clientHeight + 1,
      },
      foot,
      last: { top: lr.top, bottom: lr.bottom },
    };
  });

/** Scrolls the rail's groups to their end. */
const scrollGroupsToEnd = (p: Page) =>
  p.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>(
      ".den-rail, .den-rail *",
    ))
      if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
  });

function footInView(l: Look): void {
  expect(l.foot.length).toBeGreaterThanOrEqual(4);
  expect(l.foot.map((f) => f.name)).toContain("account");
  for (const f of l.foot) {
    expect(f.top).toBeGreaterThanOrEqual(l.rail.top);
    expect(f.bottom).toBeLessThanOrEqual(l.vh);
    expect(f.bottom).toBeLessThanOrEqual(l.rail.bottom);
  }
}

describe.each(["chromium", "webkit"])(
  "issue 1341: the rail's foot, %s",
  (name) => {
    const b = () => browsers[name];

    it("1280×700, groups overflow: the foot is in view and the groups scroll above it", async () => {
      if (!b()) return;
      const p = await open(b());
      try {
        const before = await look(p);
        footInView(before);
        // The groups don't fit: their last item starts out of view.
        expect(before.last.bottom).toBeGreaterThan(before.foot[0].top);
        await scrollGroupsToEnd(p);
        const after = await look(p);
        footInView(after);
        // Collapse keeps the rail's 10 px bottom padding below it.
        const end = after.foot[after.foot.length - 1];
        expect(
          Math.abs(after.rail.bottom - 10 - end.bottom),
        ).toBeLessThanOrEqual(1);
        // The foot didn't move; the groups did, and their end now sits
        // above the foot, never under it.
        // (Within a pixel: a scroll's end is a whole pixel.)
        expect(after.foot.map((f) => f.name)).toEqual(
          before.foot.map((f) => f.name),
        );
        after.foot.forEach((f, i) =>
          expect(Math.abs(f.top - before.foot[i].top)).toBeLessThanOrEqual(1),
        );
        expect(after.last.bottom).toBeLessThanOrEqual(after.foot[0].top + 0.5);
        expect(after.last.top).toBeLessThan(before.last.top);
      } finally {
        await p.context().close();
      }
    });

    it("1280×700 collapsed, groups overflow: the foot is in view", async () => {
      if (!b()) return;
      const p = await open(b(), { query: "?more" });
      try {
        await p.click('[data-act="collapse"]');
        await p.waitForFunction(() =>
          document.body.classList.contains("den-rail-collapsed"),
        );
        // The click scrolled the rail to Collapse: start from the top.
        await p.evaluate(() => {
          (document.querySelector(".den-rail") as HTMLElement).scrollTop = 0;
        });
        const l = await look(p);
        expect(l.rail.scrolls).toBe(true);
        expect(l.last.bottom).toBeGreaterThan(l.vh);
        footInView(l);
      } finally {
        await p.context().close();
      }
    });

    it("390×700, the ☰ drawer open: the foot is in view", async () => {
      if (!b()) return;
      const p = await open(b(), { width: 390 });
      try {
        await p.click(".den-menu-btn");
        await p.waitForFunction(() =>
          document.body.classList.contains("den-rail-open"),
        );
        const l = await look(p);
        footInView(l);
        // The drawer's own Report ends the foot, in view with it.
        expect(l.foot[l.foot.length - 1].name).toContain("den-rb");
      } finally {
        await p.context().close();
      }
    });

    it("a tall window: nothing changes (no scroll, the foot at the rail's bottom)", async () => {
      if (!b()) return;
      const p = await open(b(), { height: 1600 });
      try {
        const l = await look(p);
        expect(l.rail.scrolls).toBe(false);
        footInView(l);
        // The rail's 10 px bottom padding below Collapse, as before.
        const end = l.foot[l.foot.length - 1];
        expect(Math.abs(l.rail.bottom - 10 - end.bottom)).toBeLessThanOrEqual(
          1,
        );
        // The groups end above the foot, with the spacer between.
        expect(l.last.bottom).toBeLessThan(l.foot[0].top);
      } finally {
        await p.context().close();
      }
    });
  },
);
