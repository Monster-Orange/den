import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { stageSmokeTree } from "../../../src/pillars/smoke/staging.js";

function withTempDir(run: (tempDir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-smoke-staging-"));
  try {
    run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("stageSmokeTree", () => {
  it("copies smoke tests and imported helper modules from the test directory", () => {
    withTempDir((tempDir) => {
      const sourceDir = path.join(tempDir, "source");
      const destinationDir = path.join(tempDir, "dest");
      const helpersDir = path.join(sourceDir, "helpers");

      fs.mkdirSync(helpersDir, { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, "root.smoke.ts"),
        "test('root', () => {});\n",
      );
      fs.writeFileSync(
        path.join(helpersDir, "fixtures.ts"),
        "export const fixture = true;\n",
      );
      fs.writeFileSync(path.join(helpersDir, "manifest.yml"), "name: helper\n");

      const result = stageSmokeTree(sourceDir, destinationDir, "**/*.smoke.ts");

      expect(result.matchedTestFiles).toBe(1);
      expect(fs.existsSync(path.join(destinationDir, "root.smoke.ts"))).toBe(
        true,
      );
      expect(
        fs.existsSync(path.join(destinationDir, "helpers", "fixtures.ts")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(destinationDir, "helpers", "manifest.yml")),
      ).toBe(true);
    });
  });

  it("counts only matching smoke tests while still copying non-test support files", () => {
    withTempDir((tempDir) => {
      const sourceDir = path.join(tempDir, "source");
      const destinationDir = path.join(tempDir, "dest");

      fs.mkdirSync(path.join(sourceDir, "nested"), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, "helpers.ts"), "export {};\n");
      fs.writeFileSync(
        path.join(sourceDir, "nested", "api.smoke.ts"),
        "test('api', () => {});\n",
      );
      fs.writeFileSync(path.join(sourceDir, "nested", "notes.md"), "# notes\n");

      const result = stageSmokeTree(sourceDir, destinationDir, "**/*.smoke.ts");

      expect(result.matchedTestFiles).toBe(1);
      expect(result.copiedFiles).toBe(3);
      expect(fs.existsSync(path.join(destinationDir, "helpers.ts"))).toBe(true);
      expect(
        fs.existsSync(path.join(destinationDir, "nested", "notes.md")),
      ).toBe(true);
    });
  });
});
