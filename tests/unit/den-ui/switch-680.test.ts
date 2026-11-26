import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  switchHtml,
  switchInputHtml,
} from "../../../packages/den-ui/src/switch.js";
import { toggleControlHtml } from "../../../src/ui/server/public/settings-page.js";

const PUB = path.join(process.cwd(), "src/ui/server/public");
const read = (f: string) => fs.readFileSync(path.join(PUB, f), "utf-8");

describe("issue 680: the kit's bare switch, for a row with its own label", () => {
  it("draws the switch input: role=switch, the kit's class, its state and names", () => {
    const html = switchInputHtml({
      id: "c-x",
      on: true,
      labelledBy: "l-x",
      describedBy: "d-x",
      attrs: { "data-focus-key": "x" },
    });
    expect(html).toBe(
      '<input type="checkbox" role="switch" class="den-switch-input" id="c-x"' +
        ' aria-labelledby="l-x" aria-describedby="d-x" data-focus-key="x" checked data-den-switch>',
    );
  });

  it("off, disabled, and no names: just the switch", () => {
    expect(switchInputHtml({ id: "s", disabled: true })).toBe(
      '<input type="checkbox" role="switch" class="den-switch-input" id="s" disabled data-den-switch>',
    );
  });

  it("escapes what it is given", () => {
    expect(
      switchInputHtml({ id: 'a"b', attrs: { "data-k": "<x>" } }),
    ).toContain('id="a&quot;b" data-k="&lt;x&gt;"');
  });

  it("switchHtml draws the same input inside its label", () => {
    const html = switchHtml({ id: "s1", label: "Name", help: "Why", on: true });
    expect(html).toContain(
      switchInputHtml({
        id: "s1",
        on: true,
        labelledBy: "s1-label",
        describedBy: "s1-help",
      }),
    );
  });
});

describe("issue 680: Den draws its on/off settings with the kit's switch", () => {
  it("a settings toggle is the kit's switch, from the same data (parity)", () => {
    for (const on of [true, false])
      expect(toggleControlHtml({ cid: "c-n", key: "n", on, did: "d-n" })).toBe(
        switchInputHtml({
          id: "c-n",
          on,
          describedBy: "d-n",
          attrs: { "data-focus-key": "n" },
        }),
      );
  });

  it("the settings page and the push switch draw through it; no plain checkbox is left", () => {
    const page = read("settings-page.js");
    expect(page).toMatch(
      /import \{[^}]*switchInputHtml[^}]*\} from "\/kit\/switch\.js"/,
    );
    expect(page).toMatch(/t === "toggle"\) \{\s*ctl = toggleControlHtml\(/);
    const reg = read("settings-registry.js");
    expect(reg).toMatch(/switchInputHtml\(\{\s*id: "set-phone-push"/);
    for (const f of ["settings-page.js", "settings-registry.js", "index.html"])
      expect([f, /set-check|toggle-input/.test(read(f))]).toEqual([f, false]);
  });

  const MUST_BE_SWITCHES: [string, RegExp][] = [
    ["settings-registry.js", /switchHtml\(\{\s*id: "set-box-on"/],
    ["settings-registry.js", /switchHtml\(\{\s*id: "hub-allow-tools"/],
    ["settings-registry.js", /attrs: \{ "data-keep-on": "" \}/],
    ["settings-registry.js", /switchInputHtml\(\{\s*id: "set-phone-push"/],
  ];
  const ALLOWED_CHECKBOXES: Record<string, RegExp> = {
    "Sign out: also rotate the key (an option)": /data-signout-rotate/,
    "a rotation's never (an option in a form)": /id="rot-a-never"/,
    "a project MCP's no token (an option in a form)": /data-pmcp-nobearer/,
    "Testing: the module checklist's all": /id="module-check-all"/,
    "Testing: a module in the checklist": /value="\$\{m\.name\}"/,
    "a runner entry's heavy slot (an option in a form)": /id="set-re-heavy"/,
  };
  it("the named on/off settings are switches", () => {
    for (const [f, re] of MUST_BE_SWITCHES)
      expect([f, String(re), re.test(read(f))]).toEqual([f, String(re), true]);
  });
  it("any other checkbox in these files is a switch, or a named option in a form", () => {
    for (const f of ["settings-registry.js", "settings-page.js", "index.html"])
      for (const tag of read(f).match(/<input\b[^>]*type="checkbox"[^>]*>/g) ??
        []) {
        const ok =
          /role="switch"/.test(tag) ||
          Object.values(ALLOWED_CHECKBOXES).some((re) => re.test(tag));
        expect([f, tag, ok]).toEqual([f, tag, true]);
      }
  });
  it("switchHtml passes a host's attributes to its input", () => {
    expect(
      switchHtml({ id: "k", label: "Keep", attrs: { "data-keep-on": "" } }),
    ).toContain('id="k" aria-labelledby="k-label" data-keep-on=""');
  });

  it("no product-local CSS for it remains; the pages link the kit's switch.css", () => {
    for (const f of ["settings.html", "index.html"]) {
      const html = read(f);
      expect([f, /\.set-check|\.toggle-input/.test(html)]).toEqual([f, false]);
      expect([f, html.includes('href="/kit/switch.css"')]).toEqual([f, true]);
    }
  });

  it("the testing page's on/off controls are the kit's switch input", () => {
    const html = read("index.html");
    expect(html).toMatch(
      /id="use-local-checkout"[\s\S]{0,200}?class="den-switch-input"|class="den-switch-input"[\s\S]{0,200}?id="use-local-checkout"/,
    );
    expect(html).toMatch(
      /input\.className = "den-switch-input";\s*input\.setAttribute\("role", "switch"\)/,
    );
  });
});

describe("issue 680: the switch copies the sister app's, value for value", () => {
  const css = fs.readFileSync(
    path.join(process.cwd(), "packages/den-ui/src/switch.css"),
    "utf-8",
  );
  const tokens = fs.readFileSync(
    path.join(process.cwd(), "packages/den-ui/src/tokens.css"),
    "utf-8",
  );
  const rule = (sel: string): Record<string, string> => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(
      css.replace(/\/\*[\s\S]*?\*\//g, ""),
    );
    if (!m) throw new Error(`no rule for ${sel}`);
    return Object.fromEntries(
      m[1]
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const i = d.indexOf(":");
          return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
        }),
    );
  };

  it("the switch comes before its label, 10px apart, top-aligned", () => {
    const html = switchHtml({ id: "n", label: "Notes", help: "Kept." });
    expect(html.indexOf("<input")).toBeLessThan(
      html.indexOf("den-switch-text"),
    );
    const row = rule(".den-switch");
    expect(row.gap).toBe("10px");
    expect(row["align-items"]).toBe("flex-start");
    expect(row["justify-content"]).toBe("flex-start");
    expect(rule(".den-switch-label")["line-height"]).toBe("24px");
  });

  it("the track: 40×24, fully round, never shrinks; off is the strong border, on the accent fill", () => {
    const t = rule(".den-switch-input");
    expect(t.width).toBe("40px");
    expect(t["min-width"]).toBe("40px");
    expect(t.flex).toBe("0 0 40px");
    expect(t.height).toBe("24px");
    expect(t["border-radius"]).toBe("999px");
    expect(t["background-color"]).toBe("var(--border-strong)");
    expect(t.transition).toBe("background-color var(--dur) var(--ease-out)");
    expect(rule(".den-switch-input:checked")["background-color"]).toBe(
      "var(--accent-fill)",
    );
  });

  it("the knob: 18px at 3px, the knob colour and shadow, 16px of travel", () => {
    const k = rule(".den-switch-input::before");
    expect(rule(".den-switch-input").border).toBe("1px solid transparent");
    expect(k.top).toBe("2px");
    expect(k.left).toBe("2px");
    expect(k.width).toBe("18px");
    expect(k.height).toBe("18px");
    expect(k["background-color"]).toBe("var(--switch-knob)");
    expect(k["box-shadow"]).toBe("var(--shadow-knob)");
    expect(k.transition).toBe("transform var(--dur) var(--ease-out)");
    expect(rule(".den-switch-input:checked::before").transform).toBe(
      "translateX(16px)",
    );
  });

  it("the tokens: an ease-out curve, a knob light in both themes, the sister app's shadow", () => {
    expect(tokens).toContain("--ease-out: cubic-bezier(0.22, 1, 0.36, 1);");
    expect(tokens).toContain("--shadow-knob: 0 1px 3px rgb(32 38 29 / 0.25);");
    expect(tokens.match(/--switch-knob: var\(--surface\);/g)).toHaveLength(1);
    expect(tokens.match(/--switch-knob: var\(--text\);/g)).toHaveLength(2);
  });

  it("disabled: the input at .45, the label muted, no pointer anywhere", () => {
    expect(rule(".den-switch-input:disabled").opacity).toBe(".45");
    expect(rule(".den-switch-input:disabled").cursor).toBe("not-allowed");
    expect(rule(".den-switch[data-disabled]").cursor).toBe("not-allowed");
    expect(rule(".den-switch[data-disabled] .den-switch-label").color).toBe(
      "var(--muted)",
    );
  });

  it("the help: under the label, 4px down, small, muted, at most 60ch", () => {
    const h = rule(".den-switch-help");
    expect(h["margin-top"]).toBe("var(--space-1)");
    expect(h["font-size"]).toBe("var(--fs-s)");
    expect(h["line-height"]).toBe("1.45");
    expect(h.color).toBe("var(--muted)");
    expect(h["max-width"]).toBe("60ch");
    expect(rule(".den-switch-help:lang(ja)")["word-break"]).toBe("auto-phrase");
  });

  it("a coarse pointer gets a 44px target without changing the drawn size", () => {
    expect(css).toMatch(
      /@media \(pointer: coarse\)\s*\{\s*\.den-switch-input::after\s*\{[^}]*min-width: var\(--tap\);[^}]*min-height: var\(--tap\);/,
    );
    expect(rule(".den-switch")["min-height"]).toBeUndefined();
  });
});
