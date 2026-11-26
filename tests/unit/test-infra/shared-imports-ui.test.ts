import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");

const KNOWN = [
  "src/shared/health/rollup.ts -> src/ui/server/public/health-rollup.js",
  "src/shared/settings-cli-rows.ts -> src/ui/cli/proc-lookup.js",
];

const SPEC =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bjest\.(?:mock|unstable_mockModule)\s*\(\s*)(["'`])(\.{1,2}\/[^"'`\n]+?)\1/g;

export function uiImports(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPEC)) {
    const t = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), m[2]!),
    );
    if (t.startsWith("src/ui/")) out.push(`${file} -> ${t}`);
  }
  return out;
}

function sharedEdges(): string[] {
  const files = execFileSync("git", ["ls-files", "src/shared"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
  return [
    ...new Set(
      files.flatMap((f) =>
        uiImports(f, fs.readFileSync(path.join(ROOT, f), "utf8")),
      ),
    ),
  ].sort();
}

describe("src/shared imports nothing new from src/ui", () => {
  it("reads each kind of import, and only paths into src/ui", () => {
    expect(
      uiImports(
        "src/shared/a/b.ts",
        [
          'import { x } from "../../ui/server/x.js";',
          'const y = await import("../../ui/cli/y.js");',
          'import "../../ui/z.js";',
          'import { w } from "../w.js";',
          'import { v } from "../../ui-kit/v.js";',
        ].join("\n"),
      ),
    ).toEqual([
      "src/shared/a/b.ts -> src/ui/server/x.js",
      "src/shared/a/b.ts -> src/ui/cli/y.js",
      "src/shared/a/b.ts -> src/ui/z.js",
    ]);
  });

  it("has no shared -> ui import beyond the known ones", () => {
    const edges = sharedEdges();
    expect(edges.filter((e) => !KNOWN.includes(e))).toEqual([]);
  });

  it("lists only imports that are still there, so the list only shrinks", () => {
    const edges = sharedEdges();
    expect(KNOWN.filter((e) => !edges.includes(e))).toEqual([]);
  });
});
