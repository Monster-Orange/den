/**
 * Results Viewer
 * Display test results in CLI
 */

import Table from "cli-table3";
import chalk from "chalk";
import { resultReader } from "../../shared/results/result-reader.js";
import type {
  Pillar,
  Environment,
  TestResult,
} from "../../shared/types/index.js";

/** Journeys row metadata extracted from the JSONL row (all optional on the wire). */
interface JourneyRowMetadata {
  failureKind: string | null;
  frictionCount: number;
  snapshotCount: number;
  snapshotsDir: string | null;
}

export class ResultsViewer {
  /**
   * Display summary of recent results
   */
  async displaySummary(days: number = 7): Promise<void> {
    console.log(chalk.bold(`\n📊 Test Results Summary (Last ${days} days)`));
    console.log(chalk.gray("━".repeat(80)));

    const pillars: Pillar[] = [
      "synthetic",
      "integration",
      "performance",
      "journeys",
      "security",
    ];
    const environments: Environment[] = ["local", "dev", "sandbox", "staging"];

    for (const pillar of pillars) {
      console.log(chalk.bold(`\n${this.formatPillarName(pillar)}:`));

      const table = new Table({
        head: [
          chalk.cyan("Environment"),
          chalk.cyan("Total"),
          chalk.green("Passed"),
          chalk.red("Failed"),
          chalk.yellow("Skipped"),
          chalk.blue("Pass Rate"),
        ],
        style: {
          head: [],
          border: ["gray"],
        },
      });

      for (const env of environments) {
        const summary = await resultReader.getSummary(pillar, env, days);

        if (summary.total === 0) {
          continue; // Skip environments with no results
        }

        table.push([
          this.formatEnvironmentName(env),
          summary.total.toString(),
          chalk.green(summary.passed.toString()),
          summary.failed > 0
            ? chalk.red(summary.failed.toString())
            : chalk.gray("0"),
          summary.skipped > 0
            ? chalk.yellow(summary.skipped.toString())
            : chalk.gray("0"),
          this.formatPassRate(summary.passRate),
        ]);
      }

      if (table.length === 0) {
        console.log(chalk.gray("  No results found"));
      } else {
        console.log(table.toString());
      }
    }

    console.log(); // Empty line at end
  }

  /**
   * Display detailed results for specific pillar/environment
   */
  async displayDetailed(
    pillar: Pillar,
    environment: Environment,
    days: number = 7,
  ): Promise<void> {
    if (pillar === "journeys") {
      return this.displayJourneysDetailed(environment, days);
    }

    console.log(
      chalk.bold(
        `\n📋 Detailed Results: ${this.formatPillarName(pillar)} / ${this.formatEnvironmentName(environment)}`,
      ),
    );
    console.log(chalk.gray("━".repeat(80)));

    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const results = await resultReader.query({ pillar, environment, dateFrom });

    if (results.length === 0) {
      console.log(chalk.yellow("No results found"));
      return;
    }

    const table = new Table({
      head: [
        chalk.cyan("Test"),
        chalk.cyan("Status"),
        chalk.cyan("Duration"),
        chalk.cyan("User"),
        chalk.cyan("Time"),
      ],
      colWidths: [40, 10, 12, 20, 20],
      style: {
        head: [],
        border: ["gray"],
      },
      wordWrap: true,
    });

    // Show only recent 20 results
    const recentResults = results.slice(0, 20);

    for (const result of recentResults) {
      table.push([
        this.truncate(result.test, 38),
        this.formatStatus(result.status),
        this.formatDuration(result.duration),
        this.truncate(result.user, 18),
        this.formatTimestamp(result.timestamp),
      ]);
    }

    console.log(table.toString());

    if (results.length > 20) {
      console.log(chalk.gray(`\n... and ${results.length - 20} more results`));
    }

    // Show summary
    const summary = await resultReader.getSummary(pillar, environment, days);
    console.log(chalk.bold("\nSummary:"));
    console.log(`  Total:     ${summary.total}`);
    console.log(`  ${chalk.green("Passed:")}   ${summary.passed}`);
    console.log(`  ${chalk.red("Failed:")}   ${summary.failed}`);
    console.log(`  ${chalk.yellow("Skipped:")}  ${summary.skipped}`);
    console.log(`  Pass Rate: ${this.formatPassRate(summary.passRate)}`);
    console.log();
  }

  /**
   * Display journeys results — one row per journey run from the JSONL
   * rows, surfacing the deterministic verdict, failure_kind, friction
   * count, and the snapshots directory for the run.
   */
  async displayJourneysDetailed(
    environment: Environment,
    days: number = 7,
  ): Promise<void> {
    console.log(
      chalk.bold(
        `\n🧭 Journey Results: ${this.formatEnvironmentName(environment)}`,
      ),
    );
    console.log(chalk.gray("━".repeat(80)));

    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const results = await resultReader.query({
      pillar: "journeys",
      environment,
      dateFrom,
    });

    if (results.length === 0) {
      console.log(chalk.yellow("No results found"));
      return;
    }

    const table = new Table({
      head: [
        chalk.cyan("Journey"),
        chalk.cyan("Verdict"),
        chalk.cyan("Failure kind"),
        chalk.cyan("Friction"),
        chalk.cyan("Snapshots"),
        chalk.cyan("Time"),
      ],
      style: {
        head: [],
        border: ["gray"],
      },
      wordWrap: true,
    });

    const recentResults = results.slice(0, 20);
    for (const result of recentResults) {
      const meta = this.journeyRowMetadata(result);
      table.push([
        this.truncate(result.test, 38),
        this.formatStatus(result.status),
        meta.failureKind !== null
          ? chalk.red(meta.failureKind)
          : chalk.gray("—"),
        meta.frictionCount > 0
          ? chalk.yellow(meta.frictionCount.toString())
          : chalk.gray("0"),
        meta.snapshotsDir !== null
          ? `${meta.snapshotCount} · ${meta.snapshotsDir}`
          : meta.snapshotCount.toString(),
        this.formatTimestamp(result.timestamp),
      ]);
    }

    console.log(table.toString());

    if (results.length > 20) {
      console.log(chalk.gray(`\n... and ${results.length - 20} more results`));
    }

    const summary = await resultReader.getSummary(
      "journeys",
      environment,
      days,
    );
    console.log(chalk.bold("\nSummary:"));
    console.log(`  Total:     ${summary.total}`);
    console.log(`  ${chalk.green("Passed:")}   ${summary.passed}`);
    console.log(`  ${chalk.red("Failed:")}   ${summary.failed}`);
    console.log(`  Pass Rate: ${this.formatPassRate(summary.passRate)}`);
    console.log();
  }

  /**
   * Extract the journeys-specific metadata block from a JSONL row,
   * tolerating rows written by older den versions (missing fields
   * degrade to zero/absent — never a crash while browsing results).
   */
  private journeyRowMetadata(result: TestResult): JourneyRowMetadata {
    const metadata = result.metadata ?? {};
    const failureKind = metadata.failure_kind;
    const frictionPoints = metadata.friction_points;
    const snapshotCount = metadata.snapshot_count;
    const snapshotsDir = metadata.snapshots_dir;

    return {
      failureKind: typeof failureKind === "string" ? failureKind : null,
      frictionCount: Array.isArray(frictionPoints) ? frictionPoints.length : 0,
      snapshotCount: typeof snapshotCount === "number" ? snapshotCount : 0,
      snapshotsDir: typeof snapshotsDir === "string" ? snapshotsDir : null,
    };
  }

  /**
   * Display flaky tests
   */
  async displayFlakyTests(pillar: Pillar, days: number = 30): Promise<void> {
    console.log(
      chalk.bold(`\n⚠️  Flaky Tests: ${this.formatPillarName(pillar)}`),
    );
    console.log(chalk.gray("━".repeat(80)));

    const flakyTests = await resultReader.getFlakyTests(pillar, days);

    if (flakyTests.length === 0) {
      console.log(chalk.green("✓ No flaky tests found!"));
      return;
    }

    const table = new Table({
      head: [
        chalk.cyan("Test"),
        chalk.cyan("Runs"),
        chalk.cyan("Failures"),
        chalk.cyan("Flaky Rate"),
      ],
      colWidths: [50, 10, 12, 15],
      style: {
        head: [],
        border: ["gray"],
      },
      wordWrap: true,
    });

    for (const flaky of flakyTests) {
      table.push([
        this.truncate(flaky.test, 48),
        flaky.runs.toString(),
        chalk.red(flaky.failures.toString()),
        this.formatFlakyRate(flaky.flakyRate),
      ]);
    }

    console.log(table.toString());
    console.log();
  }

  /**
   * Format pillar name for display
   */
  private formatPillarName(pillar: Pillar): string {
    const names: Record<Pillar, string> = {
      synthetic: "🌐 Synthetic",
      integration: "🔗 Integration",
      performance: "⚡ Performance",
      smoke: "🔥 Smoke",
      journeys: "🧭 Journeys",
      security: "🛡 Security",
      suites: "🧪 Suites",
    };
    return names[pillar];
  }

  /**
   * Format environment name for display
   */
  private formatEnvironmentName(env: Environment): string {
    const names: Record<Environment, string> = {
      local: "🏠 Local",
      dev: "🔧 Dev",
      sandbox: "🏖️  Sandbox",
      staging: "🎭 Staging",
      beta: "🧪 Beta",
      prod: "🚀 Prod",
      production: "🚀 Production",
    };
    return names[env];
  }

  /**
   * Format test status with color
   */
  private formatStatus(status: "passed" | "failed" | "skipped"): string {
    switch (status) {
      case "passed":
        return chalk.green("✓ Passed");
      case "failed":
        return chalk.red("✗ Failed");
      case "skipped":
        return chalk.yellow("○ Skipped");
      default:
        return status;
    }
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    return `${(ms / 1000).toFixed(2)}s`;
  }

  /**
   * Format timestamp in relative time
   */
  private formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) {
      return "just now";
    } else if (diffMins < 60) {
      return `${diffMins}m ago`;
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else if (diffDays < 7) {
      return `${diffDays}d ago`;
    } else {
      return date.toLocaleDateString();
    }
  }

  /**
   * Format pass rate with color
   */
  private formatPassRate(rate: number): string {
    const rateStr = `${rate.toFixed(1)}%`;

    if (rate >= 95) {
      return chalk.green(rateStr);
    } else if (rate >= 80) {
      return chalk.yellow(rateStr);
    } else {
      return chalk.red(rateStr);
    }
  }

  /**
   * Format flaky rate with color
   */
  private formatFlakyRate(rate: number): string {
    const rateStr = `${rate.toFixed(1)}%`;

    if (rate >= 50) {
      return chalk.red(rateStr);
    } else if (rate >= 20) {
      return chalk.yellow(rateStr);
    } else {
      return chalk.gray(rateStr);
    }
  }

  /**
   * Truncate string with ellipsis
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) {
      return str;
    }
    return str.substring(0, maxLength - 3) + "...";
  }
}

// Export singleton instance
export const resultsViewer = new ResultsViewer();
