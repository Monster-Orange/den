import { describe, expect, it } from "@jest/globals";
import { goneBell } from "../../../src/ui/server/hub-delivery-service.js";

describe("issue 1673: the bell for items kept for a removed agent", () => {
  it("one item, in the bell's words, scoped to the item's project", () => {
    const added: {
      subject: string;
      scope?: string;
      text: string;
      msg?: unknown;
    }[] = [];
    const store = {
      add: (n: (typeof added)[number]) => {
        added.push(n);
        return null;
      },
      withdraw: () => true,
    };
    goneBell("planner-1", [{ project: "north" }, { project: "north" }], 7_000, {
      store,
    });
    expect(added).toHaveLength(1);
    expect(added[0].subject).toBe("record:delivery-gone:planner-1:7000");
    expect(added[0].scope).toBe("workspace/north");
    expect(added[0].text).toBe(
      "Not delivered: planner-1 was removed. 2 messages for it are kept.",
    );
    expect(added[0].msg).toEqual({
      key: "bell.m.deliveryGone",
      vars: { name: "planner-1", n: 2 },
    });
  });

  it("nothing kept: no bell", () => {
    const added: unknown[] = [];
    goneBell("planner-1", [], 7_000, {
      store: {
        add: (n: unknown) => (added.push(n), null),
        withdraw: () => true,
      },
    });
    expect(added).toEqual([]);
  });
});
