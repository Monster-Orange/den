/**
 * The install skill (skills/install-den/SKILL.md) and the docs that tell a
 * person to run Den with npx: every `npx @monster-orange/den` names
 * `@latest`. A bare name reuses an older Den cached in ~/.npm/_npx.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const FILES = [
  "skills/install-den/SKILL.md",
  "README.md",
  "docs/reference.md",
  "docs/distributions.md",
  "src/ui/cli/create.ts",
  "src/ui/cli/index.ts",
];

/** Each `npx … @monster-orange/den…` use, with its file and line. */
function npxUses(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const f of FILES) {
    const lines = fs.readFileSync(path.join(ROOT, f), "utf-8").split("\n");
    lines.forEach((l, i) => {
      for (const m of l.matchAll(
        /npx\s+(?:--yes\s+)?(?:@monster-orange\/den|\$\{ENGINE_PACKAGE\})(\S*)/g,
      ))
        out.push({ where: `${f}:${i + 1}`, text: m[0] });
    });
  }
  return out;
}

describe("npx always runs the newest Den", () => {
  it("the skill creates the Den with @monster-orange/den@latest", () => {
    const skill = fs.readFileSync(
      path.join(ROOT, "skills/install-den/SKILL.md"),
      "utf-8",
    );
    expect(skill).toContain(
      "`npx @monster-orange/den@latest create <name> <dir> --yes --json`",
    );
  });

  it("every npx line in the skill and the docs names @latest", () => {
    const uses = npxUses();
    expect(uses.length).toBeGreaterThan(5);
    expect(uses.filter((u) => !/@latest$/.test(u.text))).toEqual([]);
  });
});
