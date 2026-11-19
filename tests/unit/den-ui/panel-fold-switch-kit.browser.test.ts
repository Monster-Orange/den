/**
 * den-ui: the panel fold toggle (issue 548), the folded panel's edge strip
 * (issue 549) and the switch (issue 551) in a browser, with no product
 * around them: a bare page links tokens.css, base.css, panel-fold.css and
 * switch.css, draws the three with the kit's builders and wires them to a
 * host that keeps the state (a side panel that folds away).
 *
 *   - the toggle: a press calls onToggle(next) and moves aria-pressed;
 *     Enter and Space press it; focus stays on it; set() moves it with no
 *     call; pressed wears --sunken and --border-strong
 *   - the strip: 40px wide; Show panel calls onShow; when the host hides
 *     the strip and leaves focus there, focus goes to the toggle for the
 *     same panel; a focus the host moved itself is kept; setCount
 *   - the switch: role=switch named by its label, described by its help;
 *     Space, Enter and a click on its words call onChange(on); disabled is
 *     out of the tab order and calls nothing; the track is --accent-fill
 *     on, --border-strong off; the knob moves only without reduced motion
 *   - at 1280 and 390, light and dark: colours from the tokens; at 390
 *     every control is a 44px target
 *   - es and ja words
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";

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

const PAGE = (lang: string, mode: string) => `<!doctype html>
<html lang="${lang}"${mode ? ` data-mode="${mode}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/panel-fold.css"><link rel="stylesheet" href="/switch.css"></head>
<body>
<div id="bar"></div>
<div id="layout"><main id="doc"><p>Text</p><button id="other">Other</button></main>
<div id="strip-slot"></div>
<aside id="side"><button id="tab">Tab</button><div id="sw-slot"></div><div id="sw-off-slot"></div></aside></div>
<script type="module">
import { foldToggleHtml, edgeStripHtml, hydrateFoldToggle, hydrateEdgeStrip } from "/panel-fold.js";
import { switchHtml, hydrateSwitch } from "/switch.js";
import { launchBrowser } from "../helpers/browser.js";
const lang = document.documentElement.lang;
window.calls = [];
window.layout = "panel";
document.getElementById("bar").innerHTML = foldToggleHtml({ pressed: true, controls: "side", lang });
document.getElementById("strip-slot").innerHTML = edgeStripHtml({ count: 2, controls: "side", lang });
document.getElementById("sw-slot").innerHTML = switchHtml({ id: "sw", label: "Show notes in the text", help: "Kept on this device.", on: true, lang });
document.getElementById("sw-off-slot").innerHTML = switchHtml({ id: "sw2", label: "Locked", on: false, disabled: true, lang });
const strip = document.querySelector("[data-den-strip]");
const side = document.getElementById("side");
// The host keeps the state; the kit draws it.
window.moveFocus = false;
// A press moves the toggle itself; the host sets it only for its own
// changes (Show panel here).
function set(v, pressed) {
  window.layout = v;
  side.hidden = v === "doc";
  strip.hidden = v !== "doc";
  if (!pressed) window.fold.set(v === "panel");
}
window.fold = hydrateFoldToggle(document.querySelector("[data-den-fold]"), {
  onToggle: (next) => { calls.push(["toggle", next]); set(next ? "panel" : "doc", true); },
});
window.strip = hydrateEdgeStrip(strip, {
  onShow: () => {
    calls.push(["show"]);
    set("panel");
    if (window.moveFocus) document.getElementById("tab").focus();
  },
});
window.sw = hydrateSwitch(document.getElementById("sw"), {
  onChange: (on) => calls.push(["switch", on]),
});
window.sw2 = hydrateSwitch(document.getElementById("sw2"), {
  onChange: (on) => calls.push(["switch2", on]),
});
set("panel");
window.ready = true;
</script></body></html>`;

async function open(
  o: {
    lang?: string;
    mode?: string;
    width?: number;
    reduce?: boolean;
    touch?: boolean;
  } = {},
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: o.width ?? 1280, height: 800 },
    reducedMotion: o.reduce === false ? "no-preference" : "reduce",
    colorScheme: o.mode === "dark" ? "dark" : "light",
    locale: o.lang ?? "en",
    hasTouch: o.touch ?? false,
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        body: PAGE(o.lang ?? "en", o.mode ?? ""),
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
  await p.goto(`${ORIGIN}/`);
  await p
    .waitForFunction(
      () => (window as { ready?: boolean }).ready === true,
      null,
      { timeout: 10_000 },
    )
    .catch((e: Error) => {
      throw new Error(`page not ready: ${errors.join("; ") || e.message}`);
    });
  return p;
}

const calls = (p: Page) =>
  p.evaluate(() => (window as unknown as { calls: unknown[] }).calls);
const focused = (p: Page) =>
  p.evaluate(
    () =>
      document.activeElement?.id ||
      document.activeElement?.getAttribute("class") ||
      document.activeElement?.tagName,
  );
/** A token's computed colour, as a colour property would read it. */
const token = (p: Page, name: string) =>
  p.evaluate((n) => {
    const probe = document.createElement("i");
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
const style = (p: Page, sel: string, prop: string, pseudo?: string) =>
  p.evaluate(
    ([s, pr, ps]) =>
      getComputedStyle(
        document.querySelector(s!)!,
        ps || null,
      ).getPropertyValue(pr!),
    [sel, prop, pseudo ?? ""],
  );
const box = (p: Page, sel: string) =>
  p.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }, sel);

const FOLD = "[data-den-fold]";
const STRIP = "[data-den-strip]";
const SHOW = "[data-den-strip-show]";

describe("panel fold toggle (issue 548) in a browser", () => {
  it("a click calls onToggle(next) and moves aria-pressed; focus stays", async () => {
    if (skip()) return;
    const p = await open();
    const b = p.getByRole("button", { name: "Panel", exact: true });
    expect(await b.getAttribute("aria-pressed")).toBe("true");
    await b.click();
    expect(await calls(p)).toEqual([["toggle", false]]);
    expect(await b.getAttribute("aria-pressed")).toBe("false");
    await b.click();
    expect(await calls(p)).toEqual([
      ["toggle", false],
      ["toggle", true],
    ]);
    expect(await b.getAttribute("aria-pressed")).toBe("true");
    await p.close();
  });

  it("Enter and Space press it; focus stays on it", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus(FOLD);
    await p.keyboard.press("Enter");
    expect(await p.getAttribute(FOLD, "aria-pressed")).toBe("false");
    expect(await focused(p)).toBe("den-fold");
    await p.keyboard.press("Space");
    expect(await p.getAttribute(FOLD, "aria-pressed")).toBe("true");
    expect(await focused(p)).toBe("den-fold");
    expect(await calls(p)).toEqual([
      ["toggle", false],
      ["toggle", true],
    ]);
    await p.close();
  });

  it("set() moves it with no call; pressed() reads it", async () => {
    if (skip()) return;
    const p = await open();
    const r = await p.evaluate(() => {
      const f = (
        window as unknown as {
          fold: { set: (b: boolean) => void; pressed: () => boolean };
        }
      ).fold;
      f.set(false);
      return f.pressed();
    });
    expect(r).toBe(false);
    expect(await p.getAttribute(FOLD, "aria-pressed")).toBe("false");
    expect(await calls(p)).toEqual([]);
    await p.close();
  });

  it("destroy() stops it calling", async () => {
    if (skip()) return;
    const p = await open();
    await p.evaluate(() =>
      (window as unknown as { fold: { destroy: () => void } }).fold.destroy(),
    );
    await p.click(FOLD);
    expect(await calls(p)).toEqual([]);
    await p.close();
  });
});

describe("edge strip (issue 549) in a browser", () => {
  it("Show panel (keyboard) calls onShow; focus goes to the toggle when the host leaves it", async () => {
    if (skip()) return;
    const p = await open();
    await p.click(FOLD);
    expect(await p.isVisible(STRIP)).toBe(true);
    const show = p
      .getByRole("complementary", { name: "Panel, hidden" })
      .getByRole("button", { name: "Show panel" });
    await show.focus();
    await p.keyboard.press("Enter");
    expect(await calls(p)).toEqual([["toggle", false], ["show"]]);
    expect(await p.isVisible(STRIP)).toBe(false);
    expect(await focused(p)).toBe("den-fold");
    expect(await p.getAttribute(FOLD, "aria-pressed")).toBe("true");
    await p.close();
  });

  it("a focus the host moves itself is kept", async () => {
    if (skip()) return;
    const p = await open();
    await p.evaluate(() => {
      (window as unknown as { moveFocus: boolean }).moveFocus = true;
    });
    await p.click(FOLD);
    await p.focus(SHOW);
    await p.keyboard.press("Space");
    expect(await calls(p)).toEqual([["toggle", false], ["show"]]);
    expect(await focused(p)).toBe("tab");
    await p.close();
  });

  it("is 40px wide; the count is seen as a number and heard as words; setCount", async () => {
    if (skip()) return;
    const p = await open();
    await p.click(FOLD);
    expect((await box(p, STRIP)).w).toBe(40);
    expect(await p.textContent("[data-den-strip-n] [aria-hidden]")).toBe("2");
    expect(await p.textContent(".den-strip-sr")).toBe("2 open");
    await p.evaluate(() =>
      (
        window as unknown as { strip: { setCount: (n: number) => void } }
      ).strip.setCount(5),
    );
    expect(await p.textContent("[data-den-strip-n] [aria-hidden]")).toBe("5");
    expect(await p.textContent(".den-strip-sr")).toBe("5 open");
    await p.evaluate(() =>
      (
        window as unknown as { strip: { setCount: (n: number) => void } }
      ).strip.setCount(0),
    );
    expect(await p.locator("[data-den-strip-n]").count()).toBe(0);
    await p.close();
  });
});

describe("switch (issue 551) in a browser", () => {
  it("is a switch named by its label and described by its help", async () => {
    if (skip()) return;
    const p = await open();
    const sw = p.getByRole("switch", { name: "Show notes in the text" });
    expect(await sw.count()).toBe(1);
    expect(await sw.isChecked()).toBe(true);
    const snap = await p.locator("#side").ariaSnapshot();
    expect(snap).toContain('switch "Show notes in the text" [checked]');
    const desc = await p.evaluate(() => {
      const i = document.getElementById("sw")!;
      return document.getElementById(i.getAttribute("aria-describedby")!)!
        .textContent;
    });
    expect(desc).toBe("Kept on this device.");
    await p.close();
  });

  it("Space, Enter and a click on its words call onChange(on)", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus("#sw");
    await p.keyboard.press("Space");
    await p.keyboard.press("Enter");
    await p.click(".den-switch-label >> nth=0");
    expect(await calls(p)).toEqual([
      ["switch", false],
      ["switch", true],
      ["switch", false],
    ]);
    expect(await p.isChecked("#sw")).toBe(false);
    expect(await focused(p)).toBe("sw");
    await p.close();
  });

  it("set() moves it with no call; disabled is out of the tab order and calls nothing", async () => {
    if (skip()) return;
    const p = await open();
    await p.evaluate(() =>
      (window as unknown as { sw: { set: (b: boolean) => void } }).sw.set(
        false,
      ),
    );
    expect(await p.isChecked("#sw")).toBe(false);
    await p.click("label[for=sw2]", { force: true });
    expect(await calls(p)).toEqual([]);
    await p.focus("#sw");
    await p.keyboard.press("Tab");
    expect(await focused(p)).not.toBe("sw2");
    await p.evaluate(() =>
      (
        window as unknown as { sw2: { setDisabled: (b: boolean) => void } }
      ).sw2.setDisabled(false),
    );
    await p.focus("#sw2");
    await p.keyboard.press("Space");
    expect(await calls(p)).toEqual([["switch2", true]]);
    await p.close();
  });

  it("the knob moves over --dur-fast, and not under reduced motion", async () => {
    if (skip()) return;
    const moving = await open({ reduce: false });
    expect(
      await style(moving, "#sw", "transition-duration", "::after"),
    ).not.toBe("0s");
    await moving.close();
    const still = await open({ reduce: true });
    expect(await style(still, "#sw", "transition-duration", "::after")).toBe(
      "0s",
    );
    await still.close();
  });
});

describe("the look: 1280 and 390, light and dark", () => {
  for (const width of [1280, 390])
    for (const mode of ["light", "dark"])
      it(`${width} ${mode}: colours from the tokens; focus rings; sizes`, async () => {
        if (skip()) return;
        const p = await open({ width, mode, touch: width === 390 });
        // The toggle, pressed: sunken, the strong border, the text colour.
        expect(await style(p, FOLD, "background-color")).toBe(
          await token(p, "--sunken"),
        );
        expect(await style(p, FOLD, "border-top-color")).toBe(
          await token(p, "--border-strong"),
        );
        expect(await style(p, FOLD, "color")).toBe(await token(p, "--text"));
        await p.click(FOLD);
        // Off the button (a hover is the strong border).
        await p.mouse.move(width - 2, 790);
        // Not pressed: no fill, the quiet border.
        expect(await style(p, FOLD, "background-color")).toBe(
          "rgba(0, 0, 0, 0)",
        );
        expect(await style(p, FOLD, "border-top-color")).toBe(
          await token(p, "--border"),
        );
        // The strip: surface, border; the count in the accent's text colour.
        expect(await style(p, STRIP, "background-color")).toBe(
          await token(p, "--surface"),
        );
        expect(await style(p, ".den-strip-n", "color")).toBe(
          await token(p, "--accent-text"),
        );
        expect((await box(p, STRIP)).w).toBe(40);
        // Focus rings: 2px of the accent.
        await p.focus(SHOW);
        await p.keyboard.press("Shift+Tab");
        await p.keyboard.press("Tab");
        expect(await style(p, SHOW, "outline-color")).toBe(
          await token(p, "--accent"),
        );
        expect(await style(p, SHOW, "outline-width")).toBe("2px");
        await p.keyboard.press("Enter");
        // The switch: on is the accent fill, off the strong border.
        expect(await style(p, "#sw", "background-color")).toBe(
          await token(p, "--accent-fill"),
        );
        expect(await style(p, "#sw2", "background-color")).toBe(
          await token(p, "--border"),
        );
        await p.evaluate(() =>
          (window as unknown as { sw: { set: (b: boolean) => void } }).sw.set(
            false,
          ),
        );
        expect(await style(p, "#sw", "background-color")).toBe(
          await token(p, "--border-strong"),
        );
        expect(await style(p, "#sw", "background-color", "::after")).toBe(
          await token(p, "--surface"),
        );
        await p.focus("#sw");
        await p.keyboard.press("Shift+Tab");
        await p.keyboard.press("Tab");
        expect(await style(p, "#sw", "outline-color")).toBe(
          await token(p, "--accent"),
        );
        // Sizes: 44px targets on a phone; the desktop's own sizes else.
        const fold = await box(p, FOLD);
        const sw = await box(p, ".den-switch");
        expect(sw.h).toBeGreaterThanOrEqual(44);
        if (width === 390) {
          expect(fold.h).toBeGreaterThanOrEqual(44);
          await p.click(FOLD);
          const hit = await p.evaluate(() => {
            const s = getComputedStyle(
              document.querySelector("[data-den-strip-show]")!,
              "::after",
            );
            return [parseFloat(s.minWidth), parseFloat(s.minHeight)];
          });
          expect(hit).toEqual([44, 44]);
        } else {
          expect(fold.h).toBe(32);
          await p.click(FOLD);
          expect(await box(p, SHOW)).toEqual({ w: 32, h: 32 });
        }
        // No sideways scroll.
        expect(
          await p.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await p.close();
      });
});

describe("words in es and ja", () => {
  const W: Record<string, [string, string, string, string]> = {
    es: ["Panel", "Panel, oculto", "Mostrar panel", "2 abiertos"],
    ja: ["パネル", "パネル（非表示）", "パネルを表示", "2 件開いています"],
  };
  for (const [lang, [panel, hidden, show, n]] of Object.entries(W))
    it(lang, async () => {
      if (skip()) return;
      const p = await open({ lang });
      expect(
        await p.getByRole("button", { name: panel, exact: true }).count(),
      ).toBe(1);
      await p.click(FOLD);
      expect(
        await p
          .getByRole("complementary", { name: hidden })
          .getByRole("button", { name: show })
          .count(),
      ).toBe(1);
      expect(await p.textContent(".den-strip-sr")).toBe(n);
      await p.close();
    });
});
