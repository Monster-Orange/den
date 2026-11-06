/**
 * WS-6.10: the Workspaces settings as user.yml stores them (`switching`):
 * validated, defaults filled in and never stored.
 */
import { describe, expect, it } from "@jest/globals";
import {
  mergeSwitchPrefs,
  storedSwitchPrefs,
  switchPrefs,
} from "../../../src/ui/server/switch-prefs.js";

describe("switching prefs (WS-6.10)", () => {
  it("fills in the defaults", () => {
    expect(switchPrefs(undefined)).toEqual({
      on_pick: "show",
      confirm_stop_switch: true,
    });
    expect(switchPrefs({ on_pick: "ask" }).on_pick).toBe("ask");
  });

  it("merges a patch, and refuses an unknown value or key", () => {
    const cur = switchPrefs(undefined);
    expect(mergeSwitchPrefs(cur, { on_pick: "switch" })).toEqual({
      ok: true,
      value: { on_pick: "switch", confirm_stop_switch: true },
    });
    expect(mergeSwitchPrefs(cur, { on_pick: "later" })).toEqual({
      ok: false,
      error: 'switching.on_pick must be one of "show", "ask", "switch"',
    });
    expect(mergeSwitchPrefs(cur, { confirm_stop_switch: "no" }).ok).toBe(false);
    expect(mergeSwitchPrefs(cur, { colour: 1 }).ok).toBe(false);
    expect(mergeSwitchPrefs(cur, [] as unknown).ok).toBe(false);
    // null resets a key.
    expect(
      mergeSwitchPrefs(
        { on_pick: "ask", confirm_stop_switch: false },
        { on_pick: null, confirm_stop_switch: null },
      ),
    ).toEqual({
      ok: true,
      value: { on_pick: "show", confirm_stop_switch: true },
    });
  });

  it("stores only what differs from the defaults", () => {
    expect(storedSwitchPrefs(switchPrefs(undefined))).toBeUndefined();
    expect(
      storedSwitchPrefs({ on_pick: "ask", confirm_stop_switch: false }),
    ).toEqual({ on_pick: "ask", confirm_stop_switch: false });
  });
});
