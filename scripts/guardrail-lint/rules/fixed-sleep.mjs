// mo/no-fixed-sleep: waitForTimeout(…), or a fixed sleep of 100 ms or more (new Promise((r) => setTimeout(r, 500)),
// or an awaited setTimeout/sleep/delay(500)), in a browser test or live check. The scan is Den's brittle-ratchet's.
import { scan } from "./brittle-scan.mjs";

export const check = (src) => scan(src).sleeps.map((line) => ({ line, end: line }));
