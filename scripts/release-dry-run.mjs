#!/usr/bin/env node
/**
 * The release dry run on every dev tag (issue 615, CONTRIBUTING › Releasing).
 *
 *   node scripts/release-dry-run.mjs plan <tag>
 *     The versions the release will carry, as GITHUB_OUTPUT lines on stdout
 *     (den=, kit=, date=); notes on stderr.
 *     - den: the tag's version without -dev.N (v1.2.3-dev.4 → 1.2.3).
 *     - kit: packages/den-ui's own version. It is decided in the candidate,
 *       never in the release commit: when npm already has that version and
 *       the kit changed since the commit npm's copy was built from, it fails
 *       and says to bump the kit's version in the candidate (the rule is
 *       scripts/kit-version.mjs's, which CI and the release run too).
 *       When the release publishes the kit and next/queue has the same kit
 *       version with other kit files, it fails and says to bump next/queue's
 *       den-ui first (issue 1508).
 *     Exit 0: planned. 1: the kit's rule, or npm answered with an error
 *     other than a 404. 2: bad arguments.
 *
 *   node scripts/release-dry-run.mjs apply <den> <kit> <date>
 *     The release commit's edits, in the working tree (the runner's copy
 *     only): package.json, package-lock.json (lines 3 and 9, and the kit's
 *     entry), examples/distribution/package.json's dependency on Den,
 *     packages/den-ui/package.json, the changelog entry (fragments in, dated).
 *     Exit 0: applied. 1: a file lacks a line it edits (named). 2: bad
 *     arguments.
 */
import * as fs from "node:fs";
import {
  FRAGMENT_DIR,
  FragmentError,
  assemble,
  fragmentsOnDisk,
} from "./changelog-fragments.mjs";
import {
  checkKit,
  checkKitQueue,
  KIT_DIR,
  KIT_PKG,
  KitError,
} from "./kit-version.mjs";

const SEMVER = /^\d+\.\d+\.\d+$/;

class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const note = (s) => process.stderr.write(s + "\n");

/** The kit's version (scripts/kit-version.mjs): its rule failing stops the plan. */
function kitVersion() {
  try {
    const kit = checkKit();
    // Issue 1508: a published kit carries next/queue's files at its version.
    if (kit.publish) checkKitQueue({ version: kit.version });
    return kit.version;
  } catch (e) {
    if (e instanceof KitError) throw new Stop(1, e.message);
    throw e;
  }
}

function plan(tag) {
  const m = /^v(\d+\.\d+\.\d+)-dev\.\d+$/.exec(tag ?? "");
  if (!m)
    throw new Stop(2, `::error::usage: plan v<X.Y.Z>-dev.<N> (got ${tag})`);
  const den = m[1];
  const own = readJson("package.json").version;
  if (own.replace(/-.*$/, "") !== den)
    note(
      `::warning::package.json says ${own}; the tag ${tag} says ${den}: the dry run uses ${den}`,
    );
  const kit = kitVersion();
  const date = new Date().toISOString().slice(0, 10);
  process.stdout.write(`den=${den}\nkit=${kit}\ndate=${date}\n`);
  note(
    `release dry run of ${tag}: Den ${den}, kit ${kit}, changelog dated ${date}`,
  );
}

/** Replaces the version on the first line matching `line` after the first line matching `after` (if given). */
function setLine(file, text, { after, line, to, what }) {
  const lines = text.split("\n");
  let i = 0;
  if (after) {
    i = lines.findIndex((l) => after.test(l));
    if (i < 0) throw new Stop(1, `::error::${file}: no ${what}`);
  }
  const at = lines.findIndex((l, n) => n >= i && line.test(l));
  if (at < 0) throw new Stop(1, `::error::${file}: no ${what}`);
  lines[at] = lines[at].replace(line, (_m, head) => `${head}${to}"`);
  return lines.join("\n");
}

const VERSION_AT = (indent) => new RegExp(`^(${indent}"version": ")[^"]*"`);

function apply(den, kit, date) {
  if (
    !SEMVER.test(den ?? "") ||
    !SEMVER.test(kit ?? "") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")
  )
    throw new Stop(
      2,
      "::error::usage: apply <den X.Y.Z> <kit X.Y.Z> <date YYYY-MM-DD>",
    );
  const name = readJson("package.json").name;
  const kitName = readJson(KIT_PKG).name;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const edits = {
    "package.json": (t) =>
      setLine("package.json", t, {
        line: VERSION_AT("  "),
        to: den,
        what: "version",
      }),
    "package-lock.json": (t) => {
      t = setLine("package-lock.json", t, {
        line: VERSION_AT("  "),
        to: den,
        what: "version (line 3)",
      });
      t = setLine("package-lock.json", t, {
        after: /^ {4}"": \{$/,
        line: VERSION_AT("      "),
        to: den,
        what: 'packages[""].version (line 9)',
      });
      return setLine("package-lock.json", t, {
        after: new RegExp(`^ {4}"${esc(KIT_DIR)}": \\{$`),
        line: VERSION_AT("      "),
        to: kit,
        what: `packages["${KIT_DIR}"].version`,
      });
    },
    "examples/distribution/package.json": (t) =>
      setLine("examples/distribution/package.json", t, {
        line: new RegExp(`^(\\s*"${esc(name)}": ")[^"]*"`),
        to: den,
        what: `dependency on ${name}`,
      }),
    [KIT_PKG]: (t) =>
      setLine(KIT_PKG, t, { line: VERSION_AT("  "), to: kit, what: "version" }),
  };
  // every edit first, then every write: a failed one leaves the tree as it was
  const out = {};
  for (const [file, edit] of Object.entries(edits))
    out[file] = edit(fs.readFileSync(file, "utf8"));
  let fragments;
  try {
    fragments = fragmentsOnDisk();
  } catch (e) {
    if (e instanceof FragmentError) throw new Stop(1, `::error::${e.message}`);
    throw e;
  }
  const log = assemble(
    fs.readFileSync("CHANGELOG.md", "utf8"),
    fragments,
    den,
    date,
  );
  if (log !== null) out["CHANGELOG.md"] = log;
  else
    note(
      `::warning::CHANGELOG.md has no "## [${den}] - unreleased" entry and ${FRAGMENT_DIR}/ has no fragment: its date is left as it is`,
    );
  for (const [file, t] of Object.entries(out)) fs.writeFileSync(file, t);
  for (const f of fragments) fs.rmSync(f.file);
  if (fragments.length)
    note(`CHANGELOG.md: ${fragments.length} fragment(s) assembled and removed`);
  // what the release commit would carry
  const lock = readJson("package-lock.json");
  const got = {
    "package.json": readJson("package.json").version,
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': lock.packages?.[""]?.version,
    [`package-lock.json packages["${KIT_DIR}"]`]:
      lock.packages?.[KIT_DIR]?.version,
    "examples/distribution/package.json": readJson(
      "examples/distribution/package.json",
    ).dependencies?.[name],
    [KIT_PKG]: readJson(KIT_PKG).version,
  };
  for (const [where, v] of Object.entries(got)) note(`${where}: ${v}`);
  note(`release dry run: Den ${den}, ${kitName} ${kit}`);
}

try {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "plan") plan(args[0]);
  else if (cmd === "apply") apply(args[0], args[1], args[2]);
  else
    throw new Stop(
      2,
      "::error::usage: release-dry-run.mjs plan <tag> | apply <den> <kit> <date>",
    );
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  process.stderr.write(e.message + "\n");
  process.exit(e.code);
}
