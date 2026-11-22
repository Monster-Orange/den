/**
 * Issue 1127: text Den's tooling files on GitHub for an agent (an issue's
 * title and body, a comment, a report) passes the same org-name check as
 * commits and files (shared/org-names.js) before it is sent. A hit refuses
 * the write. The refusal names the field, the line and the pattern's number
 * (as the org-name gate does), never the matched text and never the list:
 * an agent's tool answer can end up in a public place too.
 *
 * The list comes from where it is configured today (DEN_ORG_NAMES, the file
 * DEN_ORG_NAMES_FILE names, or the per-user file); with none, nothing is
 * refused. Private and internal repos are not checked: the check guards
 * what the public can read. A repo whose visibility isn't known is checked.
 */
import { orgHitsWide, orgPatterns } from "./org-names.js";

export type FiledField = "title" | "body" | "comment";

export interface FiledText {
  field: FiledField;
  text: string;
}

/** One hit: the field, its 1-based line, and the pattern's 1-based number. */
export interface FiledHit {
  field: FiledField;
  line: number;
  index: number;
}

/** "Owner-Name/repo" as the matcher's allowed list writes it. */
function runTogether(repo: string): string {
  return repo.replace(/[\s_-]+/g, "").toLowerCase();
}

/**
 * Every hit in `texts`, line by line. `repo` (owner/name) is the target:
 * its own owner/name is allowed, so a link to it is not a hit.
 */
export function filedTextHits(
  texts: readonly FiledText[],
  patterns: RegExp[],
  repo?: string,
): FiledHit[] {
  const allowed = repo ? [runTogether(repo)] : [];
  const hits: FiledHit[] = [];
  for (const { field, text } of texts)
    text.split("\n").forEach((line, i) => {
      for (const { index } of orgHitsWide(line, patterns, allowed))
        hits.push({ field, line: i + 1, index });
    });
  return hits;
}

/** The refusal: where each hit is, never what it matched. */
export function filedTextRefusal(hits: readonly FiledHit[]): string {
  const where = hits
    .map((h) => `${h.field} line ${h.line} matches listed pattern #${h.index}`)
    .join("; ");
  return `${where}. The repo is public (or its visibility isn't known), and this text names an organization, host or person on the list; nothing was sent. Rewrite it without that name.`;
}

/** Whether a repo of this visibility is checked (null: not known). */
export function needsFiledCheck(
  visibility: "public" | "private" | "internal" | null,
): boolean {
  return visibility !== "private" && visibility !== "internal";
}

/**
 * The check as a write runs it: the configured list (none: no refusal), the
 * repo's visibility, then the hits. Returns the refusal, or null to go on.
 * A list file that is named but missing throws in orgPatterns: the write
 * fails closed.
 */
export function filedTextCheck(
  texts: readonly FiledText[],
  repo: string,
  visibility: "public" | "private" | "internal" | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!needsFiledCheck(visibility)) return null;
  const patterns = orgPatterns(env);
  if (!patterns.length) return null;
  const hits = filedTextHits(texts, patterns, repo);
  return hits.length ? filedTextRefusal(hits) : null;
}
