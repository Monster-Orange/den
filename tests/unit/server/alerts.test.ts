/**
 * Issue 172: alerts outside the bell. The words (the bell's own, in each
 * language, never a detail), the feed a tab reads, quiet hours, and the
 * new needs that alert: a wait's start (permission, question), never a
 * repeat, an idle agent, or one its person looks at.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  ALERT_WORDS,
  alertBody,
  alertPrefs,
  alertSettings,
  inQuietHours,
  patchAlerts,
} from "../../../src/ui/server/alerts.js";
import { AlertFeed, type Alert } from "../../../src/ui/server/alert-feed.js";
import { Attention } from "../../../src/ui/server/attention.js";
import { UI_LANGUAGES } from "../../../src/ui/server/ui-language.js";

let dir = "";
let clock = Date.parse("2026-11-17T12:00:00Z");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-alerts-"));
  clock = Date.parse("2026-11-17T12:00:00Z");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function feed(user: unknown = null, pushed: Alert[] = []) {
  return new AlertFeed({
    prefs: () => alertPrefs(user),
    lang: () => "en",
    zone: () => "UTC",
    title: () => "Acme",
    nameOf: (id) => (id === "ag-1" ? "Planner" : id),
    now: () => clock,
    push: async (a) => {
      pushed.push(a);
    },
  });
}

function attention(f: AlertFeed) {
  const store = new NotificationStore(dir, () => new Date(clock));
  return new Attention({
    store,
    outputMark: async () => "m",
    nameOf: (id) => (id === "ag-1" ? "Planner" : id),
    now: () => clock,
    lookingMs: 10_000,
    hooked: () => true,
    alert: (n) => void f.needs(n),
  });
}

describe("issue 172: the words", () => {
  it("every language has every alert, each naming the agent", () => {
    for (const lang of UI_LANGUAGES) {
      expect(Object.keys(ALERT_WORDS[lang]).sort()).toEqual(
        Object.keys(ALERT_WORDS.en).sort(),
      );
      for (const w of Object.values(ALERT_WORDS[lang]))
        expect(w).toContain("{name}");
    }
    expect(alertBody("en", "permission", "Planner")).toBe(
      "Planner needs your permission",
    );
    expect(alertBody("en", "allow", "a<b>\nc")).toBe("a b c needs your Allow");
  });
});

describe("issue 172: the feed", () => {
  it("a tab's first read starts from now; later reads get what came after", () => {
    const f = feed();
    f.needs({ agent: "ag-1", workspace: "north", why: "permission" });
    const first = f.after(null);
    expect(first.alerts).toEqual([]);
    f.needs({ agent: "ag-1", workspace: "north", why: "asked" });
    const next = f.after(first.seq);
    expect(next.alerts).toHaveLength(1);
    expect(next.alerts[0]).toMatchObject({
      why: "asked",
      title: "Acme",
      body: "Planner asked you",
      link: "/agents?project=north&agent=ag-1",
    });
    expect(f.after(next.seq).alerts).toEqual([]);
    // A count from before a restart: from now, never the whole list.
    expect(f.after(next.seq + 99).alerts).toEqual([]);
  });

  it("desktop off: a tab gets none; phone on still pushes", () => {
    const pushed: Alert[] = [];
    const f = feed({ alerts: { desktop: false } }, pushed);
    const { seq } = f.after(null);
    f.needs({ agent: "ag-1", workspace: "north", why: "allow" });
    expect(f.after(seq).alerts).toEqual([]);
    expect(pushed.map((a) => a.body)).toEqual(["Planner needs your Allow"]);
  });

  it("phone off: nothing is pushed", () => {
    const pushed: Alert[] = [];
    const f = feed({ alerts: { phone: false } }, pushed);
    f.needs({ agent: "ag-1", workspace: "north", why: "allow" });
    expect(pushed).toEqual([]);
  });

  it("quiet hours (over midnight too): nothing at all", () => {
    const pushed: Alert[] = [];
    const f = feed(
      { alerts: { quiet: { from: "22:00", to: "07:00" } } },
      pushed,
    );
    const { seq } = f.after(null);
    clock = Date.parse("2026-11-17T23:30:00Z");
    expect(
      f.needs({ agent: "ag-1", workspace: "north", why: "permission" }),
    ).toBeNull();
    clock = Date.parse("2026-11-17T07:00:00Z");
    expect(
      f.needs({ agent: "ag-1", workspace: "north", why: "permission" }),
    ).not.toBeNull();
    expect(f.after(seq).alerts).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });
});

describe("issue 172: quiet hours and the setting", () => {
  it("in, out, and a broken value is none", () => {
    const day = { quiet: { from: "09:00", to: "17:00" } };
    expect(inQuietHours(day, new Date("2026-11-17T09:00:00Z"), "UTC")).toBe(
      true,
    );
    expect(inQuietHours(day, new Date("2026-11-17T17:00:00Z"), "UTC")).toBe(
      false,
    );
    // The person's zone: 09:30 UTC is 01:30 in Los Angeles.
    expect(
      inQuietHours(
        day,
        new Date("2026-11-17T09:30:00Z"),
        "America/Los_Angeles",
      ),
    ).toBe(false);
    expect(
      alertPrefs({ alerts: { quiet: { from: "25:00", to: "07:00" } } }).quiet,
    ).toBeNull();
  });

  it("patchAlerts: switches, quiet hours, the timeout; bad values refused", () => {
    const u: Record<string, unknown> = {};
    expect(
      patchAlerts(u, {
        desktop: false,
        quiet_from: "22:00",
        quiet_to: "07:00",
      }),
    ).toEqual({ ok: true });
    expect(alertPrefs(u)).toMatchObject({
      desktop: false,
      phone: true,
      quiet: { from: "22:00", to: "07:00" },
    });
    // A start alone is kept and shown, but no quiet hours yet.
    expect(patchAlerts(u, { quiet_to: null })).toEqual({ ok: true });
    expect(alertSettings(u)).toMatchObject({
      quiet_from: "22:00",
      quiet_to: "",
    });
    expect(alertPrefs(u).quiet).toBeNull();
    expect(patchAlerts(u, { quiet_from: "", desktop: null })).toEqual({
      ok: true,
    });
    expect(alertPrefs(u)).toMatchObject({ desktop: true, quiet: null });
    expect(patchAlerts(u, { desktop: "yes" }).ok).toBe(false);
    expect(patchAlerts(u, { quiet_to: "7pm" }).ok).toBe(false);
    expect(
      alertPrefs({ alerts: { push_timeout_seconds: 0, push_ttl_seconds: 60 } }),
    ).toMatchObject({ pushTimeoutSeconds: 30, pushTtlSeconds: 60 });
    expect(patchAlerts(u, { nope: 1 }).ok).toBe(false);
  });

  it("issue 367: the push limits are page settings, with permissive defaults", () => {
    const u: Record<string, unknown> = {};
    // Unset: the defaults, served so the page shows them.
    expect(alertSettings(u)).toMatchObject({
      push_timeout_seconds: 30,
      push_ttl_seconds: 86_400,
    });
    expect(
      patchAlerts(u, { push_timeout_seconds: 5, push_ttl_seconds: 0 }),
    ).toEqual({ ok: true });
    expect(alertPrefs(u)).toMatchObject({
      pushTimeoutSeconds: 5,
      pushTtlSeconds: 0,
    });
    expect(alertSettings(u)).toMatchObject({
      push_timeout_seconds: 5,
      push_ttl_seconds: 0,
    });
    // The widest each push service takes: an hour to answer, 28 days kept.
    expect(
      patchAlerts(u, {
        push_timeout_seconds: 3600,
        push_ttl_seconds: 2_419_200,
      }),
    ).toEqual({ ok: true });
    // Out of range or not a whole number: refused, the value kept.
    for (const bad of [0, 3601, 2.5, "30"])
      expect(patchAlerts(u, { push_timeout_seconds: bad }).ok).toBe(false);
    for (const bad of [-1, 2_419_201, 1.5, "60"])
      expect(patchAlerts(u, { push_ttl_seconds: bad }).ok).toBe(false);
    expect(alertPrefs(u)).toMatchObject({
      pushTimeoutSeconds: 3600,
      pushTtlSeconds: 2_419_200,
    });
    // null: back to the default.
    expect(
      patchAlerts(u, { push_timeout_seconds: null, push_ttl_seconds: null }),
    ).toEqual({ ok: true });
    expect(u).toEqual({});
  });
});

describe("issue 172: which needs alert", () => {
  it("a wait's start alerts once, in the bell's words, without what it asks", async () => {
    const f = feed();
    const a = attention(f);
    const { seq } = f.after(null);
    await a.event("ag-1", "north", {
      event: "waiting",
      why: "permission",
      what: "Bash: export TOKEN=sk-live-123",
      hooked: true,
    });
    // The second call of the same wait (Notification after PermissionRequest).
    clock += 2000;
    await a.event("ag-1", "north", {
      event: "waiting",
      why: "permission",
      hooked: true,
    });
    const got = f.after(seq).alerts;
    expect(got.map((x) => x.body)).toEqual(["Planner needs your permission"]);
    expect(JSON.stringify(got)).not.toContain("sk-live");
    expect(JSON.stringify(got)).not.toContain("Bash");
  });

  it("a question alerts without its text; an idle agent and a finished turn don't", async () => {
    const f = feed();
    const a = attention(f);
    const { seq } = f.after(null);
    await a.event("ag-1", "north", {
      event: "waiting",
      why: "asked",
      text: "Paste the code 123456 here?",
    });
    await a.event("ag-2", "north", { event: "waiting", why: "input" });
    await a.event("ag-3", "north", { event: "finished" });
    const got = f.after(seq).alerts;
    expect(got.map((x) => x.body)).toEqual(["Planner asked you"]);
    expect(JSON.stringify(got)).not.toContain("123456");
  });

  it("its person is looking at it: no alert", async () => {
    const f = feed();
    const a = attention(f);
    const { seq } = f.after(null);
    a.lookingAt(["ag-1"]);
    await a.event("ag-1", "north", { event: "waiting", why: "permission" });
    expect(f.after(seq).alerts).toEqual([]);
  });
});
