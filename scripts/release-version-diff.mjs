#!/usr/bin/env node
/**
 * Issue 922: does <commit> change only the version since <dev commit>?
 *
 *   node scripts/release-version-diff.mjs <dev commit> <commit> <version>
 *
 * Allowed, and nothing else:
 *   - package.json: its "version" (to <version>);
 *   - package-lock.json: the root's "version" and packages[""].version;
 *   - the example distribution's package.json ($RELEASE_EXAMPLE, default
 *     examples/distribution/package.json): its pin of this package;
 *   - CHANGELOG.md: what release-dry-run.mjs apply makes of the dev tag's
 *     changelog and changes/ fragments, each fragment then removed.
 * Every other file, and every other change, was never tested: a refusal
 * names it (as ::error::). Exit 0: only the version; 1: more; 2: bad
 * arguments.
 */
import { execFileSync } from "child_process";
import {
  FRAGMENT_DIR,
  FragmentError,
  assemble,
  isFragmentPath,
  parseFragments,
} from "./changelog-fragments.mjs";

const [dev, head, version] = process.argv.slice(2);
if (!dev || !head || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(
    "::error::usage: release-version-diff.mjs <dev commit> <commit> <version>",
  );
  process.exit(2);
}
const EXAMPLE =
  process.env.RELEASE_EXAMPLE || "examples/distribution/package.json";
const git = (...a) =>
  execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 });
const show = (c, f) => JSON.parse(git("show", `${c}:${f}`));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const problems = [];
const list = (c) =>
  git("ls-tree", "-r", "--name-only", c, "--", `${FRAGMENT_DIR}/`)
    .split("\n")
    .filter((f) => f && isFragmentPath(f));
const present = (c, f) => list(c).includes(f);
let parsed = null;
const devFragments = () =>
  (parsed ??= parseFragments(
    list(dev).map((file) => ({ file, text: git("show", `${dev}:${file}`) })),
  ));

const changed = git("diff", "--name-only", "-z", "--no-renames", dev, head)
  .split("\0")
  .filter(Boolean);

let name = "";
try {
  name = show(head, "package.json").name;
} catch {
  /* reported below */
}

for (const f of changed) {
  try {
    if (f === "package.json") {
      const a = show(dev, f);
      const b = show(head, f);
      if (b.version !== version)
        problems.push(`${f}: its version isn't ${version}`);
      delete a.version;
      delete b.version;
      if (!same(a, b)) problems.push(`${f} changes more than its version`);
    } else if (f === "package-lock.json") {
      const a = show(dev, f);
      const b = show(head, f);
      for (const x of [a, b]) {
        delete x.version;
        if (x.packages?.[""]) delete x.packages[""].version;
      }
      if (!same(a, b))
        problems.push(`${f} changes more than ${name}'s own version`);
    } else if (f === EXAMPLE) {
      const a = show(dev, f);
      const b = show(head, f);
      if (b.dependencies?.[name] !== version)
        problems.push(`${f}: its pin of ${name} isn't ${version}`);
      for (const x of [a, b]) if (x.dependencies) delete x.dependencies[name];
      if (!same(a, b))
        problems.push(`${f} changes more than its pin of ${name}`);
    } else if (f === "CHANGELOG.md") {
      const log = git("show", `${head}:${f}`);
      const date = new RegExp(
        `^## \\[${version.replace(/\./g, "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})$`,
        "m",
      ).exec(log)?.[1];
      const want = date
        ? assemble(git("show", `${dev}:${f}`), devFragments(), version, date)
        : null;
      if (want !== log)
        problems.push(
          `${f} isn't the dev tag's changelog with its ${FRAGMENT_DIR}/ fragments assembled under a dated "## [${version}]" (release-dry-run.mjs apply makes it)`,
        );
    } else if (isFragmentPath(f) && !present(head, f)) {
      continue;
    } else problems.push(`${f} isn't a version file`);
  } catch (e) {
    if (e instanceof FragmentError) {
      problems.push(e.message);
      continue;
    }
    problems.push(
      `${f} couldn't be read as JSON (${String(e.message ?? e).split("\n")[0]})`,
    );
  }
}

for (const f of list(head))
  problems.push(
    `${f}: the version commit assembles every fragment into CHANGELOG.md and removes it (release-dry-run.mjs apply)`,
  );
if (list(dev).length && !changed.includes("CHANGELOG.md"))
  problems.push(
    `CHANGELOG.md: the dev tag has ${FRAGMENT_DIR}/ fragments, and the version commit doesn't assemble them`,
  );

for (const p of problems) console.log(`::error::${p}`);
if (problems.length) {
  console.log(
    `::error::${head} changes more than the version since ${dev}. Those changes weren't tested: cut a new dev tag`,
  );
  process.exit(1);
}
