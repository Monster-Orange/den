/**
 * Issue 774 row 7b: the tab-first window and the stream cap are Settings
 * with permissive defaults (alerts.tab_first_seconds 3, clamped 1–10;
 * alerts.max_streams 20 per person, 1–200), in user.yml, the CLI's config
 * keys and Settings › Notifications, in en/es/ja.
 */
import fs from "node:fs";
import { describe, expect, it } from "@jest/globals";
import {
  alertPrefs,
  alertSettings,
  patchAlerts,
} from "../../../src/shared/alerts.js";
import type { UserConfig } from "../../../src/shared/den-config.js";

describe("774: alerts.tab_first_seconds and alerts.max_streams", () => {
  it("defaults: 3 s and 20 streams", () => {
    const p = alertPrefs({});
    expect(p.tabFirstSeconds).toBe(3);
    expect(p.maxStreams).toBe(20);
  });

  it("a stored value in range is used; out of range is the default", () => {
    expect(
      alertPrefs({ alerts: { tab_first_seconds: 7 } }).tabFirstSeconds,
    ).toBe(7);
    expect(
      alertPrefs({ alerts: { tab_first_seconds: 0 } }).tabFirstSeconds,
    ).toBe(3);
    expect(
      alertPrefs({ alerts: { tab_first_seconds: 60 } }).tabFirstSeconds,
    ).toBe(3);
    expect(alertPrefs({ alerts: { max_streams: 5 } }).maxStreams).toBe(5);
    expect(alertPrefs({ alerts: { max_streams: 0 } }).maxStreams).toBe(20);
  });

  it("the page reads them and saves them within their ranges", () => {
    const u = {} as UserConfig;
    expect(alertSettings(u)).toMatchObject({
      tab_first_seconds: 3,
      max_streams: 20,
    });
    expect(patchAlerts(u, { tab_first_seconds: 5, max_streams: 40 })).toEqual({
      ok: true,
    });
    expect(alertSettings(u)).toMatchObject({
      tab_first_seconds: 5,
      max_streams: 40,
    });
    expect(patchAlerts(u, { tab_first_seconds: 11 }).ok).toBe(false);
    expect(patchAlerts(u, { max_streams: 201 }).ok).toBe(false);
    expect(patchAlerts(u, { tab_first_seconds: null })).toEqual({ ok: true });
    expect(alertSettings(u)).toMatchObject({ tab_first_seconds: 3 });
  });

  it("Settings › Notifications has a row for each, in every language", async () => {
    const reg =
      await import("../../../src/ui/server/public/settings-registry.js");
    const rows = (
      reg as unknown as { DEN_SETTINGS: { id: string; keys?: string[] }[] }
    ).DEN_SETTINGS;
    const first = rows.find((r) => r.id === "notifications.tab_first");
    const cap = rows.find((r) => r.id === "notifications.max_streams");
    expect(first?.keys).toEqual(["alerts.tab_first_seconds"]);
    expect(cap?.keys).toEqual(["alerts.max_streams"]);
    // English in shell.js; es and ja follow it (i18n.test.ts, the parity).
    const en = fs.readFileSync("src/ui/server/public/shell.js", "utf-8");
    for (const k of [
      "set.notifications.tab_first",
      "set.notifications.tab_first.d",
      "set.notifications.max_streams",
      "set.notifications.max_streams.d",
    ])
      expect(en).toContain(`"${k}":`);
  });
});
