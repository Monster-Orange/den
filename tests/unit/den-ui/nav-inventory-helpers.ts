/**
 * Issue 95: what Den's nav inventory test (nav-inventory.browser.test.ts)
 * shares: Den's host slots, the pinned faces and where the reference is.
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
 * The same glyphs on every machine (as shell-kit-parity.browser.test.ts):
 * the system faces Den's pages name are pinned, in this test only, to the
 * kit's own font files.
 */
export const PIN_DIR = path.join(
  __dirname,
  "../../../packages/den-ui/src/fonts",
);
const PIN_SANS = [
  "-apple-system",
  "BlinkMacSystemFont",
  "Segoe UI",
  "Noto Sans",
  "Hiragino Sans",
  "Noto Sans JP",
  "Helvetica",
  "Arial",
  "Times New Roman",
];
const PIN_MONO = ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas"];
export const PIN_CSS = [
  ...PIN_SANS.flatMap((f) => [
    `@font-face{font-family:"${f}";font-weight:100 449;src:url(/__pin-fonts/rubik-latin-400-normal.woff2) format("woff2")}`,
    `@font-face{font-family:"${f}";font-weight:450 900;src:url(/__pin-fonts/rubik-latin-500-normal.woff2) format("woff2")}`,
  ]),
  ...PIN_MONO.map(
    (f) =>
      `@font-face{font-family:"${f}";src:url(/__pin-fonts/space-mono-latin-400-normal.woff2) format("woff2")}`,
  ),
].join("\n");
