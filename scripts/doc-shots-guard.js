/**
 * DOC-1's capture guard, for scripts/doc-shots.mjs (and its unit test: a
 * .js module, so Jest can load it). Before each screenshot, everything a
 * viewer could read on the page goes through the org-name gate's own
 * matcher (org-names.js): a hit aborts the capture naming the shot and the
 * term, never the text around it.
 */
import { orgHits } from "./org-names.js";

/** package.json's version without its prerelease suffix: 0.3.0-dev.37 → 0.3.0. */
export function releaseVersion(version) {
  const m = /^(\d+\.\d+\.\d+)/.exec(String(version));
  if (!m) throw new Error(`doc-shots: not a semver version: ${version}`);
  return m[1];
}

/**
 * Everything a viewer could read on the page: the rendered text, every
 * title / alt / aria-label (tooltips and screen-reader names), the page
 * title, and SVG text (the graph's labels; innerText skips some of it).
 */
export async function pageText(page) {
  return page.evaluate(() => {
    const parts = [
      document.title,
      document.body ? document.body.innerText : "",
    ];
    for (const el of document.querySelectorAll(
      "[title],[alt],[aria-label],[placeholder]",
    ))
      for (const a of ["title", "alt", "aria-label", "placeholder"]) {
        const v = el.getAttribute(a);
        if (v) parts.push(v);
      }
    for (const el of document.querySelectorAll("svg text, svg title, svg desc"))
      parts.push(el.textContent || "");
    return parts.join("\n");
  });
}

/**
 * Throws when `text` matches an org-name pattern, naming the shot and the
 * term (the pattern as listed), never the text around the match. `home`,
 * when given, is a path that must not appear either (the real HOME: a
 * screenshot of a path under it would publish a username).
 */
export function checkShotText(shot, text, patterns, { home } = {}) {
  const hits = orgHits(text, patterns);
  if (hits.length)
    throw new Error(
      `doc-shots: shot "${shot}" shows an org name: ${hits
        .map((h) => `pattern #${h.index} (${h.term})`)
        .join(", ")}; no image written`,
    );
  if (home && home.length > 1 && text.includes(home))
    throw new Error(
      `doc-shots: shot "${shot}" shows a path under your home directory; no image written`,
    );
}

/** The guard: the page's text against the patterns, before a capture. */
export async function guardShot(page, shot, patterns, opts) {
  checkShotText(shot, await pageText(page), patterns, opts);
}
