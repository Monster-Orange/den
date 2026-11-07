/**
 * The handoff check (den#4, session rotation): is a handoff.md complete
 * and plain? A session that rotates (after agents.rotate.after_compactions
 * compactions, or once its pull request merged) writes one in its files
 * dir; Den relaunches the role from it, in a fresh conversation whose
 * first prompt is the handoff. `<cli> agents handoff-check <file|->` runs
 * the check, and so does the Stop hook while a rotation is due.
 *
 * The template (guardrails/instructions.md):
 *
 *   ## Objective
 *   <what the work is for, in a sentence or two>
 *   ## State
 *   <what is done and where it lives: branch, pull request, files>
 *   ## Open items
 *   <what is left, one per line; or none>
 *   ## How to QA
 *   <the steps to see it working>
 *   ## Next step
 *   <the one thing to do first>
 *
 * It rejects a handoff when:
 *
 * 1. A part is missing or empty. A part is a heading that is its label
 *    (`## Open items`) or a line that starts with its label and a colon
 *    (`Next step: open the PR`). Its content is the rest of the line and
 *    the lines after it, up to the next part or heading.
 * 2. It has a bare ID: the hand-back check's rule (handback.ts bareIds).
 *    Code, links and code blocks are not scanned.
 * 3. It is longer than HANDOFF_MAX_CHARS: it is the next session's first
 *    prompt, so it must stay short.
 */
import { bareIds } from "./handback.js";

export const HANDOFF_PARTS = [
  "Objective",
  "State",
  "Open items",
  "How to QA",
  "Next step",
] as const;
export type HandoffPart = (typeof HANDOFF_PARTS)[number];

/** The longest handoff Den passes on (it becomes a first prompt). */
export const HANDOFF_MAX_CHARS = 20_000;

export interface HandoffResult {
  ok: boolean;
  /** One line each, plain, naming what to fix. */
  problems: string[];
}

const LABEL = new RegExp(
  `^\\s*(?:[-*+]\\s+)?(#{1,6}\\s+)?(?:\\*\\*|__)?(${HANDOFF_PARTS.map((p) =>
    p.replace(/ /g, "\\s+"),
  ).join("|")})(?:\\*\\*|__)?\\s*(:)?(?:\\*\\*|__)?\\s*(.*)$`,
  "i",
);

function canonical(label: string): HandoffPart {
  const l = label.replace(/\s+/g, " ").toLowerCase();
  return HANDOFF_PARTS.find((p) => p.toLowerCase() === l)!;
}

/** Each part's content lines, by part. */
export function handoffParts(text: string): Map<HandoffPart, string[]> {
  const found = new Map<HandoffPart, string[]>();
  let cur: HandoffPart | null = null;
  let fence = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const fenceLine = /^\s*(```|~~~)/.test(line);
    if (fenceLine) fence = !fence;
    const m = fence || fenceLine ? null : LABEL.exec(line);
    // A label needs a colon, or to be the whole heading.
    if (m && (m[3] || (m[1] && !m[4].trim()))) {
      cur = canonical(m[2]);
      const body = m[4].trim();
      found.set(cur, body ? [body] : []);
      continue;
    }
    if (!fence && /^\s*#{1,6}\s/.test(line)) {
      // The document's own title, or another heading: no part's content.
      cur = null;
      continue;
    }
    if (cur && line.trim()) found.get(cur)!.push(line.trim());
  }
  return found;
}

/** Check a handoff. Pure: the text in, the problems out. */
export function checkHandoff(text: string): HandoffResult {
  const s = String(text ?? "");
  const problems: string[] = [];
  if (!s.trim())
    return {
      ok: false,
      problems: [
        `The handoff is empty. Write ${HANDOFF_PARTS.map((p) => `"## ${p}"`).join(", ")}, each with its part filled in.`,
      ],
    };
  const found = handoffParts(s);
  for (const part of HANDOFF_PARTS) {
    const body = found.get(part);
    if (body === undefined) problems.push(`Missing "## ${part}". Add it.`);
    else if (!body.join(" ").trim())
      problems.push(`"## ${part}" is empty. Fill it in.`);
  }
  if (s.length > HANDOFF_MAX_CHARS)
    problems.push(
      `The handoff is ${s.length} characters long. Keep it under ${HANDOFF_MAX_CHARS}: it is the next session's first prompt.`,
    );
  for (const id of bareIds(s))
    problems.push(
      `"${id}" is not explained. Say what it is, e.g. "${id} (what it is)".`,
    );
  return { ok: problems.length === 0, problems };
}
