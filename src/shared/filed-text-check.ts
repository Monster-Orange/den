/**
 * Issue 1127: text Den's tooling files on GitHub for an agent (an issue's
 * title and body, a comment, a report) passes the same org-name check as
 * commits and files (shared/org-names.js) before it is sent. A hit refuses
 * the write. The refusal quotes the writer's own phrase, with its field and
 * line, and offers neutral words, so one retry fixes it. It never shows the
 * list. What is kept (the audit) names only the field, the line and the
 * pattern's number, as the org-name gate does.
 *
 * The list comes from where it is configured today (DEN_ORG_NAMES, the file
 * DEN_ORG_NAMES_FILE names, or the per-user file); with none, nothing is
 * refused. Private and internal repos are not checked: the check guards
 * what the public can read. A repo whose visibility isn't known is checked.
 */
import { orgHitsByLine } from "./org-names.js";

export type FiledField =
  | "title"
  | "body"
  | "description"
  | "comment"
  | "label"
  | "milestone";

export interface FiledText {
  field: FiledField;
  text: string;
}

/**
 * One hit: the field, its 1-based line, the pattern's 1-based number, and
 * the writer's own phrase that matched (their text, never the pattern).
 */
export interface FiledHit {
  field: FiledField;
  line: number;
  index: number;
  phrase: string;
}

const NEUTRAL = `"the person", "the project", "the company" or "an internal host"`;

/**
 * The part of `line` that `pattern` matched: as written, else through the
 * wider match (spaces, hyphens and underscores between letters dropped),
 * mapped back to the line. A match inside `allowed` (the target repo's own
 * owner/name, run together) is skipped. Else the line itself, cut short.
 */
function phraseIn(line: string, pattern: RegExp, allowed: string[]): string {
  const direct = new RegExp(pattern.source, "i").exec(line);
  if (direct) return direct[0].slice(0, 120);
  let joined = "";
  const at: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const gap =
      /[\s_-]/.test(line[i]) &&
      /\p{L}/u.test(line[i - 1] ?? "") &&
      /^[\s_-]*\p{L}/u.test(line.slice(i));
    if (gap) continue;
    joined += line[i];
    at.push(i);
  }
  const lower = joined.toLowerCase();
  const skip = allowed.flatMap((a) => {
    const spans: [number, number][] = [];
    for (let k = lower.indexOf(a); k >= 0; k = lower.indexOf(a, k + 1))
      spans.push([k, k + a.length]);
    return spans;
  });
  const g = new RegExp(pattern.source, "gi");
  for (let m = g.exec(joined); m; m = g.exec(joined)) {
    if (!m[0]) {
      g.lastIndex++;
      continue;
    }
    const s0 = m.index;
    const e0 = m.index + m[0].length;
    if (skip.some(([a, b]) => s0 >= a && e0 <= b)) continue;
    return line.slice(at[s0], at[e0 - 1] + 1).slice(0, 120);
  }
  return line.trim().slice(0, 120);
}

/**
 * Every hit in `texts`, line by line (shared/org-names.js orgHitsByLine).
 * `repo` (owner/name) is the target: its own owner/name is allowed.
 */
export function filedTextHits(
  texts: readonly FiledText[],
  patterns: RegExp[],
  repo?: string,
): FiledHit[] {
  const allowed = repo ? [repo.replace(/[\s_-]+/g, "").toLowerCase()] : [];
  // Text by text, so two texts of one field (two labels) keep their lines.
  return texts.flatMap((t) =>
    (orgHitsByLine([t], patterns, repo) as Omit<FiledHit, "phrase">[]).map(
      (h) => {
        const line = String(t.text ?? "").split("\n")[h.line - 1] ?? "";
        return { ...h, phrase: phraseIn(line, patterns[h.index - 1], allowed) };
      },
    ),
  );
}

/** The refusal: the writer's own phrases and neutral words, never the list. */
export function filedTextRefusal(hits: readonly FiledHit[]): string {
  const where = hits
    .map((h) => `${h.field} line ${h.line}: "${h.phrase}"`)
    .join("; ");
  return `${where}. The repo is public (or its visibility isn't known), and this text names something that stays out of public text; nothing was sent. Write it with neutral words instead, such as ${NEUTRAL}, then send it again.`;
}

/** What is kept of a refusal (the audit): field, line and pattern number only. */
export function filedTextWhere(
  hits: readonly FiledHit[],
  listed = Infinity,
): string {
  return hits
    .map(
      (h) =>
        `${h.field} line ${h.line} matches ${h.index > listed ? "an install name" : `listed pattern #${h.index}`}`,
    )
    .join("; ");
}

/** Whether a repo of this visibility is checked (null: not known). */
export function needsFiledCheck(
  visibility: "public" | "private" | "internal" | null,
): boolean {
  return visibility !== "private" && visibility !== "internal";
}

/**
 * The check as a write runs it: the listed names (none: no refusal), the
 * repo's visibility, then the hits. The refusal, or null to go on.
 */
export function filedTextCheck(
  texts: readonly FiledText[],
  repo: string,
  visibility: "public" | "private" | "internal" | null,
  patterns: RegExp[],
): string | null {
  if (!patterns.length || !needsFiledCheck(visibility)) return null;
  const hits = filedTextHits(texts, patterns, repo);
  return hits.length ? filedTextRefusal(hits) : null;
}

export function installOwnNames(o: {
  label: string;
  host: string;
  projects: readonly string[];
  git: { name?: string; email?: string };
}): { always: string[]; named: string[] } {
  return {
    always: [
      o.label,
      o.host.split(".")[0],
      o.git.name ?? "",
      o.git.email ?? "",
    ].filter(Boolean),
    named: [...o.projects],
  };
}

export function ownNamePatterns(
  always: readonly string[],
  named: readonly string[],
  repo: string,
): RegExp[] {
  const key = (x: string) => x.trim().toLowerCase();
  const [owner = "", name = ""] = repo.split("/");
  const skip = new Set([key(owner), key(name), key(repo)]);
  const seen = new Set<string>();
  const out: RegExp[] = [];
  const names = [...always, ...named.filter((n) => /[-_ .0-9]/.test(n.trim()))];
  for (const n of names) {
    const k = key(n);
    if (k.length < 3 || skip.has(k) || seen.has(k)) continue;
    seen.add(k);
    const esc = n.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out.push(new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i"));
  }
  return out;
}
