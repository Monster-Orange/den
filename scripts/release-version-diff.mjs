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
 *   - CHANGELOG.md: new lines, and its "## [<version>] - unreleased"
 *     heading dated.
 * Every other file, and every other change, was never tested: a refusal
 * names it (as ::error::). Exit 0: only the version; 1: more; 2: bad
 * arguments.
 */
import { execFileSync } from "child_process";

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
      const diff = git(
        "diff",
        "--unified=0",
        "--no-color",
        dev,
        head,
        "--",
        f,
      ).split("\n");
      const cut = diff.filter((l) => l.startsWith("-") && !l.startsWith("---"));
      const added = diff.filter(
        (l) => l.startsWith("+") && !l.startsWith("+++"),
      );
      const esc = version.replace(/\./g, "\\.");
      const heading = new RegExp(`^-## \\[${esc}\\] - unreleased$`);
      const dated = new RegExp(`^\\+## \\[${esc}\\] - \\d{4}-\\d{2}-\\d{2}$`);
      const ok =
        cut.length === 0 ||
        (cut.length === 1 &&
          heading.test(cut[0]) &&
          added.some((l) => dated.test(l)));
      if (!ok)
        problems.push(
          `${f} loses or rewrites lines (only new lines, and its heading's date)`,
        );
    } else problems.push(`${f} isn't a version file`);
  } catch (e) {
    problems.push(
      `${f} couldn't be read as JSON (${String(e.message ?? e).split("\n")[0]})`,
    );
  }
}

for (const p of problems) console.log(`::error::${p}`);
if (problems.length) {
  console.log(
    `::error::${head} changes more than the version since ${dev}. Those changes weren't tested: cut a new dev tag`,
  );
  process.exit(1);
}
