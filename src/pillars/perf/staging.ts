import * as fs from "fs";
import * as path from "path";

export interface StagePerfTreeResult {
  copiedFiles: number;
  matchedTestFiles: number;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function matchesTestPath(relativePath: string, testMatch: string): boolean {
  const normalizedPath = normalizePath(relativePath);

  if (normalizedPath === testMatch) {
    return true;
  }

  if (testMatch.startsWith("**/*.")) {
    return normalizedPath.endsWith(testMatch.slice("**/*".length));
  }

  if (testMatch.startsWith("**/")) {
    const suffix = testMatch.slice(3);
    return normalizedPath === suffix || normalizedPath.endsWith(`/${suffix}`);
  }

  if (!testMatch.includes("/")) {
    return path.basename(normalizedPath) === testMatch;
  }

  return false;
}

export function stagePerfTree(
  sourceDir: string,
  destinationDir: string,
  testMatch: string,
): StagePerfTreeResult {
  let copiedFiles = 0;
  let matchedTestFiles = 0;

  function copyRecursive(src: string, dst: string, relativeDir = ""): void {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const sourcePath = path.join(src, entry.name);
      const destinationPath = path.join(dst, entry.name);
      const relativePath = relativeDir
        ? path.join(relativeDir, entry.name)
        : entry.name;

      if (entry.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        copyRecursive(sourcePath, destinationPath, relativePath);
        continue;
      }

      fs.copyFileSync(sourcePath, destinationPath);
      copiedFiles += 1;
      if (matchesTestPath(relativePath, testMatch)) {
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
