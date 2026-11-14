/**
 * The org-name matcher, shared by the org-name gate (scripts/org-name-gate.mjs,
 * over the tracked files) and the screenshot guard (scripts/doc-shots.mjs,
 * over each page's text before it is captured). One matcher, so the two can
 * never disagree about what counts as a hit.
 *
 * The patterns are NOT in this repo (listing them would publish them): they
 * come from DEN_ORG_NAMES (one regex per line; a CI secret) or the file named
 * by DEN_ORG_NAMES_FILE. Blank lines and `#` comments are skipped; each line
 * is a case-insensitive regex.
 */
import { readFileSync } from "node:fs";

/** The patterns from `env` ([] when neither variable is set). */
export function orgPatterns(env = process.env) {
  const raw =
    env.DEN_ORG_NAMES ??
    (env.DEN_ORG_NAMES_FILE
      ? readFileSync(env.DEN_ORG_NAMES_FILE, "utf-8")
      : "");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l, "i"));
}

/**
 * Every pattern `text` matches, as { index } (1-based, the gate's "pattern
 * #N") and { term } (the pattern as listed, never the text it matched, so a
 * report can name the term without echoing what surrounds it).
 */
export function orgHits(text, patterns) {
  const hits = [];
  patterns.forEach((p, i) => {
    if (p.test(text)) hits.push({ index: i + 1, term: p.source });
  });
  return hits;
}

/**
 * The gate's wider match: a name listed run together ("acmewidgets") is
 * also caught as a string writes it, "Acme Widgets", "acme-widgets" or
 * "ACME_WIDGETS". Only spaces, hyphens and underscores between two letters
 * are dropped, so words are never joined across other punctuation.
 * `allowed` (lower-case, run together) are names this text may carry: the
 * publisher's own, outside what the product shows.
 */
export function orgHitsWide(text, patterns, allowed = []) {
  const join = (s) => s.replace(/(?<=\p{L})[\s_-]+(?=\p{L})/gu, "");
  let joined = join(text);
  for (const a of allowed)
    joined = joined.replace(
      new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      " ",
    );
  const hits = [];
  patterns.forEach((p, i) => {
    if (p.test(text) || p.test(joined))
      hits.push({ index: i + 1, term: p.source });
  });
  return hits;
}
