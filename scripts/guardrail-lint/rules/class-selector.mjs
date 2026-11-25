// mo/no-class-selector: the "classSelectors" kind of Den's brittle-ratchet scan (rules/brittle-scan.mjs), in a browser test or live check.
import { scan } from "./brittle-scan.mjs";

export const check = (src) => scan(src).classSelectors.map((line) => ({ line, end: line }));
