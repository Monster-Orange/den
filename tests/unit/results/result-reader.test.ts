/**
 * Tests for ResultReader
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { ResultWriter } from "../../../src/shared/results/result-writer.js";
import { ResultReader } from "../../../src/shared/results/result-reader.js";
import type { TestResult } from "../../../src/shared/types/index.js";

describe("ResultReader", () => {
  const testResultsDir = join(process.cwd(), "test-results-reader");
  let writer: ResultWriter;
  let reader: ResultReader;

  beforeEach(async () => {
    // Create test results directory
    await mkdir(testResultsDir, { recursive: true });
    writer = new ResultWriter(testResultsDir);
    reader = new ResultReader(testResultsDir);
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testResultsDir, { recursive: true, force: true });
  });

  describe("query", () => {
    it("should query all results when no filters provided", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test2.spec.ts",
          status: "failed",
          duration: 2000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const queried = await reader.query();
      expect(queried.length).toBe(2);
    });

    it("should filter results by pillar", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "integration",
          environment: "dev",
          test: "test2.spec.ts",
          status: "passed",
          duration: 2000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const queried = await reader.query({ pillar: "synthetic" });
      expect(queried.length).toBe(1);
      expect(queried[0].pillar).toBe("synthetic");
    });

    it("should filter results by environment", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "staging",
          test: "test2.spec.ts",
          status: "passed",
          duration: 2000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const queried = await reader.query({ environment: "staging" });
      expect(queried.length).toBe(1);
      expect(queried[0].environment).toBe("staging");
    });

    it("should filter results by status", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test2.spec.ts",
          status: "failed",
          duration: 2000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const queried = await reader.query({ status: "failed" });
      expect(queried.length).toBe(1);
      expect(queried[0].status).toBe("failed");
    });

    it("should filter results by user", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "alice@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test2.spec.ts",
          status: "passed",
          duration: 2000,
          user: "bob@example.com",
        },
      ];

      await writer.writeResults(results);

      const queried = await reader.query({ user: "alice@example.com" });
      expect(queried.length).toBe(1);
      expect(queried[0].user).toBe("alice@example.com");
    });

    it("should filter results by date range", async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const queried = await reader.query({
        dateFrom: yesterday,
        dateTo: tomorrow,
      });
      expect(queried.length).toBe(1);
    });

    it("should return empty array when no results match", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const queried = await reader.query({ environment: "staging" });
      expect(queried.length).toBe(0);
    });

    it("should sort results by timestamp (newest first)", async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 1000);

      const results: TestResult[] = [
        {
          timestamp: earlier.toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: now.toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test2.spec.ts",
          status: "passed",
          duration: 2000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const queried = await reader.query();
      expect(queried[0].test).toBe("test2.spec.ts"); // Newer test first
      expect(queried[1].test).toBe("test1.spec.ts");
    });
  });

  describe("getSummary", () => {
    it("should calculate summary statistics", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test2.spec.ts",
          status: "passed",
          duration: 2000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test3.spec.ts",
          status: "failed",
          duration: 3000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test4.spec.ts",
          status: "skipped",
          duration: 0,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const summary = await reader.getSummary("synthetic", "dev", 7);

      expect(summary.total).toBe(4);
      expect(summary.passed).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.duration).toBe(6000);
      expect(summary.passRate).toBe(50); // 2/4 = 50%
    });

    it("should return zero values for no results", async () => {
      const summary = await reader.getSummary("synthetic", "dev", 7);

      expect(summary.total).toBe(0);
      expect(summary.passed).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.passRate).toBe(0);
    });
  });

  describe("getFlakyTests", () => {
    it("should identify flaky tests", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "flaky-test.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "flaky-test.spec.ts",
          status: "failed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "flaky-test.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "stable-test.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const flakyTests = await reader.getFlakyTests("synthetic", 30);

      expect(flakyTests.length).toBe(1);
      expect(flakyTests[0].test).toBe("flaky-test.spec.ts");
      expect(flakyTests[0].runs).toBe(3);
      expect(flakyTests[0].failures).toBe(1);
      expect(flakyTests[0].flakyRate).toBeCloseTo(33.33, 1);
    });

    it("should not identify stable passing tests as flaky", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "stable-test.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "stable-test.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "stable-test.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const flakyTests = await reader.getFlakyTests("synthetic", 30);
      expect(flakyTests.length).toBe(0);
    });
  });

  describe("getTrends", () => {
    it("should calculate trend data by date", async () => {
      const results: TestResult[] = [
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test1.spec.ts",
          status: "passed",
          duration: 1000,
          user: "test@example.com",
        },
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "dev",
          test: "test2.spec.ts",
          status: "failed",
          duration: 2000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const trends = await reader.getTrends("synthetic", "dev", 7);

      expect(trends.length).toBeGreaterThan(0);
      expect(trends[0].passRate).toBe(50); // 1 passed, 1 failed
      expect(trends[0].avgDuration).toBe(1500); // (1000 + 2000) / 2
      expect(trends[0].totalTests).toBe(2);
    });

    it("should return empty array when no results", async () => {
      const trends = await reader.getTrends("synthetic", "dev", 7);
      expect(trends.length).toBe(0);
    });
  });
});
