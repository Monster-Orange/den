/**
 * Issue 172 slice 1: alerts follow the approval policy (issue 160). What
 * counts, when an alert stays quiet, one alert per item, and the title and
 * body: all in one rules module (public/alert-rules.js), which the page
 * and the server both run. Invented names.
 */
import { describe, expect, it } from "@jest/globals";
import {
  ALERT_COUNTS,
  ALERT_COUNTS_DEFAULT,
  alertCounts,
  alertLevel,
  claimAlert,
  quietInFront,
  alertText,
} from "../../../src/ui/server/public/alert-rules.js";
import { AlertFeed, type Alert } from "../../../src/ui/server/alert-feed.js";
import {
  alertPrefs,
  alertSettings,
  patchAlerts,
} from "../../../src/ui/server/alerts.js";
import type { UserConfig } from "../../../src/shared/den-config.js";

describe("issue 172: what counts", () => {
  it("two choices; the default follows the approval policy", () => {
    expect([...ALERT_COUNTS]).toEqual(["needs_you", "watched_or_critical"]);
    expect(ALERT_COUNTS_DEFAULT).toBe("watched_or_critical");
  });

  it("watched or critical: a routine need is quiet; the rest alert", () => {
    const c = "watched_or_critical";
    expect(alertCounts(c, "critical")).toBe(true);
    expect(alertCounts(c, "escalated")).toBe(true);
    expect(alertCounts(c, "watched")).toBe(true);
    expect(alertCounts(c, "routine")).toBe(false);
  });

  it("everything that needs you: every level alerts", () => {
    for (const l of ["critical", "escalated", "watched", "routine"])
      expect(alertCounts("needs_you", l)).toBe(true);
  });

  it("an unknown choice is the default", () => {
    expect(alertCounts("bogus", "routine")).toBe(false);
    expect(alertCounts(undefined, "watched")).toBe(true);
  });

  it("a need's level: critical, then the agent's own ask, then watched", () => {
    expect(alertLevel({ why: "allow", critical: true, watched: true })).toBe(
      "critical",
    );
    expect(alertLevel({ why: "asked" })).toBe("escalated");
    expect(alertLevel({ why: "allow", escalated: true })).toBe("escalated");
    expect(alertLevel({ why: "permission", watched: true })).toBe("watched");
    expect(alertLevel({ why: "permission" })).toBe("routine");
    expect(alertLevel({ why: "allow" })).toBe("routine");
  });
});

describe("issue 172: one alert per item, none in front", () => {
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };

  it("an item is claimed once; a second tab's claim is refused", () => {
    const s = store();
    expect(claimAlert(s, "a-1")).toBe(true);
    expect(claimAlert(s, "a-1")).toBe(false);
    expect(claimAlert(s, "a-2")).toBe(true);
  });

  it("keeps the last 100 ids; no storage still shows it", () => {
    const s = store();
    for (let i = 0; i < 105; i++) claimAlert(s, `x-${i}`);
    expect(JSON.parse(s.getItem("den-alerts-shown")!)).toHaveLength(100);
    expect(claimAlert(null, "y")).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    expect(claimAlert(broken, "z")).toBe(true);
  });

  it("quiet only while the page is visible and focused", () => {
    expect(
      quietInFront({ visibilityState: "visible", hasFocus: () => true }),
    ).toBe(true);
    expect(
      quietInFront({ visibilityState: "visible", hasFocus: () => false }),
    ).toBe(false);
    expect(
      quietInFront({ visibilityState: "hidden", hasFocus: () => true }),
    ).toBe(false);
  });

  it("title is the product's; body the bell's words, never details", () => {
    expect(alertText("en", "Acme", "allow", "Planner")).toEqual({
      title: "Acme",
      body: "Planner needs your Allow",
    });
    expect(alertText("ja", "", "asked", "x\n<y>").title).toBe("");
  });
});

describe("issue 172: the feed follows what counts", () => {
  const clock = Date.parse("2026-11-17T12:00:00Z");
  const feed = (user: unknown, watched: string[], pushed: Alert[] = []) =>
    new AlertFeed({
      prefs: () => alertPrefs(user),
      lang: () => "en",
      zone: () => "UTC",
      title: () => "Acme",
      nameOf: (id) => id,
      now: () => clock,
      watched: () => watched,
      push: async (a) => void pushed.push(a),
    });

  it("by default, a permission from an agent nobody watches is quiet, tab and push", () => {
    const pushed: Alert[] = [];
    const f = feed(null, [], pushed);
    const { seq } = f.after(null);
    expect(
      f.needs({ agent: "ag-1", workspace: "north", why: "permission" }),
    ).toBeNull();
    expect(f.after(seq).alerts).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("watched by project, by agent, or pinned: it alerts", () => {
    for (const w of [["project:north"], ["agent:ag-1"], ["north"]]) {
      const f = feed(null, w);
      expect(
        f.needs({ agent: "ag-1", workspace: "north", why: "permission" }),
      ).not.toBeNull();
    }
  });

  it("an agent's question and a critical Allow alert, watched or not", () => {
    const f = feed(null, []);
    expect(
      f.needs({ agent: "ag-1", workspace: "north", why: "asked" }),
    ).not.toBeNull();
    expect(
      f.needs({
        agent: "ag-1",
        workspace: "north",
        why: "allow",
        critical: true,
      }),
    ).not.toBeNull();
    expect(
      f.needs({ agent: "ag-1", workspace: "north", why: "allow" }),
    ).toBeNull();
  });

  it("everything that needs you: a routine permission alerts", () => {
    const f = feed({ alerts: { counts: "needs_you" } }, []);
    expect(
      f.needs({ agent: "ag-1", workspace: "north", why: "permission" }),
    ).not.toBeNull();
  });
});

describe("issue 172: the what-counts setting", () => {
  it("read, written, cleared; a bad value refused", () => {
    expect(alertPrefs(null).counts).toBe("watched_or_critical");
    expect(alertPrefs({ alerts: { counts: "nope" } }).counts).toBe(
      "watched_or_critical",
    );
    const u = {} as UserConfig;
    expect(patchAlerts(u, { counts: "needs_you" })).toEqual({ ok: true });
    expect(alertSettings(u).counts).toBe("needs_you");
    const bad = patchAlerts(u, { counts: "all" });
    expect(bad.ok).toBe(false);
    expect(patchAlerts(u, { counts: null })).toEqual({ ok: true });
    expect(alertSettings(u).counts).toBe("watched_or_critical");
  });
});
