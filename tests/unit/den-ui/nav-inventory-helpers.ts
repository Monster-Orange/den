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

/**
 * Issue 1227: the nav check's own Playwright server, from DEN_PW_NAV_WS
 * (`npm run pw:server -- --nav` prints it; CI's den-ui-nav job sets it), or
 * null. DEN_PW_WS alone is not it: a general server may run another build
 * (an ARM machine's native one, issue 635), whose text the references can't
 * match.
 */
export function navServer(env: NodeJS.ProcessEnv): string | null {
  return env.DEN_PW_NAV_WS?.trim() || null;
}
