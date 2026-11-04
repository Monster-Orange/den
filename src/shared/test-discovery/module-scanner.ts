/**
 * Test Module Scanner
 * Auto-discovers test modules from filesystem
 */

import { listReposWithManifests } from "../manifest/workspace-manifests.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as yaml from "yaml";
import { discoverRepos } from "../../pillars/smoke/discover.js";
import { discoverJourneySpecs } from "../../pillars/journeys/discover.js";
import {
  discoverSecurityTargets,
  securityTargetId,
} from "../../pillars/security/discover.js";
import { TEST_FILE_EXTENSIONS, SKIP_TEST_DIRS } from "../constants.js";
import { getDistRoot } from "../paths.js";
import { getPerfTestsRoot } from "../perf/test-paths.js";
import type {
  PerformanceModuleConfig,
  PerfOptionalField,
  Pillar,
} from "../types/index.js";

export interface ModuleManifest {
  name?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  /** Declarative launch-time options for perf tests (rendered by the web UI). */
  optionalFields?: PerfOptionalField[];
}

export interface TestModule {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  path: string;
  testCount: number;
  tags: string[];
  /** Declarative launch-time options for perf tests; empty for non-perf modules. */
  optionalFields?: PerfOptionalField[];
}

export class ModuleScanner {
  private rootDir: string;

  constructor() {
    // Den-root anchored (read-only discovery): a cwd default made `den`
    // invoked outside the repo silently report zero test modules.
    this.rootDir = getDistRoot();
  }

  /**
   * Scan for test modules in a given pillar
   */
  async scanModules(pillar: Pillar): Promise<TestModule[]> {
    if (pillar === "journeys") {
      return this.scanJourneyModules();
    }
    if (pillar === "security") {
      return this.scanSecurityTargets();
    }
    if (pillar === "smoke") {
      return this.scanSmokeServices();
    }
    if (pillar === "performance") {
      return this.scanPerformanceModules();
    }
    if (pillar === "synthetic") {
      return this.scanSyntheticModules();
    }
    if (pillar === "suites") {
      return this.scanRepoSuites();
    }
    return this.scanFilesystemModules(
      path.join(this.rootDir, "src", "pillars", "api", "tests"),
      pillar,
    );
  }

  /** Suites repos declare under `tests:` in their manifest. */
  private scanRepoSuites(): TestModule[] {
    return listReposWithManifests().flatMap((r) =>
      Object.entries(r.manifest.tests ?? {}).map(([name, suite]) => ({
        name: `${r.repo}/${name}`,
        displayName: `${r.repo}/${suite.label ?? name}`,
        description: suite.cmd,
        icon: "🧪",
        path: r.repoPath,
        testCount: 1,
        tags: r.org ? [r.org] : [],
      })),
    );
  }

  /**
   * Check if directory should be skipped
   */
  private shouldSkipDirectory(dirName: string): boolean {
    // Skip directories starting with underscore
    if (dirName.startsWith("_")) {
      return true;
    }

    return (SKIP_TEST_DIRS as readonly string[]).includes(dirName);
  }

  /**
   * Count test files in directory
   */
  /**
   * Scan registered repos (via discoverRepos) and return their smoke services as modules.
   * Reads from both config/local/registered-repos.json and .den/ symlinks.
   */
  private async scanSmokeServices(): Promise<TestModule[]> {
    const modules: TestModule[] = [];

    const repos = discoverRepos();
    for (const repo of repos) {
      for (const [svcName, svc] of Object.entries(repo.manifest.smoke ?? {})) {
        const testDir = path.resolve(repo.repoPath, svc.testDir);
        const testCount = await this.countSmokeFiles(testDir);
        modules.push({
          name: `${repo.repoName}/${svcName}`,
          displayName: `${repo.repoName} — ${svcName}`,
          description: `${svcName} smoke tests from ${repo.repoName}`,
          icon: svcName === "api" ? "🔗" : "🌐",
          path: testDir,
          testCount,
          tags: [svcName],
        });
      }
    }

    return modules;
  }

  /**
   * List declared security targets as modules — manifest-driven via
   * discoverSecurityTargets(), named "<repo>/<service>" like smoke. A
   * failing discovery degrades to a warned empty list (interactive picker);
   * the run entrypoint keeps the loud fail-fast posture.
   */
  private async scanSecurityTargets(): Promise<TestModule[]> {
    try {
      return discoverSecurityTargets().map((target) => ({
        name: securityTargetId(target),
        displayName: `${target.repoName} — ${target.serviceName}`,
        description: `ZAP scan target from ${target.repoName}`,
        icon: "🛡️",
        path: target.repoPath,
        testCount: 1,
        tags: [target.config.baseUrlKey ?? "hosts"],
      }));
    } catch (error) {
      console.warn(
        "Warning: Could not scan security modules:",
        (error as Error).message,
      );
      return [];
    }
  }

  /**
   * List discovered journey specs as modules — manifest-driven via
   * discoverJourneySpecs() (one module per journey spec, named
   * "<repo>/<journey-name>" like smoke's "<repo>/<service>"). No repos
   * registered naturally yields an empty list; a failing discovery
   * (missing testDir, invalid spec) degrades to a warned empty list here
   * because this scanner feeds interactive pickers — the run entrypoint
   * keeps the loud fail-fast posture.
   */
  private async scanJourneyModules(): Promise<TestModule[]> {
    try {
      return discoverJourneySpecs().map((discovered) => ({
        name: `${discovered.repoName}/${discovered.spec.name}`,
        displayName: `${discovered.repoName} — ${discovered.spec.name}`,
        description: `${discovered.spec.surface} journey from ${discovered.repoName}`,
        icon: "🧭",
        path: discovered.specPath,
        testCount: 1,
        tags: [discovered.spec.surface],
      }));
    } catch (error) {
      console.warn(
        "Warning: Could not scan journeys modules:",
        (error as Error).message,
      );
      return [];
    }
  }

  private async scanPerformanceModules(): Promise<TestModule[]> {
    // The distribution's own suites (the engine ships none; a distribution
    // without any has no directory, which is not an error), then the suites
    // registered repos declare in their manifests.
    const distTestsDir = getPerfTestsRoot(this.rootDir);
    const modules = (await this.pathExists(distTestsDir))
      ? await this.scanFilesystemModules(distTestsDir, "performance")
      : [];

    for (const repo of discoverRepos()) {
      for (const [moduleName, config] of Object.entries(
        repo.manifest.performance ?? {},
      )) {
        const modulePath = path.resolve(repo.repoPath, config.testDir);
        const manifest = await this.loadManifest(modulePath);

        modules.push({
          name: `${repo.repoName}/${moduleName}`,
          displayName: manifest.name || `${repo.repoName} — ${moduleName}`,
          description:
            manifest.description ||
            `${moduleName} performance tests from ${repo.repoName}`,
          icon: manifest.icon || this.getModuleIcon(moduleName),
          path: modulePath,
          testCount: await this.countPerformanceFiles(modulePath, config),
          tags: manifest.tags || config.tags || [],
          optionalFields:
            manifest.optionalFields ?? config.optionalFields ?? [],
        });
      }
    }

    modules.sort((a, b) => a.name.localeCompare(b.name));
    return modules;
  }

  /**
   * Scan discovered repos for synthetic test modules.
   * Uses workspace-aware discoverRepos() (active workspace when Local Dev is
   * enabled, registered-repos.json + .den/ otherwise).
   * Falls back to pillars/browser/tests/ if no repo provides synthetics config.
   */
  private async scanSyntheticModules(): Promise<TestModule[]> {
    const modules: TestModule[] = [];
    let foundAny = false;

    const repos = discoverRepos();
    for (const repo of repos) {
      const manifest = repo.manifest as {
        synthetics?: { testDir: string };
      } | null;
      if (!manifest?.synthetics?.testDir) continue;

      const testDir = path.resolve(repo.repoPath, manifest.synthetics.testDir);

      try {
        const entries = await fs.readdir(testDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (this.shouldSkipDirectory(entry.name)) continue;

          const modulePath = path.join(testDir, entry.name);
          const testCount = await this.countTestFiles(modulePath, "synthetic");
          const modManifest = await this.loadManifest(modulePath);

          modules.push({
            name: entry.name,
            displayName: modManifest.name || this.formatDisplayName(entry.name),
            description:
              modManifest.description ||
              (await this.getModuleDescription(modulePath)),
            icon: modManifest.icon || this.getModuleIcon(entry.name),
            path: modulePath,
            testCount,
            tags: modManifest.tags || [],
          });

          foundAny = true;
        }
      } catch {
        // testDir doesn't exist or isn't readable — skip
      }
    }

    // Fall back to synthetic/tests/ if no discovered repos provide synthetics config
    if (!foundAny) {
      const testsDir = path.join(
        this.rootDir,
        "src",
        "pillars",
        "browser",
        "tests",
      );
      try {
        const entries = await fs.readdir(testsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (this.shouldSkipDirectory(entry.name)) continue;

          const modulePath = path.join(testsDir, entry.name);
          const testCount = await this.countTestFiles(modulePath, "synthetic");
          const manifest = await this.loadManifest(modulePath);

          modules.push({
            name: entry.name,
            displayName: manifest.name || this.formatDisplayName(entry.name),
            description:
              manifest.description ||
              (await this.getModuleDescription(modulePath)),
            icon: manifest.icon || this.getModuleIcon(entry.name),
            path: modulePath,
            testCount,
            tags: manifest.tags || [],
          });
        }
      } catch {
        // synthetic/tests/ doesn't exist
      }
    }

    modules.sort((a, b) => a.name.localeCompare(b.name));
    return modules;
  }

  /**
   * Recursively count .smoke.ts files under a directory
   */
  private async countSmokeFiles(dirPath: string): Promise<number> {
    let count = 0;
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          count += await this.countSmokeFiles(path.join(dirPath, entry.name));
        } else if (
          TEST_FILE_EXTENSIONS.smoke.some((ext) => entry.name.endsWith(ext))
        ) {
          count++;
        }
      }
    } catch {
      // directory unreadable (e.g. symlink not yet linked)
    }
    return count;
  }

  private async scanFilesystemModules(
    testsDir: string,
    pillar: Pillar,
  ): Promise<TestModule[]> {
    try {
      const entries = await fs.readdir(testsDir, { withFileTypes: true });
      const modules: TestModule[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (this.shouldSkipDirectory(entry.name)) {
          continue;
        }

        const modulePath = path.join(testsDir, entry.name);
        const testCount = await this.countTestFiles(modulePath, pillar);
        const manifest = await this.loadManifest(modulePath);

        modules.push({
          name: entry.name,
          displayName: manifest.name || this.formatDisplayName(entry.name),
          description:
            manifest.description ||
            (await this.getModuleDescription(modulePath)),
          icon: manifest.icon || this.getModuleIcon(entry.name),
          path: modulePath,
          testCount,
          tags: manifest.tags || [],
          optionalFields:
            pillar === "performance" ? (manifest.optionalFields ?? []) : [],
        });
      }

      modules.sort((a, b) => a.name.localeCompare(b.name));
      return modules;
    } catch (error) {
      console.warn(
        `Warning: Could not scan ${pillar} test modules:`,
        (error as Error).message,
      );
      return [];
    }
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async countTestFiles(
    dirPath: string,
    pillar: Pillar,
  ): Promise<number> {
    try {
      const files = await fs.readdir(dirPath);
      const exts =
        TEST_FILE_EXTENSIONS[pillar] ?? TEST_FILE_EXTENSIONS.synthetic;
      return files.filter((file) => exts.some((ext) => file.endsWith(ext)))
        .length;
    } catch {
      return 0;
    }
  }

  private async countPerformanceFiles(
    dirPath: string,
    config: PerformanceModuleConfig,
  ): Promise<number> {
    if (typeof config.testMatch !== "string" || config.testMatch.length === 0) {
      // One module's bad testMatch must not abort discovery of every other
      // perf module — treat it as "no files found" and move on.
      console.warn(`Invalid performance testMatch for ${dirPath} — skipping`);
      return 0;
    }

    try {
      return await this.countPerformanceFilesFromRoot(dirPath, config, "");
    } catch {
      return 0;
    }
  }

  private async countPerformanceFilesFromRoot(
    dirPath: string,
    config: PerformanceModuleConfig,
    relativeDir: string,
  ): Promise<number> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      const relativePath = relativeDir
        ? path.join(relativeDir, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        count += await this.countPerformanceFilesFromRoot(
          entryPath,
          config,
          relativePath,
        );
        continue;
      }

      if (this.matchesPerformanceTestFile(relativePath, config.testMatch)) {
        count += 1;
      }
    }

    return count;
  }

  private matchesPerformanceTestFile(
    relativePath: string,
    testMatch: string,
  ): boolean {
    const normalizedPath = relativePath.split(path.sep).join("/");

    if (normalizedPath === testMatch) {
      return true;
    }

    if (testMatch.startsWith("**/")) {
      const nestedPattern = testMatch.slice(3);
      if (nestedPattern.startsWith("*.")) {
        return normalizedPath.endsWith(nestedPattern.slice(1));
      }
      return (
        normalizedPath === nestedPattern ||
        normalizedPath.endsWith(`/${nestedPattern}`)
      );
    }

    if (testMatch.startsWith("**/*.")) {
      return normalizedPath.endsWith(testMatch.slice("**/*".length));
    }

    if (!testMatch.includes("/")) {
      return path.basename(normalizedPath) === testMatch;
    }

    return false;
  }

  /**
   * Format directory name for display
   */
  private formatDisplayName(dirName: string): string {
    // Convert kebab-case or snake_case to Title Case
    return dirName
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  /**
   * Load manifest.yml from module directory
   */
  private async loadManifest(modulePath: string): Promise<ModuleManifest> {
    const manifestPath = path.join(modulePath, "manifest.yml");

    try {
      const content = await fs.readFile(manifestPath, "utf-8");
      const manifest = yaml.parse(content) as ModuleManifest;
      return manifest || {};
    } catch {
      // No manifest or parse error - return empty object
      return {};
    }
  }

  /**
   * Get module description from README or default
   */
  private async getModuleDescription(modulePath: string): Promise<string> {
    // Try to read description from .gitkeep or README
    const readmePath = path.join(modulePath, ".gitkeep");
    try {
      const content = await fs.readFile(readmePath, "utf-8");
      const firstLine = content.split("\n")[0];
      // Remove markdown heading markers
      return firstLine.replace(/^#\s*/, "").trim();
    } catch {
      // Default descriptions based on common module names
      return this.getDefaultDescription(path.basename(modulePath));
    }
  }

  /**
   * Get default description for common module names
   */
  private getDefaultDescription(moduleName: string): string {
    const descriptions: Record<string, string> = {
      auth: "Authentication & sessions",
      basic: "Health checks & smoke tests",
      health: "API health checks",
      users: "User API endpoints",
    };

    return (
      descriptions[moduleName] || `${this.formatDisplayName(moduleName)} tests`
    );
  }

  /**
   * Get emoji icon for module
   */
  getModuleIcon(moduleName: string): string {
    const icons: Record<string, string> = {
      basic: "🔍",
      auth: "🔐",
      health: "🔍",
      users: "👥",
    };

    return icons[moduleName] || "📦";
  }
}

// Export singleton
export const moduleScanner = new ModuleScanner();
