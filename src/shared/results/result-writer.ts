/**
 * Result Writer
 * Writes test results to JSONL (JSON Lines) format
 */

import {
  appendFile,
  writeFile,
  readFile,
  mkdir,
  rename,
  unlink,
} from "fs/promises";
import { resolve, join } from "path";
import type { TestResult, Pillar } from "../types/index.js";

export class ResultWriter {
  private resultsDir: string;

  constructor(resultsDir: string = "./results") {
    this.resultsDir = resolve(resultsDir);
  }

  /**
   * Write a single test result to JSONL file
   */
  async writeResult(result: TestResult): Promise<void> {
    const filename = this.getFilename(result.pillar, result.environment);

    try {
      // Ensure results directory exists
      await mkdir(this.resultsDir, { recursive: true });

      // Append result as JSON line
      const line = JSON.stringify(result) + "\n";
      await appendFile(filename, line);

      // Update index
      await this.updateIndex(result.pillar, result.environment);
    } catch (error) {
      throw new Error(`Failed to write result: ${(error as Error).message}`);
    }
  }

  /**
   * Write multiple test results in batch
   */
  async writeResults(results: TestResult[]): Promise<void> {
    if (results.length === 0) {
      return;
    }

    // Group results by pillar and environment
    const grouped = this.groupResults(results);

    for (const [key, groupResults] of Object.entries(grouped)) {
      const [pillar, environment] = key.split(":");
      const filename = this.getFilename(pillar as Pillar, environment);

      try {
        // Ensure results directory exists
        await mkdir(this.resultsDir, { recursive: true });

        // Write all results as JSON lines
        const lines =
          groupResults.map((r) => JSON.stringify(r)).join("\n") + "\n";
        await appendFile(filename, lines);

        // Update index
        await this.updateIndex(pillar as Pillar, environment);
      } catch (error) {
        throw new Error(
          `Failed to write results for ${pillar}/${environment}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Update results index for quick lookups
   */
  private async updateIndex(
    pillar: Pillar,
    environment: string,
  ): Promise<void> {
    const indexPath = join(this.resultsDir, "index.json");

    try {
      let index: Record<string, unknown> = {};

      // Load existing index. Distinguish "no index yet" (ENOENT → start fresh)
      // from a corrupt/unreadable existing file — clobbering a corrupt index
      // with {} would silently wipe every other pillar/env entry.
      let content: string | undefined;
      try {
        content = await readFile(indexPath, "utf-8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (content !== undefined) {
        const parsed = JSON.parse(content) as unknown;
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          throw new Error("existing index.json is not an object");
        }
        index = parsed as Record<string, unknown>;
      }

      const key = `${pillar}:${environment}`;
      const date = new Date().toISOString().split("T")[0];

      // Update index entry
      index[key] = {
        pillar,
        environment,
        lastUpdated: new Date().toISOString(),
        latestFile: this.getFilename(pillar, environment),
        date,
      };

      // Write atomically (temp + rename) so a crash/concurrent worker can't
      // leave a half-written index.json.
      const tmp = `${indexPath}.${process.pid}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(index, null, 2));
        await rename(tmp, indexPath);
      } catch (err) {
        // Don't leave an orphaned temp file behind when the write/rename fails.
        await unlink(tmp).catch(() => {});
        throw err;
      }
    } catch (error) {
      // Index update is non-critical, just log error
      console.warn(`Failed to update index: ${(error as Error).message}`);
    }
  }

  /**
   * Get filename for results
   */
  private getFilename(pillar: string, environment: string): string {
    const date = new Date().toISOString().split("T")[0];
    return join(this.resultsDir, `${pillar}-${environment}-${date}.jsonl`);
  }

  /**
   * Group results by pillar and environment
   */
  private groupResults(results: TestResult[]): Record<string, TestResult[]> {
    return results.reduce(
      (acc, result) => {
        const key = `${result.pillar}:${result.environment}`;
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(result);
        return acc;
      },
      {} as Record<string, TestResult[]>,
    );
  }
}

// Export singleton instance
export const resultWriter = new ResultWriter();
