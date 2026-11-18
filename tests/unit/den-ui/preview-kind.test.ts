/**
 * Issue 440: a rail entry's "preview" kind (den-ui). A page that isn't
 * finished says so on its row: the kit's uppercase tag, in the kit's
 * words, and "<label> · Preview" in its tooltip and accessible name.
 */
import { describe, expect, it } from "@jest/globals";
import {
  NAV_KINDS,
  navItemHtml,
  navKind,
} from "../../../packages/den-ui/src/shell-html.js";

describe("the preview kind", () => {
  it("is one of the kit's kinds, worded in en, es and ja", () => {
    expect(NAV_KINDS).toContain("preview");
    expect(navKind("preview", "en")).toEqual({
      id: "preview",
      word: "Preview",
    });
    expect(navKind("Preview", "es")).toEqual({
      id: "preview",
      word: "Vista previa",
    });
    expect(navKind("preview", "ja")).toEqual({
      id: "preview",
      word: "プレビュー",
    });
  });

  it("draws the tag, and names the row '<label> · Preview'", () => {
    const html = navItemHtml(
      { id: "verify", label: "Checks", href: "/verify", kind: "preview" },
      "page",
      "en",
    );
    expect(html).toContain('data-nav-kind="preview"');
    expect(html).toContain('aria-label="Checks · Preview"');
    expect(html).toContain('title="Checks · Preview"');
    expect(html).toMatch(
      /<span class="den-k den-ni-kind"[^>]*>Preview<\/span>/,
    );
  });
});
