import { describe, expect, it } from "@jest/globals";
import { MENU_LOAD, menuLoadTimeoutMs } from "../../../src/shared/menu-load.js";

const at = (v: unknown) => () =>
  ({ web: { menu_load_timeout_ms: v } }) as never;

describe("web.menu_load_timeout_ms", () => {
  it("unset: 8000", () => {
    expect(menuLoadTimeoutMs(() => ({}) as never)).toBe(8000);
    expect(MENU_LOAD.timeout_ms.default).toBe(8000);
  });
  it("in range: as set", () => {
    expect(menuLoadTimeoutMs(at(1000))).toBe(1000);
    expect(menuLoadTimeoutMs(at(20000))).toBe(20000);
    expect(menuLoadTimeoutMs(at(600000))).toBe(600000);
  });
  it("out of range or not a whole number: the default", () => {
    for (const v of [999, 600001, 1500.5, "9000", null, -1])
      expect(menuLoadTimeoutMs(at(v))).toBe(8000);
  });
  it("an unreadable config: the default", () => {
    expect(
      menuLoadTimeoutMs(() => {
        throw new Error("bad yaml");
      }),
    ).toBe(8000);
  });
});
