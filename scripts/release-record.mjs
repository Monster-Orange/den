#!/usr/bin/env node
/**
 * Issue 922: what a release says it was built from.
 *
 *   node scripts/release-record.mjs json <version> <dev tag> <dev commit> <commit>
 *     writes ./release.json (it ships in the package): the version, the dev
 *     tag that passed its test bed, that tag's commit, and the release's own
 *     commit (the dev tag's tree plus the version files).
 *   node scripts/release-record.mjs sums <dir> <dev tag> <dev commit>
 *     adds one line to <dir>/SHA256SUMS naming the dev tag and its commit.
 *     It starts with "#", so a checksum check passes over it.
 *
 * Exits 2 on a bad argument, with nothing written.
 */
import * as fs from "fs";
import * as path from "path";

const SHA = /^[0-9a-f]{40}$/;
const DEV_TAG = /^v\d+\.\d+\.\d+-dev\.\d+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

function bad(why) {
  console.error(`release-record: ${why}`);
  process.exit(2);
}

const [cmd, ...a] = process.argv.slice(2);
if (cmd === "json") {
  const [version, devTag, devCommit, commit] = a;
  if (!VERSION.test(version ?? "")) bad(`not a release version: ${version}`);
  if (!DEV_TAG.test(devTag ?? "")) bad(`not a dev tag: ${devTag}`);
  if (!SHA.test(devCommit ?? "")) bad(`not a commit: ${devCommit}`);
  if (!SHA.test(commit ?? "")) bad(`not a commit: ${commit}`);
  fs.writeFileSync(
    "release.json",
    JSON.stringify({ version, devTag, devCommit, commit }, null, 2) + "\n",
  );
} else if (cmd === "sums") {
  const [dir, devTag, devCommit] = a;
  if (!dir || !fs.existsSync(path.join(dir, "SHA256SUMS")))
    bad(`no SHA256SUMS in ${dir}`);
  if (!DEV_TAG.test(devTag ?? "")) bad(`not a dev tag: ${devTag}`);
  if (!SHA.test(devCommit ?? "")) bad(`not a commit: ${devCommit}`);
  fs.appendFileSync(
    path.join(dir, "SHA256SUMS"),
    `# built from ${devTag}, commit ${devCommit}\n`,
  );
} else bad("usage: release-record.mjs json|sums …");
