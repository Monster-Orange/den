/**
 * The web UI's language (R19, 0.3.0-dev.39): a user pref, stored as
 * `language:` in config/local/user.yml and served by /api/settings, like
 * `editor`. Absent means English.
 *
 * The catalogs are public/shell.js's MESSAGES (en, the fallback) and one
 * classic script per other language, public/i18n/<lang>.js, which adds its
 * table to window.denMessages before shell.js runs. A page served in a
 * language other than English gets that script and `<html lang>` from
 * localizePage, so the first paint is already in that language. An English
 * page is served exactly as it is on disk.
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

/** The catalog script a language's pages load before shell.js (none for en). */
export function catalogPath(lang: UiLanguage): string | null {
  return lang === DEFAULT_UI_LANGUAGE ? null : `/i18n/${lang}.js`;
}

/**
 * A page in `lang`: `<html lang>` set, and the language's catalog loaded
 * just before shell.js, so the shell draws in it from the first paint.
 * English, or a page without the shell, comes back unchanged.
 */
export function localizePage(html: string, lang: UiLanguage): string {
  const src = catalogPath(lang);
  const shell = '<script src="/shell.js"></script>';
  if (!src || !html.includes(shell)) return html;
  return html
    .replace(/<html lang="[^"]*"/, () => `<html lang="${lang}"`)
    .replace(shell, () => `<script src="${src}"></script>${shell}`);
}
