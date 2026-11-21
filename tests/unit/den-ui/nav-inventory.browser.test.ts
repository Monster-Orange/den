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
  navWarnings,
  searchSlotDiffs,
  NAV_BROWSER_IMAGE,
  NAV_THEME,
  pinNavFonts,
  type NavDiff,
  type NavSnapshot,
} from "../../../packages/den-ui/inventory/nav-inventory.js";
import { DEN_HOST_SLOTS, referenceFile } from "./nav-inventory-helpers.js";
import { launchBrowser } from "../helpers/browser.js";

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
    // PINNED: DEN_PW_WS is set, so this connects and never launches.
    for (const b of BROWSERS) browsers[b] = await launchBrowser(pw[b]);
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
  // The kit's font pin (./inventory): the faces the reference was taken
  // with, the kit's own files.
  await pinNavFonts(ctx);
  await ctx.route("**/api/changelog", (r) => r.fulfill({ json: [] }));
  // The reference's account: a signed-in person with a name, a login and
  // a role (invented). The kit draws the name over @login.
  await ctx.route("**/api/session", async (route) => {
    const res = await route.fetch();
    const j = (await res.json()) as Record<string, unknown>;
    j.identity = {
      kind: "github",
      via: "github",
      login: "ada-fixture",
      name: "Ada Fixture",
      role: "Owner",
    };
    await route.fulfill({ response: res, json: j });
  });
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
  await navStill(p);
  await p.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.(),
  );
  return { p, ctx };
}

/**
 * Waits until the nav holds still: no transition or animation with an end
 * is running, and the top bar's and rail's markup and boxes read the same
 * on two animation frames in a row. Replaces a fixed settle time: it
 * returns as soon as the nav is drawn, and fails (at 10 s) if it never is.
 */
async function navStill(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __navLast?: string };
      const busy = document
        .getAnimations()
        .some(
          (a) =>
            a.playState === "running" &&
            a.effect?.getComputedTiming().endTime !== Infinity,
        );
      const parts = [...document.querySelectorAll("header, #den-rail")].map(
        (el) => {
          const r = el.getBoundingClientRect();
          return `${el.outerHTML}|${r.x},${r.y},${r.width},${r.height}`;
        },
      );
      const now = parts.join("\n");
      const same = !busy && parts.length > 0 && now === w.__navLast;
      w.__navLast = now;
      return same;
    },
    undefined,
    { polling: "raf", timeout: 10_000 },
  );
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
    await navStill(p);
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
 * own change and what it moves, nothing else. Issue 303: the search and
 * the chips row sit in fixed slots, so a gone bell or a wider chip moves
 * neither.
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
    // Off its slot too (searchSlot, from the viewport alone).
    "#den-search slot.x",
  ],
  bell: [
    "#den-bell > svg element",
    "#den-bell element",
    "header.den-top > div.den-chips > button.den-rb > kbd box.left",
    "header.den-top > div.den-chips > button.den-rb > kbd box.right",
    "header.den-top > div.den-chips > button.den-rb > span box.left",
    "header.den-top > div.den-chips > button.den-rb > span box.right",
    "header.den-top > div.den-chips > button.den-rb > svg box.left",
    "header.den-top > div.den-chips > button.den-rb > svg box.right",
    "header.den-top > div.den-chips > button.den-rb box.left",
    "header.den-top > div.den-chips > button.den-rb box.right",
    // The host's chips' group (a box since 0.7.1) takes the room.
    "header.den-top > div.den-chips > div.den-end box.right",
  ],
  swap: [
    "#den-bell > svg box.left",
    "#den-bell > svg box.right",
    "#den-bell > svg order",
    "#den-bell box.left",
    "#den-bell box.right",
    "#den-bell order",
    "#den-bell slot.x",
    "#version-pill > span.v-txt box.left",
    "#version-pill > span.v-txt box.right",
    "#version-pill box.left",
    "#version-pill box.right",
    "#version-pill slot.x",
    "header.den-top > div.den-chips > button.den-rb slot.x",
  ],
  kbdIcon: [
    "#den-search > kbd element",
    "#den-search > span.den-search-ic element",
    "#den-search > span.den-search-ph box.right",
  ],
  notSlot: [
    "#den-status > span.den-dot box.left",
    "#den-status > span.den-dot box.right",
    "#den-status > span.den-n box.left",
    "#den-status > span.den-n name",
    "#den-status box.left",
    "#den-status name",
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
          // 0.7.1: Den draws its account and search with the kit.
          expect(navWarnings(snap)).toEqual([]);
        } finally {
          await ctx.unrouteAll({ behavior: "ignoreErrors" });
          await ctx.close();
        }
      }, 60_000);

    if (CAPTURE) return;

    // ── red cases: each one change, each must fail on exactly it ─────────
    const [W, H] = WIDTHS[0];
    const PH = `${SEARCH} > span.den-search-ph`;

    // Issue 303: the search never moves: at widths with no reference,
    // its box is checked against searchSlot alone.
    for (const vw of [1100, 960])
      it(`Den's search sits at searchSlot at ${vw}`, async () => {
        if (skip(b)) return;
        const { p, ctx } = await open(b, vw, H);
        try {
          const snap = await snapOf(p);
          expect(formatNavDiffs(searchSlotDiffs(snap))).toBe("");
          // Den's numbers before the fix (397.5 at 1100) fail.
          const off = structuredClone(snap);
          off.elements.find((e) => e.key === SEARCH)!.box.x = 464;
          expect(searchSlotDiffs(off).map((d) => d.property)).toEqual([
            "slot.x",
          ]);
        } finally {
          await ctx.unrouteAll({ behavior: "ignoreErrors" });
          await ctx.close();
        }
      }, 60_000);

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

    it("fails when a host words the search its own way (placeholder, name)", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        const s = document.querySelector<HTMLElement>("#den-search")!;
        s.querySelector(".den-search-ph")!.textContent = "Find anything…";
        s.setAttribute("aria-label", "Find anything");
      });
      // The kit's words: one search in every product.
      expect(
        d.filter((x) => x.property === "name").map((x) => [x.key, x.actual]),
      ).toEqual([
        [SEARCH, "Find anything"],
        [PH, "Find anything…"],
      ]);
    }, 60_000);

    it("fails when the search's ⌘K or icon is gone", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document.querySelector("#den-search kbd")!.remove();
        document.querySelector("#den-search .den-search-ic")!.remove();
      });
      expect(ids(d)).toEqual(EXPECT.kbdIcon);
    }, 60_000);

    // ── host content (data-nav-role): the host's words and how many ──────
    // Crumbs, rail pages, group headings and the brand's title are the
    // host's: their count, text and width pass. The first of each role is still styled like the reference's.

    it("fails when a host restyles its first crumb (padding, colour)", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        const c = document.querySelector<HTMLElement>(
          '[data-nav-role="crumb"]',
        )!;
        const pad = parseFloat(getComputedStyle(c).paddingLeft);
        c.style.setProperty("padding-left", `${pad + 2}px`);
        c.style.setProperty("color", "rgb(1, 2, 3)");
      });
      const props = new Set(d.map((x) => x.property));
      expect(props).toContain("style.padding-left");
      expect(props).toContain("style.color");
      // Only styles, and only on the crumb: what it moves is allowed.
      expect(d.filter((x) => !x.property.startsWith("style."))).toEqual([]);
    }, 60_000);

    it("fails when a host restyles its first rail page (padding, colour)", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        const pg = document.querySelector<HTMLElement>(
          '.den-rail [data-nav-role="page"]',
        )!;
        const pad = parseFloat(getComputedStyle(pg).paddingTop);
        pg.style.setProperty("padding-top", `${pad + 2}px`);
        pg.style.setProperty("color", "rgb(1, 2, 3)");
      });
      const props = new Set(d.map((x) => x.property));
      expect(props).toContain("style.padding-top");
      expect(props).toContain("style.color");
      // 2px taller: its height style says so (the box is in tolerance).
      expect(props).toContain("style.height");
      expect(
        d.filter((x) => !/^(style\.|box\.height$)/.test(x.property)),
      ).toEqual([]);
    }, 60_000);

    const HOST_PASSES: [string, () => void][] = [
      [
        "an extra rail page",
        () => {
          const pages = document.querySelectorAll(
            '.den-rail [data-nav-role="page"]',
          );
          const last = pages[pages.length - 1]!;
          const more = last.cloneNode(true) as HTMLElement;
          more.setAttribute("data-nav", "another-page");
          more.querySelector(".den-lbl")!.textContent = "Another page";
          last.after(more);
        },
      ],
      [
        "a missing rail page",
        () => {
          const pages = document.querySelectorAll(
            '.den-rail [data-nav-role="page"]',
          );
          pages[pages.length - 1]!.remove();
        },
      ],
      [
        "a crumb's text",
        () => {
          const v = document.querySelector(
            '[data-nav-role="crumb"] .den-vn, [data-nav-role="crumb"] .den-org-name',
          )!;
          v.textContent = "A much longer company name";
        },
      ],
      [
        // Issue 303: a long name gives way in the left part; the search
        // and the kit's right-side items stay where they are.
        "a 54-character project name",
        () => {
          const v = document.querySelector("#ws-pill .den-vn")!;
          v.textContent =
            "The Quarterly Planning Project With A Very Long Name 12";
        },
      ],
      [
        "a 54-character company and project name",
        () => {
          const o = document.querySelector(
            '[data-nav-role="crumb"] .den-org-name, [data-nav-role="crumb"] .den-vn',
          )!;
          o.textContent =
            "The North Country Cooperative of Gardeners and Growers";
          document.querySelector("#ws-pill .den-vn")!.textContent =
            "The Quarterly Planning Project With A Very Long Name 12";
        },
      ],
      [
        "the brand's title",
        () => {
          document.querySelector(".den-title")!.textContent = "Another app";
        },
      ],
    ];
    // 0.7.1: the kit's slots compared by their content's shape. Den's
    // reference draws one line; another app drawing a name and @login
    // (its two lines and their fields) is not the same component.
    // (The change runs in the page: its one argument is JSON.)
    const drawAccount = (arg: string) => {
      const { shape, lines } = JSON.parse(arg) as {
        shape: string;
        lines: string[];
      };
      const a = document.querySelector<HTMLElement>("[data-den-account]")!;
      a.setAttribute("data-nav-shape", shape);
      a.querySelector(".den-lbl")!.innerHTML = lines
        .map((t, i) => `<span class="den-acct-${i ? "l" : "n"}">${t}</span>`)
        .join("");
    };
    it("fails when a crumb's label shows while its value is hidden (COMPANY / with no value)", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        // The crumb's value: its one child that is not the label.
        const v = document.querySelector<HTMLElement>(
          "#org-crumb > :not(.den-k)",
        );
        if (v)
          Object.assign(v.style, {
            width: "0",
            minWidth: "0",
            overflow: "hidden",
            padding: "0",
          });
      });
      expect(ids(d)).toContain("#org-crumb crumb.value");
    }, 60_000);

    it("fails when a host's account entry draws its role (@login · role)", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, drawAccount, {
        arg: JSON.stringify({
          shape: "login,role",
          lines: ["@a-person · Owner"],
        }),
      });
      expect(ids(d)).toContain("#den-ident shape");
    }, 60_000);

    it("passes a host's account entry with @login alone (one line)", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, drawAccount, {
        arg: JSON.stringify({ shape: "login", lines: ["@a-person"] }),
      });
      expect(formatNavDiffs(d)).toBe("");
    }, 60_000);

    it("fails when a host still passes the old label/detail", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document
          .querySelector("[data-den-account]")!
          .setAttribute("data-nav-legacy", "account");
      });
      expect(ids(d)).toEqual(["#den-ident legacy"]);
    }, 60_000);

    it("fails when a host's search is another width at the same viewport", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, W, H, () => {
        document
          .querySelector<HTMLElement>("#den-search")!
          .style.setProperty("width", "420px");
      });
      // Pinned: its right edge moves, with no host-shift excuse.
      expect(ids(d)).toContain("#den-search box.right");
    }, 60_000);

    it("passes on host content at 390: the account entry's words", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, 390, 844, () => {
        const who = document.querySelector("[data-den-account] .den-acct-n");
        if (who) who.textContent = "A person with a much longer name";
      });
      expect(formatNavDiffs(d)).toBe("");
    }, 60_000);

    it("fails at 390 when a host names the search its own way", async () => {
      if (skip(b)) return;
      const d = await diffAfter(b, 390, 844, () => {
        document
          .querySelector("#den-search")!
          .setAttribute("aria-label", "Find anything");
      });
      expect(formatNavDiffs(d)).toBe(
        "top #den-search name: Search → Find anything",
      );
    }, 60_000);

    for (const [what, change] of HOST_PASSES)
      it(`passes on host content: ${what}`, async () => {
        if (skip(b)) return;
        const d = await diffAfter(b, W, H, change);
        expect(formatNavDiffs(d)).toBe("");
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
