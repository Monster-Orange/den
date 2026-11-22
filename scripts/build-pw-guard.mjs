#!/usr/bin/env node
/**
 * Issue 1010: build `@monster-orange/den/pw-guard` (lib/pw-guard/:
 * JavaScript and its types) from src/shared/gates/pw-guard-export.ts.
 * The release packs without scripts, so the output is committed.
 *
 *   node scripts/build-pw-guard.mjs           write lib/pw-guard/
 *   node scripts/build-pw-guard.mjs --check   exit 1 when it is out of date
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "lib/pw-guard");
const ENTRY = path.join(ROOT, "src/shared/gates/pw-guard-export.ts");
const TSC = path.join(ROOT, "node_modules/typescript/bin/tsc");

/** Build into `dir`: its files, by name. */
function build(dir) {
  execFileSync(
    process.execPath,
    [
      TSC,
      ENTRY,
      "--outDir",
      dir,
      "--rootDir",
      path.join(ROOT, "src/shared/gates"),
      "--declaration",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "--types",
      "node",
      "--strict",
      "--skipLibCheck",
      "--newLine",
      "lf",
    ],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] },
  );
  const files = {};
  for (const f of fs.readdirSync(dir).sort())
    files[f] = fs.readFileSync(path.join(dir, f), "utf8");
  return files;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-pw-guard-"));
try {
  const want = build(tmp);
  if (process.argv.includes("--check")) {
    const have = fs.existsSync(OUT)
      ? Object.fromEntries(
          fs
            .readdirSync(OUT)
            .filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))
            .sort()
            .map((f) => [f, fs.readFileSync(path.join(OUT, f), "utf8")]),
        )
      : {};
    const stale = [
      ...new Set([...Object.keys(want), ...Object.keys(have)]),
    ].filter((f) => want[f] !== have[f]);
    if (stale.length) {
      console.error(
        `lib/pw-guard is out of date (${stale.join(", ")}): run npm run build:pw-guard`,
      );
      process.exit(1);
    }
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    for (const f of fs.readdirSync(OUT))
      if (f.endsWith(".js") || f.endsWith(".d.ts"))
        fs.rmSync(path.join(OUT, f));
    for (const [f, body] of Object.entries(want))
      fs.writeFileSync(path.join(OUT, f), body);
    console.log(`lib/pw-guard: ${Object.keys(want).join(", ")}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
