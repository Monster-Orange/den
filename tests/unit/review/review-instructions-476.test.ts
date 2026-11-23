/**
 * Issue 476 (REVIEW-MESH-SPEC RV-8 item 13): the reviewer reads the
 * instruction files that cover the changed paths, not only the root
 * CLAUDE.md and AGENTS.md: each CLAUDE.md or AGENTS.md in a changed path's
 * folders, and each .claude/rules/*.md whose `paths:` frontmatter matches
 * a changed path (a rules file with no `paths:` covers everything).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { instructionFiles } from "../../../src/shared/review/mesh/instructions.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-review-inst-"));
  tmp.push(d);
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), text);
  }
  return d;
}

describe("instruction files for the changed paths", () => {
  it("root files, folder files on the way down, and matching scoped rules", () => {
    const d = tree({
      "CLAUDE.md": "root",
      "AGENTS.md": "root",
      "src/CLAUDE.md": "src",
      "src/ui/AGENTS.md": "ui",
      "docs/CLAUDE.md": "docs",
      ".claude/rules/server.md":
        "---\npaths:\n  - src/ui/server/**\n---\nserver rules",
      ".claude/rules/docs.md": '---\npaths: ["docs/**"]\n---\ndocs rules',
      ".claude/rules/always.md": "no frontmatter: covers everything",
    });
    expect(instructionFiles(d, ["src/ui/server/index.ts"])).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
      "src/CLAUDE.md",
      "src/ui/AGENTS.md",
      ".claude/rules/always.md",
      ".claude/rules/server.md",
    ]);
  });

  it("a changed path that tries to climb out is ignored", () => {
    const d = tree({ "CLAUDE.md": "root" });
    expect(instructionFiles(d, ["../../etc/passwd", "/abs/x"])).toEqual([
      "CLAUDE.md",
    ]);
  });

  it("no files, no list", () => {
    expect(instructionFiles(tree({}), ["a.ts"])).toEqual([]);
  });
});
