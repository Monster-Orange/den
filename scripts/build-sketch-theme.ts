/**
 * Issue 788: builds the kit's themes/sketch.css from its den-theme.json,
 * with the same token mapping Den's server uses (renderThemeTokens), so a
 * page with the kit and no Den server (a Hub preview) can draw it.
 *
 *   npx tsx scripts/build-sketch-theme.ts           write it
 *   npx tsx scripts/build-sketch-theme.ts --check   fail if it would change
 */
import * as fs from "fs";
import * as path from "path";
import { validateThemeDir } from "../src/shared/theme/contract.js";
import { renderThemeTokens } from "../src/ui/server/theme-runtime.js";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const DIR = path.join(ROOT, "packages/den-ui/src/themes/sketch");
const OUT = path.join(ROOT, "packages/den-ui/src/themes/sketch.css");

const v = validateThemeDir(DIR, { expectId: "sketch" });
if (!v.ok || !v.theme) {
  console.error("build-sketch-theme: the sketch theme doesn't validate:");
  for (const i of v.issues) console.error(`  ${i.at} ${i.message}`);
  for (const c of v.contrast) console.error(`  ${JSON.stringify(c)}`);
  process.exit(1);
}
const css = renderThemeTokens("sketch", v.theme);
if (process.argv.includes("--check")) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (now !== css) {
    console.error(
      "build-sketch-theme: packages/den-ui/src/themes/sketch.css is out of date with its den-theme.json. Run: npx tsx scripts/build-sketch-theme.ts",
    );
    process.exit(1);
  }
  console.log(
    "build-sketch-theme: themes/sketch.css matches its den-theme.json",
  );
} else {
  fs.writeFileSync(OUT, css);
  console.log(`build-sketch-theme: wrote ${path.relative(ROOT, OUT)}`);
}
