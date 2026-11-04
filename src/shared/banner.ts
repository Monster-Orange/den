/**
 * The startup banner for the CLI and web server: the org's `brand.banner`
 * lines when configured, else the brand name spelled out. No product's art
 * is built in.
 */
import { readBrand } from "./brand.js";

export const DEN_BANNER_LINES: string[] = (() => {
  const b = readBrand();
  if (b.banner?.length) return b.banner;
  return [`  ${b.name.toUpperCase().split("").join(" ")}`];
})();

export const DEN_SUBTITLE = `  ${readBrand().tagline}`;
export const DEN_DIVIDER = "  ──────────────────────────────────";
