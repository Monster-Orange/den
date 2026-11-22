/**
 * Issue 1080: on a narrow top bar the scope crumbs drew over one another
 * and under the search. A crumb's grid track could shrink to 0
 * (`.den-scope .den-ib { min-width: 0 }`) while the crumb still drew its
 * value's 4ch (5ch and its ▾ in a menu crumb), so the next separator sat
 * on the value; and the last crumb, kept whole (issue 303), ran past the
 * left part into the search.
 *
 * Now, in shell.css:
 *   - a crumb before the last has a least width that holds what it draws
 *     (its padding and border, the label's gap, its value's least width),
 *     and clips past it: it never draws outside its track;
 *   - the optional crumb may give way to nothing (clipped, never over the
 *     next one);
 *   - when the left part is narrower than 300px, the optional crumb and
 *     its separator go (a container query on .den-left), before anything
 *     runs under the search.
 * The page's geometry is checked in kit-070.browser.test.ts (CI).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const CSS = fs.readFileSync(
  path.join(process.cwd(), "packages/den-ui/src/shell.css"),
  "utf-8",
);

/** The declarations of the first rule whose selector is exactly `sel`. */
function rule(sel: string, src = CSS): string | null {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = src.match(new RegExp(`(^|\\n|\\})\\s*${esc}\\s*\\{([^}]*)\\}`));
  return m ? m[2]! : null;
}

describe("issue 1080: scope crumbs never draw over each other or under the search", () => {
  it("a label crumb before the last holds its padding, gap and value's 4ch, and clips past it", () => {
    const r = rule(".den-scope .den-ib:not(.den-last)");
    expect(r).not.toBeNull();
    expect(r).toMatch(/min-width:\s*calc\(24px \+ 4ch\)/);
    expect(r).toMatch(/overflow:\s*hidden/);
  });

  it("a menu crumb before the last holds its value's 5ch and its ▾", () => {
    expect(rule(".den-scope .den-scope-btn:not(.den-last)")).toMatch(
      /min-width:\s*calc\(24px \+ 5ch \+ 0\.28em\)/,
    );
  });

  it("the optional crumb may give way to nothing, clipped", () => {
    const r = rule(".den-scope .den-opt:not(.den-last)");
    expect(r).toMatch(/min-width:\s*0/);
  });

  it("a narrow left part lets the optional crumb and its separator go", () => {
    expect(rule(".den-left")).toMatch(
      /container:\s*den-left\s*\/\s*inline-size/,
    );
    const q = CSS.match(
      /@container den-left \(max-width: 300px\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(q).not.toBeNull();
    expect(q![1]).toMatch(
      /\.den-scope \.den-opt,\s*\.den-scope \.den-opt \+ \.den-sep/,
    );
    expect(q![1]).toMatch(/display:\s*none/);
  });

  it("the last crumb is still kept whole (issue 303)", () => {
    expect(rule(".den-scope .den-ib.den-last")).toMatch(/min-width:\s*auto/);
  });
});
