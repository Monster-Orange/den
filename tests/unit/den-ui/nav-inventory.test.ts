/**
 * Issue 95: the nav inventory's comparer and its references, with no
 * browser (runs in every shard). The browser half, on the pinned image, is
 * nav-inventory.browser.test.ts (CI's den-ui-nav job).
 *
 *   - the references were taken on NAV_BROWSER_IMAGE, in NAV_THEME, and
 *     CI's den-ui-nav job runs that same image (the two can't drift);
 *   - a reference matches itself;
 *   - another browser build, or another theme, fails with one clear
 *     difference instead of comparing what can't match;
 *   - red cases on the reference itself: the search 3 px over, a swapped
 *     pair, a colour and a font-family changed (no theme token exempt by
 *     default).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  compareNav,
  NAV_BROWSER_IMAGE,
  NAV_THEME,
  type NavSnapshot,
} from "../../../packages/den-ui/inventory/nav-inventory.js";
import { DEN_HOST_SLOTS, referenceFile } from "./nav-inventory-helpers.js";

const ROOT = path.join(__dirname, "../../..");
const REFS = (["chromium", "webkit"] as const).flatMap((b) =>
  [1280, 390].map((w) => [b, w] as const),
);
const read = (b: string, w: number) =>
  JSON.parse(fs.readFileSync(referenceFile(b, w), "utf-8")) as NavSnapshot;
const copy = (s: NavSnapshot) => JSON.parse(JSON.stringify(s)) as NavSnapshot;
const ids = (s: NavSnapshot, ref: NavSnapshot) =>
  compareNav(s, ref, { hostSlots: DEN_HOST_SLOTS })
    .map((d) => `${d.key} ${d.property}`)
    .sort();

describe("nav inventory: the pinned browser and theme", () => {
  it("CI's den-ui-nav job runs the test on NAV_BROWSER_IMAGE", () => {
    const ci = fs.readFileSync(
      path.join(ROOT, ".github/workflows/ci.yml"),
      "utf-8",
    );
    expect(NAV_BROWSER_IMAGE).toMatch(/:v[\d.]+-\w+@sha256:[0-9a-f]{64}$/);
    expect(ci).toContain(`NAV_IMAGE: ${NAV_BROWSER_IMAGE}`);
    expect(ci).toContain("DEN_PW_WS: ws://localhost:3921/");
    expect(ci).toContain("tests/unit/den-ui/nav-inventory.browser.test.ts");
    // The run-server's Playwright is the one the image is named for.
    const v = NAV_BROWSER_IMAGE.match(/:v([\d.]+)-/)![1];
    expect(ci).toContain(`playwright@${v} run-server`);
  });

  it("NAV_THEME is Den's default theme as shipped", () => {
    const theme = JSON.parse(
      fs.readFileSync(path.join(ROOT, "themes/den/den-theme.json"), "utf-8"),
    ) as { id: string; version: string };
    expect({ id: theme.id, version: theme.version }).toEqual(NAV_THEME);
  });

  it.each(REFS)("%s %i: taken there, and matches itself", (b, w) => {
    const ref = read(b, w);
    expect(ref.env.image).toBe(NAV_BROWSER_IMAGE);
    expect(ref.env.theme).toEqual(NAV_THEME);
    expect(Object.keys(ref.env.faces).length).toBeGreaterThan(0);
    expect(compareNav(ref, ref)).toEqual([]);
  });

  it("another browser build fails with one clear difference", () => {
    const ref = read("chromium", 1280);
    const other = copy(ref);
    other.env.image = "a local browser";
    other.env.faces[Object.keys(other.env.faces)[0]!]! += 8;
    const d = compareNav(other, ref);
    expect(d).toHaveLength(1);
    expect(d[0]!.property).toBe("env");
    expect(`${d[0]!.reference}, ${d[0]!.actual}`).toBe(
      `reference taken on ${NAV_BROWSER_IMAGE} (${ref.env.userAgent}), running on a local browser (${ref.env.userAgent})`,
    );
  });

  it("another theme fails with one clear difference", () => {
    const ref = read("webkit", 1280);
    const other = copy(ref);
    other.env.theme = { id: "other", version: "1.0.0" };
    expect(compareNav(other, ref)).toEqual([
      expect.objectContaining({
        property: "theme",
        reference: `reference taken in theme ${NAV_THEME.id} ${NAV_THEME.version}`,
        actual: "running in theme other 1.0.0",
      }),
    ]);
  });
});

describe("nav inventory: red cases on the reference", () => {
  const ref = read("chromium", 1280);
  const at = (s: NavSnapshot, key: string) =>
    s.elements.find((e) => e.key === key)!;

  it("the search field 3 px over fails on its box", () => {
    const s = copy(ref);
    for (const e of s.elements)
      if (e.key === "#den-search" || e.key.startsWith("#den-search >"))
        e.box.x += 3;
    const keys = s.elements
      .filter((e) => e.key.startsWith("#den-search"))
      .flatMap((e) => [`${e.key} box.left`, `${e.key} box.right`]);
    expect(ids(s, ref)).toEqual(keys.sort());
  });

  it("2 px is within the tolerance", () => {
    const s = copy(ref);
    at(s, "#den-search").box.x += 2;
    expect(ids(s, ref)).toEqual([]);
  });

  it("a swapped pair fails on order", () => {
    const s = copy(ref);
    const i = s.elements.findIndex((e) => e.key === "#den-bell");
    const bell = s.elements.splice(i, 2); // the bell and its svg
    const j = s.elements.findIndex((e) => e.key === "#version-pill");
    s.elements.splice(j + 2, 0, ...bell); // after the chip and its text
    const order = ids(s, ref).filter((x) => x.endsWith(" order"));
    expect(order.length).toBeGreaterThan(0);
    for (const x of order) expect(x).toMatch(/^#(den-bell|version-pill)\b/);
  });

  it("a colour from a theme token fails: none is exempt by default", () => {
    const s = copy(ref);
    const ph = at(s, "#den-search > span.den-search-ph");
    const tokens = ref.tokens[ph.style.color]!;
    expect(tokens.length).toBeGreaterThan(0);
    // The same token, a new value: as another theme would draw it.
    ph.style.color = "rgb(1, 2, 3)";
    s.tokens["rgb(1, 2, 3)"] = tokens;
    expect(ids(s, ref)).toEqual([
      "#den-search > span.den-search-ph style.color",
    ]);
    // Listed on purpose (a run that switches themes), it is allowed.
    expect(
      compareNav(s, ref, { hostSlots: DEN_HOST_SLOTS, themeTokens: tokens }),
    ).toEqual([]);
  });

  it("a font-family changed fails: none is exempt by default", () => {
    const s = copy(ref);
    at(s, "#den-search > span.den-search-ph").style["font-family"] = "serif";
    expect(ids(s, ref)).toEqual([
      "#den-search > span.den-search-ph style.font-family",
    ]);
  });

  it("a host slot's contents are the host's own", () => {
    const s = copy(ref);
    const n = s.elements.find((e) => e.key.startsWith("#den-status >"))!;
    n.name = "3 of 4 up";
    n.style.color = "rgb(200, 0, 0)";
    expect(ids(s, ref)).toEqual([]);
  });
});
