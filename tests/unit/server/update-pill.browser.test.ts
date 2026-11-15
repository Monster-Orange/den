/**
 * D61: the "Den was updated" pill. Its look is the one the product owner
 * approved, the pill of Den's sibling product before its opaque full bar
 * replaced it (rejected): the same structure and values, on Den's tokens.
 * His words: "a wide pill pop-up with semi-transparent background over the
 * global nav"; "the pop-up background within the border is
 * semi-transparent; it does NOT obscure the whole global nav. More
 * padding, a bit fatter. No rendering issues before/after RELOAD. Learn
 * more: release notes + version". On a real Den page with
 * /api/server-info answering a newer build than the page was served from:
 *
 * - the strip: fixed over the whole nav, at least 48px tall, padding
 *   6px 8px, 60% of --bg (semi-transparent), a 3px backdrop blur;
 * - the pill: min(560px, 100%) wide, radius 999px (a card, radius --r,
 *   only when the message needs two lines), padding 4px 16px, gap 10px,
 *   13px text, a 1px --border-strong border, the 0 6px 24px shadow, on
 *   --surface; narrower than the nav and inside its height;
 * - beside Reload (last): the 8px button gap on its left, the pill's
 *   padding on its right, nothing overlapping or clipped, no blur of its
 *   own (device scale 1 and 2);
 * - no nav text legible inside the pill: high-contrast text put in the
 *   nav under it leaves the pill's empty areas flat (luminance spread);
 * - Learn more opens the release notes of the version the pill names.
 *
 * At 1280×800 and 390×844, light and dark. Chromium and WebKit with
 * DEN_PW_WS (Den's Playwright server); Chromium alone without it.
 * DEN_UPD_SHOTS=<dir> also saves screenshots there.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, BrowserType, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

const NEW_V = "9.9.9";
const NEW_BUILD = "feedbeef0042";
const ENGINES = process.env.DEN_PW_WS
  ? (["chromium", "webkit"] as const)
  : (["chromium"] as const);

let s: AgentsPageServer | null = null;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES) {
      const kind = pw[e] as BrowserType;
      browsers[e] = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
    }
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  for (const b of Object.values(browsers)) await b?.close();
  await s?.stop();
});

/** A Den page whose server now runs NEW_BUILD (the page has the old one). */
async function open(
  b: Browser,
  o: { width: number; height: number; dark: boolean; dsf: number },
): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: o.dsf,
    colorScheme: o.dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route("**/api/server-info", async (route) => {
    const res = await route.fetch();
    const info = await res.json();
    info.loaded = { version: NEW_V, buildId: NEW_BUILD };
    info.onDisk = { version: NEW_V, buildId: NEW_BUILD };
    info.engineStale = false;
    info.version = NEW_V;
    info.stale = false;
    await route.fulfill({ response: res, json: info });
  });
  await p.route("**/api/changelog", async (route) => {
    const res = await route.fetch();
    const entries = await res.json();
    entries.unshift({
      version: NEW_V,
      date: "2026-11-15",
      sections: { Added: [{ text: "Probe entry." }] },
    });
    await route.fulfill({ response: res, json: entries });
  });
  // What's new counts NEW_V as read, so it never opens by itself over
  // the pill: only Learn more opens it.
  await p.addInitScript((v) => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k: string) {
      return k.endsWith("-changelog-seen") ? v : get.call(this, k);
    };
  }, NEW_V);
  await p.goto(signInUrl(s!.stateDir, s!.base, "/services"));
  await p.waitForFunction(() => "denShell" in window, undefined, {
    timeout: 20_000,
  });
  await p.waitForSelector("#den-update:not([hidden])", { timeout: 20_000 });
  return p;
}

/** Closes the page's context, its routes' requests in flight ignored. */
async function done(p: Page): Promise<void> {
  await p.unrouteAll({ behavior: "ignoreErrors" });
  await p.context().close();
}

/** Puts high-contrast text in the nav, under the whole strip. */
async function inkUnder(p: Page): Promise<void> {
  await p.evaluate(() => {
    const nav = document.querySelector(".den-top") as HTMLElement;
    const ink = document.createElement("span");
    ink.id = "probe-ink";
    ink.setAttribute("aria-hidden", "true");
    ink.textContent = "HXHXHXHX ⌘K ".repeat(40);
    Object.assign(ink.style, {
      position: "absolute",
      left: "0",
      right: "0",
      top: "12px",
      overflow: "hidden",
      whiteSpace: "nowrap",
      font: "700 18px/24px sans-serif",
      color: "var(--text)",
      pointerEvents: "none",
    });
    nav.append(ink);
  });
  await p.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

type Box = { l: number; r: number; t: number; b: number; w: number; h: number };

/** Everything the checks need, measured in the page. */
async function measure(p: Page) {
  return p.evaluate(() => {
    const box = (el: Element | DOMRect) => {
      const r = el instanceof DOMRect ? el : el.getBoundingClientRect();
      return {
        l: r.left,
        r: r.right,
        t: r.top,
        b: r.bottom,
        w: r.width,
        h: r.height,
      };
    };
    const alpha = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/) || c.match(/color\(srgb ([^)]+)\)/);
      if (!m) return c === "transparent" ? 0 : 1;
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };
    const blur = (cs: CSSStyleDeclaration) => {
      const x = cs as unknown as {
        backdropFilter?: string;
        webkitBackdropFilter?: string;
      };
      return x.backdropFilter && x.backdropFilter !== "none"
        ? x.backdropFilter
        : (x.webkitBackdropFilter ?? "none");
    };
    const strip = document.getElementById("den-update")!;
    // Any earlier shape of it measures too (the strip as the pill).
    const pill = strip.querySelector(".upd-pill") ?? strip;
    const nav = document.querySelector(".den-top")!;
    const scs = getComputedStyle(strip);
    const cs = getComputedStyle(pill);
    const acts = pill.querySelector(".upd-acts") ?? pill;
    const kids = [...acts.children].filter(
      (k) => (k as HTMLElement).offsetWidth > 0,
    ) as HTMLElement[];
    const go = pill.querySelector('[data-upd="reload"]') as HTMLElement;
    const msg = pill.querySelector(".upd-msg, .den-upd-msg") as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(msg);
    const pb = box(pill);
    const hitStrip = document.elementFromPoint(2, 2);
    const hitPill = document.elementFromPoint(pb.l + pb.w / 2, pb.t + 3);
    const rootCs = getComputedStyle(document.documentElement);
    return {
      vw: window.innerWidth,
      nav: box(nav),
      strip: {
        ...box(strip),
        position: scs.position,
        minH: scs.minHeight,
        pad: scs.padding,
        bgAlpha: alpha(scs.backgroundColor),
        blur: blur(scs),
        onTop: !!hitStrip && strip.contains(hitStrip),
      },
      pill: pb,
      card: pill.classList.contains("card"),
      r: rootCs.getPropertyValue("--r").trim(),
      cs: {
        radius: cs.borderTopLeftRadius,
        pad: cs.padding,
        gap: cs.columnGap,
        font: cs.fontSize,
        border: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
        shadow: cs.boxShadow,
        bgAlpha: alpha(cs.backgroundColor),
        bg: cs.backgroundColor,
        surface: (() => {
          const d = document.createElement("div");
          d.style.background = "var(--surface)";
          document.body.append(d);
          const c = getComputedStyle(d).backgroundColor;
          d.remove();
          return c;
        })(),
      },
      onTop: !!hitPill && pill.contains(hitPill),
      msgText: box(range.getBoundingClientRect()),
      acts: box(acts),
      kids: kids.map((k) => ({ cls: k.className || k.tagName, ...box(k) })),
      goLast: kids[kids.length - 1] === go,
      go: {
        ...box(go),
        blur: blur(getComputedStyle(go)),
        text: go.textContent,
      },
      kidBlur: kids.some((k) => blur(getComputedStyle(k)) !== "none"),
      text: pill.textContent || "",
      more: (pill.querySelector('[data-upd="notes"]') as HTMLElement | null)
        ?.textContent,
      report: !!pill.querySelector("[data-den-report]"),
    };
  });
}

type M = Awaited<ReturnType<typeof measure>>;

/** What differs from the approved pill; empty when it all holds. */
function faults(m: M): string[] {
  const f: string[] = [];
  const { pill, nav, strip } = m;
  // The strip: over the whole nav, semi-transparent, a 3px blur.
  if (
    strip.position !== "fixed" ||
    strip.t !== 0 ||
    strip.l !== 0 ||
    Math.abs(strip.w - m.vw) > 0.5
  )
    f.push(
      `strip: not fixed over the whole width (${strip.position} ${strip.l},${strip.t} ${strip.w})`,
    );
  if (strip.minH !== "48px" || strip.h < 48)
    f.push(`strip: min-height ${strip.minH}, ${strip.h}px`);
  if (strip.pad !== "6px 8px") f.push(`strip: padding ${strip.pad}`);
  if (Math.abs(strip.bgAlpha - 0.6) > 0.02)
    f.push(`strip: background alpha ${strip.bgAlpha}`);
  if (strip.blur !== "blur(3px)") f.push(`strip: backdrop ${strip.blur}`);
  if (!strip.onTop) f.push("strip: not over the nav");
  // The pill: Hub's values on Den's tokens.
  const want = Math.min(560, m.vw - 16);
  if (Math.abs(pill.w - want) > 1)
    f.push(`pill: ${pill.w}px wide, not min(560px, 100%) = ${want}`);
  if (m.card) {
    if (m.vw > 600) f.push("pill: a card at a wide window");
    if (m.cs.radius !== m.r)
      f.push(`card: radius ${m.cs.radius} vs --r ${m.r}`);
    if (m.cs.pad !== "10px 16px") f.push(`card: padding ${m.cs.pad}`);
  } else {
    if (m.cs.radius !== "999px") f.push(`pill: radius ${m.cs.radius}`);
    if (m.cs.pad !== "4px 16px") f.push(`pill: padding ${m.cs.pad}`);
    if (pill.l < nav.l + 8 || pill.r > nav.r - 8)
      f.push("pill: as wide as the nav");
    if (pill.t < nav.t - 0.5 || pill.b > nav.b + 0.5)
      f.push(`pill: outside the nav's height (${pill.t}–${pill.b})`);
  }
  if (m.cs.gap !== "10px") f.push(`pill: gap ${m.cs.gap}`);
  if (m.cs.font !== "13px") f.push(`pill: font-size ${m.cs.font}`);
  if (m.cs.border !== "1px solid") f.push(`pill: border ${m.cs.border}`);
  if (!/0px 6px 24px/.test(m.cs.shadow)) f.push(`pill: shadow ${m.cs.shadow}`);
  if (m.cs.bg !== m.cs.surface)
    f.push(`pill: background ${m.cs.bg}, not --surface ${m.cs.surface}`);
  if (Math.abs(pill.l + pill.w / 2 - m.vw / 2) > 1) f.push("pill: not centred");
  if (!m.onTop) f.push("pill: something is drawn over it");
  // Beside Reload: last, the 8px gap on its left, the padding on its right.
  if (!m.goLast) f.push("reload: not the last button");
  const prev = m.kids[m.kids.length - 2];
  if (prev && Math.abs(m.go.l - prev.r - 8) > 1)
    f.push(`reload: ${(m.go.l - prev.r).toFixed(2)}px after ${prev.cls}`);
  if (Math.abs(pill.r - 1 - 16 - m.go.r) > 1)
    f.push(
      `reload: ${(pill.r - m.go.r).toFixed(2)}px from the pill's right edge`,
    );
  for (let i = 1; i < m.kids.length; i++)
    if (m.kids[i].l < m.kids[i - 1].r - 0.5)
      f.push(`${m.kids[i - 1].cls} overlaps ${m.kids[i].cls}`);
  for (const k of [...m.kids, m.msgText])
    if (
      k.l < pill.l + 1 ||
      k.r > pill.r - 1 ||
      k.t < pill.t + 1 ||
      k.b > pill.b - 1
    )
      f.push(`${"cls" in k ? k.cls : "message"} reaches the pill's border`);
  if (m.kidBlur || m.go.blur !== "none")
    f.push(`reload: a blur of its own (${m.go.blur})`);
  if (!/reload/i.test(m.go.text || "")) f.push(`reload: says "${m.go.text}"`);
  // Learn more, naming the version; Report.
  if (m.more !== "Learn more") f.push(`no Learn more (${m.more})`);
  if (!m.text.includes(NEW_V)) f.push("the version isn't named");
  if (!m.report) f.push("no Report button");
  return f;
}

/** The pill's empty areas: no glyph from under it may read there. */
function emptyAreas(m: M): Box[] {
  const { pill } = m;
  const t = pill.t + 5;
  const h = pill.h - 10;
  const out: Box[] = [];
  const add = (l: number, r: number, top = t, hh = h) => {
    if (r - l >= 6 && hh >= 6)
      out.push({ l, r, t: top, b: top + hh, w: r - l, h: hh });
  };
  // Left of the message, inside the padding.
  add(pill.l + 4, m.msgText.l - 3, m.msgText.t, m.msgText.h);
  // After the message's text, before the buttons (or, as a card, left of them).
  if (m.card) add(pill.l + 4, m.acts.l - 3, m.acts.t, m.acts.h);
  else add(m.msgText.r + 3, m.acts.l - 3);
  return out;
}

/** The luminance spread (0–1) in each area of a screenshot. */
async function spreads(p: Page, areas: Box[]): Promise<number[]> {
  const out: number[] = [];
  const probe = await p.context().newPage();
  for (const a of areas) {
    const png = await p.screenshot({
      clip: { x: a.l, y: a.t, width: a.w, height: a.h },
    });
    out.push(
      await probe.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let lo = 1;
        let hi = 0;
        for (let i = 0; i < d.length; i += 4) {
          const y =
            (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
        return hi - lo;
      }, png.toString("base64")),
    );
  }
  await probe.close();
  return out;
}

const SIZES = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

describe("D61: the update pill matches the approved one", () => {
  for (const e of ENGINES)
    for (const size of SIZES)
      for (const dark of [false, true])
        for (const dsf of [1, 2])
          it(`${e} ${size.width}×${size.height} ${dark ? "dark" : "light"} @${dsf}x`, async () => {
            const b = browsers[e];
            if (!b) return;
            const p = await open(b, { ...size, dark, dsf });
            await inkUnder(p);
            const m = await measure(p);
            const f = faults(m);
            const areas = emptyAreas(m);
            if (areas.length === 0) f.push("no empty area to check");
            const sp = await spreads(p, areas);
            sp.forEach((v, i) => {
              if (v > 0.06)
                f.push(
                  `text reads through the pill (area ${i}: spread ${v.toFixed(3)})`,
                );
            });
            const dir = process.env.DEN_UPD_SHOTS;
            const shot =
              dir &&
              (e === "webkit" || (size.width === 1280 && !dark && dsf === 1));
            if (shot) {
              fs.mkdirSync(dir, { recursive: true });
              await p.evaluate(() =>
                document.getElementById("probe-ink")?.remove(),
              );
              const name = `${e === "webkit" ? "" : `${e}-`}pill-${size.width}-${dark ? "dark" : "light"}`;
              if (dsf === 1)
                await p.screenshot({
                  path: path.join(dir, `${name}.png`),
                  clip: { x: 0, y: 0, width: size.width, height: 120 },
                });
              else if (size.width === 1280)
                await p.screenshot({
                  path: path.join(dir, `${name}-reload-200.png`),
                  clip: {
                    x: Math.max(0, m.go.l - 200),
                    y: 0,
                    width: Math.min(size.width, m.go.w + 260),
                    height: 56,
                  },
                });
            }
            expect(f).toEqual([]);
            await done(p);
          }, 90_000);

  it("Learn more opens the release notes at that version", async () => {
    const b = browsers[ENGINES[0]];
    if (!b) return;
    const p = await open(b, { width: 1280, height: 800, dark: false, dsf: 1 });
    await p.click('#den-update [data-upd="notes"]');
    await p.waitForSelector("#cl-overlay.open", { timeout: 10_000 });
    expect(await p.textContent("#cl-body")).toContain(NEW_V);
    await done(p);
  }, 90_000);

  it("Later hides it for this tab, also after a reload", async () => {
    const b = browsers[ENGINES[0]];
    if (!b) return;
    const p = await open(b, { width: 1280, height: 800, dark: false, dsf: 1 });
    await p.click('#den-update [data-upd="later"]');
    expect(await p.isHidden("#den-update")).toBe(true);
    await p.reload();
    await p.waitForFunction(() => "denShell" in window);
    await p.waitForTimeout(1500);
    expect(
      await p.evaluate(() => {
        const el = document.getElementById("den-update");
        return !el || el.hidden;
      }),
    ).toBe(true);
    await done(p);
  }, 90_000);

  it("Reload asks first when a field holds typed text", async () => {
    const b = browsers[ENGINES[0]];
    if (!b) return;
    const p = await open(b, { width: 1280, height: 800, dark: false, dsf: 1 });
    await p.evaluate(() => {
      const ta = document.createElement("textarea");
      ta.id = "probe-draft";
      document.body.append(ta);
    });
    await p.fill("#probe-draft", "half a thought");
    await p.click('#den-update [data-upd="reload"]');
    await expect(p.textContent("#den-update .upd-msg")).resolves.toContain(
      "unsaved text",
    );
    await p.click('#den-update [data-upd="later"]');
    await expect(p.textContent("#den-update .upd-msg")).resolves.toContain(
      NEW_V,
    );
    expect(await p.inputValue("#probe-draft")).toBe("half a thought");
    await done(p);
  }, 90_000);
});
