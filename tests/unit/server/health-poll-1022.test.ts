/**
 * Issue 1022: health checks poll slowly when nobody is looking.
 *
 *  - Two Settings (user.yml health_poll.*): how often a visible page polls
 *    (5 s by default) and a hidden one (60 s by default), never hard-wired.
 *  - The server re-runs the checks for a hidden page's poll only once its
 *    last answer is a slow interval old; a visible page keeps the short
 *    cache.
 *  - Settings shows both, in en, es and ja, and `den config` sets them.
 */
import { describe, expect, it } from "@jest/globals";
import {
  HEALTH_CACHE_TTL_MS,
  HEALTH_POLL,
  healthCacheTtlMs,
  healthPollSeconds,
} from "../../../src/shared/health-poll.js";
import { patchCliRows } from "../../../src/shared/settings-cli-rows.js";
import { enCatalog, langCatalog } from "./helpers/en-catalog.js";

describe("issue 1022: the two intervals are Settings", () => {
  it("5 s visible and 60 s hidden by default; out of range is the default", () => {
    expect(HEALTH_POLL).toEqual({
      visible: { default: 5, min: 2, max: 300 },
      hidden: { default: 60, min: 10, max: 3600 },
    });
    expect(healthPollSeconds(() => ({}))).toEqual({ visible: 5, hidden: 60 });
    expect(
      healthPollSeconds(() => ({
        health_poll: { visible_seconds: 10, hidden_seconds: 300 },
      })),
    ).toEqual({ visible: 10, hidden: 300 });
    for (const bad of [1, 5000, "x", 2.5])
      expect(
        healthPollSeconds(() => ({
          health_poll: { visible_seconds: bad, hidden_seconds: bad },
        })),
      ).toEqual({ visible: 5, hidden: 60 });
    expect(
      healthPollSeconds(() => {
        throw new Error("unreadable");
      }),
    ).toEqual({ visible: 5, hidden: 60 });
  });

  it("POST /api/settings' health_poll is checked against the range", () => {
    const user: Record<string, unknown> = {};
    expect(patchCliRows(user, { health_poll: { hidden_seconds: 5 } })).toEqual({
      ok: false,
      error: "health_poll.hidden_seconds is a whole number from 10 to 3600",
    });
    expect(
      patchCliRows(user, {
        health_poll: { visible_seconds: 3, hidden_seconds: 120 },
      }),
    ).toEqual({ ok: true });
    expect(user).toEqual({
      health_poll: { visible_seconds: 3, hidden_seconds: 120 },
    });
  });

  it("`den config` knows both keys", async () => {
    const { DOTTED: CONFIG_KEYS } =
      await import("../../../src/ui/cli/config-command.js");
    expect(CONFIG_KEYS["health_poll.visible_seconds"]).toEqual([
      "health_poll",
      "visible_seconds",
    ]);
    expect(CONFIG_KEYS["health_poll.hidden_seconds"]).toEqual([
      "health_poll",
      "hidden_seconds",
    ]);
  });

  it("Settings lists both, worded in en, es and ja", async () => {
    const { DEN_SETTINGS: SETTINGS } =
      await import("../../../src/ui/server/public/settings-registry.js");
    const rows = (SETTINGS as { id: string; keys?: string[] }[]).filter((s) =>
      s.keys?.some((k) => k.startsWith("health_poll.")),
    );
    expect(rows.flatMap((r) => r.keys)).toEqual([
      "health_poll.visible_seconds",
      "health_poll.hidden_seconds",
    ]);
    for (const c of [enCatalog(), langCatalog("es"), langCatalog("ja")])
      for (const r of rows) {
        expect(typeof c[`set.${r.id}`]).toBe("string");
        expect(typeof c[`set.${r.id}.d`]).toBe("string");
      }
  });
});

describe("issue 1022: the server follows the pages", () => {
  it("a visible page's poll keeps the short cache", () => {
    expect(healthCacheTtlMs(false, () => ({}))).toBe(HEALTH_CACHE_TTL_MS);
  });

  it("a hidden page's poll re-runs the checks at most once per slow interval", () => {
    expect(healthCacheTtlMs(true, () => ({}))).toBe(60_000);
    expect(
      healthCacheTtlMs(true, () => ({ health_poll: { hidden_seconds: 300 } })),
    ).toBe(300_000);
  });
});
