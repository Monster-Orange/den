/**
 * Issue 648 (review): Connect's summary is data from the server
 * (lastResult().words), worded by Settings in the page's language. Every
 * hub.cw.* key is in en, es and ja; each fallback code has words; plural
 * forms come from the catalog; a project's key and Hub's detail are drawn
 * as escaped text. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

type Table = Record<string, string>;
const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

/** window.denMessages after the classic scripts (as i18n.test.ts loads them). */
function catalogs(): Record<string, Table> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
    try {
      vm.runInContext(read(f), ctx, { filename: f });
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  }
  return window.denMessages as Record<string, Table>;
}
const M = catalogs();

/** shell.js's t(): the plural form for vars.n, then {placeholders}. */
const tFor =
  (lang: string) =>
  (key: string, vars?: Record<string, unknown>): string => {
    const look = (tb: Table | undefined) => {
      if (!tb || !(key in tb)) return null;
      if (vars && typeof vars.n === "number") {
        const f = `${key}.${new Intl.PluralRules(lang).select(vars.n)}`;
        if (f in tb) return tb[f]!;
      }
      return tb[key]!;
    };
    const s = look(M[lang]) ?? look(M.en) ?? key;
    return s.replace(/\{(\w+)\}/g, (m, k: string) =>
      vars && vars[k] != null ? String(vars[k]) : m,
    );
  };

type Mod = {
  hubConnectWords: (
    w: unknown,
    t: (k: string, v?: Record<string, unknown>) => string,
    head?: boolean,
  ) => string[];
  hubHtml: (
    b: unknown,
    f: unknown,
    t: (k: string, v?: Record<string, unknown>) => string,
  ) => string;
};
const mod = () =>
  import("../../../src/ui/server/public/settings-registry.js") as unknown as Promise<Mod>;

const FALLBACKS = [
  "old-hub",
  "other-list",
  "bad-answer",
  "rebind",
  "too-many",
  "too-big",
  "bad-key",
  "twice",
];

describe("issue 648: Connect's summary, worded by the page", () => {
  it("every hub.cw key is in en, es and ja, with the same placeholders", () => {
    const keys = Object.keys(M.en!).filter((k) => k.startsWith("hub.cw."));
    expect(keys.length).toBeGreaterThan(15);
    const ph = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of keys.filter((x) => !/\.one$/.test(x)))
      for (const l of ["es", "ja"]) {
        expect([l, k, M[l]![k] !== undefined]).toEqual([l, k, true]);
        expect(ph(M[l]![k]!)).toEqual(ph(M.en![k]!));
      }
  });

  it("each language words a one-approval result, with its plural forms", async () => {
    const { hubConnectWords } = await mod();
    const w = {
      team: "Acme Co",
      grant: {
        linked: 1,
        created: 1,
        skipped: [{ key: "east", why: "permission", detail: "members only" }],
      },
      review: { n: 1 },
    };
    for (const l of ["en", "es", "ja"]) {
      const t = tFor(l);
      const out = hubConnectWords(w, t);
      expect(out).toEqual([
        t("hub.cw.done", { company: "Acme Co" }),
        t("hub.cw.linkedNew", { n: 1, made: 1 }),
        t("hub.cw.notCreatedWhy", { key: "east", detail: "members only" }),
        t("hub.cw.review", { n: 1 }),
      ]);
      // No key leaks as words.
      for (const s of out) expect(s).not.toMatch(/hub\.cw\./);
    }
    // en's one and other forms differ.
    const en = tFor("en");
    expect(en("hub.cw.linked", { n: 1 })).not.toBe(
      en("hub.cw.linked", { n: 2 }),
    );
  });

  it("every fallback code has words in each language; an unknown code adds none", async () => {
    const { hubConnectWords } = await mod();
    for (const l of ["en", "es", "ja"])
      for (const code of FALLBACKS) {
        const out = hubConnectWords(
          { grant: { fallback: code } },
          tFor(l),
          false,
        );
        expect(out.length).toBe(1);
        expect(out[0]).not.toMatch(/hub\.cw\./);
      }
    expect(
      hubConnectWords({ grant: { fallback: "nope" } }, tFor("en"), false),
    ).toEqual([]);
  });

  it("a skip left for the review, a failed one, and Hub can't list", async () => {
    const { hubConnectWords } = await mod();
    const t = tFor("en");
    expect(
      hubConnectWords(
        {
          grant: {
            linked: 0,
            created: 0,
            skipped: [
              { key: "north", why: "person" },
              { key: "west", why: "failed" },
            ],
          },
          review: { cannot: true },
        },
        t,
        false,
      ),
    ).toEqual([
      t("hub.cw.later", { key: "north" }),
      t("hub.cw.notDone", { key: "west" }),
      t("hub.cw.cannot"),
    ]);
  });

  it("Hub's detail and a key are drawn as text, never markup", async () => {
    const { hubHtml } = await mod();
    const flash = {
      ok: true,
      message: "Connected to Hub.",
      words: {
        grant: {
          linked: 0,
          created: 0,
          skipped: [
            { key: "east", why: "failed", detail: '<img src=x onerror="1">' },
          ],
        },
      },
    };
    const html = hubHtml(
      {
        configured: true,
        connected: true,
        state: "connected",
        team: "Acme Co",
      },
      flash,
      tFor("en"),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
