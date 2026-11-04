/**
 * Post–smoke-run check: if Playwright global teardown ran, it removes
 * `.smoke-run/smoke-fixture-handoff.json` after releasing storage fixtures.
 *
 * A leftover file means global teardown did not complete — storage side effects
 * may still exist (MinIO buckets, etc.). Fail loudly so CI/UI runs do not
 * silently leak fixtures.
 *
 * Safe when no storage fixture was acquired (file never created): exits 0.
 */

import * as fs from "fs";
import * as path from "path";
import { getDistRoot } from "../../shared/paths.js";

import { product } from "../../shared/product.js";
// Den-root anchored: must resolve the SAME handoff path global-teardown.ts
// writes, or a cwd mismatch silently reports leaked fixtures as clean.
const PROJECT_ROOT = getDistRoot();
const HANDOFF = path.join(
  PROJECT_ROOT,
  ".smoke-run",
  "smoke-fixture-handoff.json",
);

function main(): void {
  if (fs.existsSync(HANDOFF)) {
    console.error(
      `[${product().cli}] smoke fixture handoff still present:\n  ${HANDOFF}\n` +
        `  Playwright global teardown did not finish releasing storage fixtures.\n` +
        `  Fix: ensure tests exit normally so globalTeardown runs; check for crashes/kill -9.`,
    );
    process.exit(1);
  }
  console.log(
    `[${product().cli}] smoke teardown verification: no stale storage fixture handoff`,
  );
}

main();
