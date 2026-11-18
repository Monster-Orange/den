/**
 * The UI's catalogs for tests (issue 409: one helper, so no test reads
 * shell.js for words again). en is public/i18n/en.js, the fallback (it was
 * shell.js's MESSAGES.en); es and ja are public/i18n/<lang>.js. Each is a
 * classic script that adds its table to window.denMessages, read here as
 * the page loads it. installEnShell / installShell put a window.denShell.t
 * over them (den#171), for tests of the pages' pure modules (edge-page.js,
 * perf-report.js): they draw their words through the shell, so a test sees
 * the words a browser in that language does.
 */
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { UI_LANGUAGES } from "../../../../src/ui/server/ui-language.js";

type Vars = Record<string, unknown>;
type Table = Record<string, string>;

/** public/, where the pages, shell.js and i18n/ live. */
export const PUBLIC_DIR = path.join(
  process.cwd(),
  "src",
  "ui",
  "server",
  "public",
);

/** A language's catalog file, relative to public/ ("i18n/en.js"). */
export const catalogFile = (lang: string): string => `i18n/${lang}.js`;

/** Every catalog file, en first, relative to public/. */
export const CATALOG_FILES: readonly string[] = UI_LANGUAGES.map(catalogFile);

/** A catalog's source text (en.js by default), for tests that grep it. */
export function catalogSource(lang = "en"): string {
  return fs.readFileSync(path.join(PUBLIC_DIR, catalogFile(lang)), "utf-8");
}

/** A language's table (public/i18n/<lang>.js), as the page loads it. */
export function langCatalog(lang: string): Table {
  const window: Record<string, unknown> = {};
  vm.runInContext(catalogSource(lang), vm.createContext({ window }), {
    filename: catalogFile(lang),
  });
  return (window.denMessages as Record<string, Table>)[lang];
}

/** en's table (public/i18n/en.js). */
export function enCatalog(): Table {
  return langCatalog("en");
}

/** Every language's table, by language: window.denMessages on a page. */
export function allCatalogs(): Record<string, Table> {
  return Object.fromEntries(UI_LANGUAGES.map((l) => [l, langCatalog(l)]));
}

/** Sets globalThis.window.denShell.t to en's words (n = 1: the `.one` form). */
export function installEnShell(): void {
  const en = enCatalog();
  const t = (key: string, vars?: Vars) => {
    const one = vars?.n === 1 && en[`${key}.one`] !== undefined;
    const s = en[one ? `${key}.one` : key] ?? key;
    return s.replace(/\{(\w+)\}/g, (m, k: string) =>
      vars?.[k] == null ? m : String(vars[k]),
    );
  };
  (globalThis as Record<string, unknown>).window = {
    denShell: { t, lang: () => "en" },
  };
}

/**
 * Sets globalThis.window.denShell.t to `lang`'s words, as shell.js's t:
 * the plural form Intl.PluralRules picks, else en's, else the key.
 */
export function installShell(lang: string): void {
  const en = enCatalog();
  const own = lang === "en" ? en : langCatalog(lang);
  const rules = new Intl.PluralRules(lang);
  const look = (table: Record<string, string>, key: string, vars?: Vars) => {
    if (!(key in table)) return undefined;
    if (typeof vars?.n === "number") {
      const form = `${key}.${rules.select(vars.n)}`;
      if (form in table) return table[form];
    }
    return table[key];
  };
  const t = (key: string, vars?: Vars) =>
    String(look(own, key, vars) ?? look(en, key, vars) ?? key).replace(
      /\{(\w+)\}/g,
      (m, k: string) => (vars?.[k] == null ? m : String(vars[k])),
    );
  (globalThis as Record<string, unknown>).window = {
    denShell: { t, lang: () => lang },
  };
}
