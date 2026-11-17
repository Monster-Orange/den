/**
 * Issue 313, item 3: the empty-container rule. A container that holds
 * nothing in one product and something in the other (the top bar's
 * den-end: empty in one, status chips in another) has its height set by
 * what it holds, so its top, bottom and height are not compared. Its x and
 * width still are, and a container with children on both sides is compared
 * as before. Hand-built inventories, no browser.
 */
import { describe, expect, it } from "@jest/globals";
import {
  compareNav,
  NAV_INVENTORY_VERSION,
  NAV_THEME,
  type NavElement,
  type NavSnapshot,
} from "../../../packages/den-ui/inventory/nav-inventory.js";

const BAR = "header.den-top";
const CHIPS = `${BAR} > div.den-chips`;
const END = `${CHIPS} > div.den-end`;

const el = (
  key: string,
  parent: string | null,
  box: NavElement["box"],
): NavElement => ({
  key,
  parent,
  slot: "top",
  role: "div",
  tag: key === BAR ? "header" : "div",
  name: "",
  classes: [key.split(".").pop()!],
  box,
  style: { height: `${box.h}px` },
});

/** The bar, its chips row, den-end, and (if `kids`) one chip in den-end. */
function snap(end: NavElement["box"], kids: number): NavSnapshot {
  const elements = [
    el(BAR, null, { x: 0, y: 0, w: 1280, h: 48 }),
    el(CHIPS, BAR, { x: 600, y: 8, w: 400, h: 32 }),
    el(END, CHIPS, end),
  ];
  for (let i = 0; i < kids; i++)
    elements.push({
      ...el(`${END} > span.chip[${i + 1}]`, END, {
        x: end.x + i * 40,
        y: end.y,
        w: 36,
        h: end.h,
      }),
      // Host content: what it is and where it sits are the host's.
      host: { role: "status", key: `${END} > span.chip[${i + 1}]` },
    });
  return {
    version: NAV_INVENTORY_VERSION,
    viewport: { w: 1280, h: 800 },
    env: { userAgent: "test", faces: {}, theme: NAV_THEME },
    elements,
    tokens: {},
  } as unknown as NavSnapshot;
}

const endDiffs = (actual: NavSnapshot, reference: NavSnapshot) =>
  compareNav(actual, reference)
    .filter((d) => d.key === END)
    .map((d) => d.property)
    .sort();

describe("nav inventory: the empty-container rule (issue 313)", () => {
  // den-end empty in the reference, a 24px row of chips in the other.
  const empty = { x: 1000, y: 24, w: 0, h: 0 };
  const full = { x: 1000, y: 12, w: 0, h: 24 };

  it("(a) empty on one side: another top, bottom and height are not diffs", () => {
    expect(endDiffs(snap(full, 2), snap(empty, 0))).toEqual([]);
    // Either way round.
    expect(endDiffs(snap(empty, 0), snap(full, 2))).toEqual([]);
  });

  it("(b) empty on one side: another x or width still fails", () => {
    expect(endDiffs(snap({ ...full, x: 990 }, 2), snap(empty, 0))).toEqual([
      "box.left",
      "box.right",
    ]);
    expect(endDiffs(snap({ ...full, w: 40 }, 2), snap(empty, 0))).toEqual([
      "box.right",
    ]);
  });

  it("(c) children on both sides: another height still fails", () => {
    // One chip in each, den-end 24px against 32px tall. If the rule
    // skipped any container whose child count differs, or any container
    // at all, this would pass with no diffs.
    expect(
      endDiffs(snap({ ...full, h: 32 }, 1), snap(full, 2)).filter((p) =>
        /height|top|bottom/.test(p),
      ),
    ).toEqual(["box.bottom", "style.height"]);
  });

  it("(c) empty on both sides: another height still fails", () => {
    expect(endDiffs(snap({ ...empty, h: 8 }, 0), snap(empty, 0))).toEqual([
      "box.bottom",
      "style.height",
    ]);
  });
});
