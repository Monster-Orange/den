/**
 * Bell v6 (0.4.45): a quieter bell. A person turns kinds off (Settings ›
 * Notifications; "Agent finished its turn" is off by default), items
 * older than the fold days fold apart, and the badge counts only what is
 * shown, not folded.
 */
import { describe, expect, it } from "@jest/globals";
import type { UserConfig } from "../../../src/shared/den-config.js";
import {
  BELL_SWITCHES,
  bellPrefs,
  bellView,
  type Notification,
  NOTIFICATION_KINDS,
  switchOf,
} from "../../../src/shared/notifications.js";
import {
  bellFoldDays,
  bellKinds,
  patchBellFoldDays,
  patchBellKinds,
} from "../../../src/ui/server/bell-prefs.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
let k = 0;
const note = (
  kind: Notification["kind"],
  daysAgo: number,
  read = false,
): Notification => ({
  id: `n${k++}`,
  source: "den",
  kind,
  subject: "agent:a",
  scope: "workspace/north",
  text: kind,
  at: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  read,
});

describe("bell v6: kinds", () => {
  it("every kind has a switch; Hub's replies and mentions share one", () => {
    for (const kind of NOTIFICATION_KINDS)
      expect(BELL_SWITCHES).toContain(switchOf(kind));
    expect(switchOf("answer")).toBe("hub");
    expect(switchOf("mention")).toBe("hub");
    expect(switchOf("decision")).toBe("pick");
  });

  it("unset: every switch on but finished; a hand-broken value is its default", () => {
    expect(bellPrefs(null)).toEqual({ off: ["finished"], foldDays: 7 });
    expect(
      bellPrefs({
        notifications: { kinds: { waiting: "no", finished: 1 }, fold_days: 5 },
      }),
    ).toEqual({ off: ["finished"], foldDays: 7 });
    expect(
      bellPrefs({
        notifications: { kinds: { finished: true, hub: false }, fold_days: 30 },
      }),
    ).toEqual({ off: ["hub"], foldDays: 30 });
  });
});

describe("bell v6: what shows", () => {
  it("kinds off don't show or count; old ones fold and don't count", () => {
    const items = [
      note("waiting", 0),
      note("finished", 0),
      note("answer", 1),
      note("answer", 1, true),
      note("service", 9),
    ];
    const v = bellView(items, { off: ["finished"], foldDays: 7 }, NOW);
    expect(v.recent.map((n) => n.kind)).toEqual([
      "waiting",
      "answer",
      "answer",
    ]);
    expect(v.older.map((n) => n.kind)).toEqual(["service"]);
    expect(v.unread).toBe(2);
    expect(v).toMatchObject({ off: ["finished"], foldDays: 7 });
    // A longer fold: the 9-day item is recent again, and counts.
    const w = bellView(items, { off: [], foldDays: 14 }, NOW);
    expect(w.older).toEqual([]);
    expect(w.unread).toBe(4);
  });
});

describe("bell v6: the settings", () => {
  it("bell_kinds: every switch as the page shows it; true, false or null", () => {
    const u: UserConfig = {};
    expect(bellKinds(u)).toEqual({
      waiting: true,
      finished: false,
      hub: true,
      pr: true,
      release: true,
      pick: true,
      shared: true,
    });
    expect(patchBellKinds(u, { finished: true, hub: false })).toEqual({
      ok: true,
    });
    expect(bellKinds(u)).toMatchObject({ finished: true, hub: false });
    patchBellKinds(u, { finished: null, hub: null });
    expect(u).toEqual({});
    for (const bad of [null, [], "hub", { hub: "off" }, { nope: true }])
      expect(patchBellKinds({}, bad)).toMatchObject({ ok: false });
  });

  it("bell_fold_days: 3, 7, 14 or 30; null is 7 again", () => {
    const u: UserConfig = {};
    expect(bellFoldDays(u)).toBe(7);
    expect(patchBellFoldDays(u, 14)).toEqual({ ok: true });
    expect(bellFoldDays(u)).toBe(14);
    patchBellFoldDays(u, null);
    expect(u).toEqual({});
    expect(patchBellFoldDays({}, 5)).toEqual({
      ok: false,
      error: "bell_fold_days must be one of 3, 7, 14, 30, or null",
    });
  });
});
