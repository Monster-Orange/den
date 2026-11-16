/**
 * Issue 95: the global nav inventory (packages/den-ui/inventory). Den's
 * top bar and rail, on Den's real server (the demo distribution), compared
 * element by element with the kit's reference: Den's nav as it was signed
 * off. At 1280 and 390, in Chromium and WebKit.
 *
 * The same spec runs in every product: a host imports collectNav and
 * compareNav and the reference files, and compares its own page. A
 * difference names the element, the property and both values.
 *
 * The comparer must not go blind: each red case below changes one thing on
 * the live page (the search field 3 px over, its corners, the bell gone,
 * two elements swapped, a font weight) and must fail on exactly that; a
 * change inside a host slot (Den's status chip) must pass; a theme token
 * changed fails unless it is listed.
 *
 * DEN_UI_NAV_CAPTURE=1 writes the reference instead of comparing (take it
 * again only on purpose: it is the look the nav must keep). DEN_PW_WS:
 * Den's own Playwright server (both browsers connect there).
 * DEN_SKIP_BROWSER_TESTS=1 skips when no browser can start.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, BrowserContext, Page } from "playwright";
import { signInUrl } from "../server/helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "../server/helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import {
  collectNav,
  compareNav,
  formatNavDiffs,
  type NavDiff,
  type NavSnapshot,
} from "../../../packages/den-ui/inventory/nav-inventory.js";
import {
  DEN_HOST_SLOTS,
  PIN_CSS,
  PIN_DIR,
  referenceFile,
} from "./nav-inventory-helpers.js";

const CAPTURE = process.env.DEN_UI_NAV_CAPTURE === "1";
const BROWSERS = ["chromium", "webkit"] as const;
type BrowserName = (typeof BROWSERS)[number];
const WIDTHS = [
  [1280, 900],
  [390, 844],
] as const;

let s: AgentsPageServer | null = null;
const browsers: Partial<Record<BrowserName, Browser>> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const b of BROWSERS)
      browsers[b] = process.env.DEN_PW_WS
        ? await pw[b].connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await pw[b].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
}, 90_000);

const skip = (b: BrowserName) => !browsers[b] || !s;

/** Den's /settings page, as the reference was taken: fixed version, fonts. */
async function open(
  b: BrowserName,
  width: number,
  height: number,
): Promise<{ p: Page; ctx: BrowserContext }> {
  const ctx = await browsers[b]!.newContext({
    viewport: { width, height },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("den-changelog-seen", "9.9.0");
    } catch {
      /* none */
    }
  });
  await ctx.route("**/__pin-fonts/**", (r) => {
    const f = new URL(r.request().url()).pathname.split("/").pop()!;
    if (f === "pin.css")
      return r.fulfill({ contentType: "text/css", body: PIN_CSS });
    return r.fulfill({
      contentType: "font/woff2",
      body: fs.readFileSync(path.join(PIN_DIR, path.basename(f))),
    });
  });
  await ctx.addInitScript(() => {
    const add = () => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "/__pin-fonts/pin.css";
      document.head.prepend(l);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add);
  });
  await ctx.route("**/api/changelog", (r) => r.fulfill({ json: [] }));
  await ctx.route("**/api/server-info", async (route) => {
    const res = await route.fetch();
    const j = (await res.json()) as Record<string, unknown>;
    j.version = "9.9.0";
    j.fresh = false;
    j.engineStale = false;
    j.onDisk = { version: "9.9.0" };
    await route.fulfill({ response: res, json: j });
  });
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(
    () =>
      "denShell" in window &&
      /\d/.test(
        document.querySelector("#version-pill .v-txt")?.textContent ?? "",
      ) &&
      document.querySelectorAll(".den-rail .den-ni").length > 1,
    undefined,
    { timeout: 20_000 },
  );
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
  await p
    .waitForFunction(() => !document.querySelector(".den-toast"), undefined, {
      timeout: 10_000,
    })
    .catch(() => {});
  await p.waitForTimeout(400);
  await p.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.(),
  );
  return { p, ctx };
}

function readRef(b: BrowserName, w: number): NavSnapshot {
  return JSON.parse(
    fs.readFileSync(referenceFile(b, w), "utf-8"),
  ) as NavSnapshot;
}

/** The page's nav after `change` ran in the page, compared with the reference. */
async function diffAfter(
  b: BrowserName,
  w: number,
  h: number,
  change: (arg: string) => void,
  opts: { hostSlots?: string[]; themeTokens?: string[]; arg?: string } = {},
): Promise<NavDiff[]> {
  const { p, ctx } = await open(b, w, h);
  try {
    await p.evaluate(change, opts.arg ?? "");
    await p.waitForTimeout(100);
    return compareNav(await collectNav(p), readRef(b, w), {
      hostSlots: opts.hostSlots ?? DEN_HOST_SLOTS,
      themeTokens: opts.themeTokens,
    });
  } finally {
    await ctx.unrouteAll({ behavior: "ignoreErrors" });
    await ctx.close();
  }
}

const SEARCH = "#den-search";

for (const b of BROWSERS)
  describe(`nav inventory, ${b}`, () => {
    for (const [w, h] of WIDTHS)
      it(`Den's nav is the reference at ${w}`, async () => {
        if (skip(b)) return;
        const { p, ctx } = await open(b, w, h);
        try {
          const snap = await collectNav(p);
          if (CAPTURE) {
            fs.mkdirSync(path.dirname(referenceFile(b, w)), {
              recursive: true,
            });
            fs.writeFileSync(
              referenceFile(b, w),
              JSON.stringify(snap, null, 1) + "\n",
            );
            return;
          }
          const ref = readRef(b, w);
          // The search field and its parts are in the reference, styled.
          // On a phone the field is its icon alone.
          const parts =
            w > 600
              ? [
                  SEARCH,
                  `${SEARCH} > span.den-search-ph`,
                  `${SEARCH} > kbd`,
                  `${SEARCH} > span.den-search-ic`,
                ]
              : [SEARCH, `${SEARCH} > span.den-search-ic`];
          for (const k of parts) {
            const e = ref.elements.find((x) => x.key === k);
            expect(e?.style["border-top-left-radius"]).toBeTruthy();
            expect(e?.style["font-weight"]).toBeTruthy();
          }
          expect(
            formatNavDiffs(
              compareNav(snap, ref, { hostSlots: DEN_HOST_SLOTS }),
            ),
          ).toBe("");
        } finally {
          await ctx.unrouteAll({ behavior: "ignoreErrors" });
          await ctx.close();
        }
      }, 60_000);

    if (CAPTURE) return;

    // ── red cases: each one change, each must fail on exactly it ─────────
    const [W, H] = WIDTHS[0];

    it("fails when the search field moves 3 px", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document
          .querySelector<HTMLElement>("#den-search")!
          .style.setProperty("transform", "translateX(3px)");
      });
      expect(d).toContainEqual(
        expect.objectContaining({ key: SEARCH, property: "box.left" }),
      );
      expect(d).toContainEqual(
        expect.objectContaining({
          key: `${SEARCH} > kbd`,
          property: "box.left",
        }),
      );
    }, 60_000);

    it("fails when the search field's corners change", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document
          .querySelector<HTMLElement>("#den-search")!
          .style.setProperty("border-radius", "13px");
      });
      expect(d.map((x) => `${x.key} ${x.property} → ${x.actual}`)).toEqual([
        `${SEARCH} style.border-top-left-radius → 13px`,
        `${SEARCH} style.border-top-right-radius → 13px`,
        `${SEARCH} style.border-bottom-right-radius → 13px`,
        `${SEARCH} style.border-bottom-left-radius → 13px`,
      ]);
    }, 60_000);

    it("fails when the bell is gone", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document.querySelector("#den-bell")!.remove();
      });
      expect(d).toContainEqual(
        expect.objectContaining({
          key: "#den-bell",
          property: "element",
          reference: "present",
          actual: "missing",
        }),
      );
    }, 60_000);

    it("fails when two elements swap", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        const bell = document.querySelector("#den-bell")!;
        const ver = document.querySelector("#version-pill")!;
        ver.after(bell);
      });
      const moved = d.filter((x) => x.property === "order").map((x) => x.key);
      // One of the two (and its own parts) is out of order; nothing else.
      expect(moved.length).toBeGreaterThan(0);
      expect(
        moved.filter((k) => !/^#(den-bell|version-pill)\b/.test(k)),
      ).toEqual([]);
      expect(moved).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^#(den-bell|version-pill)$/),
        ]),
      );
    }, 60_000);

    it("fails when a font weight changes", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document
          .querySelector<HTMLElement>("#den-search .den-search-ph")!
          .style.setProperty("font-weight", "700");
      });
      expect(d).toContainEqual(
        expect.objectContaining({
          key: `${SEARCH} > span.den-search-ph`,
          property: "style.font-weight",
          actual: "700",
        }),
      );
    }, 60_000);

    it("fails when the search's ⌘K or icon is gone", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document.querySelector("#den-search kbd")!.remove();
        document.querySelector("#den-search .den-search-ic")!.remove();
      });
      const missing = d
        .filter((x) => x.property === "element")
        .map((x) => x.key);
      expect(missing).toEqual(
        expect.arrayContaining([
          `${SEARCH} > kbd`,
          `${SEARCH} > span.den-search-ic`,
        ]),
      );
    }, 60_000);

    it("passes when a host slot's contents change (the status chip)", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        const st = document.querySelector("#den-status")!;
        st.querySelector(".den-n")!.textContent = "3 of 4 up";
        st.querySelector(".den-dot")!.className = "den-dot bad";
        st.setAttribute("aria-busy", "false");
      });
      expect(formatNavDiffs(d)).toBe("");
    }, 60_000);

    it("the same change fails when the chip is not a host slot", async () => {
      if (skip(b)) return;
      const d = await diffAfter(
        b,
        W,
        H,
        () => {
          const st = document.querySelector("#den-status")!;
          st.querySelector(".den-n")!.textContent = "3 of 4 up";
        },
        { hostSlots: DEN_HOST_SLOTS.filter((x) => x !== "#den-status") },
      );
      expect(d).toContainEqual(
        expect.objectContaining({
          key: "#den-status > span.den-n",
          property: "name",
          actual: "3 of 4 up",
        }),
      );
    }, 60_000);

    it("a theme token changed fails, unless it is listed", async () => {
      if (skip(b)) return;
      const ref = readRef(b, W);
      // A colour of the search field's that comes from a token.
      const ph = ref.elements.find(
        (x) => x.key === `${SEARCH} > span.den-search-ph`,
      )!;
      const token = (ref.tokens[ph.style.color] ?? [])[0];
      expect(token).toMatch(/^--/);
      const change = (t: string) =>
        document.documentElement.style.setProperty(t, "rgb(1, 2, 3)");
      const red = await diffAfter(b, W, H, change, { arg: token });
      expect(red).toContainEqual(
        expect.objectContaining({
          key: `${SEARCH} > span.den-search-ph`,
          property: "style.color",
          actual: "rgb(1, 2, 3)",
        }),
      );
      const green = await diffAfter(b, W, H, change, {
        themeTokens: [token!],
        arg: token,
      });
      expect(
        green.filter((x) => x.key === `${SEARCH} > span.den-search-ph`),
      ).toEqual([]);
    }, 90_000);
  });
