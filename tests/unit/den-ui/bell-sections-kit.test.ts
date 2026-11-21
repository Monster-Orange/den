/**
 * Issue 101: the bell's panel has two sections, drawn by the kit in its
 * own words: "Needs you" first, then "Earlier". The host passes only the
 * rows of each (HTML), never the headings.
 */
import { describe, expect, it } from "@jest/globals";
import { bellPanelHtml } from "../../../packages/den-ui/src/shell-html.js";
import { en, es, ja } from "../../../packages/den-ui/src/strings.js";

describe("issue 101: the bell's Needs you and Earlier sections (kit)", () => {
  it("Needs you first, then Earlier, each with the kit's heading", () => {
    const h = bellPanelHtml({
      sections: { needs: "<i>need</i>", earlier: "<i>before</i>" },
    });
    const needs = h.indexOf('data-sec="needs"');
    const earlier = h.indexOf('data-sec="earlier"');
    expect(needs).toBeGreaterThan(-1);
    expect(earlier).toBeGreaterThan(needs);
    expect(h).toContain(">Needs you</h3>");
    expect(h).toContain(">Earlier</h3>");
    expect(h.indexOf("<i>need</i>")).toBeGreaterThan(needs);
    expect(h.indexOf("<i>need</i>")).toBeLessThan(earlier);
    expect(h.indexOf("<i>before</i>")).toBeGreaterThan(earlier);
    // Each section is named by its heading.
    expect(h).toMatch(
      /<section class="den-bell-sec" data-sec="needs" aria-labelledby="den-bell-needs"><h3 class="den-bell-sech" id="den-bell-needs">/,
    );
  });

  it("nothing needs you but Earlier has items: the heading stays first, with the kit's line", () => {
    const h = bellPanelHtml({ sections: { needs: "", earlier: "<i>e</i>" } });
    expect(h).toContain(">Needs you</h3>");
    expect(h).toContain('<p class="den-bell-none">Nothing needs you now.</p>');
    expect(h.indexOf('data-sec="needs"')).toBeLessThan(
      h.indexOf('data-sec="earlier"'),
    );
  });

  it("no Earlier: no Earlier heading", () => {
    const h = bellPanelHtml({ sections: { needs: "<i>n</i>" } });
    expect(h).not.toContain('data-sec="earlier"');
  });

  it("es and ja say the headings in their words", () => {
    const es1 = bellPanelHtml({
      lang: "es",
      sections: { needs: "", earlier: "x" },
    });
    expect(es1).toContain(">Te necesitan</h3>");
    expect(es1).toContain(">Antes</h3>");
    const ja1 = bellPanelHtml({
      lang: "ja",
      sections: { needs: "", earlier: "x" },
    });
    expect(ja1).toContain(">対応が必要</h3>");
    expect(ja1).toContain(">以前</h3>");
    for (const k of [
      "kit.bell.needs",
      "kit.bell.earlier",
      "kit.bell.needsNone",
    ]) {
      expect(typeof (en as Record<string, string>)[k]).toBe("string");
      expect(typeof (es as Record<string, string>)[k]).toBe("string");
      expect(typeof (ja as Record<string, string>)[k]).toBe("string");
    }
  });

  it("issue 773: Done, not seen sits under Needs you and over Earlier, only when given", () => {
    const h = bellPanelHtml({
      sections: { needs: "<i>n</i>", done: "<i>d</i>", earlier: "<i>e</i>" },
    });
    const needs = h.indexOf('data-sec="needs"');
    const done = h.indexOf('data-sec="done"');
    const earlier = h.indexOf('data-sec="earlier"');
    expect(needs).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(needs);
    expect(earlier).toBeGreaterThan(done);
    expect(h).toContain(">Done, not seen</h3>");
    expect(h.indexOf("<i>d</i>")).toBeGreaterThan(done);
    expect(h.indexOf("<i>d</i>")).toBeLessThan(earlier);
    expect(bellPanelHtml({ sections: { needs: "", done: "" } })).not.toContain(
      'data-sec="done"',
    );
    for (const [lang, word] of [
      ["es", ">Terminado, sin ver</h3>"],
      ["ja", ">完了・未確認</h3>"],
    ])
      expect(
        bellPanelHtml({ lang, sections: { needs: "", done: "x" } }),
      ).toContain(word);
  });

  it("without sections, the panel is as before (body, after)", () => {
    const h = bellPanelHtml({ body: "<b>rows</b>", after: "<u>a</u>" });
    expect(h).toContain("<b>rows</b><u>a</u>");
    expect(h).not.toContain("den-bell-sec");
  });
});
