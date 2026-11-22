/**
 * Issue 313: the top bar's remaining shared slots, the checks that need no
 * browser (the browser half is topbar-slots-313.browser.test.ts).
 *
 *   1. Chips from data: chipHtml draws a chip from its data, and the bar's
 *      end, bell and account slots take data, so no product hands the kit
 *      its own markup for them. Den draws its chips that way.
 *   2. The ⋯ overflow: fitChips moves the chips that don't fit, last
 *      first, behind ⋯, and brings them back when there is room.
 *   4. The inventory: a host's own HTML around the bar (a banner above
 *      it, a wrapper with a margin) moves the whole nav, and that is no
 *      difference; one element moved inside the bar still is.
 *   5. Crumb labels: a label that gives way ends in "…", and the kit hides
 *      one narrower than its least width (--den-crumb-label-min).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  appearanceButtonHtml,
  bellButtonHtml,
  chipHtml,
  topBarHtml,
} from "../../../packages/den-ui/src/shell-html.js";
import {
  fitChips,
  fitCrumbLabels,
  keepChipsMenu,
  ownRect,
  standInChip,
} from "../../../packages/den-ui/src/shell-client.js";
import {
  compareNav,
  searchSlot,
  topSlotDiffs,
  NAV_INVENTORY_VERSION,
  NAV_THEME,
  type NavElement,
  type NavSnapshot,
} from "../../../packages/den-ui/inventory/nav-inventory.js";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");

describe("1. chips from data (chipHtml)", () => {
  it("draws a chip from its data: id, dot, words, tone, the kit's stamp", () => {
    const h = chipHtml({ id: "st", dot: "bad", text: "2 down", tone: "bad" });
    expect(h).toBe(
      '<button type="button" class="den-chip bad" id="st" data-nav-kit="chip">' +
        '<span class="den-dot bad" aria-hidden="true"></span>' +
        '<span class="den-n">2 down</span></button>',
    );
  });

  it("escapes the host's words and drops a dot or tone it doesn't know", () => {
    const h = chipHtml({
      id: 'x"y',
      dot: "purple",
      tone: "loud",
      text: "<b>hi</b>",
    });
    expect(h).toContain('id="x-y"');
    expect(h).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(h).not.toContain("purple");
    expect(h).not.toContain("loud");
    // An unknown dot is a plain dot (no tone), not none.
    expect(h).toContain('<span class="den-dot" aria-hidden="true"></span>');
  });

  it("takes a lead, short words, an icon, a pop-up, busy, hidden and a name", () => {
    const h = chipHtml({
      id: "lk",
      icon: "key",
      text: "Waiting",
      short: true,
      tone: "warn",
      popup: "dialog",
      busy: true,
      hidden: true,
      title: "Needs the password",
      name: "Waiting for the password",
    });
    expect(h).toContain('class="den-chip warn"');
    expect(h).toContain('aria-haspopup="dialog" aria-expanded="false"');
    expect(h).toContain('aria-busy="true"');
    expect(h).toContain(" hidden");
    expect(h).toContain('title="Needs the password"');
    expect(h).toContain('aria-label="Waiting for the password"');
    expect(h).toContain(
      '<span class="den-chip-ic" aria-hidden="true">🔑</span>',
    );
    expect(h).toContain('<span class="den-n den-lbl-l">Waiting</span>');
    const lead = chipHtml({ id: "s", dot: "", text: "up", lead: "3 of 4" });
    expect(lead).toContain(
      '<span class="den-n"><span class="den-lbl-l">3 of 4</span>up</span>',
    );
    expect(lead).toContain('<span class="den-dot" aria-hidden="true"></span>');
  });

  it("is a link with an href", () => {
    const h = chipHtml({ id: "r", text: "Runs", href: "/runs" });
    expect(h).toMatch(
      /^<a class="den-chip" id="r" data-nav-kit="chip" href="\/runs">/,
    );
    expect(h).toMatch(/<\/a>$/);
  });

  it("topBarHtml takes the end, bell and account slots as data", () => {
    const chips = [
      { id: "a", dot: "off", text: "Checking" },
      { id: "b", text: "Runs", short: true },
    ];
    const bar = topBarHtml({
      product: { name: "Acme" },
      slots: {
        end: chips,
        bell: { count: 3 },
        account: { label: "Look", title: "Look and language" },
      },
    });
    expect(bar).toContain(
      '<div class="den-end">' +
        chips.map((c) => chipHtml(c)).join("") +
        "</div>",
    );
    expect(bar).toContain(bellButtonHtml({ count: 3 }));
    expect(bar).toContain(
      '<span class="den-user" id="den-user">' +
        appearanceButtonHtml({ label: "Look", title: "Look and language" }) +
        "</span>",
    );
    // `chips` is the same as an `end` list.
    expect(
      topBarHtml({ product: { name: "Acme" }, chips, slots: {} }),
    ).toContain(chips.map((c) => chipHtml(c)).join(""));
    // HTML in the slots still draws (one release), as before.
    expect(
      topBarHtml({ product: { name: "Acme" }, slots: { end: "<i>x</i>" } }),
    ).toContain('<div class="den-end"><i>x</i></div>');
  });

  it("Den draws its chips from data, never its own chip markup", () => {
    for (const f of [
      "src/ui/server/public/shell.js",
      "src/ui/server/public/topbar.js",
    ]) {
      const src = read(f);
      expect([f, /class="den-chip/.test(src)]).toEqual([f, false]);
      expect([f, /chip\.innerHTML\s*=/.test(src)]).toEqual([f, false]);
    }
    expect(read("src/ui/server/public/shell.js")).toMatch(/var slotEnd = \[/);
  });

  it("the kit owns the chip's look; Den keeps no copy", () => {
    const css = read("packages/den-ui/src/shell.css");
    expect(css).toMatch(/\n\.den-chip \{/);
    expect(css).toMatch(/\.den-chip\.warn \{/);
    expect(css).toMatch(/\.den-dot\.run \{/);
    const den = read("src/ui/server/public/shell.js");
    expect(den).not.toMatch(/"\.den-chip \{/);
    expect(den).not.toMatch(/#den-lock \{ border-color/);
  });
});

/** A fake row of chips, right-aligned in `room` px, `gap` apart. */
function fakeRow(widths: number[], room: number, gap = 4, moreW = 28) {
  type C = { w: number; over: boolean; on: boolean; more?: boolean };
  const chips: C[] = widths.map((w) => ({ w, over: false, on: true }));
  const more: C = { w: moreW, over: false, on: false, more: true };
  const shown = () => [...chips, more].filter((c) => (c.more ? c.on : !c.over));
  return {
    chips,
    more,
    io: {
      chips: () => chips,
      overflows: () =>
        shown().reduce((s, c, i) => s + c.w + (i ? gap : 0), 0) > room + 0.5,
      setOver: (c: C, on: boolean) => (c.over = on),
      showMore: (on: boolean) => (more.on = on),
    },
  };
}

describe("2. the ⋯ overflow (fitChips)", () => {
  it("the fit measures a chip's own box, not ⋯'s that it stands in at", () => {
    class Box {
      constructor(public left: number) {}
      getBoundingClientRect() {
        return { left: this.left, right: this.left + 60 };
      }
      focus() {}
    }
    const chip = new Box(500);
    // ⋯ hidden: its box is empty, at 0.
    const more = new Box(0);
    standInChip(chip as never, more as never);
    expect(chip.getBoundingClientRect().left).toBe(0);
    expect(ownRect(chip)).toEqual({ left: 500, right: 560 });
    standInChip(chip as never, null);
    expect(ownRect(chip)).toEqual({ left: 500, right: 560 });
  });

  it("ownRect falls back to the element's own method when its prototype has none", () => {
    const bare = Object.assign(Object.create(null), {
      getBoundingClientRect: () => ({ left: 7, right: 9 }),
    }) as { getBoundingClientRect(): { left: number; right: number } };
    expect(ownRect(bare)).toEqual({ left: 7, right: 9 });
  });

  it("everything fits: no ⋯, nothing hidden", () => {
    const r = fakeRow([60, 60], 200);
    expect(fitChips(r.io)).toEqual([]);
    expect(r.more.on).toBe(false);
    expect(r.chips.map((c) => c.over)).toEqual([false, false]);
  });

  it("too many: the last chips go behind ⋯ until the rest fit", () => {
    const r = fakeRow([60, 60, 60, 60], 160);
    const hidden = fitChips(r.io);
    // 60 + 4 + 60 + 4 + 28 = 156 fits; a third chip would not.
    expect(hidden).toEqual([r.chips[2], r.chips[3]]);
    expect(r.more.on).toBe(true);
    expect(r.chips.map((c) => c.over)).toEqual([false, false, true, true]);
  });

  it("room again: every chip comes back and ⋯ goes", () => {
    const r = fakeRow([60, 60, 60, 60], 160);
    fitChips(r.io);
    const wide = fakeRow([60, 60, 60, 60], 400);
    wide.chips.forEach((c, i) => (c.over = r.chips[i].over));
    wide.more.on = true;
    expect(fitChips(wide.io)).toEqual([]);
    expect(wide.more.on).toBe(false);
    expect(wide.chips.every((c) => !c.over)).toBe(true);
  });

  it("⋯ never shows empty, and nothing spills: over with ⋯ hidden, fits once ⋯ shows", () => {
    const r = fakeRow([60, 60], 200);
    // The chips shrink to make room for ⋯, so the bar reads as fitting
    // once ⋯ shows. Hiding ⋯ again would spill; one chip goes behind it.
    r.io.overflows = () => !r.more.on;
    expect(fitChips(r.io)).toEqual([r.chips[1]]);
    expect(r.more.on).toBe(true);
    expect(r.io.overflows()).toBe(false);
  });

  it("not even one fits: all go behind ⋯", () => {
    const r = fakeRow([60, 60], 40);
    expect(fitChips(r.io)).toEqual(r.chips);
    expect(r.more.on).toBe(true);
  });
});

describe("4. the inventory: a host's own HTML around the bar", () => {
  const BAR = "header.den-top";
  const el = (
    key: string,
    parent: string | null,
    box: NavElement["box"],
    slot = "top",
  ): NavElement => ({
    key,
    parent,
    slot,
    role: "div",
    tag: key === BAR ? "header" : "div",
    name: "",
    classes: [key.split(/[ .>]/).filter(Boolean).pop()!],
    box,
    style: { height: `${box.h}px` },
  });
  /** The bar and the rail, moved by (dx, dy): what a host's HTML does. */
  function snap(dx: number, dy: number, inner = 0): NavSnapshot {
    const at = (b: NavElement["box"]) => ({ ...b, x: b.x + dx, y: b.y + dy });
    return {
      version: NAV_INVENTORY_VERSION,
      viewport: { w: 1280, h: 800 },
      env: { userAgent: "test", faces: {}, theme: NAV_THEME },
      elements: [
        el(BAR, null, at({ x: 0, y: 0, w: 1280, h: 48 })),
        el(
          `${BAR} > div.den-left`,
          BAR,
          at({ x: 12 + inner, y: 8, w: 440, h: 32 }),
        ),
        el("nav.den-rail", null, at({ x: 0, y: 48, w: 220, h: 752 }), "rail"),
        el(
          'nav.den-rail > a[data-nav="home"]',
          "nav.den-rail",
          at({ x: 8, y: 56, w: 204, h: 32 }),
          "rail",
        ),
      ],
      tokens: {},
    } as unknown as NavSnapshot;
  }

  it("a banner above the bar (the whole nav 40px lower) is no difference", () => {
    expect(compareNav(snap(0, 40), snap(0, 0))).toEqual([]);
  });

  it("a wrapper with a margin (the whole nav moved right and down) is none", () => {
    expect(compareNav(snap(16, 24), snap(0, 0))).toEqual([]);
  });

  it("one element moved inside the bar still fails, banner or not", () => {
    const props = compareNav(snap(0, 40, 6), snap(0, 0))
      .filter((d) => d.key === `${BAR} > div.den-left`)
      .map((d) => d.property)
      .sort();
    expect(props).toEqual(["box.left", "box.right"]);
  });
});

describe("5. crumb labels cut cleanly", () => {
  it("a label that gives way ends in … (never part of a glyph)", () => {
    const css = read("packages/den-ui/src/shell.css");
    const rule = css.match(/\.den-scope \.den-ib > \.den-k \{[^}]*\}/);
    expect(rule && rule[0]).toMatch(/text-overflow: ellipsis/);
    // The kit hides one it marks too narrow, whatever else shows it.
    expect(css).toMatch(
      /\.den-scope \.den-ib > \.den-k\[data-den-cut\] \{\s*display: none !important;/,
    );
    expect(css).toMatch(/--den-crumb-label-min: 24px/);
  });

  /** Labels with a width each, cut when narrower than their words. */
  function labels(spec: Array<[number, number]>) {
    return spec.map(([w, whole]) => ({ w, whole, cut: false }));
  }
  const io = (ls: ReturnType<typeof labels>, min = 24) => ({
    labels: () => ls,
    min: () => min,
    width: (l: (typeof ls)[0]) => l.w,
    whole: (l: (typeof ls)[0]) => l.w >= l.whole,
    setCut: (l: (typeof ls)[0], on: boolean) => (l.cut = on),
  });

  it("hides a cut label narrower than the least width, keeps the others", () => {
    // Whole; cut but 30px wide (ends in …); cut and 10px (hidden).
    const ls = labels([
      [60, 60],
      [30, 56],
      [10, 48],
    ]);
    fitCrumbLabels(io(ls));
    expect(ls.map((l) => l.cut)).toEqual([false, false, true]);
  });

  it("brings a label back when its crumb has room again", () => {
    const ls = labels([[10, 48]]);
    ls[0].cut = true;
    ls[0].w = 48;
    fitCrumbLabels(io(ls));
    expect(ls[0].cut).toBe(false);
  });

  it("the least width is a setting", () => {
    const ls = labels([[30, 56]]);
    fitCrumbLabels(io(ls, 40));
    expect(ls[0].cut).toBe(true);
  });
});

describe("review of PR 918", () => {
  it("1. a re-fit keeps ⋯'s menu open while the same chips are behind it", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    expect(keepChipsMenu([a, b], [a, b])).toBe(true);
    // Another set behind ⋯, or none: its rows are stale, so it closes.
    expect(keepChipsMenu([a, b], [b])).toBe(false);
    expect(keepChipsMenu([a], [a, b])).toBe(false);
    expect(keepChipsMenu([a], [])).toBe(false);
  });

  it("2. a chip behind ⋯ stands in at ⋯: its box and its focus are ⋯'s", () => {
    let focused = "";
    const more = {
      getBoundingClientRect: () => ({ x: 900, y: 8, width: 28, height: 28 }),
      focus: () => (focused = "more"),
    };
    const chip = {
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      focus: () => (focused = "chip"),
    } as Record<string, unknown> & {
      getBoundingClientRect(): { x: number };
      focus(): void;
    };
    const own = chip.getBoundingClientRect;
    standInChip(chip, more);
    expect(chip.getBoundingClientRect().x).toBe(900);
    chip.focus();
    expect(focused).toBe("more");
    // Shown again: its own box and focus.
    standInChip(chip, null);
    chip.focus();
    expect(focused).toBe("chip");
    expect(chip.getBoundingClientRect).toBe(own);
  });

  it("3. the slot checks measure from the bar (a 20px side margin is no difference)", () => {
    const vw = 1100;
    const bw = vw - 40;
    const el = (key: string, x: number, w: number, extra = {}) => ({
      key,
      parent: key === "header.den-top" ? null : "header.den-top",
      slot: "top",
      role: "button",
      tag: key === "header.den-top" ? "header" : "button",
      name: "",
      classes: [],
      box: { x, y: 8, w, h: 32 },
      style: {},
      ...extra,
    });
    // The right group from the bar's right edge, the search in its slot,
    // all 20px in from the window.
    const ap = 20 + bw - 12 - 40;
    const ver = ap - 4 - 64;
    const bell = ver - 4 - 34;
    const rb = bell - 4 - 90;
    const search = searchSlot(vw, bw);
    const snap = {
      version: NAV_INVENTORY_VERSION,
      viewport: { w: vw, h: 800 },
      env: { userAgent: "test", faces: {}, theme: NAV_THEME },
      elements: [
        el("header.den-top", 20, bw),
        el("#den-search", 20 + search.x, search.w, { classes: ["den-search"] }),
        el("button.rb", rb, 90, { classes: ["den-rb-top"] }),
        el("#den-bell", bell, 34),
        el("#version-pill", ver, 64),
        el("#appearance-btn", ap, 40),
      ],
      tokens: {},
    } as unknown as NavSnapshot;
    expect(topSlotDiffs(snap)).toEqual([]);
    // The bar's own width sets the search's slot, not the window's.
    expect(search.x).toBeLessThan(searchSlot(vw).x);
  });

  it("4. a chip's link is http, https or relative; any other scheme is no link", () => {
    for (const ok of [
      "/runs",
      "#x",
      "?a=1",
      "runs/2",
      "https://a.test/x",
      "http://a.test",
    ])
      expect(chipHtml({ id: "c", text: "x", href: ok })).toMatch(/^<a /);
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:x",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc",
    ]) {
      const h = chipHtml({ id: "c", text: "x", href: bad });
      expect([bad, h.startsWith("<button")]).toEqual([bad, true]);
      expect(h).not.toContain("href");
    }
  });
});
