/**
 * Issue 680 (Harmony): one on/off switch, the kit's, for both products.
 * Den's on/off settings were plain checkboxes with a look of their own
 * (.set-check, .toggle-input). They are the kit's switch now: a settings
 * row keeps its own label (the row's), so the kit draws the bare switch
 * for it (switchInputHtml), the same input switchHtml draws in its label.
 * The second product draws no on/off control today (checked during the
 * build); when it does, it renders the same builder.
 */
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

  // Review: every on/off setting is a switch; a checkbox that picks an
  // option inside a form stays one, and is named here, so a new checkbox
  // has to choose.
  const MUST_BE_SWITCHES: [string, RegExp][] = [
    ["settings-registry.js", /switchHtml\(\{\s*id: "set-box-on"/],
    ["settings-registry.js", /switchHtml\(\{\s*id: "hub-allow-tools"/],
    ["settings-registry.js", /attrs: \{ "data-keep-on": "" \}/],
    ["settings-registry.js", /switchInputHtml\(\{\s*id: "set-phone-push"/],
  ];
  const ALLOWED_CHECKBOXES = [
    /data-signout-rotate/, // Sign out: also rotate the key (an option)
    /id="rot-a-never"/, // a rotation's "never" (an option in a form)
    /data-pmcp-nobearer/, // a project MCP's "no token" (an option in a form)
    /id="module-check-all"/, // Testing: the module checklist's "all"
    /value="\$\{m\.name\}"/, // Testing: a module in the checklist
  ];
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
          ALLOWED_CHECKBOXES.some((re) => re.test(tag));
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
