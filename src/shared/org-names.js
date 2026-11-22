/**
 * The org-name matcher, shared by the org-name gate (scripts/org-name-gate.mjs,
 * over the tracked files), the screenshot guard (scripts/doc-shots.mjs, over
 * each page's text before it is captured) and, issue 1127, the check on text
 * Den files on GitHub (shared/filed-text-check.ts). scripts/org-names.js
 * re-exports this file. One matcher, so they can never disagree about what
 * counts as a hit. It ships in the package; the list never does.
 *
 * The patterns are NOT in this repo (listing them would publish them): they
 * come from DEN_ORG_NAMES (one regex per line; a CI secret) or the file named
 * by DEN_ORG_NAMES_FILE. Blank lines and `#` comments are skipped; each line
 * is a case-insensitive regex.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The per-user names file, read when neither variable is set, so git hooks
 * (which see no shell variables from an agent's session) still find it:
 * $XDG_CONFIG_HOME/den-dev/org-names.txt, else ~/.config/den-dev/org-names.txt.
 */
export function userNamesFile(env = process.env) {
  const base =
    env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : "");
  return base ? join(base, "den-dev", "org-names.txt") : "";
}

/**
 * The patterns from `env` ([] when nothing is configured). A file named in
 * DEN_ORG_NAMES_FILE that is missing throws: a gate set up wrongly fails
 * closed rather than passing.
 */
export function orgPatterns(env = process.env) {
  const own = userNamesFile(env);
  const file = env.DEN_ORG_NAMES_FILE || (own && existsSync(own) ? own : "");
  const raw = env.DEN_ORG_NAMES ?? (file ? readFileSync(file, "utf-8") : "");
  // Issue 1127: a line that isn't a valid pattern throws naming its line
  // number only. RegExp's own error quotes the line, and this message can
  // reach a log, an agent or a GitHub answer.
  const patterns = [];
  raw.split("\n").forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith("#")) return;
    try {
      patterns.push(new RegExp(l, "i"));
    } catch {
      throw new Error(`line ${i + 1} of the names list is not a valid pattern`);
    }
  });
  return patterns;
}

/**
 * Issue 1127: `text` with each match of a listed pattern replaced by
 * "<listed>": for text Den adds itself (a report's page and version
 * sections), so what Den writes never holds a listed name.
 */
export function orgMask(text, patterns) {
  let out = String(text ?? "");
  for (const p of patterns)
    out = out.replace(new RegExp(p.source, "gi"), "<listed>");
  return out;
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

/**
 * Issue 1127: the hits in text filed on GitHub (an issue's title and body,
 * a comment), line by line: [{ field, line, index }] (1-based line and
 * pattern number), never the matched text. `repo` (owner/name) is the
 * target: its own owner/name is allowed, so a link to it is not a hit.
 * shared/filed-text-check.ts (Den's tooling) and scripts/filed-text-scan.js
 * (the scheduled scan) both use it.
 */
export function orgHitsByLine(texts, patterns, repo) {
  const allowed = repo ? [repo.replace(/[\s_-]+/g, "").toLowerCase()] : [];
  const hits = [];
  for (const { field, text } of texts)
    String(text ?? "")
      .split("\n")
      .forEach((line, i) => {
        for (const { index } of orgHitsWide(line, patterns, allowed))
          hits.push({ field, line: i + 1, index });
      });
  return hits;
}
