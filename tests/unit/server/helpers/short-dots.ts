/**
 * Issue 699: a held button shows dots, and the kit's working pop-up opens
 * only after dotsMs (3 s by default). A test about the pop-up itself sets
 * it short on the page's own copy of the kit (the same URL busy-den.js
 * imports), so the suite stays fast. The 3 s default is
 * tests/unit/den-ui/busy-dots.test.ts's.
 */
import type { Page } from "playwright";
import { pageImport } from "./page-import.js";

export function shortDots(p: Page, ms = 300): Promise<unknown> {
  return p.evaluate(
    `${pageImport("/kit/busy.js")}.then((m) => { m.configureBusy({ dotsMs: ${Number(ms)} }); return true; })`,
  );
}
