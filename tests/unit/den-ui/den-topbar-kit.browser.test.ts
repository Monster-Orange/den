/**
 * Issue 95 (den-ui 0.7.0): every element in Den's top bar is the kit's
 * markup, in the kit's order. Den draws none of the bar itself: it gives
 * the kit words, values and callbacks, and puts its own markup only in
 * the kit's slots.
 *
 * How: before Den's shell.js runs, the kit's classic script
 * (window.DenUIShell) is wrapped, so every piece the kit draws is recorded
 * as it leaves the kit. Then, on Den's real page:
 *
 * 1. Each slot Den gave shellHtml is made of the kit's own output only:
 *    `start` is exactly the kit's scope crumbs and search field; `bell` is
 *    exactly the kit's bell; `account` is the kit's ◐ ▾ in one plain
 *    container (#den-user). Only `end` holds Den's own chips (status, Runs,
 *    the admin-password ask): host content, in the kit's slot for it.
 * 2. The live bar is the kit's bar: drawn again by the kit from the same
 *    model, its element tree (tags, ids, classes) is the live one's, in
 *    the same order, except inside the end slot (Den's chips), the brand
 *    mark (Den's theme draws its mark into the kit's slot) and the kit's
 *    update-waiting pill (shown only while the server is out of date).
 *
 * Kept red-first: Den drawing one piece of its old crumb markup itself
 * fails check 1.
 *
 * DEN_PW_WS: Den's own Playwright server. DEN_SKIP_BROWSER_TESTS=1 skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "../server/helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "../server/helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const BROWSERS = ["chromium", "webkit"] as const;
type BrowserName = (typeof BROWSERS)[number];

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
  await closeBrowserSuite({ browsers: Object.values(browsers), servers: [s] });
}, 90_000);

/** The kit's pieces of the bar, recorded as the kit draws them. */
const PIECES = [
  "scopeHtml",
  "scopeCrumbHtml",
  "searchHtml",
  "bellButtonHtml",
  "appearanceButtonHtml",
];

/** Wraps window.DenUIShell as the kit's classic script sets it. */
function spy(pieces: string[]): void {
  type Fn = (...a: unknown[]) => unknown;
  const w = window as unknown as {
    __kit: { fn: string; out: string }[];
    __shellModel: unknown;
  };
  w.__kit = [];
  let kit: Record<string, Fn> | undefined;
  Object.defineProperty(window, "DenUIShell", {
    configurable: true,
    get: () => kit,
    set(v: Record<string, Fn>) {
      const wrapped: Record<string, Fn> = { ...v };
      for (const name of pieces)
        if (typeof v[name] === "function")
          wrapped[name] = (...a: unknown[]) => {
            const out = v[name]!(...a) as string;
            w.__kit.push({ fn: name, out });
            return out;
          };
      wrapped.shellHtml = (...a: unknown[]) => {
        w.__shellModel = JSON.parse(JSON.stringify(a[0]));
        return v.shellHtml!(...a);
      };
      kit = wrapped;
    },
  });
}

async function open(b: Browser): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(spy, PIECES);
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(() => "denShell" in window, undefined, {
    timeout: 20_000,
  });
  // The org and project crumbs are filled in (header.js), the bell wired.
  await p
    .waitForFunction(
      () =>
        !document.getElementById("org-crumb")?.hidden &&
        document.getElementById("den-bell")?.dataset.wired === "1",
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {});
  return p;
}

/** Check 1: what Den put in each slot, against what the kit drew. */
const slotCheck = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as {
      __kit: { fn: string; out: string }[];
      __shellModel: { slots?: Record<string, string> };
    };
    const outs = (fn: string) =>
      w.__kit.filter((k) => k.fn === fn).map((k) => k.out);
    const slots = w.__shellModel?.slots ?? {};
    const problems: string[] = [];
    // start: the kit's crumbs, then the kit's search, and nothing else.
    const starts = outs("scopeHtml").flatMap((sc) =>
      outs("searchHtml").map((se) => sc + se),
    );
    if (!starts.includes(slots.start ?? ""))
      problems.push(
        "start is not exactly the kit's scopeHtml + searchHtml output",
      );
    if (!outs("bellButtonHtml").includes(slots.bell ?? ""))
      problems.push("bell is not exactly the kit's bellButtonHtml output");
    const acct =
      /^<span class="den-user" id="den-user">([\s\S]*)<\/span>$/.exec(
        slots.account ?? "",
      );
    if (!acct || !outs("appearanceButtonHtml").includes(acct[1]!))
      problems.push(
        "account is not the kit's appearanceButtonHtml in its container",
      );
    return problems;
  });

/** Check 2: the live bar's tree against the kit drawing the same model. */
const treeCheck = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as {
      __shellModel: Record<string, unknown>;
      DenUIShell: { topBarHtml: (m: unknown) => string };
    };
    // Where Den's own content is allowed, and the kit's state-only pill.
    const own = (el: Element) => el.id === "den-mark" || el.id === "stale-pill";
    const endIds = new Set(["den-status", "den-runs", "den-lock"]);
    const sig = (el: Element, path: string, out: string[]) => {
      if (el.id === "stale-pill") return;
      // The mark's look is the theme's: its tag and id only.
      const cls =
        el.id === "den-mark" ? "" : [...el.classList].sort().join(".");
      const here = `${path}/${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls ? "." + cls : ""}`;
      out.push(here);
      if (own(el) || endIds.has(el.id)) return;
      for (const c of el.children) sig(c, here, out);
    };
    const live: string[] = [];
    sig(document.querySelector("header.den-top")!, "", live);
    const tpl = document.createElement("template");
    tpl.innerHTML = w.DenUIShell.topBarHtml(w.__shellModel);
    const kit: string[] = [];
    sig(tpl.content.querySelector("header.den-top")!, "", kit);
    return { live, kit };
  });

for (const name of BROWSERS)
  describe(`Den's top bar is the kit's (${name})`, () => {
    it("each slot holds the kit's own output; only the end slot holds Den's chips", async () => {
      const b = browsers[name];
      if (!b || !s) return;
      const p = await open(b);
      try {
        await expect(slotCheck(p)).resolves.toEqual([]);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("the mark Den's theme draws is the kit's markHtml({ src, label }), attribute for attribute", async () => {
      const b = browsers[name];
      if (!b || !s) return;
      const p = await open(b);
      try {
        const r = await p.evaluate(() => {
          const w = window as unknown as {
            DenUIShell: {
              markHtml?: (m: { src: string; label: string }) => string;
            };
          };
          const live = document.getElementById("den-mark")!;
          const img = live.querySelector("img");
          const attrs = (el: Element | null) =>
            el
              ? Object.fromEntries(
                  [...el.attributes]
                    .filter((a) => a.name !== "data-mark")
                    .map((a) => [a.name, a.value]),
                )
              : null;
          const tpl = document.createElement("template");
          tpl.innerHTML =
            w.DenUIShell.markHtml?.({
              src: img?.getAttribute("src") ?? "",
              label: live.title,
            }) ?? "";
          const kit = tpl.content.firstElementChild;
          return {
            live: [attrs(live), attrs(img), live.children.length],
            kit: [
              attrs(kit),
              attrs(kit?.querySelector("img") ?? null),
              kit?.children.length,
            ],
          };
        });
        expect(r.live[0]).toMatchObject({ class: "den-mark den-mark-svg" });
        expect(r.kit).toEqual(r.live);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("every element in the bar is the kit's, in the kit's order", async () => {
      const b = browsers[name];
      if (!b || !s) return;
      const p = await open(b);
      try {
        const { live, kit } = await treeCheck(p);
        expect(live).toEqual(kit);
        // The kit's order, top level and the right group.
        const tops = live.filter((x) => x.split("/").length === 3);
        expect(tops.map((x) => x.replace(/^\/header[^/]*\//, ""))).toEqual([
          "button#den-menu-btn.den-ib.den-menu-btn",
          "a.den-brand",
          "div.den-scope",
          "button#den-search.den-search",
          "div.den-chips",
        ]);
        const chips = live
          .filter((x) => /\/div\.den-chips\/[^/]+$/.test(x))
          .map((x) => x.split("/").pop());
        expect(chips).toEqual([
          "button#den-status.den-chip",
          "button#den-runs.den-chip",
          "button#den-lock.den-chip",
          "button.den-rb.den-rb-top",
          "button#den-bell.den-bell.den-ib",
          "button#version-pill.den-ib.v-pill",
          "span#den-user.den-user",
        ]);
      } finally {
        await p.context().close();
      }
    }, 60_000);
  });
