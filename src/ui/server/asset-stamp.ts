/**
 * Issue 231: after Den updates, a tab left open (or a page Safari brings
 * back from its back-forward cache) must not keep an old stylesheet or
 * script. Every same-origin .css/.js/.mjs URL in what Den serves (its
 * pages, its own scripts, the UI kit's files) gets `?v=<version>`, the
 * version the running Den loaded. A new version is a new URL, so no cache
 * can answer it with old bytes.
 *
 * One rewrite where the files are served, not hand-edited pages: it covers
 * `<link href>`, `<script src>`, static and dynamic `import`s, and plain
 * string constants (a script element's src). Every reference to a module
 * gets the same stamp, so the browser keeps one copy of each module (an
 * ES module's identity is its full URL: `/a.js` and `/a.js?v=1` would be
 * two). A relative import (`./a.js`) from a stamped module is stamped too.
 *
 * Only a quoted path that starts with `/` or `./` (never `//`, a scheme or
 * a data URL) and ends in .css/.js/.mjs at its closing quote: a URL that
 * already has a query or a hash is left alone.
 */

const SAME_ORIGIN_ASSET =
  /(["'`])((?:\.{1,2})?\/(?!\/)[A-Za-z0-9_\-./]*\.(?:css|m?js))(?=\1)/g;

/** `text` with each same-origin asset URL stamped `?v=<version>`. */
export function stampAssetUrls(text: string, version: string): string {
  const v = encodeURIComponent(version);
  return text.replace(
    SAME_ORIGIN_ASSET,
    (_m, q: string, url: string) => `${q}${url}?v=${v}`,
  );
}

/** Whether a served file of this name is stamped (pages, scripts, styles). */
export function isStampedFile(file: string): boolean {
  return /\.(?:html|css|m?js)$/.test(file);
}
