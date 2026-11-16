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
 * change inside a host slot (Den's status chip) must pass; a theme token's
 * colour or a font-family changed fails: both products run in Den's "Den"
 * theme (NAV_THEME), so no colour or font is exempt.
 *
 * One browser build: the reference was taken on Playwright's image
 * NAV_BROWSER_IMAGE (its run-server, reached through DEN_PW_WS; CI's
 * den-ui-nav job starts the same image). With no DEN_PW_WS the suite
 * skips: a local browser lays text out a few px apart, and its boxes
 * can't match. On another build the comparer fails with "reference taken
 * on X, running on Y".
 *
 * Each red case compares the nav before and after its one change, both
 * against the reference, and asserts exactly the differences the change
 * added: nothing a machine's drift could add or hide.
 *
 * DEN_UI_NAV_CAPTURE=1 writes the reference instead of comparing (take it
 * again only on purpose: it is the look the nav must keep).
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
  NAV_BROWSER_IMAGE,
  NAV_THEME,
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
/** Only the pinned image's run-server can match the reference. */
const PINNED = !!process.env.DEN_PW_WS;
const BROWSERS = ["chromium", "webkit"] as const;
type BrowserName = (typeof BROWSERS)[number];
const WIDTHS = [
  [1280, 900],
  [390, 844],
] as const;

let s: AgentsPageServer | null = null;
const browsers: Partial<Record<BrowserName, Browser>> = {};

beforeAll(async () => {
  if (!PINNED) {
    console.warn(
      `nav inventory: skipped, no DEN_PW_WS (run it on ${NAV_BROWSER_IMAGE})`,
    );
    return;
  }
  try {
    const pw = await import("playwright");
    for (const b of BROWSERS)
      browsers[b] = await pw[b].connect(process.env.DEN_PW_WS!, {
        exposeNetwork: "<loopback>",
      });
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

/** The nav, with the image and the theme the page really draws in. */
async function snapOf(p: Page): Promise<NavSnapshot> {
  const theme = await p.evaluate(() =>
    fetch("/api/themes")
      .then((r) => r.json())
      .then((j: { active?: { id: string; version: string } }) => j.active),
  );
  return collectNav(p, { image: NAV_BROWSER_IMAGE, theme });
}
const id = (d: NavDiff) => `${d.key} ${d.property}`;

/**
 * The differences `change` adds: the page's nav before and after it, each
 * compared with the reference; those already there before are dropped.
 */
async function diffAfter(
  b: BrowserName,
  w: number,
  h: number,
  change: (arg: string) => void,
  opts: { hostSlots?: string[]; arg?: string } = {},
): Promise<NavDiff[]> {
  const { p, ctx } = await open(b, w, h);
  try {
    // The default run: no theme token exempt.
    const o = { hostSlots: opts.hostSlots ?? DEN_HOST_SLOTS };
    const ref = readRef(b, w);
    const before = new Set(compareNav(await snapOf(p), ref, o).map(id));
    await p.evaluate(change, opts.arg ?? "");
    await p.waitForTimeout(100);
    return compareNav(await snapOf(p), ref, o).filter(
      (d) => !before.has(id(d)),
    );
  } finally {
    await ctx.unrouteAll({ behavior: "ignoreErrors" });
    await ctx.close();
  }
}

/** The differences as "key property", sorted. */
const ids = (d: NavDiff[]) => d.map(id).sort();

const SEARCH = "#den-search";

/**
 * What each red case must add, exactly (the same in both browsers): its
 * own change and what it moves, nothing else.
 */
const EXPECT: Record<string, string[]> = {
  move3: [
    "#den-search > kbd box.left",
    "#den-search > kbd box.right",
    "#den-search > span.den-search-ic box.left",
    "#den-search > span.den-search-ic box.right",
    "#den-search > span.den-search-ph box.left",
    "#den-search > span.den-search-ph box.right",
    "#den-search box.left",
    "#den-search box.right",
  ],
  bell: [
    "#den-bell > svg element",
    "#den-bell element",
    "#den-search > kbd box.left",
    "#den-search > kbd box.right",
    "#den-search > span.den-search-ic box.left",
    "#den-search > span.den-search-ic box.right",
    "#den-search > span.den-search-ph box.right",
    "#den-search box.right",
    "header.den-top > div.den-chips > button.den-rb > kbd box.left",
    "header.den-top > div.den-chips > button.den-rb > kbd box.right",
    "header.den-top > div.den-chips > button.den-rb > span box.left",
    "header.den-top > div.den-chips > button.den-rb > span box.right",
    "header.den-top > div.den-chips > button.den-rb > svg box.left",
    "header.den-top > div.den-chips > button.den-rb > svg box.right",
    "header.den-top > div.den-chips > button.den-rb box.left",
    "header.den-top > div.den-chips > button.den-rb box.right",
    "header.den-top > div.den-chips box.left",
  ],
  swap: [
    "#den-bell > svg box.left",
    "#den-bell > svg box.right",
    "#den-bell > svg order",
    "#den-bell box.left",
    "#den-bell box.right",
    "#den-bell order",
    "#version-pill > span.v-txt box.left",
    "#version-pill > span.v-txt box.right",
    "#version-pill box.left",
    "#version-pill box.right",
  ],
  kbdIcon: [
    "#den-search > kbd element",
    "#den-search > span.den-search-ic element",
    "#den-search > span.den-search-ph box.right",
  ],
  notSlot: [
    "#den-search > kbd box.left",
    "#den-search > kbd box.right",
    "#den-search > span.den-search-ic box.left",
    "#den-search > span.den-search-ic box.right",
    "#den-search > span.den-search-ph box.right",
    "#den-search box.right",
    "#den-status > span.den-dot box.left",
    "#den-status > span.den-dot box.right",
    "#den-status > span.den-n box.left",
    "#den-status > span.den-n name",
    "#den-status box.left",
    "#den-status name",
    "header.den-top > div.den-chips box.left",
  ],
  weight: ["#den-search > span.den-search-ph style.font-weight"],
  font: ["#den-search > span.den-search-ph style.font-family"],
};

for (const b of BROWSERS)
  describe(`nav inventory, ${b}`, () => {
    for (const [w, h] of WIDTHS)
      it(`Den's nav is the reference at ${w}`, async () => {
        if (skip(b)) return;
        const { p, ctx } = await open(b, w, h);
        try {
          const snap = await snapOf(p);
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
          // Taken on the pinned image (the constant the README names).
          expect(ref.env.image).toBe(NAV_BROWSER_IMAGE);
          // …in Den's "Den" theme, as Den draws its pages today.
          expect(ref.env.theme).toEqual(NAV_THEME);
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
    const PH = `${SEARCH} > span.den-search-ph`;

    it("fails when the search field moves 3 px", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document
          .querySelector<HTMLElement>("#den-search")!
          .style.setProperty("transform", "translateX(3px)");
      });
      expect(ids(d)).toEqual(EXPECT.move3);
    }, 60_000);

    it("fails when the search field's corners change", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document
          .querySelector<HTMLElement>("#den-search")!
          .style.setProperty("border-radius", "13px");
      });
      expect(d.map((x) => `${id(x)} → ${x.actual}`).sort()).toEqual(
        [
          "border-bottom-left-radius",
          "border-bottom-right-radius",
          "border-top-left-radius",
          "border-top-right-radius",
        ].map((r) => `${SEARCH} style.${r} → 13px`),
      );
    }, 60_000);

    it("fails when the bell is gone", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document.querySelector("#den-bell")!.remove();
      });
      expect(ids(d)).toEqual(EXPECT.bell);
    }, 60_000);

    it("fails when two elements swap", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        const bell = document.querySelector("#den-bell")!;
        document.querySelector("#version-pill")!.after(bell);
      });
      expect(ids(d)).toEqual(EXPECT.swap);
    }, 60_000);

    it("fails when a font weight changes", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document
          .querySelector<HTMLElement>("#den-search .den-search-ph")!
          .style.setProperty("font-weight", "700");
      });
      expect(ids(d)).toEqual(EXPECT.weight);
    }, 60_000);

    it("fails when the search's ⌘K or icon is gone", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document.querySelector("#den-search kbd")!.remove();
        document.querySelector("#den-search .den-search-ic")!.remove();
      });
      expect(ids(d)).toEqual(EXPECT.kbdIcon);
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
      expect(ids(d)).toEqual(EXPECT.notSlot);
    }, 60_000);

    it("fails when a theme token's colour changes (no exemptions)", async () => {
      if (skip(b)) return;
      const ref = readRef(b, W);
      // The token the placeholder's colour comes from.
      const ph = ref.elements.find((x) => x.key === PH)!;
      const token = (ref.tokens[ph.style.color] ?? [])[0]!;
      expect(token).toMatch(/^--/);
      const d = await diffAfter(
        b,
        W,
        H,
        (t: string) =>
          document.documentElement.style.setProperty(t, "rgb(1, 2, 3)"),
        { arg: token },
      );
      expect(d).toContainEqual(
        expect.objectContaining({
          key: PH,
          property: "style.color",
          actual: "rgb(1, 2, 3)",
        }),
      );
      // Only colours change: those drawn from that token, nothing else.
      expect(
        d.filter((x) => !/^style\.(color|border-\w+-color)$/.test(x.property)),
      ).toEqual([]);
    }, 60_000);

    it("fails when a font-family changes (no exemptions)", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document
          .querySelector<HTMLElement>("#den-search .den-search-ph")!
          .style.setProperty("font-family", "serif");
      });
      expect(ids(d)).toEqual(EXPECT.font);
    }, 60_000);
  });
