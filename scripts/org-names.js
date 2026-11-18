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
import { existsSync, lstatSync, readFileSync } from "node:fs";
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

const parse = (raw) =>
  raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l, "i"));

/** The error a set-but-broken per-user names file throws (issue 528). */
export const BROKEN_NAMES_FILE = "DEN_NAMES_FILE_BROKEN";

/** What a set-but-broken names file says. It names the path, never a pattern. */
export function brokenNamesMessage(file) {
  return `the names file at ${file} is set but has no patterns (a broken link, or empty); fix it or remove it`;
}

/**
 * The per-user names file's state (issue 528), with the pattern count only:
 * "none" (nothing at the path: the hooks pass), "broken-link" (a symlink
 * whose target is missing), "empty" (it loads 0 patterns) or "ok".
 * { file, state, count, patterns }. The patterns are for the caller to
 * match with, never to print.
 */
export function userNamesFileState(env = process.env) {
  const file = userNamesFile(env);
  let link;
  try {
    link = file ? lstatSync(file) : null;
  } catch {
    link = null;
  }
  if (!link) return { file, state: "none", count: 0, patterns: [] };
  if (link.isSymbolicLink() && !existsSync(file))
    return { file, state: "broken-link", count: 0, patterns: [] };
  const patterns = parse(readFileSync(file, "utf-8"));
  return {
    file,
    state: patterns.length ? "ok" : "empty",
    count: patterns.length,
    patterns,
  };
}

/**
 * The patterns from `env` ([] when nothing is configured). A file named in
 * DEN_ORG_NAMES_FILE that is missing throws: a gate set up wrongly fails
 * closed rather than passing. So does the per-user file when it is there but
 * broken, a dangling link or no patterns (issue 528): set means meant, so it
 * never passes quietly. The variables win over the per-user file, as before.
 */
export function orgPatterns(env = process.env) {
  if (env.DEN_ORG_NAMES !== undefined) return parse(env.DEN_ORG_NAMES);
  if (env.DEN_ORG_NAMES_FILE)
    return parse(readFileSync(env.DEN_ORG_NAMES_FILE, "utf-8"));
  const own = userNamesFileState(env);
  if (own.state === "broken-link" || own.state === "empty") {
    const err = new Error(brokenNamesMessage(own.file));
    err.code = BROKEN_NAMES_FILE;
    throw err;
  }
  return own.patterns;
}

/**
 * orgPatterns for a gate script: a broken per-user file prints its message
 * (`tag: ...`) and exits 1 instead of a stack trace. Other errors still throw.
 */
export function orgPatternsOrExit(tag, env = process.env) {
  try {
    return orgPatterns(env);
  } catch (err) {
    if (err?.code !== BROKEN_NAMES_FILE) throw err;
    console.error(`${tag}: ${err.message}`);
    process.exit(1);
  }
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
