/**
 * Issue 798 (REVIEW-MESH-SPEC RV-1): the `review:` section of a repo's
 * manifest, the repo's own rules for which pull requests get an
 * adversarial review.
 *
 *   review:
 *     rules:
 *       - name: core
 *         match:
 *           paths: ["src/core/**"]        # globs; omitted = the whole repo
 *           authors: any                  # any | people | agents
 *           labels: [deploy]              # only PRs with one of these
 *           labels_skip: [no-review]      # never PRs with one of these
 *           min_lines_changed: 1
 *           drafts: false                 # drafts too? default no
 *         require:
 *           reviews: 2                    # default 1
 *           lenses: [correctness, security]
 *           blocks_merge: true            # default false
 *
 * Rules match in order, and a PR can match several: each matched rule
 * needs its review. With no section, every non-draft PR from an agent
 * gets one review (the default rule). `rules: []` asks for none.
 *
 * The rules that apply are the base branch's (reviewAt), never the PR
 * head's, so a PR can't change its own review. An override can only
 * tighten them (reviewLoosenings, checked in validate-layers.ts).
 *
 * The spec's later fields (skill, skill_args, ticket_coverage, reviewer,
 * agent_may, escalate) are accepted and kept for the reviewer agents
 * (issue 476); this file doesn't act on them.
 */
import { execFileSync } from "child_process";
import { parse } from "yaml";
import { z } from "zod";
import { product } from "../product.js";
import { globRegExp } from "../verify/changes.js";

const words = z.array(z.string().min(1));

const matchSchema = z
  .object({
    paths: words.min(1).optional(),
    authors: z.enum(["any", "people", "agents"]).optional(),
    labels: words.min(1).optional(),
    labels_skip: words.optional(),
    min_lines_changed: z.number().int().min(0).optional(),
    drafts: z.boolean().optional(),
  })
  .strict();

const requireSchema = z
  .object({
    reviews: z.number().int().min(1).max(10).optional(),
    lenses: words.optional(),
    blocks_merge: z.boolean().optional(),
    // RV-1's later fields: kept for the reviewer agents (issue 476).
    skill: z.string().min(1).optional(),
    skill_args: z.string().optional(),
    ticket_coverage: z.boolean().optional(),
    reviewer: z.record(z.string(), z.unknown()).optional(),
    agent_may: z.record(z.string(), z.unknown()).optional(),
    escalate: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const ruleSchema = z
  .object({
    name: z.string().min(1),
    match: matchSchema.optional(),
    require: requireSchema.optional(),
  })
  .strict();

export const reviewSchema = z
  .object({ rules: z.array(ruleSchema) })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.rules.forEach((r, i) => {
      if (seen.has(r.name))
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "name"],
          message: `rule name "${r.name}" is used twice: each rule needs its own name`,
        });
      seen.add(r.name);
    });
  });

export type Review = z.infer<typeof reviewSchema>;
export type ReviewRule = Review["rules"][number];

/** With no `review:` section: every non-draft PR from an agent, once. */
export const DEFAULT_REVIEW: Review = {
  rules: [{ name: "default", match: { authors: "agents" } }],
};

/** What a rule needs to know about a pull request. */
export interface ReviewPr {
  /** Changed paths, relative to the repo root. */
  paths: string[];
  labels: string[];
  /** Lines added plus lines removed. */
  linesChanged: number;
  author: "person" | "agent";
  draft: boolean;
}

/** A rule the PR matched, and what it asks for. */
export interface MatchedRule {
  rule: string;
  reviews: number;
  lenses: string[];
  blocksMerge: boolean;
}

/** Whether a path matches any of `globs` (Verify's glob rules). */
const matcher = (globs: string[]) => {
  const res = globs.map(globRegExp);
  return (p: string) => res.some((re) => re.test(p));
};

function matches(r: ReviewRule, pr: ReviewPr): boolean {
  const m = r.match ?? {};
  if (pr.draft && m.drafts !== true) return false;
  const authors = m.authors ?? "any";
  if (authors === "agents" && pr.author !== "agent") return false;
  if (authors === "people" && pr.author !== "person") return false;
  if (m.labels_skip?.some((l) => pr.labels.includes(l))) return false;
  if (m.labels && !m.labels.some((l) => pr.labels.includes(l))) return false;
  if (pr.linesChanged < (m.min_lines_changed ?? 0)) return false;
  if (m.paths) {
    const hit = matcher(m.paths);
    if (!pr.paths.some((p) => hit(p))) return false;
  }
  return true;
}

/** The rules `pr` matches, in order (none: it needs no review). */
export function matchReview(
  review: Review | undefined,
  pr: ReviewPr,
): MatchedRule[] {
  return (review ?? DEFAULT_REVIEW).rules
    .filter((r) => matches(r, pr))
    .map((r) => ({
      rule: r.name,
      reviews: r.require?.reviews ?? 1,
      lenses: r.require?.lenses ?? [],
      blocksMerge: r.require?.blocks_merge ?? false,
    }));
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  return v;
}

export type ReviewAt = ReturnType<typeof reviewAt>;

export function reviewRulesGuard(
  base: ReviewAt,
  head: ReviewAt,
): MatchedRule | null {
  const section = (a: ReviewAt) => JSON.stringify(canonical(a?.review ?? null));
  if (base && head && section(base) === section(head)) return null;
  return {
    rule: "review-rules-changed",
    reviews: 1,
    lenses: ["governance"],
    blocksMerge: true,
  };
}

/** How wide an author kind is: any takes both. */
const AUTHORS_WIDTH = { people: 1, agents: 1, any: 2 } as const;

/**
 * What `next` loosens against `base` (each a review section, or none for
 * the default): a rule gone, fewer reviews, a merge no longer blocked, or
 * fewer PRs or lenses covered. Empty when `next` only tightens.
 */
export function reviewLoosenings(
  base: Review | undefined,
  next: Review | undefined,
): string[] {
  const b = base ?? DEFAULT_REVIEW;
  const n = next ?? DEFAULT_REVIEW;
  const out: string[] = [];
  for (const br of b.rules) {
    const nr = n.rules.find((r) => r.name === br.name);
    if (!nr) {
      out.push(`removes the rule "${br.name}"`);
      continue;
    }
    const say = (s: string) => out.push(`"${br.name}": ${s}`);
    const bm = br.match ?? {};
    const nm = nr.match ?? {};
    const breq = br.require ?? {};
    const nreq = nr.require ?? {};
    const was = breq.reviews ?? 1;
    const now = nreq.reviews ?? 1;
    if (now < was) say(`reviews ${was} → ${now}`);
    if ((breq.blocks_merge ?? false) && !(nreq.blocks_merge ?? false))
      say("blocks_merge true → false");
    for (const l of breq.lenses ?? [])
      if (!(nreq.lenses ?? []).includes(l)) say(`drops the lens "${l}"`);
    // Paths: omitted is the whole repo, the widest.
    if (bm.paths && nm.paths)
      for (const p of bm.paths)
        if (!nm.paths.includes(p)) say(`drops the path "${p}"`);
    if (!bm.paths && nm.paths) say("narrows the whole repo to some paths");
    const ba = bm.authors ?? "any";
    const na = nm.authors ?? "any";
    if (na !== ba && AUTHORS_WIDTH[na] <= AUTHORS_WIDTH[ba])
      say(`authors ${ba} → ${na}`);
    for (const l of nm.labels_skip ?? [])
      if (!(bm.labels_skip ?? []).includes(l))
        say(`skips the label "${l}" too`);
    // labels: omitted is every PR, the widest.
    if (!bm.labels && nm.labels) say("only some labels now");
    if (bm.labels && nm.labels)
      for (const l of bm.labels)
        if (!nm.labels.includes(l)) say(`drops the label "${l}"`);
    const bl = bm.min_lines_changed ?? 0;
    const nl = nm.min_lines_changed ?? 0;
    if (nl > bl) say(`min_lines_changed ${bl} → ${nl}`);
    if ((bm.drafts ?? false) && !(nm.drafts ?? false))
      say("drafts true → false");
  }
  return out;
}

/** A ref reviewAt reads: a branch, tag or commit name; never "-…" or a "x:path". */
const SAFE_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,254}$/;

/** The manifest file names this product reads at a repo's root, in order. */
const manifestNames = (): string[] => [
  product().manifestYml,
  product().manifestJson,
];

/**
 * The review section on `ref` (the PR's base branch), read from git, never
 * the working tree: `file` is the manifest it came from (null: none on
 * that ref, so the default applies). Null when `ref` isn't there or its
 * manifest isn't valid YAML with a valid section: no rules Den can trust.
 */
export function reviewAt(
  repoPath: string,
  ref: string,
  names: readonly string[] = manifestNames(),
): { file: string | null; review: Review | undefined } | null {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    });
  // A ref is a branch or commit name, never an option or a path.
  if (!SAFE_REF_RE.test(ref) || ref.includes("..")) return null;
  try {
    git([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
  } catch {
    return null;
  }
  for (const name of names) {
    let text: string;
    try {
      text = git(["show", `${ref}:${name}`]);
    } catch {
      continue;
    }
    try {
      const doc = parse(text) as { review?: unknown } | null;
      if (doc?.review === undefined) return { file: name, review: undefined };
      const r = reviewSchema.safeParse(doc.review);
      return r.success ? { file: name, review: r.data } : null;
    } catch {
      return null;
    }
  }
  return { file: null, review: undefined };
}
