/**
 * den#143: pop-ups that draw or repaint themselves after they show carry
 * their own Report footer, so it is there the moment they show and through
 * every repaint. The page's injector (report-inject.js) adds one a frame
 * later, and a repaint wipes it: the pop-up grows, or Report blinks.
 *
 * reportAtOnce(ctx) watches, in every page of `ctx`, each change to these
 * pop-ups and checks, before the next frame (so before the injector can
 * run), that a shown one has its Report button. reportMisses(p) returns
 * the ones that didn't, once each, by selector; reportSeen(p) the ones
 * that showed at all.
 */
import type { BrowserContext, Page } from "playwright";

/** The pop-ups that must carry their own Report (den#143). */
export const OWN_REPORT = [
  "#den-bell-pop",
  ".den-svp",
  ".dg-panel[role=dialog]",
  "#den-lock-pop",
  ".den-agd",
];

/**
 * The watcher, run in the page before its own scripts. A string, so this
 * file needs no DOM types (the typecheck's ES-only lib).
 */
const WATCH = (sels: string[]) => `(() => {
  const sels = ${JSON.stringify(sels)};
  window.__reportMisses = [];
  window.__reportSeen = [];
  const shown = (el) => {
    if (el.hidden || el.closest("[hidden]")) return false;
    if (getComputedStyle(el).visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const look = () => {
    for (const sel of sels)
      for (const el of document.querySelectorAll(sel)) {
        if (!shown(el)) continue;
        if (!window.__reportSeen.includes(sel)) window.__reportSeen.push(sel);
        if (!el.querySelector("[data-den-report]") &&
            !window.__reportMisses.includes(sel))
          window.__reportMisses.push(sel);
      }
  };
  new MutationObserver(look).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "open", "class", "style", "popover"],
  });
})();`;

export async function reportAtOnce(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript({ content: WATCH(OWN_REPORT) });
}

export function reportMisses(p: Page): Promise<string[]> {
  return p.evaluate("window.__reportMisses") as Promise<string[]>;
}

/** Which of them were shown at all (so a check can't pass on none). */
export function reportSeen(p: Page): Promise<string[]> {
  return p.evaluate("window.__reportSeen") as Promise<string[]>;
}
