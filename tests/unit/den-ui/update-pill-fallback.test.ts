/**
 * Issue 286: where the browser can't draw the update pill's backdrop blur
 * (a WebKit build without backdrop-filter), the see-through pill sat over
 * the top bar's search box and neither could be read. Under
 * `@supports not (backdrop-filter …)` the pill gets the opaque surface,
 * no tint over it. Where the blur works, the pill's look is unchanged.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const CSS = fs.readFileSync(
  path.join(__dirname, "../../../packages/den-ui/src/update-pill.css"),
  "utf-8",
);
/** The body of the first top-level block whose prelude matches `re`. */
function block(css: string, re: RegExp): string | null {
  const m = re.exec(css);
  if (!m) return null;
  let i = css.indexOf("{", m.index) + 1;
  const start = i;
  for (let depth = 1; i < css.length && depth > 0; i++)
    depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
  return css.slice(start, i - 1);
}
const flat = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

describe("issue 286: the update pill without backdrop blur", () => {
  const fallback = block(
    CSS,
    /@supports\s+not\s*\(\s*\(\s*backdrop-filter:\s*blur\(1px\)\s*\)\s*or\s*\(\s*-webkit-backdrop-filter:\s*blur\(1px\)\s*\)\s*\)/,
  );

  it("has a fallback for browsers that can't blur (either spelling)", () => {
    expect(fallback).not.toBeNull();
  });

  it("there the pill is the opaque surface, no see-through tint", () => {
    const pill = block(fallback ?? "", /\.den-upd \.upd-pill\s*\{/);
    expect(pill).not.toBeNull();
    const rule = flat(pill ?? "");
    expect(rule).toMatch(/background:\s*var\(--surface\)\s*;/);
    expect(rule).toMatch(/background-image:\s*none\s*;/);
    expect(rule).not.toMatch(/color-mix|transparent/);
  });

  it("where the blur works, the pill's own rule is unchanged", () => {
    const base = flat(block(CSS, /^\.den-upd \.upd-pill\s*\{/m) ?? "");
    expect(base).toContain(
      "background: color-mix(in srgb, var(--surface) 20%, transparent);",
    );
    expect(base).toContain("backdrop-filter: blur(3px) saturate(1.4);");
  });
});
