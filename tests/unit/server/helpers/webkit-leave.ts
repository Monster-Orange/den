/**
 * WebKit refuses a fetch that a page starts after a navigation has begun
 * loading the next page, and reports it as a page error: "Fetch API cannot
 * load <url> due to access control checks." A page's polls run on timers,
 * so one can start in that gap. That error is not the page's fault.
 *
 * This lets a browser suite ignore exactly that, and nothing else:
 *   - only that message, for one URL of the test's own server;
 *   - only while the test's own navigation is leaving the page (leave(p)
 *     before the click or goto; it ends when the next page commits).
 * Every other page error still goes to the suite.
 *
 *   const nav = leaveRefusals(() => s.base);
 *   nav.watch(page, (msg) => errors.push(msg));
 *   nav.leave(page); await page.goto(next);
 */
import type { Page } from "playwright";

/** That one message, for a URL on `base`'s host. */
export function isRefusedOwnFetch(msg: string, base: string): boolean {
  const m =
    /^(?:Fetch API cannot load )?(\S+) due to access control checks\.$/.exec(
      msg,
    );
  return !!m && m[1]!.includes(`/${new URL(base).host}/`);
}

export function leaveRefusals(base: () => string) {
  const leaving = new Set<Page>();
  return {
    /** The test's own navigation is about to leave `p`. */
    leave(p: Page): void {
      leaving.add(p);
    },
    /** `p`'s page errors go to `onError`, but for the one refused fetch. */
    watch(p: Page, onError: (msg: string) => void): void {
      p.on("pageerror", (e) => {
        if (leaving.has(p) && isRefusedOwnFetch(e.message, base())) return;
        onError(e.message);
      });
      // The next page is in: the one before it starts nothing more.
      p.on("framenavigated", (f) => {
        if (f === p.mainFrame()) leaving.delete(p);
      });
    },
  };
}
