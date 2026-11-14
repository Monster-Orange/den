/**
 * The org-name matcher (scripts/org-names.js): a name listed run together
 * is caught however a string writes it: with a space, a hyphen, an
 * underscore, or in any case (dev.2 of 0.4.45 shipped one with a space the
 * gate missed). Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as path from "path";

const SCRIPTS = path.join(process.cwd(), "scripts");

type Matcher = {
  orgPatterns(env: Record<string, string>): RegExp[];
  orgHitsWide(
    text: string,
    patterns: RegExp[],
    allowed?: string[],
  ): { index: number }[];
};

describe("org-name matcher", () => {
  it("catches a run-together name written with a space, a hyphen, an underscore or any case", async () => {
    const m = (await import(path.join(SCRIPTS, "org-names.js"))) as Matcher;
    const ps = m.orgPatterns({ DEN_ORG_NAMES: "acmewidgets" });
    for (const text of [
      "hosted by Acme Widgets at {host}",
      "acme-widgets.example",
      "ACME_WIDGETS",
      "Acme  Widgets",
      "acmewidgets",
    ])
      expect(m.orgHitsWide(text, ps).map((h) => h.index)).toEqual([1]);
  });

  it("never joins words across other text: no hit where the name isn't", async () => {
    const m = (await import(path.join(SCRIPTS, "org-names.js"))) as Matcher;
    const ps = m.orgPatterns({ DEN_ORG_NAMES: "acmewidgets" });
    for (const text of ["acme, widgets", "acme. widgets", "an acme of widgets"])
      expect(m.orgHitsWide(text, ps)).toEqual([]);
  });

  it("lets text carry an allowed name (the publisher's own) and still catches the rest", async () => {
    const m = (await import(path.join(SCRIPTS, "org-names.js"))) as Matcher;
    const ps = m.orgPatterns({ DEN_ORG_NAMES: "acmewidgets\nglobexcorp" });
    expect(
      m.orgHitsWide("github.com/Acme-Widgets/den", ps, ["acmewidgets/den"]),
    ).toEqual([]);
    expect(
      m.orgHitsWide("a Hub hosted by Acme Widgets", ps, ["acmewidgets/den"]),
    ).toEqual([{ index: 1, term: "acmewidgets" }]);
    expect(
      m.orgHitsWide("Acme Widgets for Globex Corp", ps, ["acmewidgets"]),
    ).toEqual([{ index: 2, term: "globexcorp" }]);
  });
});
