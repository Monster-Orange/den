/**
 * D48: text on an accent ground is drawn in --on-accent, the one token the
 * theme contract holds to 4.5:1 there (on-accent on accent-fill,
 * src/shared/theme/contract.ts). --accent-text is accent-coloured text for
 * the normal grounds: on --accent it can be the same hue, and illegible.
 * Every CSS block in the page sources (.css, <style> in .html, the CSS
 * strings in .js) that sets an accent background and a text colour must
 * set that colour to --on-accent.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.resolve("src/ui/server/public");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(css|html|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Each `{ … }` block with no block inside it. */
const blocks = (text: string): string[] =>
  [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);

const ACCENT_BG = /background(?:-color)?\s*:\s*var\(--accent(?:-fill)?\)/;
// A text colour: `color:` on its own, not `border-color:` or `background-color:`.
const COLOR = /(?:^|[\s;"'])color\s*:\s*([^;"'}]+)/g;

export function offenders(text: string): string[] {
  const out: string[] = [];
  for (const b of blocks(text)) {
    if (!ACCENT_BG.test(b)) continue;
    for (const m of b.matchAll(COLOR)) {
      const v = m[1].trim();
      if (!/^var\(--on-accent\)/.test(v)) out.push(`color: ${v}`);
    }
  }
  return out;
}

describe("D48: text on an accent ground is --on-accent", () => {
  it("finds the wrong pair (the check itself)", () => {
    expect(
      offenders(".x{background:var(--accent);color:var(--accent-text)}"),
    ).toEqual(["color: var(--accent-text)"]);
    expect(
      offenders(
        '".y {" +\n "  background: var(--accent-fill);" +\n "  color: #fff; }"',
      ),
    ).toEqual(["color: #fff"]);
    expect(
      offenders(
        ".z{background:var(--accent-fill);color:var(--on-accent);border-color:var(--accent)}",
      ),
    ).toEqual([]);
    expect(offenders(".dot{background:var(--accent);width:6px}")).toEqual([]);
  });

  it("every page source pairs them right", () => {
    const bad: string[] = [];
    for (const f of files(PUBLIC))
      for (const o of offenders(fs.readFileSync(f, "utf-8")))
        bad.push(`${path.relative(PUBLIC, f)}: ${o}`);
    expect(bad).toEqual([]);
  });
});
