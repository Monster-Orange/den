import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { scopeHtml } from "../../../packages/den-ui/src/shell-html.js";

const CSS = fs.readFileSync(
  path.join(process.cwd(), "packages/den-ui/src/shell.css"),
  "utf-8",
);

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
      /\.den-scope \.den-opt:not\(\[aria-haspopup\]\) \+ \.den-sep\s*\{\s*display:\s*none/,
    );
    expect(q![1]).not.toMatch(/\.den-opt \+ \.den-scope-menu/);
    const hid = q![1].match(
      /\.den-scope \.den-opt:not\(\[aria-haspopup\]\),\s*\.den-scope \.den-k\s*\{([^}]*)\}/,
    );
    expect(hid).not.toBeNull();
    expect(hid![1]).toMatch(/position:\s*absolute/);
    expect(hid![1]).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hid![1]).not.toMatch(/display:\s*none/);
  });

  it("the last crumb is still kept whole (issue 303)", () => {
    expect(rule(".den-scope .den-ib.den-last")).toMatch(/min-width:\s*auto/);
  });
});

describe("issue 1080: a long last crumb on a narrow left part", () => {
  const q = () =>
    CSS.match(
      /@container den-left \(max-width: 300px\)\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? "";
  it("its key is hidden from sight only, and it shrinks to a floor of 7ch (6 characters and …)", () => {
    expect(q()).not.toMatch(/\.den-scope \.den-k\s*\{\s*display:\s*none/);
    expect(q()).toMatch(
      /\.den-scope \.den-ib\.den-last:not\(\[data-scope="env"\]\)\s*\{[^}]*min-width:\s*calc\(24px \+ 7ch \+ 0\.28em\)/,
    );
  });
  it("an env crumb last keeps its own width: no floor wider than its words", () => {
    expect(q()).not.toMatch(/\.den-scope \.den-ib\.den-last\s*\{/);
  });
  it("no guessed cap from the left part's width", () => {
    expect(CSS).not.toMatch(/cqi/);
  });
  it("the left part never clips: a crumb's menu hangs past it", () => {
    expect(rule(".den-left") ?? "").not.toMatch(
      /overflow(-x|-y)?:\s*(hidden|clip)/,
    );
  });
});

describe("issue 1080: an optional crumb's words stay reachable", () => {
  it("the scope group's title names each optional crumb", () => {
    const html = scopeHtml({
      crumbs: [
        {
          key: "org",
          label: "Company",
          value: "Fixture company name",
          optional: true,
        },
        { key: "ws", label: "Project", value: "All projects", menu: true },
      ],
      lang: "en",
    });
    expect(html).toMatch(
      /<div class="den-scope" role="group" aria-label="[^"]*" title="Company: Fixture company name">/,
    );
  });
  it("no optional crumb: no title", () => {
    const html = scopeHtml({
      crumbs: [{ key: "ws", label: "Project", value: "Garden", menu: true }],
      lang: "en",
    });
    expect(html).not.toMatch(/class="den-scope"[^>]*title=/);
  });
});
