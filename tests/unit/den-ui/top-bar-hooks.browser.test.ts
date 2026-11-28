import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";
import { scopeHtml } from "../../../packages/den-ui/src/shell-html.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
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

const CRUMBS = [
  {
    key: "company",
    label: "Company",
    value: "A company with a long name",
    optional: "wide",
  },
  {
    key: "project",
    label: "Project",
    value: "A project whose name runs on and on past its room",
  },
];

const PAGE = (o: { bare?: boolean; style?: string }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/shell.css"><style>${o.style ?? ""}</style></head>
<body class="den-has-shell">
<script type="module">
import { topBarHtml, scopeHtml, searchHtml } from "/shell-html.js";
document.body.insertAdjacentHTML("afterbegin", topBarHtml({
  product: { name: "Acme", version: "1.2.3" },
  lang: "en",
  slots: { start: scopeHtml({ crumbs: ${JSON.stringify(CRUMBS)}, lang: "en", bare: ${o.bare ? "true" : "false"} }) + searchHtml({ lang: "en" }) },
}));
window.ready = true;
</script></body></html>`;

async function open(
  width: number,
  o: { bare?: boolean; style?: string } = {},
): Promise<Page> {
  const ctx = await browser!.newContext({ viewport: { width, height: 700 } });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE(o) });
    const f = path.join(SRC, u.pathname.slice(1));
    if (/^\/[\w-]+\.(css|js)$/.test(u.pathname) && fs.existsSync(f))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(f, "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction("window.ready === true");
  expect(errs).toEqual([]);
  return p;
}

const crumbs = (p: Page) => p.getByRole("group", { name: "Scope" });
const shownW = (p: Page, sel: string) =>
  crumbs(p).evaluate(
    (g, s) =>
      [...g.querySelectorAll(s)].map((e) =>
        Math.round(e.getBoundingClientRect().width),
      ),
    sel,
  );

describe("scopeHtml: the hooks' markup (issue 1971)", () => {
  it('a crumb with optional: "wide" and its separator carry den-opt-wide', () => {
    const h = scopeHtml({ crumbs: CRUMBS, lang: "en" });
    expect(h).toMatch(/id="[^"]+" class="den-ib den-opt den-opt-wide"/);
    expect(h).toContain('class="den-sep den-company-sep den-opt-wide"');
  });

  it("optional: true is as before; bare: true marks the crumbs", () => {
    const h = scopeHtml({
      crumbs: [{ ...CRUMBS[0], optional: true }, CRUMBS[1]],
      lang: "en",
    });
    expect(h).not.toContain("den-opt-wide");
    expect(h).toMatch(/class="den-ib den-opt"/);
    expect(h).toMatch(/^<div class="den-scope" role="group"/);
    expect(scopeHtml({ crumbs: CRUMBS, lang: "en", bare: true })).toMatch(
      /^<div class="den-scope den-crumbs-bare" role="group"/,
    );
  });
});

describe("the top bar's hooks in a browser (issue 1971)", () => {
  it.each([
    [900, [0, 0]],
    [1023, [0, 0]],
    [1100, [1, 1]],
  ])(
    "at %ipx a wide-only crumb and its separator show: %j",
    async (w, want) => {
      if (skip()) return;
      const p = await open(w);
      const seen = await shownW(p, ".den-opt-wide");
      expect(seen.map((x) => (x > 0 ? 1 : 0))).toEqual(want);
      await p.context().close();
    },
  );

  it("bare crumbs: the small labels go and the last crumb gives way", async () => {
    if (skip()) return;
    const plain = await open(1100);
    const [lastPlain] = await shownW(plain, ".den-last");
    expect((await shownW(plain, ".den-k")).some((x) => x > 0)).toBe(true);
    await plain.context().close();
    const p = await open(1100, { bare: true });
    expect((await shownW(p, ".den-k")).every((x) => x === 0)).toBe(true);
    const min = await crumbs(p).evaluate(
      (g) => getComputedStyle(g.lastElementChild!).minWidth,
    );
    expect(min).toBe("0px");
    const [lastBare] = await shownW(p, ".den-last");
    expect(lastBare).toBeLessThanOrEqual(lastPlain!);
    await p.context().close();
  });

  it("a host sets the bar's widths on body, with no kit selector", async () => {
    if (skip()) return;
    const search = async (style: string) => {
      const p = await open(1100, { style });
      const w = await p
        .getByRole("banner")
        .evaluate((h) =>
          getComputedStyle(h).getPropertyValue("grid-template-columns"),
        );
      await p.context().close();
      return w.split(" ").map((x) => Math.round(parseFloat(x)));
    };
    const [, baseSearch] = await search("");
    const [, hostSearch] = await search(
      "body { --den-top-left-min: 444px; --den-top-search: clamp(160px, calc(100% - 444px - 396px), 304px); }",
    );
    expect(hostSearch).toBe(1100 - 24 - 444 - 396);
    expect(baseSearch).toBe(304);
  });
});
