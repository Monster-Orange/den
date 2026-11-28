/**
 * den-ui 0.7.5: the kit's Markdown editor in a browser, with no product
 * around it: a bare page loads tokens.css, markdown-editor.css and
 * markdown-editor.js, which loads CodeMirror from an import map (the
 * packages in node_modules, as a consumer's bundler would split them).
 *
 *   - typing goes in as Markdown, byte for byte, and the preview is drawn
 *     in place: markers hidden on lines being read, shown on the line
 *     being edited, no preview pane, no HTML;
 *   - Enter continues a list; the toolbar and ⌘B format the selection;
 *   - IME: an Enter while composing, and Safari's confirming Enter just
 *     after compositionend, never send; a later Enter does;
 *   - until CodeMirror arrives a plain textarea takes the typing, and the
 *     editor goes on from its text, caret and selection; its toolbar works;
 *   - setValue from outside never calls onChange; destroy takes it away;
 *   - touch sizes: 44px buttons and 16px text on a narrow screen;
 *   - ja words, and a strict CSP with a nonce: no violation.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const ROOT = path.join(__dirname, "../../..");
const SRC = path.join(ROOT, "packages/den-ui/src");
const NM = path.join(ROOT, "node_modules");
const ORIGIN = "http://kit.test";
const NONCE = "n0nce";
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

/** Each package CodeMirror needs, at its ES module entry in node_modules. */
function importMap(): Record<string, string> {
  const map: Record<string, string> = {};
  const scopes = ["@codemirror", "@lezer", "@marijn"];
  const names = [
    ...scopes.flatMap((s) =>
      fs.readdirSync(path.join(NM, s)).map((n) => `${s}/${n}`),
    ),
    "style-mod",
    "w3c-keyname",
    "crelt",
  ];
  for (const n of names) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(NM, n, "package.json"), "utf-8"),
    ) as { exports?: unknown; module?: string; main?: string };
    const e = pkg.exports as
      | { ".": { import?: string } | string; import?: string }
      | string
      | undefined;
    const entry =
      (typeof e === "object" && typeof e["."] === "object"
        ? e["."].import
        : typeof e === "object" && typeof e["."] === "string"
          ? e["."]
          : typeof e === "object"
            ? e.import
            : e) ??
      pkg.module ??
      pkg.main!;
    map[n] = `/nm/${n}/${entry.replace(/^\.\//, "")}`;
  }
  return map;
}

const PAGE = (lang: string, style = "") => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script type="importmap" nonce="${NONCE}">${JSON.stringify({ imports: importMap() })}</script>
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/markdown-editor.css">${style ? `<style nonce="${NONCE}">${style}</style>` : ""}</head>
<body><button id="away">Away</button><div id="host"></div>
<script type="module" src="/page.js" nonce="${NONCE}"></script></body></html>`;

const PAGE_JS = `import * as md from "/markdown-editor.js";
window.seen = { changes: [], submits: 0, escapes: 0, blurs: 0 };
window.mount = (opts) => {
  window.ed = md.mountMarkdownEditor(document.getElementById("host"), {
    value: "",
    onChange: (v) => window.seen.changes.push(v),
    onSubmit: () => { window.seen.submits++; },
    onEscape: () => { window.seen.escapes++; },
    onBlur: () => { window.seen.blurs++; },
    ...opts,
  });
  return true;
};
window.ready = true;`;

interface Opened {
  p: Page;
  release: () => void;
  bad: string[];
}

/** A page; `hold` keeps CodeMirror's view module back until release(). */
async function open(
  o: {
    lang?: string;
    hold?: boolean;
    csp?: boolean;
    width?: number;
    style?: string;
  } = {},
): Promise<Opened> {
  const ctx = await browser!.newContext({
    viewport: { width: o.width ?? 1000, height: 700 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  const bad: string[] = [];
  await p.exposeFunction("cspBad", (s: string) => bad.push(s));
  await p.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { cspBad: (s: string) => void }).cspBad(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  let release: () => void = () => undefined;
  const held = o.hold
    ? new Promise<void>((r) => {
        release = r;
      })
    : Promise.resolve();
  const headers: Record<string, string> = o.csp
    ? {
        "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${NONCE}'; style-src 'self' 'nonce-${NONCE}'`,
      }
    : {};
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        headers,
        body: PAGE(o.lang ?? "en", o.style),
      });
    if (u.pathname === "/page.js")
      return r.fulfill({
        contentType: "text/javascript",
        headers,
        body: PAGE_JS,
      });
    if (/^\/[\w-]+\.(js|css)$/.test(u.pathname)) {
      const f = path.join(SRC, u.pathname.slice(1));
      if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: "" });
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        headers,
        body: fs.readFileSync(f, "utf-8"),
      });
    }
    if (u.pathname.startsWith("/nm/")) {
      if (u.pathname.startsWith("/nm/@codemirror/view/")) await held;
      const f = path.join(NM, decodeURIComponent(u.pathname.slice(4)));
      if (!f.startsWith(NM + path.sep) || !fs.existsSync(f))
        return r.fulfill({ status: 404, body: "" });
      return r.fulfill({
        contentType: "text/javascript",
        headers,
        body: fs.readFileSync(f, "utf-8"),
      });
    }
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(() => (window as { ready?: boolean }).ready === true);
  return { p, release, bad };
}

const mount = (p: Page, opts: Record<string, unknown> = {}) =>
  p.evaluate(
    (o) => (window as unknown as { mount: (o: unknown) => boolean }).mount(o),
    opts,
  );
const ready = (p: Page) =>
  p.evaluate(
    () => (window as unknown as { ed: { ready: Promise<void> } }).ed.ready,
  );
const value = (p: Page) =>
  p.evaluate(() =>
    (window as unknown as { ed: { getValue(): string } }).ed.getValue(),
  );
const seen = (p: Page) =>
  p.evaluate(
    () =>
      (
        window as unknown as {
          seen: {
            changes: string[];
            submits: number;
            escapes: number;
            blurs: number;
          };
        }
      ).seen,
  );
const content = (p: Page) => p.locator("#host .cm-content");

describe("den-ui Markdown editor in a browser", () => {
  it("typing goes in as Markdown, byte for byte, and the preview is drawn in place", async () => {
    if (skip()) return;
    const { p } = await open();
    await mount(p, { label: "Notes" });
    await ready(p);
    await content(p).click();
    await p.keyboard.type("Hello **world** and `code`");
    const typed = "Hello **world** and `code`";
    expect(await value(p)).toBe(typed);
    expect((await seen(p)).changes.at(-1)).toBe(typed);
    // The line being edited shows its markers, muted.
    expect(await p.locator("#host .md-marker").allTextContents()).toEqual([
      "**",
      "**",
      "`",
      "`",
    ]);
    // Read (focus elsewhere): the markers hide; the words are formatted.
    await p.locator("#away").click();
    // CodeMirror reports a focus change on its own timer (10 ms): wait for
    // the redraw it brings, not for a time.
    await p.waitForFunction(() => !document.querySelector("#host .md-marker"));
    expect(await content(p).innerText()).toBe("Hello world and code");
    expect(await p.locator("#host .md-strong").innerText()).toBe("world");
    expect(await p.locator("#host .md-code").innerText()).toBe("code");
    // One text, no preview pane and no HTML made from it.
    expect(await p.locator("#host strong, #host b, #host code").count()).toBe(
      0,
    );
    expect(await p.locator("#host .cm-content").count()).toBe(1);
    expect(await value(p)).toBe(typed);
    expect(await content(p).getAttribute("aria-label")).toBe("Notes");
    expect(await content(p).getAttribute("role")).toBe("textbox");
    expect((await seen(p)).blurs).toBe(1);
    await p.context().close();
  }, 60_000);

  it("Enter continues a list; the toolbar and the shortcut format the selection", async () => {
    if (skip()) return;
    const { p } = await open();
    await mount(p);
    await ready(p);
    await content(p).click();
    await p.keyboard.type("- one");
    await p.keyboard.press("Enter");
    await p.keyboard.type("two");
    expect(await value(p)).toBe("- one\n- two");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
    expect(await value(p)).toBe("- one\n- two\n");
    await p.keyboard.type("hello world");
    for (let i = 0; i < 5; i++) await p.keyboard.press("Shift+ArrowLeft");
    await p.getByRole("button", { name: /^Bold/ }).click();
    expect(await value(p)).toBe("- one\n- two\nhello **world**");
    await p.keyboard.press("ControlOrMeta+b");
    expect(await value(p)).toBe("- one\n- two\nhello world");
    await p.keyboard.press("ControlOrMeta+Enter");
    expect((await seen(p)).submits).toBe(1);
    await p.keyboard.press("Escape");
    expect((await seen(p)).escapes).toBe(1);
    await p.context().close();
  }, 60_000);

  it("IME: an Enter while composing, or just after it ends, never sends; a later Enter does", async () => {
    if (skip()) return;
    const { p } = await open({ lang: "ja" });
    await mount(p, { mode: "lite", lang: "ja" });
    await ready(p);
    expect(await p.locator("#host [role=toolbar]").count()).toBe(0);
    await content(p).click();
    // When the composition ended, as the editor sees it.
    await p.evaluate(() =>
      window.addEventListener(
        "compositionend",
        () => ((window as unknown as { ended?: number }).ended = Date.now()),
        true,
      ),
    );
    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Input.imeSetComposition", {
      text: "かんじ",
      selectionStart: 3,
      selectionEnd: 3,
    });
    // An Enter the IME owns (keyCode 229) while the composition is open.
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 229,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 229,
    });
    // Confirm the conversion, then Safari's order: a plain Enter just
    // after compositionend.
    await cdp.send("Input.insertText", { text: "漢字" });
    await p.keyboard.press("Enter");
    expect((await seen(p)).submits).toBe(0);
    expect(await value(p)).toBe("漢字");
    // Past the editor's grace after compositionend (its own constant): an
    // Enter from here on is the person's, not the IME's.
    const grace = (await p.evaluate(
      'import("/markdown-editor.js").then((m) => m.COMPOSITION_GRACE_MS)',
    )) as number;
    await p.waitForFunction(
      (ms) =>
        Date.now() - ((window as unknown as { ended?: number }).ended ?? 0) >
        ms,
      grace,
    );
    await p.keyboard.press("Shift+Enter");
    await p.keyboard.type("x");
    expect(await value(p)).toBe("漢字\nx");
    await p.keyboard.press("Enter");
    expect((await seen(p)).submits).toBe(1);
    expect(await value(p)).toBe("漢字\nx");
    await p.context().close();
  }, 60_000);

  it("words typed before the editor arrives survive the swap, and the caret goes on after them", async () => {
    if (skip()) return;
    const { p, release } = await open({ hold: true });
    await mount(p);
    const standIn = p.locator("#host textarea.md-fallback");
    await standIn.click();
    await p.keyboard.type("Typed before the editor arrived.");
    expect(await standIn.inputValue()).toBe("Typed before the editor arrived.");
    expect((await seen(p)).changes.at(-1)).toBe(
      "Typed before the editor arrived.",
    );
    release();
    await ready(p);
    expect(await standIn.count()).toBe(0);
    await p.keyboard.type(" And after.");
    expect(await value(p)).toBe("Typed before the editor arrived. And after.");
    await p.context().close();
  }, 60_000);

  it("a selection in the stand-in goes over to the editor whole: typing replaces it", async () => {
    if (skip()) return;
    const { p, release } = await open({ hold: true });
    await mount(p, { mode: "lite" });
    const standIn = p.locator("#host textarea.md-fallback");
    await standIn.click();
    await p.keyboard.type("Old words.");
    // The stand-in follows the same Enter rule: an IME's Enter never sends.
    await standIn.dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
    expect((await seen(p)).submits).toBe(0);
    await p.keyboard.press("ControlOrMeta+a");
    release();
    await ready(p);
    await p.keyboard.type("New words.");
    expect(await value(p)).toBe("New words.");
    await p.context().close();
  }, 60_000);

  it("the toolbar works on the stand-in too, before CodeMirror arrives", async () => {
    if (skip()) return;
    const { p, release } = await open({ hold: true });
    await mount(p, { value: "hi there" });
    const standIn = p.locator("#host textarea.md-fallback");
    await standIn.click();
    await p.keyboard.press("ControlOrMeta+a");
    await p.getByRole("button", { name: /^Italic/ }).click();
    expect(await standIn.inputValue()).toBe("*hi there*");
    expect((await seen(p)).changes.at(-1)).toBe("*hi there*");
    release();
    await ready(p);
    expect(await value(p)).toBe("*hi there*");
    await p.context().close();
  }, 60_000);

  it("setValue from outside never calls onChange; destroy takes the editor away", async () => {
    if (skip()) return;
    const { p, release } = await open({ hold: true });
    await mount(p, { value: "a" });
    await p.evaluate(() =>
      (window as unknown as { ed: { setValue(v: string): void } }).ed.setValue(
        "b",
      ),
    );
    expect(await p.locator("#host textarea.md-fallback").inputValue()).toBe(
      "b",
    );
    release();
    await ready(p);
    await p.evaluate(() =>
      (window as unknown as { ed: { setValue(v: string): void } }).ed.setValue(
        "**c**",
      ),
    );
    expect(await value(p)).toBe("**c**");
    expect(await content(p).innerText()).toBe("c");
    expect((await seen(p)).changes).toEqual([]);
    await p.evaluate(() =>
      (window as unknown as { ed: { destroy(): void } }).ed.destroy(),
    );
    expect(await p.locator("#host *").count()).toBe(0);
    await p.context().close();
  }, 60_000);

  it("touch sizes: 44px toolbar buttons and 16px text on a narrow screen; desktop keeps 28px and 15px", async () => {
    if (skip()) return;
    const sizes = async (width: number) => {
      const { p, release } = await open({ width, hold: true });
      await mount(p);
      const tool = p
        .locator("#host [role=toolbar]")
        .getByRole("button", { name: /^Bold/ });
      const box = await tool.boundingBox();
      const standIn = await p
        .locator("#host textarea.md-fallback")
        .evaluate((e) => getComputedStyle(e).fontSize);
      release();
      await ready(p);
      const editor = await content(p).evaluate(
        (e) => getComputedStyle(e).fontSize,
      );
      await p.context().close();
      return { w: box!.width, h: box!.height, standIn, editor };
    };
    expect(await sizes(390)).toEqual({
      w: 44,
      h: 44,
      standIn: "16px",
      editor: "16px",
    });
    expect(await sizes(1000)).toEqual({
      w: 28,
      h: 28,
      standIn: "15px",
      editor: "15px",
    });
  }, 60_000);

  it("a host sizes the editor with variables on an ancestor: min and max height, filling its column, font", async () => {
    if (skip()) return;
    const measure = async (style: string) => {
      const { p, release } = await open({ hold: true, style });
      await mount(p, { rows: 3 });
      const box = p.locator("#host [data-markdown-field]");
      const text = box.getByRole("textbox");
      const standIn = await text.evaluate((e) => {
        const c = getComputedStyle(e);
        return {
          h: Math.round(e.getBoundingClientRect().height),
          font: `${c.fontSize} ${c.lineHeight}`,
        };
      });
      release();
      await ready(p);
      const fieldH = await box.evaluate((f) =>
        Math.round(f.getBoundingClientRect().height),
      );
      const after = await text.evaluate((content) => {
        const scroller = content.parentElement!;
        const editor = scroller.parentElement!;
        const field = editor.closest("[data-markdown-field]")!;
        const c = getComputedStyle(content);
        return {
          editorToBottom: Math.round(
            field.getBoundingClientRect().bottom -
              editor.getBoundingClientRect().bottom,
          ),
          scrollerMax: getComputedStyle(scroller).maxHeight,
          font: `${c.fontSize} ${c.lineHeight}`,
        };
      });
      await p.context().close();
      return { standIn, field: fieldH, ...after };
    };
    const tall = await measure(
      "#host { --md-editor-min-height: 420px; --md-editor-max-height: none; }",
    );
    expect(tall.standIn.h).toBe(420);
    expect(tall.field).toBeGreaterThanOrEqual(420);
    expect(tall.scrollerMax).toBe("none");
    const fill = await measure(
      "#host { display: flex; flex-direction: column; height: 600px; --md-editor-grow: 1; }",
    );
    expect(fill.field).toBe(600);
    expect(fill.editorToBottom).toBeLessThanOrEqual(1);
    const font = await measure(
      "#host { --md-font-size: 14px; --md-line-height: 1.6; }",
    );
    expect(font.standIn.font).toBe("14px 22.4px");
    expect(font.font).toBe("14px 22.4px");
  }, 60_000);

  it("speaks the page's language, and runs under a strict CSP with a nonce", async () => {
    if (skip()) return;
    const { p, bad } = await open({ lang: "ja", csp: true });
    await mount(p, { nonce: NONCE, placeholder: "ここに書く" });
    await ready(p);
    expect(
      await p.locator("#host [role=toolbar]").getAttribute("aria-label"),
    ).toBe("書式");
    expect(
      await p
        .locator("#host [role=toolbar]")
        .getByRole("button", { name: /^太字/ })
        .getAttribute("aria-label"),
    ).toMatch(/^太字（(⌘|Ctrl\+)B）$/);
    // CodeMirror's own styles are in (its nonce'd <style>).
    expect(
      await p
        .locator("#host .cm-editor")
        .evaluate((e) => getComputedStyle(e).display),
    ).toBe("flex");
    expect(await p.locator("#host .cm-placeholder").innerText()).toBe(
      "ここに書く",
    );
    expect(bad).toEqual([]);
    await p.context().close();
  }, 60_000);
});
