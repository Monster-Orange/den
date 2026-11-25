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
  navWarnings,
  railShapeDiffs,
  TOP_SHAPES,
  searchSlot,
  topSlotDiffs,
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
      // The placeholder is host content: where it sits is not compared.
      .filter((e) => e.key.startsWith("#den-search") && !e.host)
      .flatMap((e) => [`${e.key} box.left`, `${e.key} box.right`]);
    // …and it is off its slot (searchSlot, from the viewport alone).
    expect(ids(s, ref)).toEqual([...keys, "#den-search slot.x"].sort());
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

  // issue 303: the search and the kit's right-side items (Report, the bell,
  // the version chip, ◐) sit where the reference has them, whatever the
  // host's words: no host-content shift excuses moving them.
  const PINNED =
    /^(#den-search|header\.den-top > div\.den-chips > button\.den-rb|#den-bell|#version-pill|#appearance-btn)( >|$)/;
  const widen = (s: NavSnapshot, key: string, by: number) => {
    const e = at(s, key);
    e.box.w += by;
    if (e.host?.fit != null) e.host.fit += by;
  };
  const shift = (s: NavSnapshot, test: (k: string) => boolean, by: number) => {
    for (const e of s.elements) if (test(e.key)) e.box.x += by;
  };

  it("a longer crumb that moves the search fails on the search", () => {
    const s = copy(ref);
    widen(s, "#env-btn", 40);
    shift(s, (k) => /^#den-search( >|$)/.test(k), 40);
    const got = ids(s, ref);
    expect(got).toContain("#den-search box.left");
    expect(got).toContain("#den-search box.right");
  });

  it("a longer brand title that moves the search fails on the search", () => {
    const s = copy(ref);
    widen(
      s,
      "header.den-top > div.den-left > a.den-brand > span.den-title",
      30,
    );
    shift(
      s,
      (k) =>
        /^(#den-search|header\.den-top > div\.den-left > div\.den-scope|#org-crumb|#ws-pill|#env-btn)( >|$)/.test(
          k,
        ),
      30,
    );
    expect(ids(s, ref)).toContain("#den-search box.left");
  });

  it("a wider host chip that moves Report, the bell, the version or ◐ fails on them", () => {
    const s = copy(ref);
    widen(s, "#den-status", 20);
    shift(s, (k) => PINNED.test(k) && !k.startsWith("#den-search"), 20);
    shift(s, (k) => k.startsWith("#den-runs"), 20);
    const got = ids(s, ref);
    for (const k of [
      "header.den-top > div.den-chips > button.den-rb",
      "#den-bell",
      "#version-pill",
      "#appearance-btn",
    ])
      expect(got).toContain(`${k} box.left`);
  });

  it("a longer crumb that moves nothing kit-pinned passes", () => {
    const s = copy(ref);
    widen(s, "#env-btn", 40);
    expect(ids(s, ref).filter((x) => PINNED.test(x.split(" ")[0]!))).toEqual(
      [],
    );
  });

  // 0.7.1: kit-owned slots are compared by their content's shape too.
  const ACCT = "#den-ident";
  const withShape = (shape: string, lines?: number) => {
    const r = copy(ref);
    at(r, ACCT).shape = shape;
    at(r, ACCT).account = true;
    if (lines != null) at(r, ACCT).lines = lines;
    return r;
  };
  it("the account entry's shape is the kit's: name over @login, or @login alone, never a role", () => {
    const r = withShape("name,login", 2);
    expect(ids(withShape("name,login", 2), r)).toEqual([]);
    expect(ids(withShape("login", 1), r)).toEqual([]);
    // "@login · role" drawn in the entry: another shape.
    expect(ids(withShape("login,role", 1), r)).toEqual([`${ACCT} shape`]);
    expect(ids(withShape("name,login,role", 2), r)).toEqual([`${ACCT} shape`]);
    // A name alone (no login), or name and login on one line.
    expect(ids(withShape("name", 1), r)).toEqual([`${ACCT} shape`]);
    expect(ids(withShape("name,login", 1), r)).toEqual([`${ACCT} shape`]);
  });

  // Issue 1341: the rail's foot is one .den-rail-foot holding the account
  // entry. An entry of another line count than the reference's makes the
  // foot taller or shorter by exactly its own change, and no more.
  const FOOT = "#den-rail > div.den-rail-foot";
  const oneLine = (extra = 0) => {
    const s = withShape("login", 1);
    const a = at(s, ACCT);
    const d = 16;
    a.box.h -= d;
    a.box.y += d;
    a.style.height = `${parseFloat(a.style.height) - d}px`;
    const f = at(s, FOOT);
    f.box.h -= d + extra;
    f.box.y += d + extra;
    f.style.height = `${parseFloat(f.style.height) - d - extra}px`;
    return s;
  };
  it("issue 1341: the foot follows the account entry's own height change", () => {
    const r = withShape("name,login", 2);
    expect(ids(oneLine(), r).filter((x) => x.startsWith(FOOT + " "))).toEqual(
      [],
    );
  });
  it("issue 1341: a foot that changes by more than the account entry fails", () => {
    const r = withShape("name,login", 2);
    expect(ids(oneLine(8), r)).toContain(`${FOOT} style.height`);
  });
  it("issue 1341: the foot's height still holds when the account's line count matches", () => {
    const r = withShape("name,login", 2);
    const s = withShape("name,login", 2);
    at(s, FOOT).style.height = `${parseFloat(at(s, FOOT).style.height) - 16}px`;
    expect(ids(s, r)).toContain(`${FOOT} style.height`);
  });

  it("an account given the old label/detail fails: flagged as deprecated", () => {
    const r = withShape("name,login", 2);
    const s = withShape("name,login", 2);
    at(s, ACCT).legacy = true;
    expect(ids(s, r)).toEqual([`${ACCT} legacy`]);
  });

  it("two searches of different widths at the same viewport fail", () => {
    const s = copy(ref);
    at(s, "#den-search").box.w += 116;
    expect(ids(s, ref)).toContain("#den-search box.right");
  });

  it("searchSlot: the search's x and width for a viewport, the same in any host", () => {
    expect(searchSlot(1280)).toEqual({ x: 464, w: 304 });
    expect(searchSlot(1100)).toEqual({ x: 396, w: 304 });
    expect(searchSlot(960)).toEqual({ x: 256, w: 304 });
    // Issue 981: under 944px the search gives way before the crumbs do
    // (the left part keeps 220px, the project picker in it); down to its
    // icon (56px) where the page is zoomed.
    expect(searchSlot(944)).toEqual({ x: 240, w: 304 });
    expect(searchSlot(820)).toEqual({ x: 240, w: 180 });
    expect(searchSlot(800)).toEqual({ x: 240, w: 160 });
    expect(searchSlot(768)).toEqual({ x: 240, w: 128 });
    expect(searchSlot(721)).toEqual({ x: 240, w: 81 });
    expect(searchSlot(390)).toEqual({ x: 82, w: 54 });
    expect(searchSlot(600)).toEqual({ x: 220, w: 54 });
  });

  // The right group, anchored from the right edge in any host: ◐ at the
  // bar's padding, then the version's fixed slot, the bell, Report, 4px
  // apart. Widths that depend on the engine (Report's words, ◐'s glyph)
  // are taken as drawn; their places follow.
  const rightGroup = (vw: number, report: number) => {
    const s = copy(ref);
    s.viewport.w = vw;
    const ap = at(s, "#appearance-btn");
    ap.box.x = vw - 12 - ap.box.w;
    const ver = at(s, "#version-pill");
    ver.box.w = vw > 1100 ? 96 : 64;
    ver.box.x = ap.box.x - 4 - ver.box.w;
    const bell = at(s, "#den-bell");
    bell.box.x = ver.box.x - 4 - bell.box.w;
    const rb = s.elements.find((e) => e.classes.includes("den-rb-top"))!;
    rb.box.x = report;
    at(s, "#den-search").box.x = searchSlot(vw).x;
    return { s, bellX: bell.box.x, rbW: rb.box.w };
  };
  it("topSlotDiffs: Report, bell, version and ◐ anchored from the right edge", () => {
    const ok = rightGroup(1100, 0);
    const good = ok.bellX - 4 - ok.rbW;
    expect(topSlotDiffs(rightGroup(1100, good).s)).toEqual([]);
    // Today's Den at 1100: Report at 788 (its version's words moved it).
    expect(
      topSlotDiffs(rightGroup(1100, 788).s).map(
        (d) => `${d.key} ${d.property}`,
      ),
    ).toEqual([
      `${rightGroup(1100, 0).s.elements.find((e) => e.classes.includes("den-rb-top"))!.key} slot.x`,
    ]);
    // A version in another width fails on its slot.
    const v = rightGroup(1280, 0);
    at(v.s, "#version-pill").box.w = 111;
    expect(topSlotDiffs(v.s).map((d) => d.property)).toContain("slot.w");
  });

  it("a crumb whose label shows while its value is hidden fails", () => {
    const s = copy(ref);
    const c = s.elements.find(
      (e) => e.host?.role === "crumb" && e.host.key === e.key,
    )!;
    c.labelOnly = true;
    expect(ids(s, ref)).toContain(`${c.key} crumb.value`);
  });

  it("a search away from searchSlot fails at any width, with no reference box", () => {
    const s = copy(ref);
    const e = at(s, "#den-search");
    s.viewport.w = 1100;
    // Where a host drew it before the slot (Den's 1280 place).
    e.box.x = 464;
    expect(ids(s, s)).toContain("#den-search slot.x");
  });

  it("lists host HTML in the account and search slots (a warning, not a failure)", () => {
    const s = withShape("name,login", 2);
    at(s, "#den-search").kit = "search";
    expect(navWarnings(s)).toEqual([]);
    delete at(s, ACCT).shape;
    delete at(s, "#den-search").kit;
    expect(navWarnings(s).sort()).toEqual([
      `account: ${ACCT} is not the kit's (host HTML; draw it with accountHtml)`,
      "search: #den-search is not the kit's (host HTML; draw it with searchHtml)",
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

// Issue 694: a page drawn with topBarHtml({ rail: false }) (the header's
// data-nav-shape "no-rail") has no rail and no ☰, at any width.
describe("nav inventory: the top bar's no-rail shape (issue 694)", () => {
  const ref = read("chromium", 390);
  const TOP = "header.den-top";
  const head = (s: NavSnapshot) => s.elements.find((e) => e.key === TOP)!;
  // The bar as rail: false draws it: no ☰, no rail, the shape stamped.
  const noRail = () => {
    const s = copy(ref);
    s.elements = s.elements.filter(
      (e) => e.slot === "top" && !e.key.startsWith("#den-menu-btn"),
    );
    head(s).shape = "no-rail";
    delete head(s).menu;
    delete head(s).rail;
    return s;
  };

  it("no-rail is a shape the kit draws", () => {
    expect(TOP_SHAPES).toContain("no-rail");
  });

  it("the default shape (☰ and a rail) passes, as before", () => {
    expect(railShapeDiffs(ref)).toEqual([]);
    expect(ids(copy(ref), ref)).toEqual([]);
  });

  it("a no-rail page with neither a rail nor ☰ passes, against its own shape", () => {
    const s = noRail();
    expect(railShapeDiffs(s)).toEqual([]);
    expect(ids(s, noRail())).toEqual([]);
  });

  it("a no-rail page that draws ☰ fails", () => {
    const s = noRail();
    const menu = ref.elements.find((e) => e.key === "#den-menu-btn")!;
    s.elements.splice(1, 0, JSON.parse(JSON.stringify(menu)));
    expect(railShapeDiffs(s).map((d) => `${d.key} ${d.property}`)).toEqual([
      `${TOP} menu`,
    ]);
    expect(ids(s, noRail())).toContain(`${TOP} menu`);
  });

  it("a no-rail page with ☰ in the page but hidden fails all the same", () => {
    const s = noRail();
    head(s).menu = true;
    expect(railShapeDiffs(s).map((d) => d.property)).toEqual(["menu"]);
  });

  it("a no-rail page that draws a rail fails", () => {
    const s = noRail();
    s.elements.push(
      ...ref.elements
        .filter((e) => e.slot !== "top")
        .map((e) => JSON.parse(JSON.stringify(e))),
    );
    expect(railShapeDiffs(s).map((d) => `${d.key} ${d.property}`)).toEqual([
      `${TOP} rail`,
    ]);
    const hidden = noRail();
    head(hidden).rail = true;
    expect(railShapeDiffs(hidden).map((d) => d.property)).toEqual(["rail"]);
  });

  it("a top bar shape the kit doesn't draw fails", () => {
    const s = noRail();
    head(s).shape = "no-menu";
    expect(railShapeDiffs(s).map((d) => `${d.key} ${d.property}`)).toEqual([
      `${TOP} shape`,
    ]);
  });

  it("a no-rail page against the default reference fails on the shape", () => {
    expect(ids(noRail(), ref)).toContain(`${TOP} shape`);
  });
});
