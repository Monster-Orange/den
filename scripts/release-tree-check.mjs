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
 *     2. The tag's tree must be the tree a green ci.yml run tested, with the
 *        whole suite, as its `tested` artifact records it: on a pull request
 *        or in the merge queue (merge_group: the base and the pull request
 *        together, the tree that lands). Only this repository's runs, and
 *        only those whose head has the release's own ci.yml.
 *     3. Only when DEN_BED_REQUIRED is "true": a commit with that tree must
 *        carry the bed's status (context DEN_BED_CONTEXT, default den/bed)
 *        as success, posted by DEN_BED_POSTER (default github-actions[bot]:
 *        the bed's own workflow token). Off, the bed's PASS stays as before:
 *        the dev tag and the bed's verdict.
 *     Exit 0: tested. 1: not (one line says why). 2: bad arguments.
 *
 * `decide` is the rule, with no network or git: the tests call it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The bed's poster when DEN_BED_POSTER isn't set: its workflow's GITHUB_TOKEN. */
export const DEFAULT_POSTER = "github-actions[bot]";

/**
 * The rule. A tree is tested when a green ci.yml run (pull request or
 * merge queue) has it. When `required` (DEN_BED_REQUIRED "true"), the bed's
 * status must say so too, and only the bed's own poster counts: `poster`
 * (DEN_BED_POSTER, default github-actions[bot]) is matched exactly but in
 * any case against each status's creator. Every agent on the bed's machine
 * shares one gh login, so a status from any other login proves nothing. Of
 * the poster's statuses on commits with this tree, the newest decides.
 *
 * @param {{ tree: string,
 *   green: { tree: string, sha: string, run: number, event?: string }[],
 *   statuses: { tree: string, sha: string, context: string, state: string,
 *     creator: string, at: string }[],
 *   context: string, poster?: string, required?: boolean }} o
 * @returns {{ ok: boolean, line: string }}
 */
export function decide({ tree, green, statuses, context, poster, required }) {
  // `tree` is the tree each run's `tested` artifact recorded: what CI
  // checked out (a pull request's merge with its base), not the head's.
  const same = green.filter((g) => g.tree === tree);
  if (!same.length)
    return {
      ok: false,
      line: `tree ${tree}: no green pull-request or merge-queue CI run recorded this tree as tested, so it was never tested (only the newest 100 runs per event are searched)`,
    };
  const run = same.find((g) => g.selection === "all");
  if (!run)
    return {
      ok: false,
      line: `tree ${tree}: green CI run(s) ${same.map((g) => g.run).join(", ")} ran only the affected tests, not the full suite`,
    };
  const ran = `${run.event === "merge_group" ? "merge_group" : "pull-request CI"} run ${run.run} attempt ${run.attempt ?? 1} on ${run.sha.slice(0, 8)}`;
  if (!required)
    return {
      ok: true,
      line: `tree ${tree}: tested (${ran}; the bed's ${context} status isn't required: DEN_BED_REQUIRED isn't "true")`,
    };
  poster = (poster ?? "").trim() || DEFAULT_POSTER;
  const who = poster.toLowerCase();
  const mine = statuses
    .filter(
      (s) =>
        s.tree === tree &&
        s.context === context &&
        String(s.creator ?? "").toLowerCase() === who,
    )
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!mine.length)
    return {
      ok: false,
      line: `tree ${tree}: ${ran} passed, but there is no ${context} status from ${poster} on a commit with this tree`,
    };
  const newest = mine[0];
  if (newest.state === "success")
    return {
      ok: true,
      line: `tree ${tree}: tested (${ran}, ${context} success from ${poster} on ${newest.sha.slice(0, 8)})`,
    };
  return {
    ok: false,
    line: `tree ${tree}: ${ran} passed, but ${poster}'s newest ${context} is ${newest.state}, not success`,
  };
}

/**
 * The green runs whose `tested` artifact may count for `tree`:
 * - ci.yml's own runs (by path), with `tree` at their head (on a pull
 *   request the tested tree is the merge with its base, so the artifact
 *   decides; this only narrows what is downloaded);
 * - from this repository, never a fork;
 * - whose head has the release's own ci.yml (`ci_blob`, attached by the
 *   caller): the workflow that wrote the artifact is the release's.
 *
 * @param {object[]} runs @param {string} tree
 * @param {{ repo: string, ciBlob: string }} o
 */
export function candidates(runs, tree, { repo, ciBlob }) {
  return runs.filter(
    (r) =>
      r.path === ".github/workflows/ci.yml" &&
      r.head_commit?.tree_id === tree &&
      String(r.head_repository?.full_name ?? "").toLowerCase() ===
        String(repo).toLowerCase() &&
      !!r.ci_blob &&
      r.ci_blob === ciBlob,
  );
}

/**
 * A run's entry, from its `tested` artifact (tested.json): null when there
 * is none, or it names no tree. A run with no artifact doesn't count.
 */
export function entryOf(run, tested) {
  if (!tested || typeof tested.tree !== "string" || !tested.tree) return null;
  return {
    tree: tested.tree,
    sha: run.head_sha,
    run: run.id,
    attempt: Number(tested.attempt ?? run.run_attempt ?? 1),
    selection: tested.selection === "all" ? "all" : "affected",
    event: String(tested.event ?? ""),
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
/** ci.yml's blob at `sha`, fetching the commit when it isn't here; null if none. */
function blobAt(sha) {
  try {
    git("cat-file", "-e", `${sha}^{commit}`);
  } catch {
    try {
      git("fetch", "-q", "origin", sha);
    } catch {
      return null;
    }
  }
  try {
    return git("rev-parse", `${sha}:.github/workflows/ci.yml`);
  } catch {
    return null;
  }
}

/** A run's `tested` artifact (tested.json), parsed; null when it has none. */
function testedOf(repo, runId) {
  // the newest: a re-run's attempt writes its own
  const art = (
    gh(`repos/${repo}/actions/runs/${runId}/artifacts?name=tested`).artifacts ??
    []
  )
    .filter((a) => a.name === "tested" && !a.expired)
    .sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    )[0];
  if (!art) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tested-"));
  try {
    const zip = path.join(dir, "tested.zip");
    fs.writeFileSync(
      zip,
      execFileSync(
        "gh",
        ["api", `repos/${repo}/actions/artifacts/${art.id}/zip`],
        {
          maxBuffer: 16 << 20,
        },
      ),
    );
    return JSON.parse(
      execFileSync("unzip", ["-p", zip, "tested.json"], { encoding: "utf8" }),
    );
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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
        // Beside this script, never the checkout's: a release runs main's
        // copy against the promoted tree (issue 922).
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "release-dry-run.mjs",
        ),
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
  // A pull request's run, or the merge queue's (the base and the pull
  // request together: the tree that lands). Each counts by what its own
  // `tested` artifact recorded, never by its head's tree.
  const ciBlob = blobAt("HEAD");
  const green = [];
  for (const event of ["pull_request", "merge_group"]) {
    const runs = gh(
      `repos/${repo}/actions/workflows/ci.yml/runs?event=${event}&status=success&per_page=100`,
    ).workflow_runs;
    // only runs whose head has the tree are worth a ci.yml lookup
    for (const r of runs)
      if (r.head_commit?.tree_id === tagTree) r.ci_blob = blobAt(r.head_sha);
    for (const r of candidates(runs, tagTree, { repo, ciBlob })) {
      const e = entryOf(r, testedOf(repo, r.id));
      if (e) green.push(e);
    }
  }
  const required = process.env.DEN_BED_REQUIRED === "true";
  const shas = new Set([
    git("rev-parse", `${tag}^{commit}`),
    ...green.filter((g) => g.tree === tagTree).map((g) => g.sha),
  ]);
  // Every status, with who made it: the combined /status keeps only the
  // newest per context, from anyone, which would hide the poster's own.
  const statuses = [];
  if (required)
    for (const sha of shas)
      for (const s of gh(`repos/${repo}/commits/${sha}/statuses?per_page=100`))
        statuses.push({
          tree: tagTree,
          sha,
          context: s.context,
          state: s.state,
          creator: s.creator?.login ?? "",
          at: s.created_at,
        });
  const r = decide({
    tree: tagTree,
    green,
    statuses,
    context,
    poster: process.env.DEN_BED_POSTER,
    required,
  });
  if (r.ok) console.log(r.line);
  else console.error(`::error::${r.line}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv[2]));
