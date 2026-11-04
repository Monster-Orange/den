/**
 * Tests for ResultWriter
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdir, rm, readFile, readdir } from "fs/promises";
import { join } from "path";
import { ResultWriter } from "../../../src/shared/results/result-writer.js";
import type { TestResult } from "../../../src/shared/types/index.js";

describe("ResultWriter", () => {
  const testResultsDir = join(process.cwd(), "test-results-writer");
  let writer: ResultWriter;

  beforeEach(async () => {
    // Create test results directory
    await mkdir(testResultsDir, { recursive: true });
    writer = new ResultWriter(testResultsDir);
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testResultsDir, { recursive: true, force: true });
  });

  describe("writeResult", () => {
    it("should write result to JSONL file", async () => {
      const result: TestResult = {
        timestamp: new Date().toISOString(),
        pillar: "synthetic",
        environment: "dev",
        test: "auth/login.spec.ts",
        status: "passed",
        duration: 1234,
        user: "test@example.com",
      };

      await writer.writeResult(result);

      const files = await readdir(testResultsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      expect(jsonlFiles.length).toBe(1);
      expect(jsonlFiles[0]).toMatch(/synthetic-dev-\d{4}-\d{2}-\d{2}\.jsonl/);
    });

    it("should write valid JSONL format", async () => {
      const result: TestResult = {
        timestamp: new Date().toISOString(),
        pillar: "synthetic",
        environment: "dev",
        test: "auth/login.spec.ts",
        status: "passed",
        duration: 1234,
        user: "test@example.com",
      };

      await writer.writeResult(result);

      const files = await readdir(testResultsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      const content = await readFile(
        join(testResultsDir, jsonlFiles[0]),
        "utf-8",
      );

      const parsed = JSON.parse(content.trim());
      expect(parsed.test).toBe("auth/login.spec.ts");
      expect(parsed.status).toBe("passed");
      expect(parsed.duration).toBe(1234);
    });

    it("should append to existing file", async () => {
      const result1: TestResult = {
        timestamp: new Date().toISOString(),
        pillar: "synthetic",
        environment: "dev",
        test: "test1.spec.ts",
        status: "passed",
        duration: 1000,
        user: "test@example.com",
      };

      const result2: TestResult = {
        timestamp: new Date().toISOString(),
        pillar: "synthetic",
        environment: "dev",
        test: "test2.spec.ts",
        status: "failed",
        duration: 2000,
        user: "test@example.com",
      };

      await writer.writeResult(result1);
      await writer.writeResult(result2);

      const files = await readdir(testResultsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      expect(jsonlFiles.length).toBe(1);

      const content = await readFile(
        join(testResultsDir, jsonlFiles[0]),
        "utf-8",
      );
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(2);

      const parsed1 = JSON.parse(lines[0]);
      const parsed2 = JSON.parse(lines[1]);

      expect(parsed1.test).toBe("test1.spec.ts");
      expect(parsed2.test).toBe("test2.spec.ts");
    });

    it("should handle results with optional fields", async () => {
      const result: TestResult = {
        timestamp: new Date().toISOString(),
        pillar: "synthetic",
        environment: "dev",
        test: "failing-test.spec.ts",
        status: "failed",
        duration: 5000,
        user: "test@example.com",
        error: "Assertion failed",
        screenshot: "./screenshots/fail-123.png",
        trace: "./traces/trace-123.zip",
        metadata: { retries: 3, browser: "chromium" },
      };

      await writer.writeResult(result);

      const files = await readdir(testResultsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      const content = await readFile(
        join(testResultsDir, jsonlFiles[0]),
        "utf-8",
      );

      const parsed = JSON.parse(content.trim());
      expect(parsed.error).toBe("Assertion failed");
      expect(parsed.screenshot).toBe("./screenshots/fail-123.png");
      expect(parsed.metadata.browser).toBe("chromium");
    });

    it("should create results directory if it does not exist", async () => {
      // Remove the test directory
      await rm(testResultsDir, { recursive: true, force: true });

      const result: TestResult = {
        timestamp: new Date().toISOString(),
        pillar: "synthetic",
        environment: "dev",
        test: "test.spec.ts",
        status: "passed",
        duration: 1000,
        user: "test@example.com",
      };

      await writer.writeResult(result);

      const files = await readdir(testResultsDir);
      expect(files.length).toBeGreaterThan(0);
    });
  });

  describe("writeResults", () => {
    it("should write multiple results in batch", async () => {
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
      ];

      await writer.writeResults(results);

      const files = await readdir(testResultsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      expect(jsonlFiles.length).toBe(1);

      const content = await readFile(
        join(testResultsDir, jsonlFiles[0]),
        "utf-8",
      );
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(3);
    });

    it("should group results by pillar and environment", async () => {
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
        {
          timestamp: new Date().toISOString(),
          pillar: "synthetic",
          environment: "staging",
          test: "test3.spec.ts",
          status: "passed",
          duration: 3000,
          user: "test@example.com",
        },
      ];

      await writer.writeResults(results);

      const files = await readdir(testResultsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      // Should create 3 files: synthetic-dev, integration-dev, synthetic-staging
      expect(jsonlFiles.length).toBe(3);
      expect(jsonlFiles.some((f) => f.includes("synthetic-dev"))).toBe(true);
      expect(jsonlFiles.some((f) => f.includes("integration-dev"))).toBe(true);
      expect(jsonlFiles.some((f) => f.includes("synthetic-staging"))).toBe(
        true,
      );
    });

    it("should handle empty results array", async () => {
      await writer.writeResults([]);

      const files = await readdir(testResultsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

      expect(jsonlFiles.length).toBe(0);
    });
  });

  describe("index file", () => {
    it("should create index file", async () => {
      const result: TestResult = {
        timestamp: new Date().toISOString(),
        pillar: "synthetic",
        environment: "dev",
        test: "test.spec.ts",
        status: "passed",
        duration: 1000,
        user: "test@example.com",
      };

      await writer.writeResult(result);

      const files = await readdir(testResultsDir);
      expect(files).toContain("index.json");
    });

    it("should update index with latest info", async () => {
      const result: TestResult = {
        timestamp: new Date().toISOString(),
        pillar: "synthetic",
        environment: "dev",
        test: "test.spec.ts",
        status: "passed",
        duration: 1000,
        user: "test@example.com",
      };

      await writer.writeResult(result);

      const indexContent = await readFile(
        join(testResultsDir, "index.json"),
        "utf-8",
      );
      const index = JSON.parse(indexContent);

      expect(index["synthetic:dev"]).toBeDefined();
      expect(index["synthetic:dev"].pillar).toBe("synthetic");
      expect(index["synthetic:dev"].environment).toBe("dev");
      expect(index["synthetic:dev"].lastUpdated).toBeDefined();
    });
  });
});
