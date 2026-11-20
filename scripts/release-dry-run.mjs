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
 *       and says to bump the kit's version in the candidate.
 *     Exit 0: planned. 1: the kit's rule, or npm answered with an error
 *     other than a 404. 2: bad arguments.
 *
 *   node scripts/release-dry-run.mjs apply <den> <kit> <date>
 *     The release commit's edits, in the working tree (the runner's copy
 *     only): package.json, package-lock.json (lines 3 and 9, and the kit's
 *     entry), examples/distribution/package.json's dependency on Den,
 *     packages/den-ui/package.json, and the changelog entry's date.
 *     Exit 0: applied. 1: a file lacks a line it edits (named). 2: bad
 *     arguments.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";

const KIT_DIR = "packages/den-ui";
const KIT_PKG = `${KIT_DIR}/package.json`;
const SEMVER = /^\d+\.\d+\.\d+$/;

class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const note = (s) => process.stderr.write(s + "\n");

/** npm view <spec> <field>: the value, or null on a 404. Any other error stops. */
function npmView(spec, field) {
  const r = spawnSync("npm", ["view", spec, field], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim();
  if (/E404/.test(r.stderr ?? "")) return null;
  throw new Stop(
    1,
    `::error::npm view ${spec} ${field} failed (not a 404): ${(r.stderr ?? "").trim()}`,
  );
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const isCommit = (sha) =>
  spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`]).status === 0;

function kitVersion() {
  const kit = readJson(KIT_PKG);
  const v = kit.version;
  const lock = readJson("package-lock.json");
  const locked = lock.packages?.[KIT_DIR]?.version;
  if (locked !== v)
    throw new Stop(
      1,
      `::error::${KIT_PKG} says ${v}, package-lock.json's "${KIT_DIR}" says ${locked}: bump both together in the candidate`,
    );
  if (v.includes("-")) {
    note(`kit ${v} is a prerelease: the release never publishes it`);
    return v;
  }
  if (npmView(kit.name, "name") === null) {
    note(`${kit.name} isn't on npm yet: its first publish is by hand`);
    return v;
  }
  if (npmView(`${kit.name}@${v}`, "version") !== v) {
    note(`the release publishes ${kit.name}@${v} (npm doesn't have it yet)`);
    return v;
  }
  // npm has this version: the kit must not have changed since then.
  let base = npmView(`${kit.name}@${v}`, "gitHead") || "";
  let from = `the commit npm's copy was built from (${base.slice(0, 9)})`;
  if (!base || !isCommit(base)) {
    base = git("log", "-1", "--format=%H", "-G", '"version"', "--", KIT_PKG);
    from = `the commit that set ${v} (${base.slice(0, 9)})`;
  }
  const changed = base
    ? git("diff", "--name-only", base, "HEAD", "--", KIT_DIR)
    : "";
  if (changed) {
    throw new Stop(
      1,
      `::error::${KIT_DIR} changed since ${from}, but its version ${v} is on npm already. ` +
        `Bump the kit's version in this candidate (${KIT_PKG} and its entry in package-lock.json): ` +
        `the release commit never changes it (CONTRIBUTING › Releasing). Changed: ${changed.split("\n").join(", ")}`,
    );
  }
  note(
    `${kit.name}@${v} is on npm and the kit is unchanged since: nothing new to publish`,
  );
  return v;
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
  const log = fs.readFileSync("CHANGELOG.md", "utf8");
  const heading = new RegExp(`^(## \\[${esc(den)}\\] - )unreleased$`, "im");
  if (heading.test(log))
    out["CHANGELOG.md"] = log.replace(heading, `$1${date}`);
  else
    note(
      `::warning::CHANGELOG.md has no "## [${den}] - unreleased" entry: its date is left as it is`,
    );
  for (const [file, t] of Object.entries(out)) fs.writeFileSync(file, t);
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
