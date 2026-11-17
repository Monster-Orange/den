/**
 * Issue 334: a state read with an app key is a use, and is audited: the
 * key's id, the route, when, and how it ended (ok, refused). Never the
 * key, never a body. A polling app doesn't flood the trail: one line per
 * key, route and outcome per window (embed.app_key_audit_window_seconds,
 * 60 by default), with the count of reads in it.
 *
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { AppKeyUseAudit } from "../../../src/ui/server/embed-routes.js";
import {
  embedSettings,
  patchEmbed,
} from "../../../src/ui/server/embed-settings.js";
import type { UserConfig } from "../../../src/shared/den-config.js";

const KEY = {
  id: "0123456789abcdef",
  project: "north",
  agent: "scout",
  origin: "http://127.0.0.1:5173",
};
const ROUTE = "/api/embed/p/north/agents/scout/state";

function rig(windowSeconds = 60) {
  const lines: { detail: string; outcome?: string; reason?: string }[] = [];
  let now = Date.parse("2026-11-17T18:00:00Z");
  const audit = new AppKeyUseAudit({
    windowMs: () => windowSeconds * 1000,
    now: () => now,
    write: (a) => lines.push(a),
    timers: false,
  });
  return { audit, lines, tick: (ms: number) => (now += ms) };
}

describe("an app key's reads, audited", () => {
  it("5 reads in one window: one line, count 5; a read in the next window: a second line", () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      r.audit.note(KEY, ROUTE, "ok");
      r.tick(5_000);
    }
    expect(r.lines).toEqual([]);
    r.tick(60_000);
    r.audit.note(KEY, ROUTE, "ok");
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].detail).toBe(
      `app key ${KEY.id} read ${ROUTE}: 5 reads, ok, from 2026-11-17T18:00:00.000Z`,
    );
    expect(r.lines[0].outcome).toBeUndefined();
    r.tick(61_000);
    r.audit.sweep();
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1].detail).toMatch(/: 1 read, ok, from /);
  });

  it("a refused read (another agent) is audited too, as refused, apart from the ok ones", () => {
    const r = rig();
    r.audit.note(KEY, ROUTE, "ok");
    r.audit.note(
      KEY,
      "/api/embed/p/north/agents/pilot/state",
      "refused",
      "another agent",
    );
    r.tick(60_000);
    r.audit.sweep();
    expect(r.lines).toHaveLength(2);
    const refused = r.lines.find((l) => l.outcome === "refused");
    expect(refused).toMatchObject({
      outcome: "refused",
      reason: "another agent",
    });
    expect(refused?.detail).toMatch(
      /^app key 0123456789abcdef read \/api\/embed\/p\/north\/agents\/pilot\/state: 1 read, refused, from /,
    );
  });

  it("the window is a setting: 60 s by default, 1 s to a day", () => {
    const u: UserConfig = {};
    expect(embedSettings(u).app_key_audit_window_seconds).toBe(60);
    expect(patchEmbed(u, { app_key_audit_window_seconds: 5 })).toEqual({
      ok: true,
    });
    expect(embedSettings(u).app_key_audit_window_seconds).toBe(5);
    expect(patchEmbed(u, { app_key_audit_window_seconds: 0 }).ok).toBe(false);
    const r = rig(5);
    r.audit.note(KEY, ROUTE, "ok");
    r.tick(6_000);
    r.audit.sweep();
    expect(r.lines).toHaveLength(1);
  });
});
