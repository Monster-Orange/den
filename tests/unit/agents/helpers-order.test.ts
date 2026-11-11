/**
 * D32: how helpers are listed. Running first, then the newest; a helper's
 * own helpers right under it (0.4.28-dev.0's gate: a nested helper sorted
 * flat by start time showed above its parent, indented under the row
 * before it). The indent counts only parents shown above.
 */
import { describe, expect, it } from "@jest/globals";
import {
  capHelpers,
  shownDepths,
  sortHelpers,
  type Helper,
} from "../../../src/shared/agents/helpers.js";

const h = (
  id: string,
  startedAt: number,
  more: Partial<Helper> = {},
): Helper => ({
  id,
  depth: more.parentId ? 2 : 1,
  status: "done",
  statusFrom: "test",
  startedAt,
  ...more,
});

/** The cases the page's twin (agent-helpers.js) is checked against too. */
const ORDER_CASES: { name: string; list: Helper[]; ids: string[] }[] = [
  {
    name: "a child started after its parent and after a later sibling",
    list: [h("p", 100), h("q", 300), h("c", 400, { parentId: "p", depth: 2 })],
    ids: ["q", "p", "c"],
  },
  {
    name: "grandchildren under their parents; running first at each level",
    list: [
      h("p", 100),
      h("c1", 200, { parentId: "p" }),
      h("c2", 150, { parentId: "p", status: "running" }),
      h("g", 250, { parentId: "c1", depth: 3 }),
    ],
    ids: ["p", "c2", "c1", "g"],
  },
  {
    name: "a done parent with a running child: the branch sorts as running",
    list: [
      h("p", 100),
      h("q", 300),
      h("c", 150, { parentId: "p", status: "running" }),
    ],
    ids: ["p", "c", "q"],
  },
  {
    name: "a running grandchild lifts its branch at every level",
    list: [
      h("p", 100),
      h("q", 300),
      h("c1", 200, { parentId: "p" }),
      h("c2", 120, { parentId: "p" }),
      h("g", 250, { parentId: "c2", depth: 3, status: "running" }),
    ],
    ids: ["p", "c2", "g", "c1", "q"],
  },
  {
    name: "a parent not listed: the child at the top level",
    list: [h("a", 100), h("orphan", 200, { parentId: "gone" })],
    ids: ["orphan", "a"],
  },
  {
    name: "a loop of parents: still listed, once each",
    list: [h("x", 100, { parentId: "y" }), h("y", 200, { parentId: "x" })],
    ids: ["y", "x"],
  },
];

describe("sortHelpers: a tree, running first, then the newest", () => {
  it.each(ORDER_CASES)("$name", ({ list, ids }) => {
    expect(sortHelpers(list).map((x) => x.id)).toEqual(ids);
  });
});

describe("shownDepths: indent only under a parent shown above", () => {
  it("one step per shown parent; none when the parent isn't listed", () => {
    const list = sortHelpers([
      h("p", 100),
      h("c", 200, { parentId: "p" }),
      h("g", 300, { parentId: "c", depth: 3 }),
      h("orphan", 50, { parentId: "gone", depth: 2 }),
    ]);
    expect([...shownDepths(list)]).toEqual([
      ["p", 0],
      ["c", 1],
      ["g", 2],
      ["orphan", 0],
    ]);
  });

  it("a parent folded away (filtered out): its child isn't indented", () => {
    const all = sortHelpers([h("p", 100), h("c", 200, { parentId: "p" })]);
    const shown = all.filter((x) => x.id !== "p");
    expect(shownDepths(shown).get("c")).toBe(0);
  });
});

describe("capHelpers: a running helper is never cut for a done one", () => {
  it("keeps the running child of a done parent past the cap, in order", () => {
    const list = [
      ...Array.from({ length: 9 }, (_, i) => h(`d${i}`, 900 - i)),
      h("kid", 50, { parentId: "d8", status: "running" }),
    ];
    const out = capHelpers(list, 8).map((x) => x.id);
    expect(out).toHaveLength(8);
    expect(out.at(-1)).toBe("kid");
    expect(out.slice(0, 7)).toEqual(list.slice(0, 7).map((x) => x.id));
  });

  it("under the cap: all of them, unchanged", () => {
    const list = [h("a", 2), h("b", 1, { status: "running" })];
    expect(capHelpers(list, 8)).toEqual(list);
  });
});
