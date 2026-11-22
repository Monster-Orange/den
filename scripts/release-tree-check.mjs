#!/usr/bin/env node
/**
 * Issue 996: a release publishes only a tree that was tested, and runs no
 * test suite of its own.
 *
 *   node scripts/release-tree-check.mjs <version>
 *     In release.yml, on the release commit (HEAD), with GH_TOKEN and
 *     GITHUB_REPOSITORY set:
 *     1. The newest dev tag v<version>-dev.N is the candidate that was
 *        tested. HEAD's tree must be that tag's tree with the release's
 *        versions applied (scripts/release-dry-run.mjs apply, with HEAD's
 *        own versions and changelog date): the release commit changes
 *        versions and the date, nothing else.
 *     2. The tag's tree must have a green pull-request ci.yml run, and a
 *        commit with that tree must carry the bed's status (context
 *        DEN_BED_CONTEXT, default den/bed) as success.
 *     Exit 0: tested. 1: not (one line says why). 2: bad arguments.
 *
 * `decide` is the rule, with no network or git: the tests call it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {{ tree: string,
 *   green: { tree: string, sha: string, run: number }[],
 *   statuses: { tree: string, sha: string, context: string, state: string }[],
 *   context: string }} o
 * @returns {{ ok: boolean, line: string }}
 */
export function decide({ tree, green, statuses, context }) {
  const run = green.find((g) => g.tree === tree);
  if (!run)
    return {
      ok: false,
      line: `tree ${tree}: no green pull-request CI run has this tree, so it was never tested`,
    };
  const mine = statuses.filter((s) => s.tree === tree && s.context === context);
  if (mine.some((s) => s.state === "success"))
    return {
      ok: true,
      line: `tree ${tree}: tested (pull-request CI run ${run.run} on ${run.sha.slice(0, 8)}, ${context} success)`,
    };
  if (!mine.length)
    return {
      ok: false,
      line: `tree ${tree}: pull-request CI run ${run.run} passed, but there is no ${context} status on a commit with this tree`,
    };
  return {
    ok: false,
    line: `tree ${tree}: pull-request CI run ${run.run} passed, but ${context} is ${mine.map((s) => s.state).join(", ")}, not success`,
  };
}

const git = (...a) =>
  execFileSync("git", a, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const gh = (p) =>
  JSON.parse(
    execFileSync("gh", ["api", p], { encoding: "utf8", maxBuffer: 64 << 20 }),
  );
const treeOf = (sha) => {
  try {
    return git("rev-parse", `${sha}^{tree}`);
  } catch {
    return null;
  }
};

/** The newest v<version>-dev.N, by N. */
export function newestDevTag(version) {
  const tags = git("tag", "-l", `v${version}-dev.*`)
    .split("\n")
    .filter(Boolean);
  const n = (t) => Number(/-dev\.(\d+)$/.exec(t)?.[1] ?? -1);
  return tags.sort((a, b) => n(b) - n(a))[0] ?? null;
}

/** The tag's tree with HEAD's versions applied, as the release commit makes it. */
export function appliedTree(tag, version) {
  const kit = JSON.parse(
    git("show", "HEAD:packages/den-ui/package.json"),
  ).version;
  const log = git("show", "HEAD:CHANGELOG.md");
  const esc = version.replace(/\./g, "\\.");
  const date = new RegExp(
    `^## \\[${esc}\\] - (\\d{4}-\\d{2}-\\d{2})$`,
    "m",
  ).exec(log)?.[1];
  if (!date)
    return { error: `CHANGELOG.md has no dated "## [${version}]" entry` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-tree-"));
  try {
    git("worktree", "add", "-q", "--detach", dir, `${tag}^{commit}`);
    execFileSync(
      process.execPath,
      [
        path.resolve("scripts/release-dry-run.mjs"),
        "apply",
        version,
        kit,
        date,
      ],
      { cwd: dir, stdio: ["ignore", "ignore", "inherit"] },
    );
    execFileSync("git", ["add", "-A"], { cwd: dir });
    return {
      tree: execFileSync("git", ["write-tree"], {
        cwd: dir,
        encoding: "utf8",
      }).trim(),
    };
  } finally {
    try {
      git("worktree", "remove", "--force", dir);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function main(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    console.error("::error::usage: release-tree-check.mjs <X.Y.Z>");
    return 2;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const context = process.env.DEN_BED_CONTEXT || "den/bed";
  const tag = newestDevTag(version);
  if (!tag) {
    console.error(
      `::error::no dev tag v${version}-dev.N: there is no tested candidate to release`,
    );
    return 1;
  }
  const head = git("rev-parse", "HEAD^{tree}");
  const tagTree = git("rev-parse", `${tag}^{tree}`);
  if (head !== tagTree) {
    const a = appliedTree(tag, version);
    if (a.error || a.tree !== head) {
      console.error(
        `::error::this commit's tree (${head}) isn't ${tag} with the release's versions applied` +
          (a.error ? `: ${a.error}` : ` (that would be ${a.tree})`) +
          ": the release commit may change only the versions and the changelog date",
      );
      return 1;
    }
  }
  console.log(
    `${tag} (${tagTree}) is the tested candidate; this commit only sets the release's versions`,
  );
  const runs = gh(
    `repos/${repo}/actions/workflows/ci.yml/runs?event=pull_request&status=success&per_page=100`,
  ).workflow_runs;
  const green = [];
  for (const r of runs) {
    const tree = r.head_commit?.tree_id ?? treeOf(r.head_sha);
    if (tree) green.push({ tree, sha: r.head_sha, run: r.id });
  }
  const shas = new Set([
    git("rev-parse", `${tag}^{commit}`),
    ...green.filter((g) => g.tree === tagTree).map((g) => g.sha),
  ]);
  const statuses = [];
  for (const sha of shas)
    for (const s of gh(`repos/${repo}/commits/${sha}/status`).statuses ?? [])
      statuses.push({ tree: tagTree, sha, context: s.context, state: s.state });
  const r = decide({ tree: tagTree, green, statuses, context });
  if (r.ok) console.log(r.line);
  else console.error(`::error::${r.line}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv[2]));
