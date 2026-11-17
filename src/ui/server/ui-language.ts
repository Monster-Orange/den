/**
 * The web UI's language (R19, 0.3.0-dev.39): a user pref, stored as
 * `language:` in config/local/user.yml and served by /api/settings, like
 * `editor`. Absent means English.
 *
 * The catalogs are one classic script per language, public/i18n/<lang>.js,
 * each adding its table to window.denMessages before shell.js runs. en.js
 * (issue 409; it was in shell.js) is the fallback, so every page with the
 * shell loads it; a page served in another language also gets that
 * language's script and `<html lang>`, so the first paint is already in
 * that language. Both come from localizePage.
 *
 * Only Den's own words are translated: names (services, workspaces, repos,
 * themes, languages), logs and command output never are.
 */

/** Every language the UI ships a catalog for; the first is the fallback. */
export const UI_LANGUAGES = ["en", "ja", "es"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];
export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

export function isUiLanguage(v: unknown): v is UiLanguage {
  return (
    typeof v === "string" && (UI_LANGUAGES as readonly string[]).includes(v)
  );
}

/** The stored value, normalised: an unknown or missing one is English. */
export function uiLanguage(stored: unknown): UiLanguage {
  return isUiLanguage(stored) ? stored : DEFAULT_UI_LANGUAGE;
}

/** The en catalog (issue 409): every page with the shell loads it first. */
export const EN_CATALOG_PATH = "/i18n/en.js";

/** Another language's catalog script, loaded after en's (none for en). */
export function catalogPath(lang: UiLanguage): string | null {
  return lang === DEFAULT_UI_LANGUAGE ? null : `/i18n/${lang}.js`;
}

/**
 * A page in `lang`: the en catalog loaded just before shell.js, and for
 * another language `<html lang>` set and its catalog loaded after en's, so
 * the shell draws in it from the first paint. A page without the shell
 * comes back unchanged.
 */
export function localizePage(html: string, lang: UiLanguage): string {
  const src = catalogPath(lang);
  const shell = '<script src="/shell.js"></script>';
  if (!html.includes(shell)) return html;
  const scripts = [EN_CATALOG_PATH, ...(src ? [src] : [])]
    .map((s) => `<script src="${s}"></script>`)
    .join("");
  const page = src
    ? html.replace(/<html lang="[^"]*"/, () => `<html lang="${lang}"`)
    : html;
  return page.replace(shell, () => `${scripts}${shell}`);
}
