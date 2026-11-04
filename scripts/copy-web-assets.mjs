import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const source = resolve(root, "src/ui/server/public");
const target = resolve(root, "dist/src/ui/server/public");

if (!existsSync(source)) {
  throw new Error(`Web asset source directory not found: ${source}`);
}

mkdirSync(dirname(target), { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

console.log(`Copied web assets to ${target}`);
