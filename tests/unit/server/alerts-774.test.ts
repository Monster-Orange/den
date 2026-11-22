/**
 * Issue 774: browser alerts, optional sounds, and a count in the tab
 * title and icon. One test clause per rule of the approved mock (Den
 * project in Hub, version 3):
 *
 *   1  Settings › Notifications: three new rows (finished, sounds, the
 *      tab count); defaults finished off, sounds off, count on.
 *   1c the browser blocks notifications: the row says so, the bell and
 *      the tab count still work.
 *   1d the browser can't show them: a note, no error; fewer rows.
 *   3  the two alerts: "needs you" in the shipped words, "finished" new;
 *      the heading is the words, the line under it the project, never
 *      the tool line or the question.
 *   4  the tab title "(2) Den · Agents"; the icon badge a digit, "9+"
 *      from ten; zero shows nothing.
 *   6  when it stays quiet (each row of the table).
 *   7  no double alert: two tabs show one, one sound.
 *
 * Browser side only: nothing is raised from the Den computer itself.
 * Invented names only.
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
  patchAlerts,
} from "../../../src/ui/server/alerts.js";
import { AlertFeed } from "../../../src/ui/server/alert-feed.js";
import { Attention } from "../../../src/ui/server/attention.js";
import { UI_LANGUAGES } from "../../../src/ui/server/ui-language.js";
import {
  alertPlan,
  deliverAlert,
} from "../../../src/ui/server/public/alerts.js";
import {
  badgeColors,
  badgeText,
  titleWithCount,
} from "../../../src/ui/server/public/tab-count.js";
import { ALERT_SOUNDS } from "../../../src/ui/server/public/alert-sounds.js";
import { DEN_SETTINGS } from "../../../src/ui/server/public/settings-registry.js";

/** The fields of a settings row these tests read. */
type Row = {
  read: (ctx: unknown) => unknown;
  keys?: readonly string[];
  label: string;
  shown?: () => boolean;
  control: { notice: () => string };
};

let dir = "";
let clock = Date.parse("2026-11-20T12:00:00Z");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-alerts-774-"));
  clock = Date.parse("2026-11-20T12:00:00Z");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function feed(user: unknown = null, muted: Set<string> = new Set()) {
  return new AlertFeed({
    prefs: () => alertPrefs(user),
    lang: () => "en",
    zone: () => "UTC",
    title: () => "Acme",
    nameOf: (id) => (id === "ag-1" ? "Planner" : id),
    now: () => clock,
    muted: (agent, ws) => muted.has(agent) || muted.has(`ws:${ws}`),
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

describe("774 clause 1: the settings and their defaults", () => {
  it("finished off, sounds off, count on; each a switch the page saves", () => {
    expect(alertPrefs(null)).toMatchObject({
      finished: false,
      sound: false,
      tabCount: true,
    });
    expect(alertSettings({})).toMatchObject({
      finished: false,
      sound: false,
      tab_count: true,
    });
    const u: Record<string, unknown> = {};
    expect(
      patchAlerts(u, { finished: true, sound: true, tab_count: false }),
    ).toEqual({ ok: true });
    expect(alertPrefs(u)).toMatchObject({
      finished: true,
      sound: true,
      tabCount: false,
    });
    for (const k of ["finished", "sound", "tab_count"])
      expect(patchAlerts(u, { [k]: "yes" }).ok).toBe(false);
    expect(
      patchAlerts(u, { finished: null, sound: null, tab_count: null }),
    ).toEqual({ ok: true });
    expect(u).toEqual({});
  });

  it("Settings › Notifications has the three new rows, in the mock's order", () => {
    const ids = DEN_SETTINGS.filter((r) => r.category === "notifications").map(
      (r) => r.id,
    );
    const at = (id: string) => ids.indexOf(id);
    for (const id of [
      "notifications.alert_finished",
      "notifications.alert_sound",
      "notifications.tab_count",
    ])
      expect(ids).toContain(id);
    expect(at("notifications.desktop")).toBeLessThan(
      at("notifications.alert_finished"),
    );
    expect(at("notifications.alert_finished")).toBeLessThan(
      at("notifications.alert_sound"),
    );
    expect(at("notifications.alert_sound")).toBeLessThan(
      at("notifications.tab_count"),
    );
    expect(at("notifications.tab_count")).toBeLessThan(
      at("notifications.phone"),
    );
    const row = (id: string) =>
      DEN_SETTINGS.find((r) => r.id === id) as unknown as Row;
    const ctx = { data: { alerts: {} } };
    expect(row("notifications.alert_finished").read(ctx)).toBe(false);
    expect(row("notifications.alert_sound").read(ctx)).toBe(false);
    expect(row("notifications.tab_count").read(ctx)).toBe(true);
    expect(row("notifications.alert_finished").keys).toEqual([
      "alerts.finished",
    ]);
    expect(row("notifications.alert_sound").keys).toEqual(["alerts.sound"]);
    expect(row("notifications.tab_count").keys).toEqual(["alerts.tab_count"]);
    expect(row("notifications.alert_finished").label).toBe(
      "Also tell me when an agent finishes",
    );
    expect(row("notifications.alert_sound").label).toBe("Sounds");
    expect(row("notifications.tab_count").label).toBe("Count in the tab");
  });
});

describe("774 clauses 1c and 1d: a browser that can't notify", () => {
  const row = (id: string) =>
    DEN_SETTINGS.find((r) => r.id === id) as unknown as Row;
  const withNotification = (N: unknown, fn: () => void) => {
    const g = globalThis as Record<string, unknown>;
    const had = "window" in g;
    const was = g.window;
    g.window = N === undefined ? {} : { Notification: N };
    try {
      fn();
    } finally {
      if (had) g.window = was;
      else delete g.window;
    }
  };

  it("blocked: the row says so; the bell and the tab count still work", () => {
    const N = Object.assign(function () {}, { permission: "denied" });
    withNotification(N, () => {
      const note = row("notifications.desktop").control.notice();
      expect(note).toContain("blocks notifications");
      expect(note).toContain("The bell and the tab count still work.");
    });
  });

  it("can't show them (iPhone Safari outside a Home Screen app): a note, and fewer rows", () => {
    withNotification(undefined, () => {
      const note = row("notifications.desktop").control.notice();
      expect(note).toContain("Home Screen");
      expect(note).toContain("The bell and the tab count still work.");
      // Fewer rows: the finished alert and push need notifications.
      expect(row("notifications.alert_finished").shown?.()).toBe(false);
      expect(row("notifications.phone").shown?.()).toBe(false);
      // Sounds and the count still work there.
      expect(row("notifications.alert_sound").shown?.() ?? true).toBe(true);
      expect(row("notifications.tab_count").shown?.() ?? true).toBe(true);
    });
  });
});

describe("774 clause 3: the two alerts", () => {
  it("finished has words in every language, naming the agent", () => {
    for (const lang of UI_LANGUAGES) {
      expect(ALERT_WORDS[lang].finished).toContain("{name}");
    }
    expect(alertBody("en", "finished", "builder")).toBe("builder finished");
  });

  it("the heading is the words, the line under it the project; never the tool line", async () => {
    const f = feed({ alerts: { finished: true } });
    const a = attention(f);
    const { seq } = f.after(null);
    await a.event("ag-1", "north", {
      event: "waiting",
      why: "permission",
      what: "Bash: export KEY=sk-live-4",
      hooked: true,
    });
    const got = f.after(seq).alerts;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      body: "Planner needs your permission",
      project: "north",
    });
    expect(JSON.stringify(got)).not.toContain("sk-live");
  });

  it("a finished turn alerts only when Also tell me is on", async () => {
    const off = feed();
    const a1 = attention(off);
    const s1 = off.after(null).seq;
    await a1.event("ag-1", "north", { event: "finished", text: "all done" });
    expect(off.after(s1).alerts).toEqual([]);

    const on = feed({ alerts: { finished: true } });
    const a2 = attention(on);
    const s2 = on.after(null).seq;
    await a2.event("ag-1", "north", { event: "finished", text: "secret 99" });
    const got = on.after(s2).alerts;
    expect(got.map((x) => [x.why, x.body])).toEqual([
      ["finished", "Planner finished"],
    ]);
    expect(JSON.stringify(got)).not.toContain("secret 99");
  });
});

describe("774 clause 4: the tab title and icon", () => {
  it("the count goes in front of the whole title; zero shows none", () => {
    expect(titleWithCount("Den · Agents", 2)).toBe("(2) Den · Agents");
    expect(titleWithCount("(2) Den · Agents", 12)).toBe("(12) Den · Agents");
    expect(titleWithCount("(12) Den · Agents", 0)).toBe("Den · Agents");
    expect(titleWithCount("Den · Terminals", 1)).toBe("(1) Den · Terminals");
  });

  it("the icon's badge: a digit, 9+ from ten, nothing at zero", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
    expect(badgeText(12)).toBe("9+");
  });

  // The count's rule (running agents on a permission, a question or an
  // Allow) is the rail's: tab-count-773-774.test.ts.
});

describe("774 clause 6: when it stays quiet", () => {
  const prefs = { desktop: true, sound: true, tab_count: true };
  const need = { id: "x1", why: "permission", agent: "ag-1" };
  const done = { id: "x2", why: "finished", agent: "ag-1" };
  const env = {
    front: false,
    permission: "granted",
    pushed: false,
    agent: null as string | null,
  };

  it("looking at that agent: no notification, no sound", () => {
    expect(
      alertPlan(need, prefs, { ...env, front: true, agent: "ag-1" }),
    ).toEqual({
      notify: false,
      sound: null,
    });
  });

  it("Den in front on another agent or page: no notification; the sound plays if on", () => {
    expect(
      alertPlan(need, prefs, { ...env, front: true, agent: "ag-2" }),
    ).toEqual({
      notify: false,
      sound: "needs",
    });
    expect(
      alertPlan(need, { ...prefs, sound: false }, { ...env, front: true }),
    ).toEqual({ notify: false, sound: null });
  });

  it("in the background, permission granted: one notification and the sound", () => {
    expect(alertPlan(need, prefs, env)).toEqual({
      notify: true,
      sound: "needs",
    });
  });

  it("permission denied or not supported: no notification, no error; the sound if on", () => {
    for (const permission of ["denied", "default", "unsupported"])
      expect(alertPlan(need, prefs, { ...env, permission })).toEqual({
        notify: false,
        sound: "needs",
      });
  });

  it("desktop alerts off: no notification", () => {
    expect(alertPlan(need, { ...prefs, desktop: false }, env)).toEqual({
      notify: false,
      sound: "needs",
    });
  });

  it("finished: the soft sound", () => {
    expect(alertPlan(done, prefs, env)).toEqual({
      notify: true,
      sound: "finished",
    });
    expect(ALERT_SOUNDS.finished.gain).toBeLessThan(ALERT_SOUNDS.needs.gain);
  });

  it("a muted agent (or its project) never alerts, need or finished", () => {
    const f = feed(
      { alerts: { finished: true } },
      new Set(["ag-1", "ws:west"]),
    );
    expect(
      f.needs({ agent: "ag-1", workspace: "north", why: "permission" }),
    ).toBeNull();
    expect(
      f.needs({ agent: "ag-1", workspace: "north", why: "finished" }),
    ).toBeNull();
    expect(
      f.needs({ agent: "ag-9", workspace: "west", why: "asked" }),
    ).toBeNull();
    expect(
      f.needs({ agent: "ag-9", workspace: "north", why: "asked" }),
    ).not.toBeNull();
  });

  it("quiet hours: no finished alert either", () => {
    const f = feed({
      alerts: { finished: true, quiet: { from: "22:00", to: "07:00" } },
    });
    clock = Date.parse("2026-11-20T23:30:00Z");
    expect(
      f.needs({ agent: "ag-1", workspace: "north", why: "finished" }),
    ).toBeNull();
  });

  it("desktop off but sounds on: a tab still reads the alerts, and the switches", () => {
    const f = feed({ alerts: { desktop: false, sound: true } });
    const { seq } = f.after(null);
    f.needs({ agent: "ag-1", workspace: "north", why: "asked" });
    const got = f.after(seq);
    expect(got.alerts).toHaveLength(1);
    expect(got.prefs).toEqual({ desktop: false, sound: true, tab_count: true });
  });
});

describe("774 clause 7: no double alert", () => {
  /** A browser: two tabs share its storage. */
  function browserTabs() {
    const store = new Map<string, string>();
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const tab = () => {
      const shown: string[] = [];
      const played: string[] = [];
      return {
        shown,
        played,
        win: { localStorage } as unknown as Window,
        deps: {
          show: (a: { id: string }) => void shown.push(a.id),
          play: (k: string) => void played.push(k),
          wait: async () => undefined,
        },
      };
    };
    return [tab(), tab()];
  }
  const prefs = { desktop: true, sound: true, tab_count: true };
  const alert = { id: "a-7", why: "permission", agent: "ag-1" };

  it("two tabs in the background: one notification, one sound", async () => {
    const [t1, t2] = browserTabs();
    const env = {
      front: false,
      permission: "granted",
      pushed: false,
      agent: null,
    };
    await deliverAlert(t1.win, alert, prefs, env, t1.deps);
    await deliverAlert(t2.win, alert, prefs, env, t2.deps);
    expect([...t1.shown, ...t2.shown]).toEqual(["a-7"]);
    expect([...t1.played, ...t2.played]).toEqual(["needs"]);
  });

  it("one tab in front: the sound from it, no notification from the other", async () => {
    const [front, back] = browserTabs();
    let release = () => {};
    const backWaits = new Promise<void>((r) => (release = r));
    const backDone = deliverAlert(
      back.win,
      alert,
      prefs,
      { front: false, permission: "granted", pushed: false, agent: null },
      { ...back.deps, wait: () => backWaits },
    );
    await deliverAlert(
      front.win,
      alert,
      prefs,
      { front: true, permission: "granted", pushed: false, agent: "ag-2" },
      front.deps,
    );
    release();
    await backDone;
    expect(front.played).toEqual(["needs"]);
    expect(back.shown).toEqual([]);
    expect(back.played).toEqual([]);
  });

  it("push on for this device: the push shows it, the tab only plays the sound", async () => {
    const [t] = browserTabs();
    await deliverAlert(
      t.win,
      alert,
      prefs,
      { front: false, permission: "granted", pushed: true, agent: null },
      t.deps,
    );
    expect(t.shown).toEqual([]);
    expect(t.played).toEqual(["needs"]);
  });
});

describe("the tab badge takes the theme's colors (774)", () => {
  const docWith = (vars: Record<string, string>) =>
    ({
      documentElement: {},
      defaultView: {
        getComputedStyle: () => ({
          getPropertyValue: (n: string) => vars[n] ?? "",
        }),
      },
    }) as unknown as Document;

  it("reads the accent, background, on-accent and sans tokens", () => {
    expect(
      badgeColors(
        docWith({
          "--accent": " #123456",
          "--bg": "#000",
          "--on-accent": "#fff",
          "--sans": '"Test Sans", sans-serif',
        }),
      ),
    ).toEqual({
      dot: "#123456",
      ring: "#000",
      digit: "#fff",
      sans: '"Test Sans", sans-serif',
    });
  });

  it("gives empty colors when the page has no theme yet", () => {
    expect(badgeColors({} as Document)).toEqual({
      dot: "",
      ring: "",
      digit: "",
      sans: "",
    });
  });
});
