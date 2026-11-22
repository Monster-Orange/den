#!/usr/bin/env node
/**
 * Vision 11-22: an issue (897) closed itself through a commit's closing
 * keyword, with no proof it worked. In Den an issue closes only with a
 * live-proof comment, so a pull request's title, body and commits may not
 * carry a GitHub closing keyword (close, fix or resolve, in any tense,
 * before #N, owner/repo#N or an issue URL). They say "Refs #N".
 *
 *   PR_TITLE=… PR_BODY=… node scripts/no-close-keywords.mjs [<base>..<head>]
 *
 * The title and body are always checked. A commit already on a shared
 * branch (origin/next/*, origin/release/*) is not: it landed before.
 *
 * Exits 1 with each hit and where it is.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REF = String.raw`(?:[\w.-]+\/[\w.-]+)?#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+`;
const KEYWORD = new RegExp(
  String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \t]+(?:${REF})`,
  "gi",
);

/** The closing keywords in a text, as written. */
export function closingRefs(text) {
  return [...String(text ?? "").matchAll(KEYWORD)].map((m) => m[0]);
}

const RULE = "use Refs #N; issues close only with a live-proof comment";

function main() {
  const hits = [];
  for (const [where, text] of [
    ["pull request title", process.env.PR_TITLE],
    ["pull request body", process.env.PR_BODY],
  ])
    for (const h of closingRefs(text)) hits.push(`${where}: ${h}`);
  const range = process.argv[2];
  if (range) {
    const git = (...a) => execFileSync("git", a, { encoding: "utf-8" });
    // Builder 2, 11-22: a release PR (next/queue into main) carries commits
    // that landed before, and history is never rewritten. Not checked: a
    // commit already on another shared branch (origin/next/*, release/*;
    // the PR's own head branch never counts, so a fresh release/x can't
    // skip its own commits), or one older than the commit that added this
    // script (the rule's start, read from the history, so no date to keep).
    const headRef = (process.env.PR_HEAD_REF ?? "").trim();
    const shared = git(
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes/origin/next/",
      "refs/remotes/origin/release/",
    )
      .split("\n")
      .filter((r) => r && r !== `refs/remotes/origin/${headRef}`);
    const tip = range.split("..")[1] || "HEAD";
    const added = git(
      "log",
      tip,
      "--diff-filter=A",
      "--format=%ct",
      "--",
      "scripts/no-close-keywords.mjs",
    )
      .split("\n")
      .filter(Boolean)
      .map(Number);
    const since = added.length ? Math.min(...added) : 0;
    const all = git("rev-list", "--count", range).trim();
    const log = git(
      "log",
      "--format=%H%x00%ct%x00%B%x01",
      range,
      ...(shared.length ? ["--not", ...shared] : []),
    );
    const fresh = log.split("\x01").filter((e) => e.trim());
    const onShared = Number(all) - fresh.length;
    const plural = (n) => `${n} commit${n === 1 ? "" : "s"}`;
    if (onShared > 0)
      console.log(
        `${plural(onShared)} already on a shared branch, not checked`,
      );
    const old = fresh.filter((e) => Number(e.trim().split("\0")[1]) < since);
    if (old.length)
      console.log(`${plural(old.length)} from before this check, not checked`);
    for (const entry of fresh) {
      const [sha, ct, body] = entry.trim().split("\0");
      if (!sha || Number(ct) < since) continue;
      for (const h of closingRefs(body))
        hits.push(`commit ${sha.slice(0, 8)}: ${h}`);
    }
  }
  if (hits.length) {
    for (const h of hits) console.error(`closing keyword in the ${h}`);
    console.error(
      `::error::A closing keyword closes the issue with no proof: ${RULE}.`,
    );
    process.exit(1);
  }
  console.log("no closing keywords");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
