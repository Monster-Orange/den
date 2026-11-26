#!/usr/bin/env node
/**
 * Issue 1527: the visual-reference tests (tagged `@visual-reference` in
 * their top comment), one path per line, sorted: CI's visual job
 * (den-ui-nav) runs exactly these, in the pinned Playwright image, where
 * their references were taken. The same tag the gate reads
 * (src/shared/gates/visual.ts); a test keeps the two alike.
 *
 *   node scripts/visual-tests.mjs           → the tagged test files
 *   node scripts/visual-tests.mjs --in F    → those also listed in file F
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const HEAD_BYTES = 4096;
/** A comment line of its own, as the gate reads it. */
const TAG = /^[ \t]*\*[ \t]*@visual-reference\b/m;

export function visualTests(cwd = process.cwd()) {
  return execFileSync(
    "git",
    ["ls-files", "*.test.ts", "*.test.js", "*.spec.ts", "*.spec.js"],
    { cwd, encoding: "utf-8" },
  )
    .split("\n")
    .filter(Boolean)
    .filter((f) => {
      let fd;
      try {
        fd = fs.openSync(`${cwd}/${f}`, "r");
        const buf = Buffer.alloc(HEAD_BYTES);
        const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
        return TAG.test(buf.toString("utf-8", 0, n));
      } catch {
        return false;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    })
    .sort();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--in");
  let out = visualTests();
  if (i >= 0) {
    const listed = new Set(
      fs
        .readFileSync(process.argv[i + 1], "utf-8")
        .split("\n")
        .map((l) => l.trim()),
    );
    out = listed.has("ALL") ? out : out.filter((f) => listed.has(f));
  }
  if (out.length) process.stdout.write(out.join("\n") + "\n");
}
