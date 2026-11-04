/**
 * Result Reader
 * Reads and queries test results from JSONL files
 */

import { readFile, readdir } from "fs/promises";
import { resolve, join } from "path";
import type {
  TestResult,
  TestSummary,
  FlakyTest,
  TrendData,
  Pillar,
} from "../types/index.js";

export interface QueryFilters {
  pillar?: Pillar;
  environment?: string;
  dateFrom?: Date;
  dateTo?: Date;
  status?: "passed" | "failed" | "skipped";
  user?: string;
}

export class ResultReader {
  private resultsDir: string;

  constructor(resultsDir: string = "./results") {
    this.resultsDir = resolve(resultsDir);
  }

  /**
   * Query results with filters
   */
  async query(filters: QueryFilters = {}): Promise<TestResult[]> {
    const files = await this.getRelevantFiles(filters);
    const results: TestResult[] = [];

    for (const file of files) {
      try {
        const fileResults = await this.readJSONLFile(file);
        const filtered = fileResults.filter((r) =>
          this.matchesFilters(r, filters),
        );
        results.push(...filtered);
      } catch (error) {
        console.warn(
          `Failed to read file ${file}: ${(error as Error).message}`,
        );
      }
    }

    // Sort by timestamp (newest first)
    return results.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }

  /**
   * Get summary statistics for a pillar/environment
   */
  async getSummary(
    pillar: Pillar,
    environment: string,
    days: number = 7,
  ): Promise<TestSummary> {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const results = await this.query({ pillar, environment, dateFrom });

    const total = results.length;
    const passed = results.filter((r) => r.status === "passed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const duration = results.reduce((sum, r) => sum + r.duration, 0);
    const passRate = total > 0 ? (passed / total) * 100 : 0;

    return {
      pillar,
      environment,
      total,
      passed,
      failed,
      skipped,
      duration,
      passRate,
    };
  }

  /**
   * Find flaky tests (tests that fail inconsistently)
   */
  async getFlakyTests(pillar: Pillar, days: number = 30): Promise<FlakyTest[]> {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const results = await this.query({ pillar, dateFrom });

    // Group results by test name
    const testGroups = results.reduce(
      (acc, r) => {
        if (!acc[r.test]) {
          acc[r.test] = [];
        }
        acc[r.test].push(r);
        return acc;
      },
      {} as Record<string, TestResult[]>,
    );

    // Find tests with both passes and failures
    const flakyTests: FlakyTest[] = [];

    for (const [testName, testResults] of Object.entries(testGroups)) {
      const runs = testResults.length;
      const failures = testResults.filter((r) => r.status === "failed").length;

      // Consider a test flaky if it has both passes and failures
      if (failures > 0 && failures < runs && runs >= 3) {
        flakyTests.push({
          test: testName,
          runs,
          failures,
          flakyRate: (failures / runs) * 100,
        });
      }
    }

    // Sort by flaky rate (most flaky first)
    return flakyTests.sort((a, b) => b.flakyRate - a.flakyRate);
  }

  /**
   * Get trend data for visualization
   */
  async getTrends(
    pillar: Pillar,
    environment: string,
    days: number = 30,
  ): Promise<TrendData[]> {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const results = await this.query({ pillar, environment, dateFrom });

    // Group results by date
    const dateGroups = results.reduce(
      (acc, r) => {
        const date = r.timestamp.split("T")[0];
        if (!acc[date]) {
          acc[date] = [];
        }
        acc[date].push(r);
        return acc;
      },
      {} as Record<string, TestResult[]>,
    );

    // Calculate metrics for each date
    const trends: TrendData[] = [];

    for (const [date, dayResults] of Object.entries(dateGroups)) {
      const total = dayResults.length;
      const passed = dayResults.filter((r) => r.status === "passed").length;
      const passRate = total > 0 ? (passed / total) * 100 : 0;
      const avgDuration =
        total > 0
          ? dayResults.reduce((sum, r) => sum + r.duration, 0) / total
          : 0;

      trends.push({
        date,
        passRate,
        avgDuration,
        totalTests: total,
      });
    }

    // Sort by date (oldest first)
    return trends.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Read JSONL file and parse results
   */
  private async readJSONLFile(filepath: string): Promise<TestResult[]> {
    const content = await readFile(filepath, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);

    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as TestResult;
        } catch (error) {
          console.warn(`Failed to parse line in ${filepath}: ${line}`);
          return null;
        }
      })
      .filter((r): r is TestResult => r !== null);
  }

  /**
   * Get relevant files based on filters
   */
  private async getRelevantFiles(filters: QueryFilters): Promise<string[]> {
    try {
      const files = await readdir(this.resultsDir);

      return files
        .filter((f) => f.endsWith(".jsonl"))
        .filter((f) => {
          // Filter by pillar if specified
          if (filters.pillar && !f.startsWith(filters.pillar)) {
            return false;
          }

          // Filter by environment if specified
          if (filters.environment && !f.includes(`-${filters.environment}-`)) {
            return false;
          }

          return true;
        })
        .map((f) => join(this.resultsDir, f));
    } catch {
      return [];
    }
  }

  /**
   * Check if result matches filters
   */
  private matchesFilters(result: TestResult, filters: QueryFilters): boolean {
    if (filters.status && result.status !== filters.status) {
      return false;
    }

    if (filters.user && result.user !== filters.user) {
      return false;
    }

    if (filters.dateFrom) {
      const resultDate = new Date(result.timestamp);
      if (resultDate < filters.dateFrom) {
        return false;
      }
    }

    if (filters.dateTo) {
      const resultDate = new Date(result.timestamp);
      if (resultDate > filters.dateTo) {
        return false;
      }
    }

    return true;
  }
}

// Export singleton instance
export const resultReader = new ResultReader();
