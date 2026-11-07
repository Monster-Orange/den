/**
 * The UI's catalogs (R19, 0.3.0-dev.39): en is shell.js's MESSAGES.en, the
 * fallback; ja and es are public/i18n/<lang>.js. A key missing from any
 * catalog fails here, as does a key the code looks up that en lacks, a
 * plural form the language never uses, or a placeholder a translation
 * drops. The node-side fallbacks of the pure modules (EN_FALLBACK) are held
 * to en, so a test of those modules sees the words the browser shows.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { UI_MODULES } from "../../../src/ui/server/ui-assets.js";
import {
  UI_LANGUAGES,
  catalogPath,
  localizePage,
  uiLanguage,
} from "../../../src/ui/server/ui-language.js";
import { EN_FALLBACK as TOPBAR_EN } from "../../../src/ui/server/public/topbar.js";
import { EN_FALLBACK as APPEARANCE_EN } from "../../../src/ui/server/public/appearance.js";
import { EN_FALLBACK as PICKER_EN } from "../../../src/ui/server/public/workspace-picker.js";
import { DEN_SETTINGS } from "../../../src/ui/server/public/settings-registry.js";

type Table = Record<string, string>;
const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

/** window.denMessages after running these classic scripts, in order. */
function catalogs(...files: string[]): {
  messages: Record<string, Table>;
  languages: { id: string; name: string }[];
} {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of files) {
    try {
      vm.runInContext(read(f), ctx, { filename: f });
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  }
  const shell = read("shell.js");
  const langs = /var LANGUAGES = (\[[\s\S]*?\]);/.exec(shell);
  return {
    messages: window.denMessages as Record<string, Table>,
    languages: langs
      ? (vm.runInNewContext(`(${langs[1]})`) as { id: string; name: string }[])
      : [],
  };
}

const NON_EN = UI_LANGUAGES.filter((l) => l !== "en");
const { messages, languages } = catalogs(
  ...NON_EN.map((l) => `i18n/${l}.js`),
  "shell.js",
);
const EN = messages.en;
const vars = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** A key's base: "pal.count.one" → "pal.count" (en has the base). */
const PLURAL = /\.(zero|one|two|few|many|other)$/;
const base = (k: string) =>
  PLURAL.test(k) && EN[k.replace(PLURAL, "")] !== undefined
    ? k.replace(PLURAL, "")
    : k;

describe("the admin-password prompt (LK-0)", () => {
  // It is for sudo only: it names the command that needs it, and no
  // language calls it a lock on services and agents any more.
  it.each(["en", "ja", "es"])(
    "%s names the command, and locks nothing",
    (lang) => {
      expect(vars(messages[lang]["lock.needs"])).toEqual(["cmd"]);
      for (const k of ["lock.title", "lock.locked", "lock.unlocked"])
        expect(messages[lang][k]).toBeUndefined();
    },
  );
});
describe("the catalogs", () => {
  it("en is shell.js's, and has the shell's words", () => {
    expect(Object.keys(EN).length).toBeGreaterThan(200);
    expect(EN["n.workspaces"]).toBe("Workspaces");
  });

  it.each(NON_EN)("%s has every key en has", (lang) => {
    const table = messages[lang];
    expect(table).toBeDefined();
    const missing = Object.keys(EN)
      .filter((k) => base(k) === k)
      .filter((k) => !(k in table));
    expect(missing).toEqual([]);
  });

  it.each(NON_EN)(
    "%s has a key's plural forms where its language uses them, and no others",
    (lang) => {
      const table = messages[lang];
      const used = new Set(
        new Intl.PluralRules(lang).resolvedOptions().pluralCategories,
      );
      const wrong = Object.keys(table).filter((k) => {
        if (base(k) === k) return !(k in EN);
        const cat = PLURAL.exec(k)![1];
        return !used.has(cat as Intl.LDMLPluralRule) || cat === "other";
      });
      expect(wrong).toEqual([]);
      // Every en `.one` has its counterpart where the language says "one".
      if (used.has("one")) {
        const missing = Object.keys(EN)
          .filter((k) => k.endsWith(".one"))
          .filter((k) => !(k in table));
        expect(missing).toEqual([]);
      }
    },
  );

  it("en pluralizes: a count with a singular in any catalog has its en .one (0.3.0-dev.40)", () => {
    // The org menu said "1 workspaces".
    expect(EN["org.n.one"]).toBe("{n} workspace");
    const counted = Object.keys(EN).filter(
      (k) => base(k) === k && vars(EN[k]).includes("n"),
    );
    const missing = counted.filter(
      (k) =>
        NON_EN.some((l) => `${k}.one` in messages[l]) && !(`${k}.one` in EN),
    );
    expect(missing).toEqual([]);
  });

  it.each(NON_EN)("%s keeps every placeholder of en", (lang) => {
    const table = messages[lang];
    const off = Object.keys(table).filter(
      (k) => vars(table[k]).join() !== vars(EN[base(k)] ?? "").join(),
    );
    expect(off).toEqual([]);
  });

  it("every key the UI looks up by name is in en", () => {
    const keys = new Set<string>();
    for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith(".js")))
      for (const m of read(f).matchAll(/\btr?\(\s*"([\w.]+)"/g)) keys.add(m[1]);
    // Computed keys: topbar.js's kind labels.
    for (const k of ["page", "service", "app", "agent", "action", "setting"])
      keys.add(`kind.${k}`);
    const unknown = [...keys].filter((k) => !(k in EN));
    expect(unknown).toEqual([]);
  });

  it.each([
    ["topbar.js", TOPBAR_EN],
    ["appearance.js", APPEARANCE_EN],
    ["workspace-picker.js", PICKER_EN],
  ] as [string, Table][])("%s's EN_FALLBACK is en's words", (_f, table) => {
    const drift = Object.keys(table).filter((k) => table[k] !== EN[k]);
    expect(drift).toEqual([]);
  });
});

describe("the Settings rows in the palette", () => {
  it("every built-in row has its label in en, word for word", () => {
    const off = (DEN_SETTINGS as { id: string; label: string }[])
      .filter((r) => EN[`set.${r.id}`] !== r.label)
      .map((r) => r.id);
    expect(off).toEqual([]);
  });
});

describe("the languages", () => {
  it("the shell offers exactly the server's languages, each named in itself", () => {
    expect(languages.map((l) => l.id)).toEqual([...UI_LANGUAGES]);
    expect(languages.find((l) => l.id === "ja")?.name).toBe("日本語");
  });

  it.each(NON_EN)("%s's catalog is a served module on disk", (lang) => {
    const src = catalogPath(lang)!;
    expect(UI_MODULES).toContain(src);
    expect(fs.existsSync(path.join(PUBLIC, src.slice(1)))).toBe(true);
  });

  it("a stored value that is no UI language is English", () => {
    expect(uiLanguage(undefined)).toBe("en");
    expect(uiLanguage("klingon")).toBe("en");
    expect(uiLanguage("ja")).toBe("ja");
  });
});

describe("localizePage", () => {
  const page =
    '<!doctype html><html lang="en"><body><div id="den-shell"></div><script src="/shell.js"></script></body></html>';

  it("serves English exactly as on disk", () => {
    expect(localizePage(page, "en")).toBe(page);
  });

  it("sets <html lang> and loads the catalog just before shell.js", () => {
    const out = localizePage(page, "ja");
    expect(out).toContain('<html lang="ja">');
    expect(out).toContain(
      '<script src="/i18n/ja.js"></script><script src="/shell.js"></script>',
    );
  });

  it("leaves a page without the shell alone", () => {
    const bare = '<html lang="en"><body>x</body></html>';
    expect(localizePage(bare, "es")).toBe(bare);
  });
});
