#!/usr/bin/env node
/**
 * Issue 996: some CI runs always run the whole suite, never only the tests
 * a change affects, because a release may be cut from what they tested:
 *
 * - every merge-queue run (merge_group: the base and the pull request
 *   together, the tree that lands);
 * - a pull request that changes package.json's "version" (a dev-tag or
 *   release version commit).
 *
 *   node scripts/ci-force-all.mjs <event> <base-sha>
 *     Prints "yes" when HEAD's run must be the whole suite, else "no".
 *
 * `forceAll` is the rule; the tests call it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {{ event: string, baseVersion?: string, headVersion?: string }} o */
export function forceAll({ event, baseVersion, headVersion }) {
  if (event === "merge_group") return true;
  return (baseVersion ?? "") !== (headVersion ?? "");
}

function versionAt(sha) {
  try {
    const text = execFileSync("git", ["show", `${sha}:package.json`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(text).version ?? "";
  } catch {
    return "";
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [event, base] = process.argv.slice(2);
  const headVersion = JSON.parse(
    fs.readFileSync("package.json", "utf8"),
  ).version;
  const yes = forceAll({
    event: event ?? "",
    baseVersion: base ? versionAt(base) : "",
    headVersion,
  });
  process.stdout.write(yes ? "yes\n" : "no\n");
}
