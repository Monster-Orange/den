/**
 * Issue 459: Settings › Project setup › App event feeds: each feed's
 * state (connected, retrying, last event time), in en, es and ja, and
 * never a bearer. The palette's unrelated searches don't find its rows.
 * Invented names only.
 */
import { beforeAll, describe, expect, it } from "@jest/globals";
import { enCatalog, langCatalog } from "./helpers/en-catalog.js";

type Html = (
  v: unknown,
  t: (k: string, v?: Record<string, unknown>) => string,
  fmt?: (ms: number) => string,
) => string;
let appFeedsHtml: Html;
let rows: { id: string; label: string }[] = [];

const tOf =
  (cat: Record<string, string>) => (k: string, v?: Record<string, unknown>) =>
    (cat[k] ?? `MISSING:${k}`).replace(/\{(\w+)\}/g, (m, n: string) =>
      v?.[n] == null ? m : String(v[n]),
    );

beforeAll(async () => {
  (globalThis as Record<string, unknown>).window = {
    denShell: { t: (k: string) => k, lang: () => "en" },
  };
  const m =
    (await import("../../../src/ui/server/public/settings-registry.js")) as unknown as {
      appFeedsHtml: Html;
      DEN_SETTINGS: { id: string; label: string }[];
    };
  appFeedsHtml = m.appFeedsHtml;
  rows = m.DEN_SETTINGS;
});

const view = {
  ok: true,
  feeds: [
    {
      name: "chat",
      agent: "north-helper",
      url: "https://app.example.test/events",
      state: "connected",
      since: 1,
      last_event_at: Date.UTC(2026, 10, 21, 18, 0),
      unread: 0,
      problem: null,
    },
    {
      name: "orders",
      agent: "north-helper",
      url: "https://app.example.test/orders",
      state: "retrying",
      since: 1,
      last_event_at: null,
      unread: 2,
      problem: "the app answered HTTP 502",
    },
  ],
  problems: [],
};

describe("issue 459: the app event feeds row", () => {
  it("shows each feed's state and its last event's time (en)", () => {
    const html = appFeedsHtml(view, tOf(enCatalog()), () => "6:00 PM");
    expect(html).toContain(
      "chat to north-helper: https://app.example.test/events",
    );
    expect(html).toContain('data-feed-state="connected"');
    expect(html).toContain("<strong data-feed-st>Connected</strong>");
    expect(html).toContain("Last event 6:00 PM.");
    expect(html).toContain("<strong data-feed-st>Retrying</strong>");
    expect(html).toContain("No events yet. Unread: 2.");
  });

  it("every word it draws is in es and ja", () => {
    for (const lang of ["es", "ja"]) {
      const cat = langCatalog(lang);
      const all = appFeedsHtml(
        {
          feeds: [
            "connecting",
            "connected",
            "retrying",
            "no_secret",
            "over_limit",
            "no_agent",
            "stopped",
          ].map((state, i) => ({
            name: `f${i}`,
            agent: "a",
            url: "https://x.example.test",
            state,
            last_event_at: i ? 1 : null,
            unread: 1,
          })),
          problems: ["agents.event_feeds[3]: name: bad"],
        },
        tOf(cat),
      );
      expect(all).not.toContain("MISSING:");
      expect(appFeedsHtml({ feeds: [] }, tOf(cat))).not.toContain("MISSING:");
    }
  });

  it("no feeds: says so; a state it doesn't know is shown as connecting", () => {
    const t = tOf(enCatalog());
    expect(appFeedsHtml({ feeds: [] }, t)).toContain(
      "No app event feeds for this project.",
    );
    expect(
      appFeedsHtml({ feeds: [{ ...view.feeds[0], state: "<b>x</b>" }] }, t),
    ).toContain('data-feed-state="connecting"');
  });

  it("the rows' labels don't fuzzy-match the palette's unrelated search", () => {
    const mine = rows.filter(
      (r) =>
        r.id === "workspace.event_feeds" ||
        r.id.startsWith("embed.feed_") ||
        r.id === "embed.paste_max_kb",
    );
    expect(mine).toHaveLength(9);
    const fuzzy = (w: string, s: string) => {
      let at = -1;
      for (const ch of w) {
        at = s.indexOf(ch, at + 1);
        if (at < 0) return false;
      }
      return true;
    };
    for (const r of mine)
      expect(fuzzy("shop", r.label.toLowerCase())).toBe(false);
  });
});
