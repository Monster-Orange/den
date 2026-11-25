#!/usr/bin/env node
/**
 * The kit's version rule (CONTRIBUTING › Releasing): a change to the UI kit
 * (packages/den-ui) bumps the kit's version.
 *
 *   node scripts/kit-version.mjs
 *     Notes on stderr; GITHUB_OUTPUT lines on stdout: version=<the kit's
 *     version>, go=yes when the release publishes it, else go=no.
 *     Exit 0: the rule holds. 1: it doesn't (the message says what to do),
 *     or npm answered with an error other than a 404.
 *
 * It fails when packages/den-ui changed since the commit npm's copy of the
 * kit's version was built from (npm's gitHead; without one, or one this
 * history lacks, the commit that set the version) while npm has that
 * version: the release would skip publishing it, and the change would
 * never reach the kit's npm users. A prerelease, or a version npm doesn't
 * have yet, passes. The kit's package.json and its package-lock.json entry
 * must agree.
 *
 * CI's checks run it on every pull request; the release's den-ui job
 * decides with it; the release dry run (scripts/release-dry-run.mjs plan)
 * calls checkKit. It needs the whole history (checkout's fetch-depth: 0).
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

export const KIT_DIR = "packages/den-ui";
export const KIT_PKG = `${KIT_DIR}/package.json`;

/** The rule doesn't hold, or npm couldn't say: the message is the ::error:: line. */
export class KitError extends Error {}

const BUMP =
  `Bump ${KIT_PKG}'s version and its package-lock.json entry ("${KIT_DIR}") together, ` +
  `in this change (CONTRIBUTING › Releasing)`;

/** The real npm and git calls, in the current directory. */
export function realDeps() {
  return {
    readJson: (f) => JSON.parse(fs.readFileSync(f, "utf8")),
    /** npm view <spec> <field>: the value, or null on a 404. Any other error throws. */
    npmView(spec, field) {
      const r = spawnSync("npm", ["view", spec, field], { encoding: "utf8" });
      if (r.status === 0) return r.stdout.trim();
      if (/E404/.test(r.stderr ?? "")) return null;
      throw new KitError(
        `::error::npm view ${spec} ${field} failed (not a 404): ${(r.stderr ?? "").trim()}`,
      );
    },
    git: (...args) => execFileSync("git", args, { encoding: "utf8" }).trim(),
    isCommit: (sha) =>
      spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`]).status === 0,
    isShallow: () =>
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        encoding: "utf8",
      }).trim() === "true",
    note: (s) => process.stderr.write(s + "\n"),
  };
}

/**
 * The kit's version, and whether the release publishes it.
 * Throws KitError when the rule doesn't hold.
 * @returns {{ version: string, publish: boolean }}
 */
export function checkKit(deps = realDeps()) {
  const { readJson, npmView, git, isCommit, isShallow, note } = deps;
  const kit = readJson(KIT_PKG);
  const v = kit.version;
  const locked = readJson("package-lock.json").packages?.[KIT_DIR]?.version;
  if (locked !== v)
    throw new KitError(
      `::error::${KIT_PKG} says ${v}, package-lock.json's "${KIT_DIR}" says ${locked}. ${BUMP}.`,
    );
  if (v.includes("-")) {
    note(`kit ${v} is a prerelease: the release never publishes it`);
    return { version: v, publish: false };
  }
  if (npmView(kit.name, "name") === null) {
    note(`${kit.name} isn't on npm yet: its first publish is by hand`);
    return { version: v, publish: false };
  }
  if (npmView(`${kit.name}@${v}`, "version") !== v) {
    note(`the release publishes ${kit.name}@${v} (npm doesn't have it yet)`);
    return { version: v, publish: true };
  }
  // npm has this version: the kit must not have changed since then.
  if (isShallow())
    throw new KitError(
      `::error::${kit.name}@${v} is on npm, and this clone is shallow: the commit npm's copy was built from ` +
        `may not be in it. Check out the whole history (actions/checkout with fetch-depth: 0).`,
    );
  let base = npmView(`${kit.name}@${v}`, "gitHead") || "";
  let from = `the commit npm's copy was built from (${base.slice(0, 9)})`;
  if (!base || !isCommit(base)) {
    base = git("log", "-1", "--format=%H", "-G", '"version"', "--", KIT_PKG);
    from = `the commit that set ${v} (${base.slice(0, 9)})`;
  }
  if (!base)
    throw new KitError(
      `::error::${kit.name}@${v} is on npm, but no commit here built it or set ${v} in ${KIT_PKG}: ` +
        `can't tell whether the kit changed since.`,
    );
  const changed = git("diff", "--name-only", base, "HEAD", "--", KIT_DIR);
  if (changed)
    throw new KitError(
      `::error::${KIT_DIR} changed since ${from}, but its version ${v} is on npm already, ` +
        `so the release would skip publishing the change. ${BUMP}. ` +
        `Changed: ${changed.split("\n").join(", ")}`,
    );
  note(
    `${kit.name}@${v} is on npm and the kit is unchanged since: nothing new to publish`,
  );
  return { version: v, publish: false };
}

/** next/queue, as a full clone (fetch-depth: 0) has it. KIT_QUEUE_REF sets another. */
export const QUEUE_REF = "origin/next/queue";

/** git's answer, or null when git refuses (a ref or path that isn't there). */
function gitOr(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Issue 1508: a release that publishes the kit at `version` from `ref`
 * must carry next/queue's kit files when next/queue has that same version:
 * otherwise npm's copy of the version lacks next/queue's change, and every
 * pull request after fails the kit's rule. Throws KitError naming the files
 * that differ. next/queue missing from the clone: in CI (GITHUB_ACTIONS) it
 * fails rather than guess; elsewhere it is a note.
 */
export function checkKitQueue({
  version,
  ref = "HEAD",
  queue = process.env.KIT_QUEUE_REF || QUEUE_REF,
  ci = process.env.GITHUB_ACTIONS === "true",
  note = (s) => process.stderr.write(s + "\n"),
}) {
  if (gitOr(["rev-parse", "-q", "--verify", `${queue}^{commit}`]) === null) {
    if (ci)
      throw new KitError(
        `::error::${queue} isn't in this clone, so the kit can't be checked against next/queue's ` +
          `before it is published. Check out the whole history (actions/checkout with fetch-depth: 0).`,
      );
    note(`${queue} isn't here: the kit isn't checked against next/queue's`);
    return;
  }
  const raw = gitOr(["show", `${queue}:${KIT_PKG}`]);
  let theirs = null;
  try {
    theirs = raw === null ? null : JSON.parse(raw).version;
  } catch {
    theirs = null;
  }
  if (theirs !== version) {
    note(
      `next/queue's kit is at ${theirs ?? "none"}, not ${version}: nothing to compare`,
    );
    return;
  }
  const changed = gitOr(["diff", "--name-only", ref, queue, "--", KIT_DIR]);
  if (changed === null)
    throw new KitError(
      `::error::git couldn't compare ${KIT_DIR} at ${ref} and ${queue}`,
    );
  if (changed)
    throw new KitError(
      `::error::next/queue has ${KIT_DIR} at ${version} too, with other files, so npm's ${version} ` +
        `would lack them and every pull request after would fail the kit's rule. ` +
        `So bump next/queue's den-ui before promoting (CONTRIBUTING › Releasing). Different: ${changed.split("\n").join(", ")}`,
    );
  note(
    `next/queue's kit at ${version} is the same: it is published as next/queue has it`,
  );
}

/** The GITHUB_OUTPUT lines for a checkKit result. */
export const githubOutput = ({ version, publish }) =>
  `version=${version}\ngo=${publish ? "yes" : "no"}\n`;

/**
 * `node scripts/kit-version.mjs queue <commit>` (release-promote.sh): the
 * kit at <commit> against next/queue's, when the release publishes it (npm
 * doesn't have that version yet). No kit at <commit>: nothing to check.
 */
function kitQueueCli(ref) {
  if (!ref)
    throw new KitError("::error::usage: kit-version.mjs queue <commit>");
  const raw = gitOr(["show", `${ref}:${KIT_PKG}`]);
  if (raw === null) {
    process.stderr.write(`no ${KIT_PKG} at ${ref}: no kit to check\n`);
    return;
  }
  const { name, version } = JSON.parse(raw);
  if (realDeps().npmView(`${name}@${version}`, "version") === version) {
    process.stderr.write(
      `${name}@${version} is on npm: the release doesn't publish it\n`,
    );
    return;
  }
  checkKitQueue({ version, ref });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [cmd, ref] = process.argv.slice(2);
    if (cmd === "queue") kitQueueCli(ref);
    else process.stdout.write(githubOutput(checkKit()));
  } catch (e) {
    if (!(e instanceof KitError)) throw e;
    process.stderr.write(e.message + "\n");
    process.exit(1);
  }
}
