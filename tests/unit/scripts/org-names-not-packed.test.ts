/**
 * Issue 1127: the org-name matcher ships in the package
 * (src/shared/org-names.js), so Den's own tooling can check what it files.
 * The list it matches never does: it lives in a secret or a file outside
 * the repo. The packed file list holds no list file, and no packed file
 * holds the configured list's lines (when one is configured here).
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { orgPatterns, userNamesFile } from "../../../src/shared/org-names.js";

const ROOT = process.cwd();

function packedFiles(): string[] {
  const r = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: ROOT, encoding: "utf-8", maxBuffer: 1 << 28 },
  );
  expect(r.status).toBe(0);
  const [pack] = JSON.parse(r.stdout) as { files: { path: string }[] }[];
  return pack.files.map((f) => f.path);
}

describe("issue 1127: the package holds the matcher, never the list", () => {
  const files = packedFiles();

  it("the matcher is packed", () => {
    expect(files).toContain("src/shared/org-names.js");
  });

  it("no list file is packed (org-names*.txt, a den-dev config folder)", () => {
    expect(
      files.filter((f) => /org-names[^/]*\.txt$|(^|\/)den-dev\//i.test(f)),
    ).toEqual([]);
  });

  it("no packed file holds a configured pattern's source line", () => {
    // The list as configured here: the variable, the file it names, or the
    // per-user file. None configured (most CI jobs): nothing to look for.
    const listFile =
      process.env.DEN_ORG_NAMES_FILE ||
      (fs.existsSync(userNamesFile()) ? userNamesFile() : "");
    const sources = orgPatterns().map((p) => p.source);
    if (!sources.length) return;
    const where: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(ROOT, f), "utf-8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      // A pattern's source as the list writes it, on a line of its own:
      // the shape a copied list would have.
      const lines = new Set(text.split("\n").map((l) => l.trim()));
      if (sources.some((s) => lines.has(s))) where.push(f);
    }
    // Name the files only, never the pattern.
    expect([listFile ? "list configured" : "list from env", where]).toEqual([
      listFile ? "list configured" : "list from env",
      [],
    ]);
  });
});
