/**
 * Slack Reporter
 * Sends test results to Slack via webhook
 */

import { readBrand } from "../brand.js";
import { IncomingWebhook, IncomingWebhookSendArguments } from "@slack/webhook";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { TestSummary, Pillar } from "../types/index.js";

export interface SlackConfig {
  webhookUrl: string;
  enabled: boolean;
  notifyOn: {
    testComplete: boolean;
    testFailure: boolean;
    thresholdExceeded: boolean;
  };
  thresholds: {
    failurePercentage: number;
  };
  channel: string;
}

export class SlackReporter {
  private webhook: IncomingWebhook | null = null;
  private config: SlackConfig | null = null;

  /**
   * Load Slack configuration
   */
  async loadConfig(): Promise<void> {
    // cwd-derived path is READ-ONLY: optional notify config lookup; nothing is
    // ever written here (and the unit test pins cwd via jest).
    const configPath = resolve(process.cwd(), "config/slack.json");

    try {
      const content = await readFile(configPath, "utf-8");
      this.config = JSON.parse(content);

      if (
        this.config?.enabled &&
        this.config.webhookUrl !== "REPLACE_WITH_SLACK_WEBHOOK_URL"
      ) {
        this.webhook = new IncomingWebhook(this.config.webhookUrl);
      }
    } catch (error) {
      console.warn("Failed to load Slack config:", (error as Error).message);
    }
  }

  /**
   * Check if Slack reporting is enabled and configured
   */
  isEnabled(): boolean {
    return this.webhook !== null && this.config !== null && this.config.enabled;
  }

  /**
   * Send test summary to Slack
   */
  async sendTestSummary(
    pillar: Pillar,
    environment: string,
    summary: TestSummary,
    reportUrl?: string,
  ): Promise<void> {
    if (!this.isEnabled() || !this.config) {
      return;
    }

    const failurePercentage =
      summary.total > 0 ? (summary.failed / summary.total) * 100 : 0;
    const shouldNotify = this.shouldNotify(summary, failurePercentage);

    if (!shouldNotify) {
      return;
    }

    const message = this.formatTestSummary(
      pillar,
      environment,
      summary,
      reportUrl,
    );

    try {
      await this.webhook!.send(message);
    } catch (error) {
      console.error(
        "Failed to send Slack notification:",
        (error as Error).message,
      );
    }
  }

  /**
   * Send test failure notification
   */
  async sendTestFailure(
    pillar: Pillar,
    environment: string,
    testName: string,
    errorMessage: string,
    reportUrl?: string,
  ): Promise<void> {
    if (!this.isEnabled() || !this.config?.notifyOn.testFailure) {
      return;
    }

    const message = this.formatTestFailure(
      pillar,
      environment,
      testName,
      errorMessage,
      reportUrl,
    );

    try {
      await this.webhook!.send(message);
    } catch (error) {
      console.error(
        "Failed to send Slack notification:",
        (error as Error).message,
      );
    }
  }

  /**
   * Determine if we should send notification based on config
   */
  private shouldNotify(
    summary: TestSummary,
    failurePercentage: number,
  ): boolean {
    if (!this.config) {
      return false;
    }

    // Always notify on threshold exceeded
    if (
      this.config.notifyOn.thresholdExceeded &&
      failurePercentage >= this.config.thresholds.failurePercentage
    ) {
      return true;
    }

    // Notify on test complete if enabled
    if (this.config.notifyOn.testComplete) {
      return true;
    }

    // Notify on any failure if enabled
    if (this.config.notifyOn.testFailure && summary.failed > 0) {
      return true;
    }

    return false;
  }

  /**
   * Format test summary as Slack message
   */
  private formatTestSummary(
    pillar: Pillar,
    environment: string,
    summary: TestSummary,
    reportUrl?: string,
  ): IncomingWebhookSendArguments {
    const passPercentage = (
      summary.total > 0 ? (summary.passed / summary.total) * 100 : 0
    ).toFixed(1);
    const emoji = summary.failed === 0 ? ":white_check_mark:" : ":warning:";
    const color = summary.failed === 0 ? "#36a64f" : "#ff9800";

    return {
      username: `${readBrand().name} E2E`,
      icon_emoji: ":robot_face:",
      channel: this.config?.channel,
      attachments: [
        {
          color,
          title: `${emoji} ${this.formatPillar(pillar)} Tests - ${environment}`,
          fields: [
            {
              title: "Status",
              value:
                summary.failed === 0
                  ? "All Passed"
                  : `${summary.failed} Failed`,
              short: true,
            },
            {
              title: "Pass Rate",
              value: `${passPercentage}%`,
              short: true,
            },
            {
              title: "Total Tests",
              value: summary.total.toString(),
              short: true,
            },
            {
              title: "Duration",
              value: this.formatDuration(summary.duration),
              short: true,
            },
            {
              title: "Passed",
              value: summary.passed.toString(),
              short: true,
            },
            {
              title: "Failed",
              value: summary.failed.toString(),
              short: true,
            },
            {
              title: "Skipped",
              value: summary.skipped.toString(),
              short: true,
            },
            {
              title: "Environment",
              value: environment,
              short: true,
            },
          ],
          footer: `${readBrand().name} E2E`,
          ts: Math.floor(Date.now() / 1000).toString(),
        },
      ],
      ...(reportUrl && {
        text: `<${reportUrl}|View Full Report>`,
      }),
    };
  }

  /**
   * Format test failure as Slack message
   */
  private formatTestFailure(
    pillar: Pillar,
    environment: string,
    testName: string,
    errorMessage: string,
    reportUrl?: string,
  ): IncomingWebhookSendArguments {
    return {
      username: `${readBrand().name} E2E`,
      icon_emoji: ":robot_face:",
      channel: this.config?.channel,
      attachments: [
        {
          color: "#d32f2f",
          title: `:x: Test Failure - ${this.formatPillar(pillar)}`,
          fields: [
            {
              title: "Environment",
              value: environment,
              short: true,
            },
            {
              title: "Test",
              value: testName,
              short: true,
            },
            {
              title: "Error",
              value: this.truncateError(errorMessage),
              short: false,
            },
          ],
          footer: `${readBrand().name} E2E`,
          ts: Math.floor(Date.now() / 1000).toString(),
        },
      ],
      ...(reportUrl && {
        text: `<${reportUrl}|View Full Report>`,
      }),
    };
  }

  /**
   * Format pillar name for display
   */
  private formatPillar(pillar: Pillar): string {
    const pillarNames: Record<Pillar, string> = {
      synthetic: "Synthetic (Browser)",
      integration: "Integration (API)",
      performance: "Performance (Load)",
      smoke: "Smoke",
      journeys: "Journeys (Agent E2E)",
      security: "Security (OWASP ZAP)",
      suites: "Repo suites",
    };

    return pillarNames[pillar] || pillar;
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m`;
    }

    if (minutes > 0) {
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds}s`;
    }

    return `${seconds}s`;
  }

  /**
   * Truncate error message if too long
   */
  private truncateError(error: string, maxLength: number = 500): string {
    if (error.length <= maxLength) {
      return error;
    }

    return error.substring(0, maxLength) + "...";
  }
}

// Export singleton instance
export const slackReporter = new SlackReporter();
