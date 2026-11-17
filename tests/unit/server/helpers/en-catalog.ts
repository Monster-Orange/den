/**
 * shell.js's en catalog behind a window.denShell.t (den#171), for tests of
 * the pages' pure modules (edge-page.js, perf-report.js): they draw their
 * words through the shell, so a test sees en's, as a browser in English
 * does. shell.js is read as i18n.test.ts reads it.
 */
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

type Vars = Record<string, unknown>;

/** shell.js's MESSAGES.en. */
export function enCatalog(): Record<string, string> {
  const window: Record<string, unknown> = {};
  const ctx = vm.createContext({
    window,
    document: {
      getElementById: () => null,
      documentElement: { lang: "en" },
      addEventListener: () => {},
    },
    Intl,
  });
  const src = fs.readFileSync(
    path.join(process.cwd(), "src", "ui", "server", "public", "shell.js"),
    "utf-8",
  );
  try {
    vm.runInContext(src, ctx);
  } catch {
    // shell.js stops at its first DOM use; its catalog is set before it.
  }
  return (window.denMessages as Record<string, Record<string, string>>).en;
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
  (globalThis as Record<string, unknown>).window = { denShell: { t } };
}

/** A catalog other than en (public/i18n/<lang>.js), as the page loads it. */
export function langCatalog(lang: string): Record<string, string> {
  const window: Record<string, unknown> = {};
  vm.runInContext(
    fs.readFileSync(
      path.join(
        process.cwd(),
        "src",
        "ui",
        "server",
        "public",
        "i18n",
        `${lang}.js`,
      ),
      "utf-8",
    ),
    vm.createContext({ window }),
  );
  return (window.denMessages as Record<string, Record<string, string>>)[lang];
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
  (globalThis as Record<string, unknown>).window = { denShell: { t } };
}
