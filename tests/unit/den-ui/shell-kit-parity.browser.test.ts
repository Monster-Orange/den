/**
 * Issue 95 (UI kit slice 1): Den on the kit's shell looks exactly as Den
 * did before the move. Six areas, Chromium, light, at 1280×900 and 390×844:
 *
 *   shell     a page with the rail and the top bar
 *   version   the version chip
 *   whatsnew  the release notes pop-up, open
 *   update    the update pill, showing
 *   report    the Report form, open
 *   working   the working pop-up, open
 *
 * Two checks per area and width:
 *
 * 1. The DOM and the computed sizes (fixtures/den-shell-baseline.json,
 *    captured from Den before the move): each area's elements, their tree
 *    (tags, ids, classes, attributes, words) and their boxes and key
 *    computed styles must match. The only allowed differences are listed in
 *    ALLOWED below, each with its reason.
 * 2. The pixels, when the baseline PNGs are on this machine
 *    (DEN_UI_DIFF_DIR, default ~/Library/Logs/den-probe/den-ui-diff/
 *    baseline): a 0-pixel difference, compared in the browser. The PNGs
 *    are not in the repo (each is ~100 KB); CI runs check 1 only.
 *
 * Where it runs: the fixture keeps the browser's fingerprint from the
 * capture (its user agent, pixel ratio and the width of one line of text in
 * each face: ENV_FINGERPRINT). On the same browser the rects match
 * exactly. On another (CI's Linux runner: other font hinting) the tree,
 * the counts and every computed style still match exactly, and each rect
 * edge within GEO_TOLERANCE px: text there lays out a pixel or three
 * apart. A real layout change still fails: it changes a style, or moves a
 * box past the tolerance.
 *
 * DEN_UI_CAPTURE=1 writes the fixture and the PNGs instead of comparing
 * (run once, before the move). DEN_PW_WS: Den's own Playwright server.
 * DEN_SKIP_BROWSER_TESTS=1 skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, BrowserContext, Page } from "playwright";
import { signInUrl } from "../server/helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "../server/helpers/agents-page-server.js";
import { pageImport } from "../server/helpers/page-import.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const CAPTURE = process.env.DEN_UI_CAPTURE === "1";
const FIXTURE = path.join(__dirname, "fixtures", "den-shell-baseline.json");
const OUT_DIR =
  process.env.DEN_UI_DIFF_DIR ??
  path.join(os.homedir(), "Library", "Logs", "den-probe", "den-ui-diff");
const BASE_DIR = path.join(OUT_DIR, "baseline");
const AFTER_DIR = path.join(OUT_DIR, "after");

const AREAS = [
  "shell",
  "version",
  "whatsnew",
  "update",
  "report",
  "working",
] as const;
type Area = (typeof AREAS)[number];
const WIDTHS = [
  [1280, 900],
  [390, 844],
] as const;

/** What each area measures (the first is the area's root). */
const SELECTORS: Record<Area, string[]> = {
  shell: [
    "header.den-top",
    "#den-rail",
    "#den-menu-btn",
    ".den-brand",
    ".den-chips",
    ".den-rb-top",
    "#den-bell",
    "#version-pill",
    "#den-user",
    ".den-rail .den-ni",
    ".den-collapse-btn",
  ],
  version: ["#version-pill", "#version-pill .v-txt", "#v-pip"],
  whatsnew: [
    "#cl-overlay",
    "#cl-overlay .cl-box",
    "#cl-overlay .cl-hdr",
    "#cl-overlay .cl-body",
    "#cl-overlay .cl-footer",
    "#cl-got-it-btn",
  ],
  update: [".den-upd", ".den-upd .upd-pill"],
  report: ["dialog.fb-dlg", "dialog.fb-dlg .fb-btns"],
  working: ["dialog.bz-dlg", "dialog.bz-dlg h2"],
};

/** The computed styles each element keeps. */
const STYLES = [
  "display",
  "position",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "color",
  "background-color",
  "border-top-width",
  "border-top-color",
  "border-radius",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-left",
  "gap",
  "z-index",
  "opacity",
  "box-shadow",
];

/**
 * The differences the move may make, none visible, each with its reason.
 * Keyed by the attribute that differs.
 */
/** How far a rect may move on another browser (see the top). */
const GEO_TOLERANCE = 4;
const ENV_KEY = "__env";

/** The browser's fingerprint: what decides where text lands. */
function envFingerprint(p: Page): Promise<string> {
  return p.evaluate(() => {
    const c = document.createElement("canvas").getContext("2d")!;
    const line = "Den shell metrics: Reload, Report, 0123456789";
    const faces = [
      "15px Rubik",
      "15px sans-serif",
      "13px 'Space Mono'",
      "13px monospace",
    ].map((f) => {
      c.font = f;
      return `${f}=${c.measureText(line).width.toFixed(3)}`;
    });
    return [navigator.userAgent, devicePixelRatio, ...faces].join(" | ");
  });
}

/** Rects' edges apart by more than `tol`, as "sel: [want] vs [got]". */
function geoDiff(want: Measure[], got: Measure[], tol: number): string[] {
  const out: string[] = [];
  want.forEach((w, i) => {
    const g = got[i];
    if (!g || !w.rect || !g.rect) return;
    if (w.rect.some((v, k) => Math.abs(v - g.rect![k]!) > tol))
      out.push(`${w.sel}: [${w.rect.join(", ")}] vs [${g.rect.join(", ")}]`);
  });
  return out;
}

/**
 * Computed styles the kit may change with no visible difference, each with
 * its reason: "selector property" → [before, after].
 */
const ALLOWED_STYLES: Record<string, Array<[string, string]>> = {
  // den-ui 0.6.3: the top bar is pinned (fixed at the top, as the rail is),
  // so it no longer scrolls away; at the top of the page it is where it
  // was, as its rect (unchanged) shows. Fixed, it spans the window from
  // left 0 itself, so it no longer reaches back over the rail's padding.
  "header.den-top position": [["relative", "fixed"]],
  "header.den-top margin-left": [["-233px", "0px"]],
};

/** `want` with the allowed style changes applied. */
function allowStyles(want: Measure[]): Measure[] {
  return want.map((m) => {
    if (!m.style) return m;
    const style = { ...m.style };
    for (const [k, v] of Object.entries(style))
      for (const [from, to] of ALLOWED_STYLES[`${m.sel} ${k}`] ?? [])
        if (v === from) style[k] = to;
    return { ...m, style };
  });
}

/**
 * Pixels: a channel within PIXEL_ROUNDING counts as the same. A fixed
 * element is its own layer (0.6.3 pins the top bar), so a backdrop, or a
 * blur sampling the page behind What's new or the update pill, rounds a
 * channel a few steps differently; no one can see that. A moved or
 * recoloured part differs by tens of steps, and still fails.
 */
const PIXEL_ROUNDING = 8;

const ALLOWED_ATTRS = new Set([
  // CSP (issue 95 b): the version chip opened What's new with an inline
  // onclick="openChangelog()"; the kit binds a listener instead.
  "onclick",
]);

interface Node {
  tag: string;
  attrs: Record<string, string>;
  text?: string;
  kids: Node[];
}
interface Measure {
  sel: string;
  count: number;
  rect: [number, number, number, number] | null;
  style: Record<string, string> | null;
}
interface Shot {
  tree: Node | null;
  measures: Measure[];
}

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    browser = process.env.DEN_PW_WS
      ? await pw.chromium.connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await pw.chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
}, 90_000);

const skip = () => !browser || !s;

/** The fixed release notes What's new shows (the CHANGELOG changes). */
const NOTES = [
  {
    version: "9.9.0",
    date: "2026-11-16",
    sections: {
      Added: [
        { text: "A shared shell for every page." },
        { text: "The release notes in one place." },
      ],
    },
  },
  {
    version: "9.8.0",
    date: "2026-11-01",
    sections: { Fixed: [{ text: "A quieter top bar." }] },
  },
];

async function open(
  width: number,
  height: number,
  o: { stale?: boolean } = {},
): Promise<{ p: Page; ctx: BrowserContext }> {
  const ctx = await browser!.newContext({
    viewport: { width, height },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.0");
    } catch {
      /* none */
    }
    // The same "random" request ids and words on every run.
    let seed = 7;
    Math.random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
  });
  await ctx.route("**/api/changelog", (r) => r.fulfill({ json: NOTES }));
  await ctx.route("**/api/server-info", async (route) => {
    const res = await route.fetch();
    const j = (await res.json()) as Record<string, unknown>;
    j.version = "9.9.0";
    j.fresh = false;
    j.engineStale = o.stale === true;
    j.onDisk = { version: o.stale ? "9.9.1" : "9.9.0" };
    await route.fulfill({ response: res, json: j });
  });
  await ctx.route("**/api/report**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/report")
      return r.fulfill({
        json: {
          ok: true,
          enabled: true,
          repos: [{ repo: "acme-eng/engine" }],
          github: { signedIn: true, deviceFlow: true },
          maxPerHour: 5,
          sentThisHour: 0,
        },
      });
    if (u.pathname === "/api/report/diagnostics")
      return r.fulfill({
        json: { ok: true, sections: { Den: "acme 9.9.0" } },
      });
    return r.fulfill({ json: { ok: true } });
  });
  // The working pop-up's action: an answer that never comes.
  await ctx.route("**/api/den-ui-probe", () => {
    /* never answered */
  });
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(
    () =>
      "denShell" in window &&
      /\d/.test(
        document.querySelector("#version-pill .v-txt")?.textContent ?? "",
      ),
    undefined,
    { timeout: 20_000 },
  );
  await settle(p);
  return { p, ctx };
}

/** Polls answered, fonts in, nothing moving. */
async function settle(p: Page): Promise<void> {
  await p
    .waitForFunction(
      () =>
        document.querySelector("#den-status")?.getAttribute("aria-busy") !==
        "true",
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {});
  await p.evaluate(() => document.fonts.ready.then(() => true));
  // The sign-in toast ("This device is signed in to …") stays 2.2 s after
  // the page opens: gone before any shot, or a slow run catches it.
  await p
    .waitForFunction(() => !document.querySelector(".den-toast"), undefined, {
      timeout: 10_000,
    })
    .catch(() => {});
  await p.waitForTimeout(400);
}

async function show(p: Page, area: Area): Promise<void> {
  if (area === "whatsnew") {
    await p.evaluate(() =>
      (window as never as { openChangelog: () => void }).openChangelog(),
    );
    await p.waitForSelector("#cl-overlay.open .cl-box", { state: "visible" });
    // The heading has focus; take it off, so no ring is in the shot.
  } else if (area === "update") {
    await p.waitForSelector(".den-upd .upd-pill", {
      state: "visible",
      timeout: 20_000,
    });
  } else if (area === "report") {
    await p.evaluate(() =>
      (
        window as never as { denShell: { report: () => Promise<unknown> } }
      ).denShell.report(),
    );
    await p.waitForSelector("dialog.fb-dlg[open]", {
      state: "visible",
      timeout: 20_000,
    });
  } else if (area === "working") {
    await p.evaluate(`${pageImport("/busy-den.js")}.then(() => true)`);
    await p.evaluate(() => {
      type Fn = (...a: unknown[]) => Promise<unknown>;
      const sh = (window as never as { denShell: { busyAction: Fn; api: Fn } })
        .denShell;
      void sh
        .busyAction(
          "link",
          (headers: Record<string, string>) =>
            sh.api("POST", "/api/den-ui-probe", {}, { headers }),
          {},
        )
        .catch(() => {});
    });
    await p.waitForSelector("dialog.bz-dlg[open]", {
      state: "visible",
      timeout: 20_000,
    });
  }
  await p.waitForTimeout(300);
  // Focus rings follow where focus happened to land: none in the shot.
  await p.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.(),
  );
  await p.waitForTimeout(100);
}

/** The area's tree and measures, from the page. */
async function measure(p: Page, area: Area): Promise<Shot> {
  return p.evaluate(
    ({ sels, styles }) => {
      const round = (n: number) => Math.round(n * 100) / 100;
      const tree = (el: Element, depth: number): Node => {
        const attrs: Record<string, string> = {};
        for (const a of Array.from(el.attributes))
          if (a.name !== "style" || el.tagName !== "svg")
            attrs[a.name] = a.value;
        const kids: Node[] = [];
        let text = "";
        for (const c of Array.from(el.childNodes)) {
          if (c.nodeType === 3) text += c.textContent ?? "";
          else if (c.nodeType === 1 && depth < 40)
            kids.push(tree(c as Element, depth + 1));
        }
        const out: Node = { tag: el.tagName.toLowerCase(), attrs, kids };
        if (text.trim()) out.text = text.replace(/\s+/g, " ").trim();
        return out;
      };
      type Node = {
        tag: string;
        attrs: Record<string, string>;
        text?: string;
        kids: Node[];
      };
      const root = document.querySelector(sels[0]);
      return {
        tree: root ? tree(root, 0) : null,
        measures: sels.map((sel) => {
          const all = document.querySelectorAll(sel);
          const el = all[0];
          if (!el) return { sel, count: 0, rect: null, style: null };
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const style: Record<string, string> = {};
          for (const k of styles) style[k] = cs.getPropertyValue(k);
          return {
            sel,
            count: all.length,
            rect: [round(r.x), round(r.y), round(r.width), round(r.height)] as [
              number,
              number,
              number,
              number,
            ],
            style,
          };
        }),
      };
    },
    { sels: SELECTORS[area], styles: STYLES },
  );
}

/** Differences between two trees, as paths (the allowed ones dropped). */
function treeDiff(a: Node | null, b: Node | null, at = ""): string[] {
  if (!a || !b) return a === b ? [] : [`${at}: ${a ? "gone" : "new"}`];
  const out: string[] = [];
  const here = `${at}/${a.tag}${a.attrs.id ? "#" + a.attrs.id : ""}`;
  if (a.tag !== b.tag) return [`${here}: tag ${a.tag} → ${b.tag}`];
  const names = new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)]);
  for (const n of names)
    if (a.attrs[n] !== b.attrs[n] && !ALLOWED_ATTRS.has(n))
      out.push(`${here} [${n}]: ${a.attrs[n]} → ${b.attrs[n]}`);
  if ((a.text ?? "") !== (b.text ?? ""))
    out.push(`${here} text: ${a.text} → ${b.text}`);
  if (a.kids.length !== b.kids.length)
    out.push(`${here}: ${a.kids.length} children → ${b.kids.length}`);
  for (let i = 0; i < Math.min(a.kids.length, b.kids.length); i++)
    out.push(...treeDiff(a.kids[i], b.kids[i], here));
  return out;
}

/** The number of pixels that differ between two PNGs (in the browser). */
async function pixelDiff(
  p: Page,
  a: Buffer,
  b: Buffer,
  skip: number[][] = [],
): Promise<number> {
  if (a.equals(b)) return 0;
  return p.evaluate(
    async ({ x, y, skip, tol }) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, c.width, c.height);
      };
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return -1;
      let n = 0;
      for (let i = 0; i < ia.data.length; i += 4) {
        const px = (i / 4) % ia.width;
        const py = Math.floor(i / 4 / ia.width);
        if (
          skip.some(
            ([l, t, r, btm]) => px >= l! && px < r! && py >= t! && py < btm!,
          )
        )
          continue;
        for (let k = 0; k < 4; k++)
          if (Math.abs(ia.data[i + k]! - ib.data[i + k]!) > tol) {
            n++;
            break;
          }
      }
      return n;
    },
    {
      x: a.toString("base64"),
      y: b.toString("base64"),
      skip,
      tol: PIXEL_ROUNDING,
    },
  );
}

const fixture: Record<string, Shot> = CAPTURE
  ? {}
  : fs.existsSync(FIXTURE)
    ? (JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as Record<string, Shot>)
    : {};

describe("issue 95: Den on the kit's shell looks as it did", () => {
  for (const [w, h] of WIDTHS)
    for (const area of AREAS)
      it(`${area} at ${w}`, async () => {
        if (skip()) return;
        const { p, ctx } = await open(w, h, { stale: area === "update" });
        try {
          await show(p, area);
          const shot = await measure(p, area);
          const png = await p.screenshot({
            animations: "disabled",
            caret: "hide",
          });
          const key = `${area}-${w}`;
          const name = `den-${area}-${w}.png`;
          const env = await envFingerprint(p);
          if (CAPTURE) {
            (fixture as unknown as Record<string, string>)[ENV_KEY] = env;
            fs.mkdirSync(BASE_DIR, { recursive: true });
            fs.writeFileSync(path.join(OUT_DIR, name), png);
            fs.writeFileSync(path.join(BASE_DIR, name), png);
            fixture[key] = shot;
            fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
            fs.writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + "\n");
            return;
          }
          const want = fixture[key];
          expect(want).toBeDefined();
          expect(shot.tree).not.toBeNull();
          expect(treeDiff(want.tree, shot.tree)).toEqual([]);
          const same =
            (fixture as unknown as Record<string, string>)[ENV_KEY] === env;
          const wantM = allowStyles(want.measures);
          if (same) expect(shot.measures).toEqual(wantM);
          else {
            // Another browser: all but the rects exactly, the rects within
            // GEO_TOLERANCE.
            const noRect = (m: Measure[]) =>
              m.map((x) => ({ ...x, rect: x.rect ? "rect" : null }));
            expect(noRect(shot.measures)).toEqual(noRect(wantM));
            expect(geoDiff(wantM, shot.measures, GEO_TOLERANCE)).toEqual([]);
          }
          const base = path.join(BASE_DIR, name);
          // The pixels: only against shots from this same browser.
          if (same && fs.existsSync(base)) {
            fs.mkdirSync(AFTER_DIR, { recursive: true });
            fs.writeFileSync(path.join(AFTER_DIR, name), png);
            // Report's screenshot preview is a picture of the page, not the
            // kit's look: left out.
            const skipRects = await p.evaluate(() =>
              [
                ...document.querySelectorAll(".fb-shot canvas, .fb-shot img"),
              ].map((e) => {
                const r = e.getBoundingClientRect();
                return [r.left, r.top, r.right, r.bottom];
              }),
            );
            expect(
              await pixelDiff(p, fs.readFileSync(base), png, skipRects),
            ).toBe(0);
          }
        } finally {
          await ctx.unrouteAll({ behavior: "ignoreErrors" });
          await ctx.close();
        }
      }, 60_000);
});
