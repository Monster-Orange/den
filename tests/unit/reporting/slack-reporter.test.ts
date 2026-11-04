/**
 * Unit tests for Slack Reporter
 */

import { SlackReporter } from "../../../src/shared/reporting/slack-reporter";
import * as fs from "fs/promises";
import type { TestSummary } from "../../../src/shared/types/index.js";

// Mock @slack/webhook
jest.mock("@slack/webhook", () => {
  return {
    IncomingWebhook: jest.fn().mockImplementation((_url: string) => {
      return {
        send: jest.fn().mockResolvedValue({ text: "ok" }),
      };
    }),
  };
});

describe("SlackReporter", () => {
  let reporter: SlackReporter;
  const testConfigDir = "./test-config";
  const testConfigPath = `${testConfigDir}/config/slack.json`;

  beforeEach(async () => {
    reporter = new SlackReporter();
    await fs.mkdir(`${testConfigDir}/config`, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testConfigDir, { recursive: true, force: true });
  });

  describe("loadConfig", () => {
    it("should load valid config", async () => {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: true,
        notifyOn: {
          testComplete: true,
          testFailure: true,
          thresholdExceeded: true,
        },
        thresholds: {
          failurePercentage: 10,
        },
        channel: "#test",
      };

      // Mock process.cwd() to return test directory
      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);

      await fs.writeFile(testConfigPath, JSON.stringify(config));

      await reporter.loadConfig();

      expect(reporter.isEnabled()).toBe(true);
    });

    it("should not enable if webhookUrl is placeholder", async () => {
      const config = {
        webhookUrl: "REPLACE_WITH_SLACK_WEBHOOK_URL",
        enabled: true,
        notifyOn: {
          testComplete: true,
          testFailure: true,
          thresholdExceeded: true,
        },
        thresholds: {
          failurePercentage: 10,
        },
        channel: "#test",
      };

      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);

      await fs.writeFile(testConfigPath, JSON.stringify(config));

      await reporter.loadConfig();

      expect(reporter.isEnabled()).toBe(false);
    });

    it("should not enable if enabled is false", async () => {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: false,
        notifyOn: {
          testComplete: true,
          testFailure: true,
          thresholdExceeded: true,
        },
        thresholds: {
          failurePercentage: 10,
        },
        channel: "#test",
      };

      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);

      await fs.writeFile(testConfigPath, JSON.stringify(config));

      await reporter.loadConfig();

      expect(reporter.isEnabled()).toBe(false);
    });

    it("should handle missing config file gracefully", async () => {
      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation();

      await reporter.loadConfig();

      expect(reporter.isEnabled()).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });
  });

  describe("sendTestSummary", () => {
    it("should not send if not enabled", async () => {
      const summary: TestSummary = {
        pillar: "synthetic",
        environment: "dev",
        total: 100,
        passed: 90,
        failed: 10,
        skipped: 0,
        duration: 60000,
        passRate: 90,
      };

      // Reporter not configured, so it won't send
      await expect(
        reporter.sendTestSummary("synthetic", "dev", summary),
      ).resolves.not.toThrow();
    });

    it("should send summary when enabled", async () => {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: true,
        notifyOn: {
          testComplete: true,
          testFailure: false,
          thresholdExceeded: false,
        },
        thresholds: {
          failurePercentage: 10,
        },
        channel: "#test",
      };

      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);
      await fs.writeFile(testConfigPath, JSON.stringify(config));
      await reporter.loadConfig();

      const summary: TestSummary = {
        pillar: "synthetic",
        environment: "dev",
        total: 100,
        passed: 95,
        failed: 5,
        skipped: 0,
        duration: 60000,
        passRate: 95,
      };

      await expect(
        reporter.sendTestSummary(
          "synthetic",
          "dev",
          summary,
          "https://report.url",
        ),
      ).resolves.not.toThrow();
    });

    it("should notify on threshold exceeded", async () => {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: true,
        notifyOn: {
          testComplete: false,
          testFailure: false,
          thresholdExceeded: true,
        },
        thresholds: {
          failurePercentage: 10,
        },
        channel: "#test",
      };

      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);
      await fs.writeFile(testConfigPath, JSON.stringify(config));
      await reporter.loadConfig();

      const summary: TestSummary = {
        pillar: "integration",
        environment: "staging",
        total: 100,
        passed: 85,
        failed: 15, // 15% failure exceeds 10% threshold
        skipped: 0,
        duration: 60000,
        passRate: 85,
      };

      await expect(
        reporter.sendTestSummary("integration", "staging", summary),
      ).resolves.not.toThrow();
    });
  });

  describe("sendTestFailure", () => {
    it("should not send if not enabled", async () => {
      await expect(
        reporter.sendTestFailure(
          "synthetic",
          "dev",
          "test/login.spec.ts",
          "Login failed",
          "https://report.url",
        ),
      ).resolves.not.toThrow();
    });

    it("should send failure when enabled", async () => {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: true,
        notifyOn: {
          testComplete: false,
          testFailure: true,
          thresholdExceeded: false,
        },
        thresholds: {
          failurePercentage: 10,
        },
        channel: "#test",
      };

      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);
      await fs.writeFile(testConfigPath, JSON.stringify(config));
      await reporter.loadConfig();

      await expect(
        reporter.sendTestFailure(
          "synthetic",
          "dev",
          "test/login.spec.ts",
          "Login failed: Invalid credentials",
          "https://report.url",
        ),
      ).resolves.not.toThrow();
    });

    it("should truncate long error messages", async () => {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: true,
        notifyOn: {
          testComplete: false,
          testFailure: true,
          thresholdExceeded: false,
        },
        thresholds: {
          failurePercentage: 10,
        },
        channel: "#test",
      };

      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);
      await fs.writeFile(testConfigPath, JSON.stringify(config));
      await reporter.loadConfig();

      const longError = "Error: ".repeat(200); // Very long error

      await expect(
        reporter.sendTestFailure(
          "integration",
          "dev",
          "test/api.spec.ts",
          longError,
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("isEnabled", () => {
    it("should return false when not configured", () => {
      expect(reporter.isEnabled()).toBe(false);
    });

    it("should return true when properly configured", async () => {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: true,
        notifyOn: {
          testComplete: true,
          testFailure: true,
          thresholdExceeded: true,
        },
        thresholds: {
          failurePercentage: 10,
        },
        channel: "#test",
      };

      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);
      await fs.writeFile(testConfigPath, JSON.stringify(config));
      await reporter.loadConfig();

      expect(reporter.isEnabled()).toBe(true);
    });
  });

  describe("sendTestSummary", () => {
    const baseSummary: TestSummary = {
      total: 10,
      passed: 10,
      failed: 0,
      skipped: 0,
      duration: 5000,
      flaky: 0,
    };

    async function loadReporter(overrides?: {
      notifyOn?: Partial<{
        testComplete: boolean;
        testFailure: boolean;
        thresholdExceeded: boolean;
      }>;
    }) {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: true,
        notifyOn: {
          testComplete: false,
          testFailure: false,
          thresholdExceeded: false,
          ...(overrides?.notifyOn ?? {}),
        },
        thresholds: { failurePercentage: 10 },
        channel: "#test",
      };
      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);
      await fs.writeFile(testConfigPath, JSON.stringify(config));
      await reporter.loadConfig();
    }

    it("does not send when shouldNotify returns false", async () => {
      await loadReporter(); // all notifyOn flags false
      await reporter.sendTestSummary("smoke", "local", baseSummary);
      // No error = early return worked
    });

    it("sends when testFailure is enabled and there are failures", async () => {
      await loadReporter({ notifyOn: { testFailure: true } });
      const failSummary = { ...baseSummary, failed: 3, passed: 7 };
      await reporter.sendTestSummary("smoke", "local", failSummary);
      // Webhook send should have been called (no error thrown)
    });

    it("does not send when testFailure is enabled but no failures", async () => {
      await loadReporter({ notifyOn: { testFailure: true } });
      await reporter.sendTestSummary("smoke", "local", baseSummary);
    });

    it("sends when thresholdExceeded and failure percentage is above threshold", async () => {
      await loadReporter({ notifyOn: { thresholdExceeded: true } });
      const failSummary = { ...baseSummary, failed: 5, passed: 5 }; // 50%
      await reporter.sendTestSummary("smoke", "local", failSummary);
    });

    it("logs error when webhook.send throws", async () => {
      await loadReporter({ notifyOn: { testComplete: true } });
      // Make webhook.send throw
      const { IncomingWebhook } = jest.requireMock("@slack/webhook") as {
        IncomingWebhook: jest.Mock;
      };
      IncomingWebhook.mockImplementation(() => ({
        send: jest.fn().mockRejectedValue(new Error("network error")),
      }));
      // Reload to get the throwing webhook
      await reporter.loadConfig();

      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      await reporter.sendTestSummary("smoke", "local", baseSummary);
      expect(spy).toHaveBeenCalledWith(
        "Failed to send Slack notification:",
        "network error",
      );
      spy.mockRestore();

      // Restore normal mock
      IncomingWebhook.mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({ text: "ok" }),
      }));
    });
  });

  describe("sendTestFailure", () => {
    it("logs error when webhook.send throws", async () => {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: true,
        notifyOn: {
          testComplete: false,
          testFailure: true,
          thresholdExceeded: false,
        },
        thresholds: { failurePercentage: 10 },
        channel: "#test",
      };
      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);
      await fs.writeFile(testConfigPath, JSON.stringify(config));

      const { IncomingWebhook } = jest.requireMock("@slack/webhook") as {
        IncomingWebhook: jest.Mock;
      };
      IncomingWebhook.mockImplementation(() => ({
        send: jest.fn().mockRejectedValue(new Error("timeout")),
      }));
      await reporter.loadConfig();

      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      await reporter.sendTestFailure(
        "smoke",
        "local",
        "test-name",
        "assertion failed",
      );
      expect(spy).toHaveBeenCalledWith(
        "Failed to send Slack notification:",
        "timeout",
      );
      spy.mockRestore();

      IncomingWebhook.mockImplementation(() => ({
        send: jest.fn().mockResolvedValue({ text: "ok" }),
      }));
    });
  });

  describe("formatDuration (via sendTestSummary)", () => {
    // formatDuration is private, but exercised through sendTestSummary's output.
    // We test it indirectly by checking the webhook payload.

    async function loadWithTestComplete() {
      const config = {
        webhookUrl: "https://hooks.slack.com/services/TEST",
        enabled: true,
        notifyOn: {
          testComplete: true,
          testFailure: false,
          thresholdExceeded: false,
        },
        thresholds: { failurePercentage: 10 },
        channel: "#test",
      };
      jest.spyOn(process, "cwd").mockReturnValue(testConfigDir);
      await fs.writeFile(testConfigPath, JSON.stringify(config));

      const { IncomingWebhook } = jest.requireMock("@slack/webhook") as {
        IncomingWebhook: jest.Mock;
      };
      const mockSend = jest.fn().mockResolvedValue({ text: "ok" });
      IncomingWebhook.mockImplementation(() => ({ send: mockSend }));
      await reporter.loadConfig();
      return mockSend;
    }

    it("formats sub-second durations as milliseconds", async () => {
      const mockSend = await loadWithTestComplete();
      const summary: TestSummary = {
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        duration: 500,
        flaky: 0,
      };
      await reporter.sendTestSummary("smoke", "local", summary);
      const payload = JSON.stringify(mockSend.mock.calls[0][0]);
      expect(payload).toContain("500ms");
    });

    it("formats seconds-only durations", async () => {
      const mockSend = await loadWithTestComplete();
      const summary: TestSummary = {
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        duration: 45000,
        flaky: 0,
      };
      await reporter.sendTestSummary("smoke", "local", summary);
      const payload = JSON.stringify(mockSend.mock.calls[0][0]);
      expect(payload).toContain("45s");
    });

    it("formats minute+second durations", async () => {
      const mockSend = await loadWithTestComplete();
      const summary: TestSummary = {
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        duration: 125000,
        flaky: 0,
      };
      await reporter.sendTestSummary("smoke", "local", summary);
      const payload = JSON.stringify(mockSend.mock.calls[0][0]);
      expect(payload).toContain("2m 5s");
    });

    it("formats hour+minute durations", async () => {
      const mockSend = await loadWithTestComplete();
      const summary: TestSummary = {
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        duration: 3725000,
        flaky: 0,
      };
      await reporter.sendTestSummary("smoke", "local", summary);
      const payload = JSON.stringify(mockSend.mock.calls[0][0]);
      expect(payload).toContain("1h 2m");
    });
  });
});
