#!/usr/bin/env node
/**
 * The static tests' command line (the rule and the list: scripts/static-tests.js).
 *
 *   node scripts/static-tests.mjs --candidates   every test file the rule allows
 *   node scripts/static-tests.mjs --check        what is wrong with the list (exit 1)
 *   node scripts/static-tests.mjs --list         the listed files, one a line
 *   node scripts/static-tests.mjs --timing <jest --json file> [--summary <md>]
 *                                                each file's time against max_seconds
 *                                                (STATIC_WALL_SECONDS: the job's wall time, for the summary)
 */
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  LIST,
  listProblems,
  loadList,
  staticViolations,
  testFiles,
  timing,
} from "./static-tests.js";

function main(argv) {
  if (argv.includes("--candidates")) {
    for (const f of testFiles())
      if (
        !/\.(browser|integration)\.test\.ts$/.test(f) &&
        !staticViolations(f).length
      )
        console.log(f);
    return 0;
  }
  if (argv.includes("--list")) {
    for (const f of loadList().files) console.log(f);
    return 0;
  }
  if (argv.includes("--check")) {
    const p = listProblems(loadList());
    for (const l of p) console.error(l);
    return p.length ? 1 : 0;
  }
  const t = argv.indexOf("--timing");
  if (t >= 0) {
    const doc = loadList();
    const res = timing(JSON.parse(fs.readFileSync(argv[t + 1], "utf-8")), doc);
    const s = argv.indexOf("--summary");
    const wall = Number(process.env.STATIC_WALL_SECONDS || NaN);
    const lines = [
      "### Static tests",
      "",
      `${res.rows.length} files${Number.isFinite(wall) ? `, ${wall} s wall` : ""}; each must run under ${doc.max_seconds} s.`,
      "",
      "| File | Seconds |",
      "| --- | --- |",
      ...res.rows
        .slice(0, 10)
        .map((r) => `| \`${r.file}\` | ${r.seconds.toFixed(1)} |`),
      "",
    ];
    if (s >= 0) fs.appendFileSync(argv[s + 1], lines.join("\n") + "\n");
    else console.log(lines.join("\n"));
    for (const r of res.slow)
      console.log(
        `::error file=${r.file}::${r.file} took ${r.seconds.toFixed(1)} s, over the static limit of ${doc.max_seconds} s: speed it up or take it out of ${LIST}`,
      );
    for (const f of res.missing)
      console.log(
        `::error file=${f}::${f} is listed in ${LIST} but did not run`,
      );
    return res.slow.length || res.missing.length ? 1 : 0;
  }
  console.error(
    "usage: node scripts/static-tests.mjs --candidates | --check | --list | --timing <jest.json> [--summary <file>]",
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(main(process.argv.slice(2)));
