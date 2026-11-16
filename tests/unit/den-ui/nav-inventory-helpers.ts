/**
 * Issue 95: what Den's nav inventory test (nav-inventory.browser.test.ts)
 * shares: Den's host slots and where the reference is. The font pin is
 * the kit's (pinNavFonts, ./inventory).
 */
import * as path from "path";

/** The kit's nav reference files. */
export const REFERENCE_DIR = path.join(
  __dirname,
  "../../../packages/den-ui/inventory/reference",
);

/** One reference: Den's nav in `browser` at `width`. */
export function referenceFile(browser: string, width: number): string {
  return path.join(REFERENCE_DIR, `den-${browser}-${width}.json`);
}

/**
 * The parts of the bar Den fills with its own live contents: the status
 * chip (its words and dot follow the services), the Runs chip, the sudo
 * ask (shown only while a run waits) and the bell's count.
 */
export const DEN_HOST_SLOTS = [
  "#den-status",
  "#den-runs",
  "#den-lock",
  ".den-bell-n",
];
