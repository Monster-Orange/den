/**
 * Issue 644: Den's mark and tab icons live in the kit. One head snippet
 * (the favicon, the touch icon, the manifest, the theme colour) and the
 * files it names, in one kit folder (src/site/), so Den and Hub emit the
 * same tags. The mark comes in two drawings: marks/den.svg, and
 * marks/den-16.svg for the 18px brand. In dark mode the mark gets a faint
 * cream edge so its dark tile doesn't sink into a dark bar; never in light.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PKG = path.join(process.cwd(), "packages", "den-ui");
const SITE = path.join(PKG, "src", "site");
const MARKS = path.join(PKG, "src", "marks");

const TILE = "#2b2118";
const CREAM = "#f4efe8";
const ORANGE = "#FF7300";

const read = (f: string) => fs.readFileSync(f, "utf-8");

/** The hrefs of the snippet's <link>s, by rel. */
function links(html: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of html.matchAll(/<link\b([^>]*)>/g)) {
    const rel = /\brel="([^"]+)"/.exec(m[1]!)?.[1] ?? "";
    const href = /\bhref="([^"]+)"/.exec(m[1]!)?.[1] ?? "";
    (out[rel] ??= []).push(href);
  }
  return out;
}

describe("den-ui site head (issue 644)", () => {
  it("the package exports the site folder and the marks", () => {
    const pkg = JSON.parse(read(path.join(PKG, "package.json"))) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports["./site/*"]).toBe("./src/site/*");
    expect(pkg.exports["./marks/*"]).toBe("./src/marks/*");
  });

  it("one snippet: the favicon (ico and svg), the touch icon, the manifest and the theme colour", () => {
    const html = read(path.join(SITE, "head.html"));
    expect(links(html)).toEqual({
      icon: ["/favicon.svg", "/favicon.ico"],
      "apple-touch-icon": ["/apple-touch-icon.png"],
      manifest: ["/site.webmanifest"],
    });
    expect(html.split("\n")).toEqual([
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
      '<link rel="icon" href="/favicon.ico" sizes="any">',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
      '<link rel="manifest" href="/site.webmanifest">',
      `<meta name="theme-color" content="${TILE}">`,
      "",
    ]);
    const ico = fs.readFileSync(path.join(SITE, "favicon.ico"));
    expect(
      Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i]),
    ).toEqual([16, 32, 48]);
    // Tags only: no comment, no script.
    expect(html).not.toMatch(/<!--|<script/i);
    // Every file it names is in the same folder.
    for (const hrefs of Object.values(links(html)))
      for (const h of hrefs)
        expect([h, fs.existsSync(path.join(SITE, h.slice(1)))]).toEqual([
          h,
          true,
        ]);
  });

  it("the manifest is Den's, its icons in the same folder", () => {
    const m = JSON.parse(read(path.join(SITE, "site.webmanifest"))) as {
      name: string;
      short_name: string;
      theme_color: string;
      icons: { src: string; type: string }[];
    };
    expect([m.name, m.short_name, m.theme_color]).toEqual(["Den", "Den", TILE]);
    expect(m.icons.length).toBeGreaterThanOrEqual(3);
    for (const i of m.icons) {
      expect(i.type).toBe("image/png");
      const f = path.join(SITE, i.src.slice(1));
      expect([i.src, fs.existsSync(f)]).toEqual([i.src, true]);
      // A PNG by its first bytes.
      expect(fs.readFileSync(f).subarray(1, 4).toString()).toBe("PNG");
    }
  });

  it("the marks: the tile, the cream arch, the orange door; one named Den", () => {
    for (const [f, size] of [
      ["den.svg", 512],
      ["den-16.svg", 16],
    ] as const) {
      const svg = read(path.join(MARKS, f));
      expect(svg).toMatch(/^<svg /);
      expect(svg).toContain('viewBox="0 0 64 64"');
      expect(svg).toContain(`width="${size}"`);
      for (const c of [TILE, CREAM, ORANGE]) expect(svg).toContain(c);
      expect(svg).toContain("<title>Den</title>");
    }
    // The tab's svg is the small drawing.
    expect(read(path.join(SITE, "favicon.svg"))).toContain(
      'viewBox="0 0 64 64"',
    );
  });

  it("the README tells a host how to use the snippet and the small mark", () => {
    const readme = read(path.join(PKG, "README.md"));
    expect(readme).toContain("site/head.html");
    expect(readme).toContain("marks/den-16.svg");
  });

  it("dark mode only: the mark's cream edge", () => {
    // The edge's colour is a token (no raw colour outside tokens.css).
    expect(read(path.join(PKG, "src", "tokens.css"))).toMatch(
      /--den-mark-edge:\s*rgba\(244,\s*239,\s*232,\s*0?\.18\);/,
    );
    const css = read(path.join(PKG, "src", "shell.css"));
    const EDGE = /box-shadow:\s*0 0 0 1px var\(--den-mark-edge\)/;
    // Each rule that draws the edge, with its selector and the @media it is in.
    const rules: { media: string; selector: string }[] = [];
    let media = "";
    let depth = 0;
    for (const m of css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]*)\{|\}|([^{}]+)(?=\})/g)) {
      if (m[1] !== undefined) {
        const sel = m[1].trim();
        if (sel.startsWith("@media")) media = sel;
        else rules.push({ media: depth ? media : "", selector: sel });
        depth++;
        continue;
      }
      if (m[0] === "}") {
        depth--;
        if (depth === 0) media = "";
        continue;
      }
      if (EDGE.test(m[2] ?? "")) rules[rules.length - 1]!.selector += " ⟵EDGE";
    }
    const edged = rules.filter((r) => r.selector.endsWith("⟵EDGE"));
    expect(edged.length).toBeGreaterThan(0);
    for (const r of edged) {
      expect(r.selector).toMatch(/\.den-mark/);
      const dark =
        /\[data-mode="dark"\]/.test(r.selector) ||
        (/prefers-color-scheme:\s*dark/.test(r.media) &&
          /:not\(\[data-mode\]\)/.test(r.selector));
      expect([r.selector, dark]).toEqual([r.selector, true]);
      expect(r.selector).not.toMatch(/data-mode="light"/);
    }
    // Explicit dark, and dark by the system with no mode set.
    expect(edged.some((r) => /\[data-mode="dark"\]/.test(r.selector))).toBe(
      true,
    );
    expect(edged.some((r) => /prefers-color-scheme/.test(r.media))).toBe(true);
  });
});
