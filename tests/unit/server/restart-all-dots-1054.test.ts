/**
 * Issues 1054 and 698: Restart all now (issue 1407) shows its wait on its
 * own button with the kit's dots, never a disabled state of its own.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { wireRestartNow } from "../../../src/ui/server/public/restart-result.js";

type Handler = () => Promise<void>;

function fakeButton(data: Record<string, string>) {
  const on: Record<string, Handler> = {};
  return {
    dataset: data,
    disabled: false,
    attrs: {} as Record<string, string>,
    removed: false,
    on,
    addEventListener(ev: string, h: Handler) {
      on[ev] = h;
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    closest: () => null,
    remove() {
      this.removed = true;
    },
  };
}

describe("issues 1054 and 698: Restart all now", () => {
  it("holds the kit's dots on its button until every restart answers", async () => {
    const rows = [
      fakeButton({ rsNow: "a1", rsWs: "w" }),
      fakeButton({ rsNow: "a2", rsWs: "w" }),
    ];
    const all = fakeButton({});
    const root = {
      querySelectorAll: () => rows.filter((b) => !b.removed),
      querySelector: (s: string) => (s === "[data-rs-all]" ? all : null),
    };
    const order: string[] = [];
    const release = jest.fn(() => order.push("release"));
    const holdDots = jest.fn((b: unknown) => {
      order.push(b === all ? "hold all" : "hold other");
      return release;
    });
    wireRestartNow(
      root as never,
      {
        api: async () => {
          order.push("restart");
          return { ok: true };
        },
        holdDots,
        t: (k: string) => k,
      } as never,
    );
    await all.on.click!();
    expect(holdDots).toHaveBeenCalledWith(all);
    expect(order).toEqual(["hold all", "restart", "restart", "release"]);
    // The kit's hold is the only busy state: none drawn here.
    expect(all.attrs["aria-busy"]).toBeUndefined();
  });
});
