#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  process.stderr.write(`skill-pack-update: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { root: ROOT };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") out.from = argv[++i];
    else if (argv[i] === "--root") out.root = argv[++i];
    else rest.push(argv[i]);
  }
  [out.pack, out.commit] = rest;
  if (!out.pack || !/^[a-z][a-z0-9-]{0,63}$/.test(out.pack))
    fail("usage: skill-pack-update.mjs <pack> <commit> [--from <dir>]");
  if (!out.commit || !/^[0-9a-f]{40}$/.test(out.commit))
    fail("the commit must be a full 40-character sha");
  return out;
}

const hashFile = (f) =>
  `sha256-${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}`;

function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), {
      withFileTypes: true,
    })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

const excluded = (rel, exclude) =>
  exclude.some(({ path: x }) => rel === x || rel.startsWith(`${x}/`));

const skillsOf = (files) =>
  [
    ...new Set(
      files
        .map((f) => /^skills\/([^/]+)\/SKILL\.md$/.exec(f)?.[1])
        .filter(Boolean),
    ),
  ].sort();

function download(pin, commit) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(pin.source);
  if (!m) fail(`${pin.source} is not a GitHub repository address`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-skill-pack-"));
  const tgz = path.join(tmp, "pack.tgz");
  execFileSync("curl", [
    "-fsSL",
    "-o",
    tgz,
    `https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/${commit}`,
  ]);
  const out = path.join(tmp, "src");
  fs.mkdirSync(out);
  execFileSync("tar", ["-xzf", tgz, "-C", out, "--strip-components=1"]);
  return {
    dir: out,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

function notice(name, pin, commit) {
  const lines = [
    `# ${name} in Den`,
    "",
    `These files come from ${name}, ${pin.copyright.replace(/^Copyright \(c\) \d+ /, "by ")}, under the ${pin.license} License in \`LICENSE\` beside this file.`,
    "",
    `Source: ${pin.source}/tree/${commit}/${pin.path}`,
    "",
    "Den writes `.claude-plugin/plugin.json` and this file. Every other file is upstream's, unchanged, except for the patches below.",
    "",
    "## Left out",
    "",
    ...pin.exclude.map((x) => `- \`${x.path}\`: ${x.why}`),
    "",
    "## Changed",
    "",
    ...Object.entries(pin.patches ?? {}).map(
      ([f, why]) => `- \`${f}\`: ${why}`,
    ),
    "",
    "## Off by default",
    "",
    ...(pin.default_off ?? []).map((x) => `- \`${x.skill}\`: ${x.why}`),
    "",
  ];
  return `${lines.join("\n")}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packsDir = path.join(args.root, "skill-packs");
  const packsFile = path.join(packsDir, "packs.json");
  const packs = JSON.parse(fs.readFileSync(packsFile, "utf8"));
  const pin = packs[args.pack];
  if (!pin) fail(`no pack named ${args.pack} in skill-packs/packs.json`);
  const got = args.from
    ? { dir: path.resolve(args.from), cleanup: () => {} }
    : download(pin, args.commit);
  try {
    const src = path.join(got.dir, pin.path);
    if (!fs.existsSync(path.join(src, "LICENSE")))
      fail(`${pin.path}/LICENSE is missing upstream`);
    const before = skillsOf(Object.keys(pin.files ?? {}));
    const dest = path.join(packsDir, args.pack);
    fs.rmSync(dest, { recursive: true, force: true });
    for (const rel of listFiles(src)) {
      if (excluded(rel, pin.exclude)) continue;
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.copyFileSync(path.join(src, rel), path.join(dest, rel));
    }
    const patches = path.join(packsDir, "patches", args.pack);
    if (fs.existsSync(patches))
      for (const p of fs
        .readdirSync(patches)
        .filter((f) => f.endsWith(".patch"))
        .sort()) {
        if (!Object.hasOwn(pin.patches ?? {}, p))
          fail(`${p} isn't listed in the pack's patches`);
        execFileSync(
          "git",
          [
            "apply",
            "--unsafe-paths",
            `--directory=${path.relative(args.root, dest)}`,
            path.join(patches, p),
          ],
          {
            cwd: args.root,
          },
        );
      }
    const upstream = JSON.parse(
      fs.readFileSync(path.join(src, "plugin.json"), "utf8"),
    );
    fs.mkdirSync(path.join(dest, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(dest, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: args.pack,
          version: `${upstream.version}+${args.commit.slice(0, 12)}`,
          description: upstream.description,
          author: upstream.author,
          homepage: `${pin.source}/tree/${args.commit}/${pin.path}`,
          license: pin.license,
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(dest, "DEN-NOTICE.md"),
      notice(args.pack, pin, args.commit),
    );
    const files = {};
    for (const rel of listFiles(dest))
      files[rel] = hashFile(path.join(dest, rel));
    packs[args.pack] = { ...pin, commit: args.commit, files };
    fs.writeFileSync(packsFile, `${JSON.stringify(packs, null, 2)}\n`);
    const after = skillsOf(Object.keys(files));
    const added = after.filter((s) => !before.includes(s));
    const removed = before.filter((s) => !after.includes(s));
    process.stdout.write(
      `${args.pack} at ${args.commit.slice(0, 12)}: ${Object.keys(files).length} files, ${after.length} skills\n` +
        `added: ${added.join(", ") || "none"}\nremoved: ${removed.join(", ") || "none"}\n`,
    );
  } finally {
    got.cleanup();
  }
}

main();
