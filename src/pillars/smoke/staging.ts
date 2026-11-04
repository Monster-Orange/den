import * as fs from "fs";
import * as path from "path";

export interface StageSmokeTreeResult {
  copiedFiles: number;
  matchedTestFiles: number;
}

function testMatchToRegex(testMatch: string): RegExp {
  const matchExt = testMatch.replace(/^\*\*\/\*\./, "").replace(/\./g, "\\.");
  return new RegExp(`\\.${matchExt}$`);
}

export function stageSmokeTree(
  sourceDir: string,
  destinationDir: string,
  testMatch: string,
): StageSmokeTreeResult {
  const testRegex = testMatchToRegex(testMatch);
  let copiedFiles = 0;
  let matchedTestFiles = 0;

  function copyRecursive(src: string, dst: string): void {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const sourcePath = path.join(src, entry.name);
      const destinationPath = path.join(dst, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        copyRecursive(sourcePath, destinationPath);
        continue;
      }

      fs.copyFileSync(sourcePath, destinationPath);
      copiedFiles += 1;
      if (testRegex.test(entry.name)) {
        matchedTestFiles += 1;
      }
    }
  }

  fs.mkdirSync(destinationDir, { recursive: true });
  copyRecursive(sourceDir, destinationDir);

  return {
    copiedFiles,
    matchedTestFiles,
  };
}
