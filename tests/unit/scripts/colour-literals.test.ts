/**
 * Issue 322: an issue number in a comment ("issue #320", "(#311)") is not
 * a colour; a real colour still is, in code, CSS, strings and comments.
 */
import { describe, expect, it } from "@jest/globals";
import { colourLiterals } from "../helpers/colour-literals.js";

const hexes = (t: string) => colourLiterals(t).map((h) => h.hex);

describe("issue numbers in comments", () => {
  it("// issue #320: … passes", () => {
    expect(hexes("// issue #320: the pane's height\nconst a = 1;")).toEqual([]);
  });

  it("(#311) in a comment passes", () => {
    expect(hexes("/* the dock (#311) */")).toEqual([]);
    expect(hexes("x(); // as before (#311)")).toEqual([]);
  });

  it("#320 at the start of a comment's text passes", () => {
    expect(hexes("// #320: fixed")).toEqual([]);
    expect(hexes("/**\n * #320 kept the pane\n */")).toEqual([]);
    expect(hexes("<!-- #320 -->")).toEqual([]);
  });

  it("a number elsewhere in a comment is still read as a colour", () => {
    expect(hexes("// the value #320 here")).toEqual(["#320"]);
  });
});

describe("real colours still fail", () => {
  it("color: #320 in CSS", () => {
    expect(hexes(".a { color: #320; }")).toEqual(["#320"]);
  });

  it("'#320' in a JS string", () => {
    expect(hexes("el.style.color = '#320';")).toEqual(["#320"]);
  });

  it("#fff and #a1b2c3 in code", () => {
    expect(hexes("a{color:#fff;background:#a1b2c3}")).toEqual([
      "#fff",
      "#a1b2c3",
    ]);
  });

  // Decided: a colour kept in a comment counts. An old value left there
  // is copied back into code; keep it out of the file.
  it("a colour in a CSS comment (/* was #fff */) fails", () => {
    expect(hexes("/* was #fff */")).toEqual(["#fff"]);
    expect(hexes("/* issue #fff */")).toEqual(["#fff"]);
  });

  it("a URL's // is not a comment", () => {
    expect(hexes('const u = "https://x.test/a", c = "#320";')).toEqual([
      "#320",
    ]);
    expect(hexes('a = "http://x"; b = "#320";')).toEqual(["#320"]);
  });

  it("an HTML entity is not a colour", () => {
    expect(hexes("&#9654;")).toEqual([]);
  });
});
