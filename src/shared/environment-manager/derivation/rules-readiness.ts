/**
 * Rule D — readiness-probe dependencies (the "read the /readyz code" signal).
 *
 * A peer service referenced inside a DEDICATED readiness/health handler
 * (`readyz_get`, `healthz_get`, `health.go`, `health_router.py`, …) is, by
 * convention, a startup gate: the service declares it isn't ready until that
 * peer is reachable. So we emit a HARD edge for it.
 *
 * This is forward-looking: today every surveyed `/readyz` checks only its own
 * DB/redis, so this rule yields nothing. It activates automatically once a team
 * adopts the convention (make `/readyz` 200 only when hard deps are reachable).
 * We deliberately scan only dedicated handler files — never broad files like
 * main.py — to avoid false positives. Comments are blanked before matching, and
 * bare single-word aliases ("app", "token", "backend") only count as URL hosts —
 * in prose they are far too ambiguous to mint a hard startup gate from.
 */

import type { AliasResolver } from "./alias.js";
import type { DerivedEdge, ScannedRepo } from "./types.js";
import { evidenceAt } from "./text.js";

const HANDLER_FILE = /(readyz|healthz|health_router|(^|\/)health\.go$)/;
const TOKEN = /[A-Za-z][A-Za-z0-9_.-]+/g;
const URL_HOST = /https?:\/\/([a-z0-9][a-z0-9.-]*)/g;
/** Multi-segment tokens (`files-api`, `shop.web`, `token_service`) only. */
const MULTI_SEGMENT = /[-._]/;

/**
 * Where an inline `//` or `#` comment starts on `line`, or -1. A `//` preceded
 * by `:` is a URL scheme separator (`http://…`), not a comment.
 */
function commentStart(line: string): number {
  let slashes = line.indexOf("//");
  while (slashes > 0 && line[slashes - 1] === ":") {
    slashes = line.indexOf("//", slashes + 1);
  }
  const hash = line.indexOf("#");
  if (slashes === -1) return hash;
  if (hash === -1) return slashes;
  return Math.min(slashes, hash);
}

/**
 * Blank full-line AND inline comments with spaces. Lengths and newlines are
 * preserved so match indexes still map onto the original content for evidence.
 */
function blankComments(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const cut = commentStart(line);
      return cut === -1
        ? line
        : line.slice(0, cut) + " ".repeat(line.length - cut);
    })
    .join("\n");
}

export function deriveReadinessEdges(
  repo: ScannedRepo,
  alias: AliasResolver,
): DerivedEdge[] {
  const out: DerivedEdge[] = [];
  const seen = new Set<string>();
  for (const file of repo.files) {
    if (!HANDLER_FILE.test(file.rel)) continue;
    const code = blankComments(file.content);
    const emit = (token: string, index: number): void => {
      const to = alias.resolve(token);
      if (!to || to === repo.repoName || to === alias.infraRepo || seen.has(to))
        return;
      seen.add(to);
      out.push({
        from: repo.repoName,
        to,
        kind: "http",
        blocking: "hard",
        signal: "readiness-probe",
        evidence: evidenceAt(file, index),
        confidence: "high",
      });
    };
    // A URL host is structured context — a bare word counts there
    // (`http://tokens:8080/healthz` really does gate on the tokens service).
    for (const m of code.matchAll(URL_HOST)) {
      emit(m[1].split(/[.:]/)[0], m.index ?? 0);
    }
    // Everywhere else only multi-segment tokens count: bare alias words like
    // "app" or "token" are just as often prose, and every readiness edge is a
    // HARD startup gate — too costly to mint from a stray word.
    for (const m of code.matchAll(TOKEN)) {
      if (MULTI_SEGMENT.test(m[0])) emit(m[0], m.index ?? 0);
    }
  }
  return out;
}
