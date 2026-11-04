import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { stagePerfTree } from "../../../src/pillars/perf/staging.js";

function withTempDir(run: (tempDir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-perf-staging-"));
  try {
    run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("stagePerfTree", () => {
  it("copies repo-owned perf helpers while counting an exact test.js entrypoint", () => {
    withTempDir((tempDir) => {
      const sourceDir = path.join(tempDir, "source");
      const destinationDir = path.join(tempDir, "dest");
      const sharedDir = path.join(sourceDir, "shared");

      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, "test.js"),
        "export default function () {};\n",
      );
      fs.writeFileSync(
        path.join(sharedDir, "artifacts.js"),
        "export const shared = true;\n",
      );

      const result = stagePerfTree(sourceDir, destinationDir, "test.js");

      expect(result.matchedTestFiles).toBe(1);
      expect(result.copiedFiles).toBe(2);
      expect(fs.existsSync(path.join(destinationDir, "test.js"))).toBe(true);
      expect(
        fs.existsSync(path.join(destinationDir, "shared", "artifacts.js")),
      ).toBe(true);
    });
  });

  it("counts relative module entrypoints while copying sibling shared helpers", () => {
    withTempDir((tempDir) => {
      const sourceDir = path.join(tempDir, "source");
      const destinationDir = path.join(tempDir, "dest");

      fs.mkdirSync(path.join(sourceDir, "search"), { recursive: true });
      fs.mkdirSync(path.join(sourceDir, "shared"), { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, "search", "test.js"),
        "export default function () {};\n",
      );
      fs.writeFileSync(
        path.join(sourceDir, "search", "helpers.js"),
        "export const helper = true;\n",
      );
      fs.writeFileSync(
        path.join(sourceDir, "shared", "artifacts.js"),
        "export const shared = true;\n",
      );

      const result = stagePerfTree(sourceDir, destinationDir, "search/test.js");

      expect(result.matchedTestFiles).toBe(1);
      expect(result.copiedFiles).toBe(3);
      expect(
        fs.existsSync(path.join(destinationDir, "search", "helpers.js")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(destinationDir, "shared", "artifacts.js")),
      ).toBe(true);
    });
  });
});
