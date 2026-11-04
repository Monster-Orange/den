/**
 * Rule A — the shared local-infra repo (`graph.infra` in the org config).
 *
 * When an org runs shared local infra (databases, cloud emulators, …) from one
 * repo, backends must not start until it is healthy. A repo whose infra files
 * (stack.yml, manifest, Makefile, env files) match a configured signal gets a
 * single hard `repo → <infra repo>` edge. No `graph.infra`: no edges.
 */

import { product } from "../../product.js";
import type { AliasResolver } from "./alias.js";
import type { DerivedEdge, ScannedRepo } from "./types.js";
import { evidenceAt, isCommentedLine } from "./text.js";

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Files that carry local-infra wiring. */
const infraFiles = (): RegExp =>
  new RegExp(
    `(^|/)(stack\\.yml|${product().manifestFiles.map(escapeRe).join("|")}|Makefile|\\.env)`,
  );

export function deriveInfraEdges(
  repo: ScannedRepo,
  alias: AliasResolver,
): DerivedEdge[] {
  const infra = alias.infraRepo;
  if (!infra || repo.repoName === infra) return [];
  if (!alias.knownRepos.has(infra)) return [];
  // Configured signals are strong (concrete wiring); a bare mention of the
  // infra repo's name is weak and only used when no strong signal is found.
  const STRONG_SIGNALS = alias.infraSignals;
  const WEAK_SIGNALS = [new RegExp(`\\b${escapeRe(infra)}\\b`)];

  const filesRe = infraFiles();
  const infraFilesOf = repo.files.filter((f) => filesRe.test(f.rel));
  const edgeAt = (file: (typeof infraFilesOf)[number], index: number) => [
    {
      from: repo.repoName,
      to: infra,
      kind: "infra" as const,
      blocking: "hard" as const,
      signal: "infra",
      evidence: evidenceAt(file, index),
      confidence: "high" as const,
    },
  ];

  // Signal-major: exhaust the strong signals across every file first, so a
  // concrete `:4566` in one file wins over a bare-name mention in another.
  for (const signals of [STRONG_SIGNALS, WEAK_SIGNALS]) {
    for (const re of signals) {
      for (const file of infraFilesOf) {
        for (const m of file.content.matchAll(new RegExp(re, "g"))) {
          const index = m.index ?? 0;
          if (isCommentedLine(file.content, index)) continue;
          return edgeAt(file, index);
        }
      }
    }
  }
  return [];
}
