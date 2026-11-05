/**
 * Product identity shown to people: the banner, web page titles and the help
 * header. Read from the org config's `brand:` block, defaulting to the
 * profile's name (den.yml). Runtime names (env vars, files, directories) come
 * from the profile, never from the brand.
 *
 *   brand:
 *     name: Acme Dev                 # shown in titles and the banner
 *     tagline: Acme local dev and E2E harness
 *     banner: [ "...", "..." ]       # optional ASCII art lines
 *     theme: acme                    # the web UI's default theme (an id in
 *                                    # plugins/<id>/, or den)
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { getDistRoot } from "./paths.js";
import { product } from "./product.js";

export interface BrandConfig {
  name: string;
  tagline: string;
  banner?: string[];
  /** The web UI's default theme id; the user's appearance.theme wins. */
  theme?: string;
}

export function defaultBrand(): BrandConfig {
  return { name: product().title, tagline: "Local dev and E2E harness" };
}

let cached: BrandConfig | null = null;

export function readBrand(root: string = getDistRoot()): BrandConfig {
  if (cached) return cached;
  const fallback = defaultBrand();
  let raw: Partial<BrandConfig> = {};
  try {
    const parsed = yaml.parse(
      fs.readFileSync(path.join(root, product().configFile), "utf-8"),
    ) as { brand?: Partial<BrandConfig> } | null;
    raw = parsed?.brand ?? {};
  } catch {
    /* no config — defaults */
  }
  cached = {
    name: raw.name?.trim() || fallback.name,
    tagline: raw.tagline?.trim() || fallback.tagline,
    banner: Array.isArray(raw.banner) ? raw.banner.map(String) : undefined,
    ...(typeof raw.theme === "string" && raw.theme.trim()
      ? { theme: raw.theme.trim() }
      : {}),
  };
  return cached;
}

/** The brand name as a slug: "Acme Dev" → "acme-dev". Names the web route. */
export function brandSlug(brand: BrandConfig = readBrand()): string {
  const s = brand.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || product().name;
}

export function resetBrandCache(): void {
  cached = null;
}

/** Put the brand name in an HTML page's <title> (pages carry the product title). */
export function brandHtmlTitle(html: string, brand: BrandConfig): string {
  const title = product().title;
  if (brand.name === title) return html;
  return html.replace(
    /<title>([^<]*)<\/title>/i,
    (_m, t: string) =>
      `<title>${t.split(title).join(escapeHtml(brand.name))}</title>`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}
