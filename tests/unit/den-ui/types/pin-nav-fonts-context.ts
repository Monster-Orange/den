/**
 * Issue 95, a type check (`npm run typecheck` covers this file): a real
 * Playwright BrowserContext goes to the kit's pinNavFonts with no cast.
 * Playwright's route and addInitScript resolve to a Disposable, so the
 * kit's NavFontContext must accept any result.
 */
import type { BrowserContext } from "playwright";
import { pinNavFonts } from "../../../../packages/den-ui/inventory/nav-inventory.js";

export async function pinRealContext(c: BrowserContext): Promise<void> {
  await pinNavFonts(c);
}
