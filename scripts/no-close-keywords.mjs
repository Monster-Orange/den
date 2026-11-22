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
    const log = execFileSync("git", ["log", "--format=%H%x00%B%x01", range], {
      encoding: "utf-8",
    });
    for (const entry of log.split("\x01")) {
      const [sha, body] = entry.trim().split("\0");
      if (!sha) continue;
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
