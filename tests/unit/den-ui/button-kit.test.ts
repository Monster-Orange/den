/**
 * den-ui, issue 556: the kit's general button (button.css, button.js), the
 * checks that need no browser.
 *
 *   - button.css is the one `.den-btn`: secondary (the base), primary and
 *     small, disabled, a link drawn as a button, a visible focus ring and
 *     a 44px tap on a touch screen. Tokens only.
 *   - buttonHtml draws it from data: the host's label, the variant and
 *     size, a link or a button, disabled, and data-/aria- attributes only.
 *   - Den keeps no copy: its frame script no longer styles .den-btn, and
 *     every page with the frame links the kit's button.css.
 *
 * The browser half (each variant's look, light and dark, the same as Den's
 * own rules before the move; keys; the tap size) is
 * kit-button-menu-row.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { buttonHtml } from "../../../packages/den-ui/src/button.js";
import { KIT_FILES, KIT_PAGE_CSS } from "../../../src/ui/server/ui-assets.js";

const SRC = path.join(process.cwd(), "packages", "den-ui", "src");
const DEN_PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const css = () =>
  fs
    .readFileSync(path.join(SRC, "button.css"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

describe("buttonHtml (button.js)", () => {
  it("draws a secondary button by default, the host's label escaped", () => {
    expect(buttonHtml({ label: "Save <now>" })).toBe(
      '<button type="button" class="den-btn">Save &lt;now&gt;</button>',
    );
  });

  it("primary and small are classes on the one button", () => {
    expect(
      buttonHtml({ label: "Go", variant: "primary", size: "sm", id: "go" }),
    ).toBe(
      '<button type="button" class="den-btn primary sm" id="go">Go</button>',
    );
    // Issue 673: danger, a step that takes something away.
    expect(buttonHtml({ label: "Remove", variant: "danger" })).toBe(
      '<button type="button" class="den-btn danger">Remove</button>',
    );
    // Any other variant or size is dropped, never passed through.
    expect(
      buttonHtml({
        label: "Go",
        variant: 'danger" onclick="x' as "primary",
        size: "xl" as "sm",
      }),
    ).toBe('<button type="button" class="den-btn">Go</button>');
  });

  it("a submit, a disabled button, and a link drawn as a button", () => {
    expect(buttonHtml({ label: "Save", type: "submit", disabled: true })).toBe(
      '<button type="submit" class="den-btn" disabled>Save</button>',
    );
    expect(buttonHtml({ label: "Open", href: "/a?b=1&c=2" })).toBe(
      '<a class="den-btn" href="/a?b=1&amp;c=2">Open</a>',
    );
    // A link that can't be followed has no href and says it is disabled.
    expect(buttonHtml({ label: "Open", href: "/a", disabled: true })).toBe(
      '<a class="den-btn" role="link" aria-disabled="true">Open</a>',
    );
  });

  it("takes data- and aria- attributes only", () => {
    expect(
      buttonHtml({
        label: "More",
        attrs: {
          "data-act": "more",
          "aria-haspopup": "menu",
          onclick: "alert(1)",
          style: "color:red",
          'data-x"y': "z",
        },
      }),
    ).toBe(
      '<button type="button" class="den-btn" data-act="more" aria-haspopup="menu">More</button>',
    );
  });
});

describe("button.css", () => {
  it("is the one .den-btn: base, hover, primary, sm, disabled, link, focus", () => {
    const c = css().replace(/\s+/g, " ");
    const rule = (sel: string) => {
      const at = c.indexOf(`} ${sel} {`);
      if (at < 0 && !c.trimStart().startsWith(`${sel} {`)) return null;
      const from = at < 0 ? c.indexOf(`${sel} {`) : at + 2;
      const body = c.slice(c.indexOf("{", from) + 1, c.indexOf("}", from));
      return body.trim();
    };
    // Den's values, value for value (they were in Den's frame script),
    // and issue 673: the second product's shipped button lays its words
    // and icon out in a row, 6px apart, as Den's error page did.
    expect(rule(".den-btn")).toBe(
      "border: 1px var(--edge-style, solid) var(--border); background: var(--surface); border-radius: var(--radius-button); padding: 6px 12px; cursor: pointer; font: inherit; font-weight: 500; white-space: nowrap; color: var(--text); text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;",
    );
    // A row of its own must not undo [hidden].
    expect(rule(".den-btn[hidden]")).toBe("display: none;");
    // Issue 673: danger, the second product's shipped values.
    // Kept on hover: the second product's danger comes after its hover.
    expect(
      rule('.den-btn.danger, .den-btn.danger:not([aria-busy="true"]):hover'),
    ).toBe(
      "color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--border));",
    );
    // Issue 699: a held button (aria-busy) has no hover change.
    expect(rule('.den-btn:not([aria-busy="true"]):hover')).toBe(
      "border-color: var(--border-strong);",
    );
    expect(rule(".den-btn.primary")).toBe(
      "background: var(--primary-bg, var(--accent-fill)); border-color: var(--primary-border, var(--accent-fill)); color: var(--primary-text, var(--on-accent));",
    );
    expect(rule(".den-btn.sm")).toBe("padding: 2px 9px; font-size: 12.5px;");
    expect(rule('.den-btn:disabled, a.den-btn[aria-disabled="true"]')).toBe(
      "opacity: 0.6; cursor: default;",
    );
    // The link drawn as a button: the base already lays it out (673).
    expect(rule("a.den-btn")).toBeNull();
    expect(rule(".den-btn:focus-visible")).toBe(
      "outline: 2px solid var(--accent); outline-offset: 2px;",
    );
  });

  it("gives a 44px tap on a touch screen without changing the look", () => {
    const c = css();
    const touch = c.slice(c.indexOf("@media (pointer: coarse)"));
    expect(touch).toMatch(/\.den-btn\s*\{\s*position:\s*relative;/);
    expect(touch).toMatch(
      /\.den-btn::after\s*\{[^}]*min-width:\s*var\(--tap\)/,
    );
    expect(touch).toMatch(
      /\.den-btn::after\s*\{[^}]*min-height:\s*var\(--tap\)/,
    );
  });
});

describe("Den keeps no copy of the button", () => {
  it("Den's frame script no longer styles .den-btn itself", () => {
    const shell = fs.readFileSync(path.join(DEN_PUBLIC, "shell.js"), "utf-8");
    // A rule that starts with the button's class (a host's own scoped
    // rule, `.x .den-btn`, is still its own).
    expect(shell).not.toMatch(/"\s*(a)?\.den-btn[\s.:,{]/);
  });

  it("no stylesheet or page of Den's starts a rule with .den-btn", () => {
    const own = fs
      .readdirSync(DEN_PUBLIC)
      .filter((f) => /\.(css|html)$/.test(f))
      .flatMap((f) =>
        fs
          .readFileSync(path.join(DEN_PUBLIC, f), "utf-8")
          .split("\n")
          .map((l, i) => [f, i + 1, l] as const),
      )
      .filter(([, , l]) => /^\s*(a)?\.den-btn[.:[\s,{]/.test(l))
      .map(([f, n, l]) => `${f}:${n}: ${l.trim()}`);
    expect(own).toEqual([]);
  });

  // Issue 673: Den's own .btn is gone; every button is the kit's.
  it("no source of Den's draws or styles its own .btn", () => {
    const SRC_DIR = path.join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(m?[jt]s|html|css)$/.test(e.name)) files.push(p);
      }
    };
    walk(SRC_DIR);
    const draws =
      /(class(Name)?\s*[=:]\s*\\?["'`]|classList\.add\(\s*["'])([^"'`]*\s)?btn(?![\w-])/;
    const styles = /(^|[}\s,;>+~])([a-z]+)?\.btn(?![\w-])[^{}\n]*[,{]/;
    const own = files.flatMap((f) =>
      fs
        .readFileSync(f, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
        .split("\n")
        .flatMap((l, i) =>
          draws.test(l) || styles.test(l)
            ? [
                `${path.relative(SRC_DIR, f)}:${i + 1}: ${l.trim().slice(0, 80)}`,
              ]
            : [],
        ),
    );
    expect(own).toEqual([]);
  });

  it("serves button.css and button.js, and links button.css on every page with the frame", () => {
    expect(KIT_FILES).toContain("button.css");
    expect(KIT_FILES).toContain("button.js");
    expect(KIT_PAGE_CSS).toContain("/kit/button.css");
    // First: before the frame's own sheets, where Den's rules came from.
    expect(KIT_PAGE_CSS[0]).toBe("/kit/button.css");
  });
});
