/**
 * Issue 798 (REVIEW-MESH-SPEC RV-1): a repo's own rules for which pull
 * requests get an adversarial review. The `review:` section of the
 * repo's manifest says, per rule, which PRs (paths, labels, size, author
 * kind, drafts), how many reviews, which lenses, and whether a review
 * blocks the merge. With no section, every non-draft PR from an agent
 * gets one review. An override can only tighten. The rules that apply
 * are the base branch's, never the PR head's.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  matchReview,
  reviewAt,
  reviewLoosenings,
  type ReviewPr,
} from "../../../src/shared/review/rules.js";
import {
  validateManifest,
  validateManifestLayers,
} from "../../../src/shared/manifest/validate-manifest.js";

const pr = (o: Partial<ReviewPr> = {}): ReviewPr => ({
  paths: ["src/app.ts"],
  labels: [],
  linesChanged: 10,
  author: "agent",
  draft: false,
  ...o,
});
const names = (r: ReturnType<typeof matchReview>) => r.map((m) => m.rule);

const CORE = {
  rules: [
    {
      name: "core",
      match: {
        paths: ["src/core/**", "src/shared/auth/**"],
        authors: "any",
        labels_skip: ["no-review"],
        min_lines_changed: 1,
      },
      require: {
        reviews: 2,
        lenses: ["correctness", "security"],
        blocks_merge: true,
      },
    },
    {
      name: "docs",
      match: { paths: ["docs/**", "*.md"] },
      require: { reviews: 1, lenses: ["conventions"] },
    },
  ],
};

describe("the review section in a manifest", () => {
  it("a full section is valid, with the spec's later fields kept", () => {
    const r = validateManifest({
      name: "shop",
      review: {
        rules: [
          {
            ...CORE.rules[0],
            require: {
              ...CORE.rules[0].require,
              skill: "deep-review:deep-review",
              skill_args: "--depth standard",
              ticket_coverage: true,
              reviewer: { not_author_agent: true, min_model: "opus" },
              agent_may: { resolve: false, merge: false },
              escalate: { after_rounds: 3 },
            },
          },
        ],
      },
    });
    expect(r.errors).toEqual([]);
  });

  it("a typo, a bad author kind or zero reviews is refused, naming where", () => {
    const bad = (rule: unknown) =>
      validateManifest({ name: "shop", review: { rules: [rule] } }).errors.map(
        (e) => e.path,
      );
    expect(bad({ name: "x", match: { pathz: ["a/**"] } })).toContain(
      "review.rules[0].match",
    );
    expect(bad({ name: "x", match: { authors: "bots" } })).toContain(
      "review.rules[0].match.authors",
    );
    expect(bad({ name: "x", require: { reviews: 0 } })).toContain(
      "review.rules[0].require.reviews",
    );
    expect(bad({ match: {} })).toContain("review.rules[0].name");
  });

  it("two rules with one name are refused", () => {
    const r = validateManifest({
      name: "shop",
      review: { rules: [{ name: "a" }, { name: "a" }] },
    });
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(
      /rule name "a" is used twice/,
    );
  });
});

describe("which pull requests want a review", () => {
  it("no section: every non-draft PR from an agent gets one review, and no other", () => {
    expect(matchReview(undefined, pr())).toEqual([
      {
        rule: "default",
        reviews: 1,
        lenses: [],
        blocksMerge: false,
      },
    ]);
    expect(matchReview(undefined, pr({ author: "person" }))).toEqual([]);
    expect(matchReview(undefined, pr({ draft: true }))).toEqual([]);
  });

  it("rules: [] means no reviews at all", () => {
    expect(matchReview({ rules: [] }, pr())).toEqual([]);
  });

  it("by path, in order; a PR can match several", () => {
    expect(
      names(matchReview(CORE, pr({ paths: ["src/core/a.ts", "README.md"] }))),
    ).toEqual(["core", "docs"]);
    expect(names(matchReview(CORE, pr({ paths: ["docs/x.md"] })))).toEqual([
      "docs",
    ]);
    expect(matchReview(CORE, pr({ paths: ["src/other.ts"] }))).toEqual([]);
    expect(matchReview(CORE, pr({ paths: ["src/core/a.ts"] }))[0]).toEqual({
      rule: "core",
      reviews: 2,
      lenses: ["correctness", "security"],
      blocksMerge: true,
    });
  });

  it("labels_skip, labels, size, author kind and drafts", () => {
    const core = pr({ paths: ["src/core/a.ts"] });
    expect(matchReview(CORE, { ...core, labels: ["no-review"] })).toEqual([]);
    expect(matchReview(CORE, { ...core, linesChanged: 0 })).toEqual([]);
    // authors: any takes people too.
    expect(names(matchReview(CORE, { ...core, author: "person" }))).toEqual([
      "core",
    ]);
    // Drafts are skipped unless the rule says drafts: true.
    expect(matchReview(CORE, { ...core, draft: true })).toEqual([]);
    const r = {
      rules: [
        {
          name: "infra",
          match: {
            labels: ["infra", "deploy"],
            authors: "people" as const,
            drafts: true,
          },
        },
      ],
    };
    const p = pr({ author: "person", labels: ["deploy"], draft: true });
    expect(names(matchReview(r, p))).toEqual(["infra"]);
    expect(matchReview(r, { ...p, labels: [] })).toEqual([]);
    expect(matchReview(r, { ...p, author: "agent" })).toEqual([]);
    // No paths: the whole repo. No require: one review, not blocking.
    expect(matchReview(r, p)[0]).toMatchObject({
      reviews: 1,
      blocksMerge: false,
    });
  });
});

describe("an override can only tighten", () => {
  const rule = (o: Record<string, unknown> = {}, req = {}) => ({
    rules: [
      {
        name: "core",
        match: {
          paths: ["src/core/**"],
          authors: "agents",
          labels_skip: ["no-review"],
          min_lines_changed: 5,
          ...o,
        },
        require: { reviews: 1, lenses: ["security"], ...req },
      },
    ],
  });

  it("raising, adding and widening what gets reviewed pass", () => {
    expect(reviewLoosenings(rule(), rule({}, { reviews: 2 }))).toEqual([]);
    expect(reviewLoosenings(rule(), rule({}, { blocks_merge: true }))).toEqual(
      [],
    );
    expect(
      reviewLoosenings(rule(), rule({ paths: ["src/core/**", "src/x/**"] })),
    ).toEqual([]);
    expect(reviewLoosenings(rule(), rule({ authors: "any" }))).toEqual([]);
    expect(reviewLoosenings(rule(), rule({ labels_skip: [] }))).toEqual([]);
    expect(reviewLoosenings(rule(), rule({ min_lines_changed: 1 }))).toEqual(
      [],
    );
    const more = rule();
    more.rules.push({ name: "docs", match: {}, require: {} } as never);
    expect(reviewLoosenings(rule(), more)).toEqual([]);
  });

  it("each loosening is named", () => {
    const base = rule({}, { blocks_merge: true });
    expect(reviewLoosenings(base, { rules: [] })).toEqual([
      'removes the rule "core"',
    ]);
    expect(
      reviewLoosenings(base, rule({}, { reviews: 0 + 1, blocks_merge: false })),
    ).toEqual(['"core": blocks_merge true → false']);
    expect(
      reviewLoosenings(rule({}, { reviews: 2 }), rule({}, { reviews: 1 })),
    ).toEqual(['"core": reviews 2 → 1']);
    expect(
      reviewLoosenings(rule(), rule({ paths: ["src/core/a/**"] })),
    ).toEqual(['"core": drops the path "src/core/**"']);
    expect(reviewLoosenings(rule(), rule({ authors: "people" }))).toEqual([
      '"core": authors agents → people',
    ]);
    expect(
      reviewLoosenings(rule(), rule({ labels_skip: ["no-review", "wip"] })),
    ).toEqual(['"core": skips the label "wip" too']);
    expect(reviewLoosenings(rule(), rule({ min_lines_changed: 9 }))).toEqual([
      '"core": min_lines_changed 5 → 9',
    ]);
    expect(reviewLoosenings(rule(), rule({}, { lenses: [] }))).toEqual([
      '"core": drops the lens "security"',
    ]);
    expect(
      reviewLoosenings(rule({ drafts: true }), rule({ drafts: false })),
    ).toEqual(['"core": drafts true → false']);
  });

  it("with no section in the base, the default is what it may not loosen", () => {
    expect(reviewLoosenings(undefined, { rules: [] })).toEqual([
      'removes the rule "default"',
    ]);
    expect(reviewLoosenings(undefined, rule())).toEqual([
      'removes the rule "default"',
    ]);
    expect(
      reviewLoosenings(undefined, {
        rules: [
          { name: "default", match: { authors: "any" } },
          ...rule().rules,
        ],
      }),
    ).toEqual([]);
  });
});

describe("in the layered manifest", () => {
  const tmp: string[] = [];
  let held: string;
  let repo: string;
  const temp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-review-"));
    tmp.push(d);
    return d;
  };
  beforeEach(() => {
    held = temp();
    process.env.DEN_MANIFESTS_DIR = held;
    repo = path.join(temp(), "shop");
    fs.mkdirSync(repo);
    fs.writeFileSync(
      path.join(repo, ".den.yml"),
      [
        "name: shop",
        "review:",
        "  rules:",
        "    - name: core",
        "      match: { paths: ['src/core/**'] }",
        "      require: { reviews: 2 }",
        "",
      ].join("\n"),
    );
  });
  afterEach(() => {
    delete process.env.DEN_MANIFESTS_DIR;
    for (const d of tmp.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  const errors = () =>
    validateManifestLayers(repo).layers.flatMap((l) =>
      l.result.errors.map(
        (e) => `${l.file ? path.basename(l.file) : "merged"}: ${e.message}`,
      ),
    );

  it("an override that tightens passes; one that loosens is refused, naming its file", () => {
    const ov = path.join(held, "shop.override.yml");
    fs.writeFileSync(
      ov,
      "review:\n  rules:\n    - name: core\n      match: { paths: ['src/core/**'] }\n      require: { reviews: 3 }\n",
    );
    expect(errors()).toEqual([]);
    fs.writeFileSync(
      ov,
      "review:\n  rules:\n    - name: core\n      match: { paths: ['src/core/**'] }\n      require: { reviews: 1 }\n",
    );
    expect(errors()).toEqual([
      'shop.override.yml: an override can only tighten review rules: "core": reviews 2 → 1',
    ]);
  });

  it("an override may add a review section the base lacks, if it tightens the default", () => {
    fs.writeFileSync(path.join(repo, ".den.yml"), "name: shop\n");
    const ov = path.join(held, "shop.override.yml");
    fs.writeFileSync(
      ov,
      "review:\n  rules:\n    - name: default\n      match: { authors: any }\n",
    );
    expect(errors()).toEqual([]);
    fs.writeFileSync(ov, "review:\n  rules: []\n");
    expect(errors()).toEqual([
      'shop.override.yml: an override can only tighten review rules: removes the rule "default"',
    ]);
  });

  it("the rules that apply are the base branch's, never the PR head's", () => {
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "add",
      ".",
    );
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "base",
    );
    git("checkout", "-q", "-b", "pr");
    // The PR turns its own review off.
    fs.writeFileSync(
      path.join(repo, ".den.yml"),
      "name: shop\nreview:\n  rules: []\n",
    );
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qam",
      "no review",
    );
    const at = reviewAt(repo, "main")!;
    expect(at.file).toBe(".den.yml");
    expect(
      names(matchReview(at.review, pr({ paths: ["src/core/a.ts"] }))),
    ).toEqual(["core"]);
    expect(reviewAt(repo, "no-such-ref")).toBeNull();
    // A base with no manifest file: no section, so the default applies.
    git("checkout", "-q", "--orphan", "bare");
    git("rm", "-rqf", ".");
    fs.writeFileSync(path.join(repo, "README.md"), "x\n");
    git("add", "README.md");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "bare",
    );
    expect(reviewAt(repo, "bare")).toEqual({ file: null, review: undefined });
  });
});
