// mo/no-positional-locator: the "positional" kind of Den's brittle-ratchet scan (rules/brittle-scan.mjs), in a browser test or live check.
import { scan } from "./brittle-scan.mjs";

export const check = (src) => scan(src).positional.map((line) => ({ line, end: line }));
