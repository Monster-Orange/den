/**
 * iPad: a modal <dialog> stays centred and as tall as its content (issue
 * 231). A modal dialog sits at inset-block 0. On an iPad a pop-up still
 * ran the window's full height even with height: fit-content, so Den no
 * longer leans on the browser's box: an open modal dialog is fixed at top
 * 50%, moved up by half its height, bottom auto, height auto, capped at
 * the window less 32 px.
 *
 * The model, stronger than the device:
 * - `dialog{height:auto}` in a cascade layer, as the page's first sheet
 *   (it ranks like the browser's own sheet);
 * - every `height: fit-content` stripped from Den's served HTML, CSS and
 *   JS (the kit's dialog.js and busy.js inject CSS from JS strings);
 * - Playwright's iPad Pro 11 and iPad (gen 7) descriptors, portrait and
 *   landscape, in Chromium and WebKit;
 * - one more pass per browser with dvh made invalid, as an older iPad
 *   without dvh: the vh line before it must still cap a tall pop-up.
 * It opens the kit's confirm (short and tall), the working pop-up,
 * Report (without its screenshot), the Agents page's Rename and Move, a
 * persona dialog and a bare tall <dialog> that only base.css styles.
 * Each must be under the window less 32 px (short ones well under) with
 * its top and bottom gaps within 3 px of each other.
 *
 * Also: a menu opened inside a centred dialog sits at its anchor even
 * without the top layer (no popover), where the dialog's transform makes
 * it the menu's containing block; and at 390×844 Report is a sheet
 * anchored at the bottom. DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

let s: AgentsPageServer | null = null;
const browsers: Record<string, Browser> = {};
let devices: Record<string, Record<string, unknown>> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    devices = pw.devices as unknown as typeof devices;
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
  s = await startAgentsPageServer();
}, 60_000);

// Closing two remote browsers and the server: more than Jest's default 10 s
// on a loaded runner, as the setup above has its own 60 s.
afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
}, 60_000);

/** iPad's default for a dialog, ahead of every page stylesheet. */
const IPAD_DEFAULT = () => {
  const put = () => {
    const st = document.createElement("style");
    // A cascade layer, so it ranks like the browser's own sheet: any
    // unlayered page rule beats it, whatever its specificity.
    st.textContent = "@layer ipad-default { dialog { height: auto; } }";
    document.head.prepend(st);
  };
  if (document.head) put();
  else document.addEventListener("DOMContentLoaded", put, { once: true });
};

/** Den's text with no `height: fit-content`, and with no dvh if asked. */
function rewrite(text: string, noDvh: boolean): string {
  let t = text.replace(/(^|[^-\w])height:\s*fit-content\s*;?/g, "$1");
  // An unknown unit makes the declaration invalid, so it drops out, as
  // on a browser without dvh.
  if (noDvh) t = t.replace(/(\d)dvh\b/g, "$1xdvh");
  return t;
}

async function model(ctx: BrowserContext, noDvh: boolean): Promise<void> {
  await ctx.addInitScript(IPAD_DEFAULT);
  await ctx.route("**/*", async (route: Route) => {
    const req = route.request();
    // No screenshot, so the Report dialog's content is short too.
    if (req.url().includes("/report-shot.js"))
      return route.fulfill({ status: 404 });
    if (!["document", "stylesheet", "script"].includes(req.resourceType()))
      return route.continue();
    // The test fetches every page, script and sheet itself; a kept-alive
    // socket the server closes just as one is reused answers ECONNRESET
    // ("socket hang up"). Playwright retries only that, once.
    const res = await route.fetch({ maxRetries: 1 });
    await route.fulfill({
      response: res,
      body: rewrite(await res.text(), noDvh),
    });
  });
}

async function agentsPage(ctx: BrowserContext): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, "/agents"));
  await p.waitForFunction(() => "denShell" in window, undefined, {
    timeout: 20_000,
  });
  await p.waitForSelector("#ag-rn", { state: "attached", timeout: 20_000 });
  await p.addScriptTag({
    type: "module",
    content: [
      'import { askConfirm } from "/dialog-den.js";',
      'import { busyAction } from "/busy-den.js";',
      'import { openReport } from "/report-dialog.js";',
      "window.fitKit = { askConfirm, busyAction, openReport };",
    ].join("\n"),
  });
  await p.waitForFunction(() => "fitKit" in window);
  return p;
}

type Kit = {
  fitKit: {
    askConfirm(o: unknown): Promise<unknown>;
    busyAction(n: string, run: () => Promise<unknown>): Promise<unknown>;
    openReport(): Promise<unknown>;
  };
};

/** Opens pop-up `k`; the selector of its open dialog. */
async function open(p: Page, k: string): Promise<string> {
  return p.evaluate(async (kind) => {
    const kit = (window as unknown as Kit).fitKit;
    if (kind === "confirm" || kind === "confirm-tall") {
      void kit.askConfirm({
        title: "Remove it?",
        message: kind === "confirm" ? "It goes." : "A long line. ".repeat(900),
      });
      return ".dk-dlg";
    }
    if (kind === "busy") {
      void kit.busyAction("save", () => new Promise(() => {}));
      return ".bz-dlg";
    }
    if (kind === "report") {
      void kit.openReport();
      return ".fb-dlg";
    }
    if (kind === "persona") {
      const d = document.createElement("dialog");
      d.className = "pe-dlg den-ap-dlg";
      d.innerHTML = `<form method="dialog"><h2>Allow?</h2><p>One line.</p></form>`;
      document.body.append(d);
      d.showModal();
      return ".pe-dlg.den-ap-dlg";
    }
    if (kind === "bare-tall") {
      const d = document.createElement("dialog");
      d.className = "fit-bare";
      d.innerHTML = `<div style="height:3000px">Tall.</div>`;
      document.body.append(d);
      d.showModal();
      return ".fit-bare";
    }
    (document.getElementById(kind) as HTMLDialogElement).showModal();
    return `#${kind}`;
  }, k);
}

async function closeAll(p: Page, sel: string): Promise<void> {
  await p.evaluate((q) => {
    for (const d of document.querySelectorAll<HTMLDialogElement>(q)) d.close();
    document.querySelector("den-busy")?.remove();
    document.querySelector(".fit-bare")?.remove();
  }, sel);
}

const SHORT = ["confirm", "busy", "report", "ag-rn", "ag-mv", "persona"];
const TALL = ["confirm-tall", "bare-tall"];

const CASES: Array<{ device: string; noDvh: boolean }> = [
  { device: "iPad Pro 11", noDvh: false },
  { device: "iPad Pro 11 landscape", noDvh: false },
  { device: "iPad (gen 7)", noDvh: false },
  { device: "iPad (gen 7) landscape", noDvh: false },
  { device: "iPad (gen 7)", noDvh: true },
];

function descriptor(name: string): Record<string, unknown> {
  const { defaultBrowserType: _ignored, ...d } = devices[name]!;
  return d;
}

async function done(ctx: BrowserContext): Promise<void> {
  // Let any route handler still running finish first.
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
}

describe("iPad: pop-ups stay centred and fit their content", () => {
  for (const name of ["chromium", "webkit"])
    for (const c of CASES)
      it(`${name}, ${c.device}${c.noDvh ? ", no dvh" : ""}`, async () => {
        const b = browsers[name];
        if (!b) return;
        const ctx = await b.newContext({
          ...descriptor(c.device),
          reducedMotion: "reduce",
        });
        await model(ctx, c.noDvh);
        const p = await agentsPage(ctx);
        const bad: string[] = [];
        for (const k of [...SHORT, ...TALL]) {
          const sel = await open(p, k);
          await p.waitForSelector(`${sel}[open]`, { timeout: 10_000 });
          const m = await p.evaluate((q) => {
            const r = document.querySelector(q)!.getBoundingClientRect();
            return {
              top: r.top,
              bottom: r.bottom,
              h: r.height,
              vh: window.innerHeight,
            };
          }, sel);
          const gaps = Math.abs(m.top - (m.vh - m.bottom));
          const cap = TALL.includes(k) ? m.vh - 32 + 1 : m.vh * 0.7;
          if (m.h > cap || gaps > 3)
            bad.push(
              `${k}: top ${m.top.toFixed(0)}, bottom gap ${(m.vh - m.bottom).toFixed(0)}, h ${m.h.toFixed(0)} of ${m.vh}`,
            );
          await closeAll(p, sel);
        }
        expect(bad).toEqual([]);
        await done(ctx);
      }, 120_000);

  for (const name of ["chromium", "webkit"])
    it(`${name}: a menu inside a centred dialog sits at its anchor, without popover`, async () => {
      const b = browsers[name];
      if (!b) return;
      const ctx = await b.newContext({
        ...descriptor("iPad Pro 11"),
        reducedMotion: "reduce",
      });
      await model(ctx, false);
      // No top layer for a menu, as on an iPad before popover.
      await ctx.addInitScript(() => {
        Object.defineProperty(HTMLElement.prototype, "showPopover", {
          value: undefined,
          configurable: true,
        });
      });
      const p = await agentsPage(ctx);
      const m = await p.evaluate(() => {
        const d = document.createElement("dialog");
        d.innerHTML = `<p style="height:200px">Pick one.</p><button type="button" class="fit-anchor">More</button>`;
        document.body.append(d);
        d.showModal();
        const a = d.querySelector<HTMLElement>(".fit-anchor")!;
        (
          window as unknown as {
            denShell: { openMenu(a: Element, m: unknown): void };
          }
        ).denShell.openMenu(a, {
          label: "More",
          items: [{ label: "One", onSelect() {} }],
        });
        const pop = d.querySelector<HTMLElement>(".den-pop")!;
        const ar = a.getBoundingClientRect();
        const pr = pop.getBoundingClientRect();
        return {
          dTransform: getComputedStyle(d).transform,
          dy: pr.top - (ar.bottom + 6),
          dx: pr.left - ar.left,
        };
      });
      expect(m.dTransform).not.toBe("none");
      expect(Math.abs(m.dy)).toBeLessThanOrEqual(2);
      expect(Math.abs(m.dx)).toBeLessThanOrEqual(2);
      await done(ctx);
    }, 90_000);

  for (const name of ["chromium", "webkit"])
    it(`${name}: at 390×844 Report is a sheet anchored at the bottom`, async () => {
      const b = browsers[name];
      if (!b) return;
      const ctx = await b.newContext({
        viewport: { width: 390, height: 844 },
        reducedMotion: "reduce",
      });
      await model(ctx, false);
      const p = await agentsPage(ctx);
      await open(p, "report");
      await p.waitForSelector(".fb-dlg[open]", { timeout: 10_000 });
      const m = await p.evaluate(() => {
        const r = document.querySelector(".fb-dlg")!.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          w: r.width,
          vh: window.innerHeight,
        };
      });
      expect(Math.round(m.w)).toBe(390);
      expect(Math.abs(m.bottom - m.vh)).toBeLessThanOrEqual(1);
      expect(m.top).toBeGreaterThan(0);
      await done(ctx);
    }, 90_000);
});

describe("the vh cap comes before the dvh cap", () => {
  it.each([
    "packages/den-ui/src/base.css",
    "packages/den-ui/src/dialog.js",
    "packages/den-ui/src/busy.js",
  ])("%s", (f) => {
    const t = readFileSync(f, "utf8").replace(/\s+/g, "");
    const vh = t.indexOf(
      "max-height:calc(100vh-32px);max-height:calc(100dvh-32px)",
    );
    expect(vh).toBeGreaterThan(-1);
  });
});
