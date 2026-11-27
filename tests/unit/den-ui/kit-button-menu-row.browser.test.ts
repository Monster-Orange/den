/**
 * den-ui, issues 554, 555 and 556: three pieces, in a browser, on a bare page built from the
 * kit's own files (Chromium, headless; the page's clock is faked):
 *
 * 1. The general button (issue 556): `.den-btn` from button.css, outside
 *    any frame. Secondary, primary and small, disabled and a link look
 *    exactly as Den's own rules drew them before the move (DEN_RULES
 *    below, copied from Den's frame script), in light and dark; a visible
 *    focus ring; a 44px tap on a phone, the look unchanged.
 * 2. The settings on/off row (issue 554): Space ticks it; Save calls the
 *    host's onSave with the box's state; "Saving…" past 400 ms, then
 *    "Saved" or the error, said politely; focus stays on Save; a change
 *    after Saved clears it. Read-only: nothing to press. Light and dark
 *    at 1280 and 390, AA text, 44px targets at 390, no sideways scroll.
 * 3. The page action menu (issue 555): More ▾ opens on Enter, ↓ or ↑;
 *    ↑ ↓ Home End move through every item, a disabled one too (it says
 *    why); a disabled item does nothing; a pick calls onSelect and closes;
 *    Esc closes; focus goes back to More. Light and dark at 1280 and 390,
 *    44px rows at 390, the menu kept in the window.
 * 4. The kit's own menus (◐ ▾) look as they did before menuRowHtml was
 *    exported: every row's computed style and height, light and dark,
 *    against fixtures/kit-menu-popovers.json (taken from the kit before
 *    the export, with DEN_UI_CAPTURE_MENU=1).
 *
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 *
 * @visual-reference tests/unit/den-ui/fixtures/visual-env.json
 * (issue 1527): it compares against stored references, so the gate runs it
 * only on a box whose browser matches that record of where they were taken.
 * Its capture writes the record.
 */
import { visualOff } from "../helpers/visual-guard.js";
import {
  visualEnvOf,
  writeVisualEnv,
} from "../../../src/shared/gates/visual.js";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const POPOVERS = path.join(__dirname, "fixtures", "kit-menu-popovers.json");
const CAPTURE = process.env.DEN_UI_CAPTURE_MENU === "1";
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
const VISUAL_RECORD = "tests/unit/den-ui/fixtures/visual-env.json";

/**
 * Den's own button rules, as its frame script drew them before the kit had
 * a general button, with issue 673's: the second product's shipped button
 * (its words and icon in a row, 6px apart; its danger).
 */
const DEN_RULES = `
.den-btn { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-button);
  padding: 6px 12px; cursor: pointer; font: inherit; font-weight: 500; white-space: nowrap; color: var(--text);
  text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.den-btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); }
.den-btn:hover { border-color: var(--border-strong); }
.den-btn.primary { background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-accent); }
.den-btn.sm { padding: 2px 9px; font-size: 12.5px; }
.den-btn:disabled { opacity: .6; cursor: default; }
a.den-btn, a.den-pvisit { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
`;

const BUTTONS = `<style>#btns > * { margin: 24px; }</style><div id="btns">
<button type="button" class="den-btn" id="b-sec">Secondary</button>
<button type="button" class="den-btn primary" id="b-pri">Primary</button>
<button type="button" class="den-btn sm" id="b-sm">Small</button>
<button type="button" class="den-btn sm primary" id="b-smp">Small primary</button>
<button type="button" class="den-btn" id="b-dis" disabled>Disabled</button>
<button type="button" class="den-btn danger" id="b-dan">Danger</button>
<a class="den-btn" id="b-link" href="#x">Link</a>
<a class="den-btn sm" id="b-linksm" href="#x">Small link</a>
</div>`;

type Look = "kit" | "den" | "pieces" | "pop";

function pageHtml(look: Look, lang: string, mode: string): string {
  const head =
    `<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/fonts.css">` +
    `<link rel="stylesheet" href="/base.css">` +
    (look === "den"
      ? `<style>${DEN_RULES}</style>`
      : `<link rel="stylesheet" href="/button.css">`) +
    (look === "pieces" || look === "pop"
      ? `<link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/savestate.css">` +
        `<link rel="stylesheet" href="/setting-row.css">`
      : "");
  const body =
    look === "pieces"
      ? `<style>body { background: var(--bg); } #rowbox { background: var(--surface); padding: 12px; }</style>
<main id="main"><h1>Doc</h1><div id="acts"></div><section id="rowbox"></section>
<section id="robox"></section></main>
<script type="module">
import { pageMenuButtonHtml } from "/shell-html.js";
import { hydratePageMenu } from "/shell-client.js";
import { mountSettingRow } from "/setting-row.js";
import { addStrings } from "/strings.js";
addStrings("en", { "app.copy": "Copy link" });
window.picked = [];
window.saves = [];
window.plan = { ms: 10, ok: true };
document.getElementById("acts").innerHTML = pageMenuButtonHtml({ id: "more", lang: "${lang}" });
window.menu = hydratePageMenu(document.getElementById("more"), {
  lang: "${lang}",
  items: [
    { id: "edit", label: "Edit", onSelect: () => picked.push("edit:own") },
    { id: "copy", label: { key: "app.copy" } },
    { hr: true },
    { id: "dl", label: "Download v3 (.md)", disabled: true,
      note: "Downloads are off here. An admin can turn them on in Settings.",
      noteHref: "#settings" },
    { id: "pause", label: "Pause…", disabled: true, note: "Only an owner can pause it." },
    { id: "end", label: "Won't do…" },
  ],
  onSelect: (id) => picked.push(id),
});
window.row = mountSettingRow(document.getElementById("rowbox"), {
  id: "downloads", lang: "${lang}",
  label: "Owners can download",
  help: "Owners of a doc can download it from More. Each download is in its history.",
  checked: true, who: ["Admins", "Owners"],
  last: { by: "@sam", at: "2026-11-18T10:40:00Z" },
  onSave: (checked) => {
    saves.push(checked);
    const p = window.plan;
    return new Promise((res, rej) => setTimeout(() => (p.ok ? res() : rej(new Error("down"))), p.ms));
  },
});
window.ro = mountSettingRow(document.getElementById("robox"), {
  id: "ro", lang: "${lang}", label: "Read only", checked: false, who: [], last: null,
  readOnly: true, onSave: () => { saves.push("ro"); return Promise.resolve(); },
});
window.ready = true;
</script>`
      : look === "pop"
        ? `<main><button id="ap" type="button">◐</button></main>
<script type="module">
import { hydrateAppearance } from "/shell-client.js";
hydrateAppearance(document.getElementById("ap"), {
  lang: "es",
  menu: () => ({
    mode: "dark",
    themes: [{ value: "den", label: "Den", selected: true }, { value: "x", label: "Other" }],
    notice: "A note",
    languages: [{ id: "en", name: "English", current: true }, { id: "ja", name: "日本語" }],
    items: [{ label: "Settings", href: "#s" }, { label: "Help", id: "help" }],
  }),
  onPick: () => {},
});
window.ready = true;
</script>`
        : `${BUTTONS}<script type="module">window.ready = true;</script>`;
  return `<!doctype html>
<html lang="${lang}"${mode ? ` data-mode="${mode}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${head}</head>
<body>${body}</body></html>`;
}

async function open(
  o: {
    look?: Look;
    lang?: string;
    mode?: string;
    width?: number;
    touch?: boolean;
  } = {},
): Promise<Page> {
  const width = o.width ?? 1280;
  const ctx = await browser!.newContext({
    viewport: { width, height: width < 500 ? 844 : 900 },
    reducedMotion: "reduce",
    colorScheme: o.mode === "dark" ? "dark" : "light",
    timezoneId: "UTC",
    locale: o.lang ?? "en",
    hasTouch: !!o.touch,
    isMobile: !!o.touch,
  });
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date("2026-11-18T10:42:00Z") });
  await p.clock.pauseAt(new Date("2026-11-18T10:42:00Z"));
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        body: pageHtml(o.look ?? "pieces", o.lang ?? "en", o.mode ?? ""),
      });
    const f = u.pathname.slice(1);
    if (
      /^(fonts\/)?[a-z0-9-]+\.(js|css|woff2)$/.test(f) &&
      fs.existsSync(path.join(SRC, f))
    )
      return r.fulfill({
        contentType: f.endsWith(".css")
          ? "text/css"
          : f.endsWith(".woff2")
            ? "font/woff2"
            : "text/javascript",
        body: fs.readFileSync(path.join(SRC, f)),
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
      {
        timeout: 10_000,
      },
    )
    .catch((e: Error) => {
      throw new Error(`page not ready: ${errors.join("; ") || e.message}`);
    });
  await p.evaluate(() => document.fonts.ready);
  return p;
}

const PROPS = [
  "display",
  "box-sizing",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "border-left-color",
  "border-top-left-radius",
  "background-color",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "white-space",
  "text-decoration-line",
  "cursor",
  "opacity",
  "align-items",
  "justify-content",
  "position",
];

/** Each element's computed PROPS and its height, by a key. */
function styles(p: Page, sel: string, props = PROPS) {
  return p.evaluate(
    ([s, ps]) =>
      Array.from(document.querySelectorAll<HTMLElement>(s)).map((el) => {
        const cs = getComputedStyle(el);
        const o: Record<string, string> = {
          key:
            el.id ||
            `${el.tagName.toLowerCase()}.${el.className}${el.getAttribute("data-kind") ? `:${el.getAttribute("data-kind")}` : ""}${el.getAttribute("data-value") ? `=${el.getAttribute("data-value")}` : ""}`,
          height: `${Math.round(el.getBoundingClientRect().height * 10) / 10}`,
        };
        for (const k of ps as string[]) o[k] = cs.getPropertyValue(k);
        return o;
      }),
    [sel, props] as const,
  );
}

/** WCAG contrast of an element's text on the first opaque background under it. */
function contrastOf(p: Page, sel: string) {
  return p.evaluate((s) => {
    const rgb = (c: string) =>
      (c.match(/[\d.]+/g) || []).slice(0, 4).map(Number) as number[];
    const lum = ([r, g, b]: number[]) => {
      const ch = (x: number) => {
        const v = x / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r!) + 0.7152 * ch(g!) + 0.0722 * ch(b!);
    };
    const el = document.querySelector<HTMLElement>(s)!;
    let bg: number[] | null = null;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length === 3 || (c.length === 4 && c[3] === 1)) {
        bg = c;
        break;
      }
    }
    bg = bg || rgb(getComputedStyle(document.body).backgroundColor);
    const fg = rgb(getComputedStyle(el).color);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100;
  }, sel);
}

const noSideways = (p: Page) =>
  p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// ── 1. the general button ────────────────────────────────────────────────

describe("the general button (button.css)", () => {
  it.each(["light", "dark"])(
    "looks as Den's own rules drew it, every variant (%s)",
    async (mode) => {
      if (skip()) return;
      const den = await open({ look: "den", mode });
      const kit = await open({ look: "kit", mode });
      const want = await styles(den, ".den-btn");
      const have = await styles(kit, ".den-btn");
      // Issue 673: danger is the eighth.
      expect(want.length).toBe(8);
      expect(have).toEqual(want);
      // Hover, too.
      for (const p of [den, kit]) await p.hover("#b-sec");
      expect(await styles(kit, "#b-sec")).toEqual(await styles(den, "#b-sec"));
      // Primary is the accent fill, secondary the surface: not one look.
      const [sec, pri] = [have[0]!, have[1]!];
      expect(pri["background-color"]).not.toBe(sec["background-color"]);
      await den.context().close();
      await kit.context().close();
    },
  );

  it("a visible focus ring from the keyboard", async () => {
    if (skip()) return;
    const p = await open({ look: "kit" });
    await p.keyboard.press("Tab");
    const f = await p.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cs = getComputedStyle(el);
      const probe = document.createElement("i");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return {
        id: el.id,
        ring: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineOffset}`,
        color: cs.outlineColor === accent,
      };
    });
    expect(f).toEqual({ id: "b-sec", ring: "solid 2px 2px", color: true });
    await p.context().close();
  });

  it("a 44px tap on a phone, its box unchanged", async () => {
    if (skip()) return;
    const desk = await open({ look: "kit", width: 390 });
    const phone = await open({ look: "kit", width: 390, touch: true });
    const box = (p: Page) =>
      p.evaluate(() => {
        const r = document.getElementById("b-sm")!.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
    expect(await box(phone)).toEqual(await box(desk));
    const tap = await phone.evaluate(() => {
      const b = document.getElementById("b-sm")!;
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = (x: number, y: number) =>
        b.contains(document.elementFromPoint(x, y));
      return {
        h: r.height < 44,
        up: hit(cx, cy - 21),
        down: hit(cx, cy + 21),
        after: getComputedStyle(b, "::after").minHeight,
      };
    });
    expect(tap).toEqual({ h: true, up: true, down: true, after: "44px" });
    await desk.context().close();
    await phone.context().close();
  });
});

// ── 2. the settings on/off row ───────────────────────────────────────────

const rowState = (p: Page) =>
  p.evaluate(() => {
    const s = document.getElementById("downloads-state")!;
    return `${s.getAttribute("data-state")}|${s.textContent}`;
  });
const saves = (p: Page) =>
  p.evaluate(() => (window as unknown as { saves: unknown[] }).saves);

describe("the settings on/off row (setting-row.js)", () => {
  it("Space ticks it; Save calls onSave with its state; Saved; focus stays on Save", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus("#downloads-cb");
    await p.keyboard.press("Space");
    expect(await p.isChecked("#downloads-cb")).toBe(false);
    await p.keyboard.press("Tab");
    expect(
      await p.evaluate(() =>
        document.activeElement!.hasAttribute("data-den-setrow-save"),
      ),
    ).toBe(true);
    await p.keyboard.press("Enter");
    expect(await saves(p)).toEqual([false]);
    // A quick save never shows Saving….
    expect(await rowState(p)).toBe("idle|");
    await p.clock.runFor(20);
    expect(await rowState(p)).toBe("saved|Saved");
    expect(
      await p.evaluate(() =>
        document.activeElement!.hasAttribute("data-den-setrow-save"),
      ),
    ).toBe(true);
    // A change after Saved clears it.
    await p.click("#downloads-cb");
    expect(await rowState(p)).toBe("idle|");
    await p.context().close();
  });

  it("Saving… past 400 ms, a second press waits; then the error, said politely", async () => {
    if (skip()) return;
    const p = await open();
    await p.evaluate(() => {
      (window as unknown as { plan: object }).plan = { ms: 1000, ok: false };
    });
    await p.click("[data-den-setrow-save]");
    await p.clock.runFor(390);
    expect(await rowState(p)).toBe("idle|");
    await p.clock.runFor(20);
    expect(await rowState(p)).toBe("saving|Saving…");
    // Busy: Save says so, and a second press does nothing.
    expect(
      await p.getAttribute("[data-den-setrow-save]", "aria-disabled"),
    ).toBe("true");
    // (force: Playwright won't press what says it is disabled.)
    await p.click("[data-den-setrow-save]", { force: true });
    expect(await saves(p)).toEqual([true]);
    await p.clock.runFor(700);
    expect(await rowState(p)).toBe("error|Not saved. Try again.");
    expect(
      await p.getAttribute("[data-den-setrow-save]", "aria-disabled"),
    ).toBe(null);
    const live = await p.evaluate(() => {
      const s = document.getElementById("downloads-state")!;
      return `${s.getAttribute("role")}|${s.getAttribute("aria-live")}`;
    });
    expect(live).toBe("status|null");
    // row.set() draws a state the host decides.
    await p.evaluate(() =>
      (window as unknown as { row: { set(s: string): void } }).row.set("saved"),
    );
    expect(await rowState(p)).toBe("saved|Saved");
    await p.context().close();
  });

  it("read-only: the box and Save can't be used; the line says who can", async () => {
    if (skip()) return;
    const p = await open();
    expect(await p.isDisabled("#ro-cb")).toBe(true);
    expect(await p.isDisabled("#ro [data-den-setrow-save]")).toBe(true);
    expect(await p.textContent("#ro-meta")).toBe(
      "Nobody can change this · No changes yet",
    );
    expect(await saves(p)).toEqual([]);
    await p.context().close();
  });

  it("names and descriptions: the box by its label, described by help and line", async () => {
    if (skip()) return;
    const p = await open();
    const a = await p.evaluate(() => {
      const cb = document.getElementById("downloads-cb") as HTMLInputElement;
      const ids = (cb.getAttribute("aria-describedby") || "").split(" ");
      return {
        label: cb.labels![0]!.textContent!.trim(),
        described: ids.map((i) =>
          document.getElementById(i)!.textContent!.trim(),
        ),
      };
    });
    expect(a).toEqual({
      label: "Owners can download",
      described: [
        "Owners of a doc can download it from More. Each download is in its history.",
        "Admins and Owners can change this · Last changed 2 minutes ago by @sam",
      ],
    });
    await p.context().close();
  });

  it("speaks es and ja", async () => {
    if (skip()) return;
    for (const [lang, save, meta] of [
      [
        "es",
        "Guardar",
        "Admins y Owners pueden cambiar esto · Último cambio: hace 2 minutos, por @sam",
      ],
      ["ja", "保存", "Admins、Ownersが変更できます · 最終変更: 2 分前（@sam）"],
    ] as const) {
      const p = await open({ lang });
      expect(await p.textContent("#downloads [data-den-setrow-save]")).toBe(
        save,
      );
      expect(await p.textContent("#downloads-meta")).toBe(meta);
      await p.context().close();
    }
  });

  for (const mode of ["light", "dark"])
    for (const width of [1280, 390])
      it(`its look (${mode}, ${width}): tokens, AA text, ${width < 500 ? "44px targets, " : ""}no sideways scroll`, async () => {
        if (skip()) return;
        const p = await open({ mode, width });
        const tok = await p.evaluate(() => {
          const t = (n: string) => {
            const probe = document.createElement("i");
            probe.style.color = `var(${n})`;
            document.body.append(probe);
            const c = getComputedStyle(probe).color;
            probe.remove();
            return c;
          };
          const c = (id: string) =>
            getComputedStyle(document.getElementById(id)!).color;
          const l = document.querySelector("#downloads .den-setrow-l")!;
          return {
            label: getComputedStyle(l).color === t("--text"),
            help: c("downloads-help") === t("--muted"),
            meta: c("downloads-meta") === t("--faint"),
          };
        });
        expect(tok).toEqual({ label: true, help: true, meta: true });
        for (const sel of [
          "#downloads .den-setrow-l",
          "#downloads-help",
          "#downloads-meta",
          "#downloads [data-den-setrow-save]",
        ])
          expect([sel, (await contrastOf(p, sel)) >= 4.5]).toEqual([sel, true]);
        if (width < 500) {
          const h = await p.evaluate(() => ({
            label: document
              .querySelector("#downloads .den-setrow-l")!
              .getBoundingClientRect().height,
            save: document
              .querySelector("#downloads [data-den-setrow-save]")!
              .getBoundingClientRect().height,
            box: document
              .getElementById("downloads-cb")!
              .getBoundingClientRect().width,
          }));
          expect(h.label).toBeGreaterThanOrEqual(44);
          expect(h.save).toBeGreaterThanOrEqual(44);
          expect(h.box).toBeGreaterThanOrEqual(22);
        }
        expect(await noSideways(p)).toBe(true);
        await p.context().close();
      });
});

// ── 3. the page action menu ──────────────────────────────────────────────

const focused = (p: Page) =>
  p.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    return a.id || a.tagName;
  });
const picked = (p: Page) =>
  p.evaluate(() => (window as unknown as { picked: string[] }).picked);

describe("the page action menu (hydratePageMenu)", () => {
  it("Enter opens it on the first item; ↑ ↓ Home End move through every item", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus("#more");
    await p.keyboard.press("Enter");
    expect(await p.getAttribute("#more", "aria-expanded")).toBe("true");
    const menuId = await p.getAttribute("#more", "aria-controls");
    expect(menuId).toBe("more-menu");
    expect(await p.getAttribute("#more-menu", "role")).toBe("menu");
    expect(await p.getAttribute("#more-menu", "aria-label")).toBe("More");
    expect(await focused(p)).toBe("more-edit");
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await p.keyboard.press("ArrowDown");
      order.push(await focused(p));
    }
    expect(order).toEqual([
      "more-copy",
      "more-dl",
      "more-dl-note",
      "more-pause",
      "more-end",
      "more-edit",
    ]);
    await p.keyboard.press("End");
    expect(await focused(p)).toBe("more-end");
    await p.keyboard.press("Home");
    expect(await focused(p)).toBe("more-edit");
    await p.keyboard.press("Escape");
    expect(await p.getAttribute("#more", "aria-expanded")).toBe("false");
    expect(await focused(p)).toBe("more");
    // ↑ opens it on the last item.
    await p.keyboard.press("ArrowUp");
    expect(await focused(p)).toBe("more-end");
    await p.context().close();
  });

  it("a disabled item says why, does nothing, and keeps the menu open", async () => {
    if (skip()) return;
    const p = await open();
    await p.click("#more");
    const why = await p.evaluate(() => {
      const d = document.getElementById("more-dl")!;
      const n = document.getElementById(d.getAttribute("aria-describedby")!)!;
      const q = document.getElementById("more-pause")!;
      return {
        disabled: d.getAttribute("aria-disabled"),
        note: n.textContent,
        noteTag: n.tagName,
        under: n.previousElementSibling === d,
        pause: document.getElementById(q.getAttribute("aria-describedby")!)!
          .textContent,
      };
    });
    expect(why).toEqual({
      disabled: "true",
      note: "Downloads are off here. An admin can turn them on in Settings.",
      noteTag: "A",
      under: true,
      pause: "Only an owner can pause it.",
    });
    await p.focus("#more-dl");
    await p.keyboard.press("Enter");
    await p.click("#more-pause", { force: true });
    expect(await picked(p)).toEqual([]);
    expect(await p.getAttribute("#more", "aria-expanded")).toBe("true");
    await p.context().close();
  });

  it("a pick calls the item's own onSelect or onSelect(id), closes, focus back on More", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus("#more");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("Enter");
    expect(await picked(p)).toEqual(["edit:own"]);
    expect(await p.$("#more-menu")).toBe(null);
    expect(await focused(p)).toBe("more");
    await p.keyboard.press("Enter");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press(" ");
    expect(await picked(p)).toEqual(["edit:own", "copy"]);
    expect(await focused(p)).toBe("more");
    // A click outside closes it, and focus stays where it went.
    await p.click("#more");
    await p.mouse.click(5, 5);
    expect(await p.$("#more-menu")).toBe(null);
    await p.context().close();
  });

  it("the host's key words, and the kit's own: More, in es and ja", async () => {
    if (skip()) return;
    let p = await open();
    await p.click("#more");
    expect(await p.textContent("#more-copy")).toBe("Copy link");
    await p.context().close();
    for (const [lang, more] of [
      ["es", "Más ▾"],
      ["ja", "その他 ▾"],
    ] as const) {
      p = await open({ lang });
      expect(await p.textContent("#more")).toBe(more);
      await p.click("#more");
      expect(await p.getAttribute("#more-menu", "aria-label")).toBe(
        more.replace(" ▾", ""),
      );
      await p.context().close();
    }
  });

  for (const mode of ["light", "dark"])
    for (const width of [1280, 390])
      it(`its look (${mode}, ${width}): disabled faint, the note AA, ${width < 500 ? "44px rows, " : ""}kept in the window`, async () => {
        if (skip()) return;
        const p = await open({ mode, width });
        await p.click("#more");
        const look = await p.evaluate(() => {
          const t = (n: string) => {
            const probe = document.createElement("i");
            probe.style.color = `var(${n})`;
            document.body.append(probe);
            const c = getComputedStyle(probe).color;
            probe.remove();
            return c;
          };
          const c = (id: string) =>
            getComputedStyle(document.getElementById(id)!).color;
          const r = document
            .getElementById("more-menu")!
            .getBoundingClientRect();
          return {
            enabled: c("more-edit") === t("--text"),
            disabled: c("more-dl") === t("--faint"),
            note: c("more-dl-note") === t("--muted"),
            line: c("more-pause-note") === t("--muted"),
            inWindow: r.left >= 0 && r.right <= window.innerWidth,
            cursor: getComputedStyle(document.getElementById("more-dl")!)
              .cursor,
          };
        });
        expect(look).toEqual({
          enabled: true,
          disabled: true,
          note: true,
          line: true,
          inWindow: true,
          cursor: "not-allowed",
        });
        for (const sel of ["#more-edit", "#more-dl-note", "#more-pause-note"])
          expect([sel, (await contrastOf(p, sel)) >= 4.5]).toEqual([sel, true]);
        // A disabled item doesn't light up under the pointer.
        await p.hover("#more-dl");
        const hover = await p.evaluate(
          () =>
            getComputedStyle(document.getElementById("more-dl")!)
              .backgroundColor,
        );
        expect(hover).toBe("rgba(0, 0, 0, 0)");
        if (width < 500) {
          const rows = await p.evaluate(() =>
            Array.from(document.querySelectorAll("#more-menu .den-mi")).map(
              (r) => [r.id, r.getBoundingClientRect().height >= 44],
            ),
          );
          expect(rows.filter(([, ok]) => !ok)).toEqual([]);
          expect(
            await p.evaluate(
              () =>
                getComputedStyle(document.getElementById("more")!).minHeight,
            ),
          ).toBe("44px");
        }
        expect(await noSideways(p)).toBe(true);
        await p.context().close();
      });
});

// ── 4. the kit's own menus, unchanged ────────────────────────────────────

const POP_PROPS = [
  "display",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-left-radius",
  "background-color",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "cursor",
  "min-height",
  "max-width",
  "white-space",
];

/**
 * One spelling for the system face. The token names BlinkMacSystemFont;
 * Chromium on macOS reports it back as "system-ui", Chromium on Linux keeps
 * the name. The same face either way, so the stored look matches on both.
 */
function oneFontName(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v).replace(/\\"system-ui\\"/g, "BlinkMacSystemFont"),
  );
}

describe("the kit's own menus look as they did (◐ ▾)", () => {
  it("every row's style and height, light and dark, at 1280 and 390", async () => {
    if (skip()) return;
    // Issue 1527: the stored rows compare only in the browser they were
    // taken on (the rest of this file compares live renders, anywhere).
    if (!CAPTURE && (await visualOff(browser!, VISUAL_RECORD))) return;
    const got: Record<string, unknown> = {};
    for (const mode of ["light", "dark"])
      for (const width of [1280, 390]) {
        const p = await open({ look: "pop", mode, width });
        await p.click("#ap");
        got[`${mode}-${width}`] = await styles(
          p,
          "#ap-menu, #ap-menu > *",
          POP_PROPS,
        );
        await p.context().close();
      }
    if (CAPTURE) {
      fs.writeFileSync(POPOVERS, JSON.stringify(got, null, 1) + "\n");
      // Issue 1527: the record of the browser they were taken on.
      if (browser)
        writeVisualEnv(path.dirname(POPOVERS), await visualEnvOf(browser));
      return;
    }
    const want = JSON.parse(fs.readFileSync(POPOVERS, "utf-8"));
    expect(oneFontName(got)).toEqual(oneFontName(want));
  });
});
