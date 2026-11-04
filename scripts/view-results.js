#!/usr/bin/env node
/**
 * View JSONL test results
 * Shows summary, trends, and flaky tests
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "../results");

// Read all JSONL files
function readResults(pillar, environment, days = 7) {
  const filename = path.join(RESULTS_DIR, `${pillar}-${environment}.jsonl`);

  if (!fs.existsSync(filename)) {
    return [];
  }

  const content = fs.readFileSync(filename, "utf8");
  const lines = content
    .trim()
    .split("\n")
    .filter((line) => line);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  return lines
    .map((line) => JSON.parse(line))
    .filter((result) => new Date(result.timestamp) > cutoffDate);
}

// Calculate summary stats
function calculateStats(results) {
  const total = results.length;
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / total;

  return {
    total,
    passed,
    failed,
    skipped,
    avgDuration,
    passRate: ((passed / total) * 100).toFixed(1),
  };
}

// Find flaky tests (tests that sometimes pass, sometimes fail)
function findFlakyTests(results) {
  const testResults = {};

  results.forEach((result) => {
    if (!testResults[result.test]) {
      testResults[result.test] = { passed: 0, failed: 0, total: 0 };
    }
    testResults[result.test].total++;
    if (result.status === "passed") testResults[result.test].passed++;
    if (result.status === "failed") testResults[result.test].failed++;
  });

  return Object.entries(testResults)
    .filter(([test, stats]) => stats.passed > 0 && stats.failed > 0)
    .map(([test, stats]) => ({
      test,
      passRate: ((stats.passed / stats.total) * 100).toFixed(1),
      runs: stats.total,
    }))
    .sort((a, b) => parseFloat(a.passRate) - parseFloat(b.passRate));
}

// Performance trends
function getPerformanceTrends(results, testName) {
  return results
    .filter((r) => r.test === testName)
    .slice(-10) // Last 10 runs
    .map((r) => ({
      timestamp: new Date(r.timestamp).toLocaleString(),
      duration: r.duration,
      status: r.status,
    }));
}

// Main
const command = process.argv[2] || "summary";
const pillar = process.argv[3] || "synthetic";
const environment = process.argv[4] || "local";

console.log(`\n📊 Test Results - ${pillar}/${environment}\n`);

const results = readResults(pillar, environment);

if (results.length === 0) {
  console.log("No results found. Run some tests first!\n");
  process.exit(0);
}

if (command === "summary") {
  const stats = calculateStats(results);
  console.log(`Total Tests:    ${stats.total}`);
  console.log(`✅ Passed:      ${stats.passed} (${stats.passRate}%)`);
  console.log(`❌ Failed:      ${stats.failed}`);
  console.log(`⏭️  Skipped:     ${stats.skipped}`);
  console.log(`⏱️  Avg Duration: ${stats.avgDuration.toFixed(0)}ms\n`);

  // Recent failures
  const recentFailures = results.filter((r) => r.status === "failed").slice(-5);
  if (recentFailures.length > 0) {
    console.log("Recent Failures:");
    recentFailures.forEach((r) => {
      console.log(`  • ${r.test}`);
      if (r.error) console.log(`    ${r.error.substring(0, 80)}...`);
    });
    console.log();
  }
}

if (command === "flaky") {
  const flaky = findFlakyTests(results);
  if (flaky.length === 0) {
    console.log("✅ No flaky tests detected!\n");
  } else {
    console.log(`⚠️  Found ${flaky.length} flaky tests:\n`);
    flaky.forEach(({ test, passRate, runs }) => {
      console.log(`  ${passRate}% pass rate (${runs} runs)`);
      console.log(`  ${test}\n`);
    });
  }
}

if (command === "trends") {
  const testName = process.argv[5];
  if (!testName) {
    console.log(
      "Usage: node view-results.js trends <pillar> <environment> <testName>\n",
    );
    process.exit(1);
  }

  const trends = getPerformanceTrends(results, testName);
  console.log(`Performance trend for: ${testName}\n`);
  trends.forEach(({ timestamp, duration, status }) => {
    const statusIcon = status === "passed" ? "✅" : "❌";
    console.log(`${statusIcon} ${timestamp}: ${duration}ms`);
  });
  console.log();
}

console.log(`📁 Results file: results/${pillar}-${environment}.jsonl`);
console.log(`📅 Showing last 7 days\n`);
