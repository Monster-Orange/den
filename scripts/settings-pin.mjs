#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST = "tests/unit/server/settings-registry-order.test.ts";

if (!process.argv.includes("--write")) {
  console.log(
    "usage: node scripts/settings-pin.mjs --write\n" +
      "  rewrites tests/fixtures/settings-registry-order.json from the registry as it is now",
  );
  process.exit(process.argv.length > 2 ? 2 : 0);
}

const r = spawnSync("npx", ["jest", "--maxWorkers=1", "--forceExit", TEST], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, DEN_SETTINGS_PIN_WRITE: "1" },
});
if (r.status !== 0) process.exit(r.status ?? 1);
const f = spawnSync(
  "npx",
  ["prettier", "--write", "tests/fixtures/settings-registry-order.json"],
  { cwd: ROOT, stdio: "inherit" },
);
process.exit(f.status ?? 1);
