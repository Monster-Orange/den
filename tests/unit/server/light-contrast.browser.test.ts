/**
 * Text contrast on the light theme (WCAG 2.1 AA, 1.4.3), measured from
 * computed styles in a real browser: every visible text on Den's pages,
 * its color (with its alpha and every ancestor's opacity) over the
 * background actually behind it (each ancestor's background, alpha
 * composited). 4.5:1, or 3:1 for large text. Disabled controls are
 * exempt, as WCAG exempts them.
 *
 * Why: a Hub axe run on shared light tokens found a faint label, a 15%
 * tinted ok pill and a row dimmed to opacity .8 under AA on a sunken
 * background. This holds Den's own pages to the same bar, sunken surfaces
 * included (each hovered/pressed control paints --sunken).
 *
 * Real chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let browser: Browser | null = null;
let tmp = "";
let port = 0;
let server: ChildProcess;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-cr-")));
  const root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local, dev]\n",
  );
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: path.join(home, ".den"),
        HOME: home,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 60_000 },
  );
  server = started.server;
  port = started.port;
}, 90_000);

afterAll(async () => {
  await browser?.close();
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

interface Low {
  text: string;
  where: string;
  ratio: number;
  need: number;
  fg: string;
  bg: string;
  dimmed: boolean;
}

/** Every visible text under AA on this page, as the browser paints it. */
function lowContrast(p: Page): Promise<Low[]> {
  return p.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true })!;
    /** Any CSS color (rgb, color(srgb …), a color-mix result) as sRGB 0–255 + alpha. */
    const rgba = (c: string): [number, number, number, number] => {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (
      top: [number, number, number, number],
      under: [number, number, number],
    ): [number, number, number] => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const lum = (c: [number, number, number]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const hex = (c: [number, number, number]) =>
      "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const out: Low[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      if (el.closest("script, style, noscript, [aria-hidden='true']")) continue;
      if (el.closest(":disabled, [aria-disabled='true']")) continue;
      const rects = el.getClientRects();
      if (!rects.length || !rects[0].width) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== "visible") continue;
      // Root to the element: backgrounds (alpha × the opacity above them).
      const chain: Element[] = [];
      for (let a: Element | null = el; a; a = a.parentElement) chain.unshift(a);
      // An ancestor's background is behind the text only where the text
      // lies inside its box (a label positioned below a swatch is not on it).
      const r = rects[0];
      const inside = (a: Element) => {
        const b = a.getBoundingClientRect();
        return (
          r.left >= b.left - 1 &&
          r.right <= b.right + 1 &&
          r.top >= b.top - 1 &&
          r.bottom <= b.bottom + 1
        );
      };
      let bg: [number, number, number] = [255, 255, 255];
      let opacity = 1;
      let unknown = false;
      for (const a of chain) {
        const s = getComputedStyle(a);
        opacity *= Number(s.opacity);
        if (a !== document.documentElement && a !== document.body && !inside(a))
          continue;
        if (s.backgroundImage !== "none") unknown = true;
        const b = rgba(s.backgroundColor);
        if (b[3] > 0) bg = over([b[0], b[1], b[2], b[3] * opacity], bg);
      }
      if (unknown || opacity === 0) continue;
      const f = rgba(cs.color);
      const fg = over([f[0], f[1], f[2], f[3] * opacity], bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const px = parseFloat(cs.fontSize);
      const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio + 0.005 < need)
        out.push({
          text: n.textContent.trim().slice(0, 40),
          where:
            el.tagName.toLowerCase() +
            (el.id ? `#${el.id}` : "") +
            (el.className && typeof el.className === "string"
              ? "." + el.className.trim().split(/\s+/).join(".")
              : ""),
          ratio: Math.round(ratio * 100) / 100,
          need,
          fg: hex(fg),
          bg: hex(bg),
          dimmed: opacity < 1 || f[3] < 1,
        });
    }
    return out;
  });
}

async function lightPage(url: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  // What's new stays shut: this release counts as seen.
  const latest =
    (
      (await (
        await fetch(`http://localhost:${port}/api/changelog`)
      ).json()) as { version: string }[]
    )[0]?.version ?? "";
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${port}${url}`);
  await p.waitForLoadState("networkidle");
  await p.waitForTimeout(500);
  return p;
}

const PAGES = [
  "/",
  "/services",
  "/environments",
  "/tests",
  "/agents",
  "/logs",
  "/edge",
  "/release",
  "/settings",
  "/graph",
];

describe("light theme text contrast (WCAG AA)", () => {
  it.each(PAGES)(
    "%s: every visible text meets AA",
    async (url) => {
      if (!browser) return;
      const p = await lightPage(url);
      expect(await p.getAttribute("html", "data-mode")).toBe("light");
      const low = await lowContrast(p);
      await p.context().close();
      expect(low).toEqual([]);
    },
    60_000,
  );

  it.each(PAGES)(
    "%s: with every hover, focus and pressed state applied, text still meets AA",
    async (url) => {
      if (!browser) return;
      const p = await lightPage(url);
      // Each rule for :hover, :focus or a pressed/expanded state, applied for
      // good (the --sunken backgrounds, a primary button's hover opacity), so
      // the scan reads every such control as it looks then.
      const css = await p.evaluate(() => {
        const out: string[] = [];
        const walk = (list: CSSRuleList) => {
          for (const r of Array.from(list)) {
            if (
              (r as CSSMediaRule).cssRules &&
              !(r as CSSStyleRule).selectorText
            ) {
              if (
                !(r as CSSMediaRule).media ||
                matchMedia((r as CSSMediaRule).media.mediaText).matches
              )
                walk((r as CSSMediaRule).cssRules);
              continue;
            }
            const sr = r as CSSStyleRule;
            if (!sr.selectorText || !sr.style) continue;
            if (
              !/:hover|:focus|aria-expanded|aria-pressed/.test(sr.selectorText)
            )
              continue;
            const sel = sr.selectorText
              .replace(/:hover|:focus-visible|:focus-within|:focus/g, "")
              .trim();
            const decl = Array.from(sr.style)
              .map((k) => `${k}: ${sr.style.getPropertyValue(k)} !important;`)
              .join(" ");
            if (sel && decl) out.push(`${sel} { ${decl} }`);
          }
        };
        for (const sh of Array.from(document.styleSheets)) {
          try {
            walk(sh.cssRules);
          } catch {
            /* another origin's sheet */
          }
        }
        return out;
      });
      expect(css.length).toBeGreaterThan(3);
      await p.addStyleTag({ content: css.join("\n") });
      const low = await lowContrast(p);
      await p.context().close();
      expect(low).toEqual([]);
    },
    60_000,
  );

  it.each([
    [
      "/",
      // A repo row already in the workspace, in the add-service picker.
      '<div class="add-svc-row already"><div class="add-svc-row-info"><span class="add-svc-name">shop</span><div class="add-svc-row-path">code/shop</div></div><span class="add-svc-pill added">added</span></div>',
    ],
    [
      "/release",
      // The table's loading note, with its sub-line.
      '<table><tbody><tr><td class="loading-note">Loading deployed state<span class="sub">Checking every repo against GitHub</span></td></tr></tbody></table>',
    ],
    [
      "/",
      // Status pills (their token on a tint of it), on a sunken surface.
      '<div style="background: var(--sunken); padding: 8px"><span class="add-svc-pill supported">Checking pill</span> <span class="add-svc-pill no-manifest">Checking pill</span> <span class="add-svc-pill added">Checking pill</span> <span class="den-bdg bad">Checking pill</span></div>',
    ],
    [
      "/tests",
      '<div style="background: var(--sunken); padding: 8px"><span class="perf-ok">Checking pill</span> <span class="perf-fail">Checking pill</span></div>',
    ],
    [
      "/graph",
      '<div style="background: var(--sunken); padding: 8px"><span class="dg-tag entry">Checking pill</span> <span class="dg-tag warn">Checking pill</span></div>',
    ],
    [
      "/release",
      '<div style="background: var(--sunken); padding: 8px"><div class="banner hotfix">Checking pill</div><div class="banner prod">Checking pill</div></div>',
    ],
  ])(
    "%s: a state an empty Den doesn't show meets AA",
    async (url, html) => {
      if (!browser) return;
      const p = await lightPage(url);
      await p.evaluate((h) => {
        const box = document.createElement("div");
        box.id = "cr-probe";
        box.innerHTML = h;
        (document.querySelector("main, #den-content") ?? document.body).prepend(
          box,
        );
      }, html);
      const low = (await lowContrast(p)).filter((l) =>
        /shop|code\/shop|added|Loading|Checking/.test(l.text),
      );
      await p.context().close();
      expect(low).toEqual([]);
    },
    60_000,
  );
});
