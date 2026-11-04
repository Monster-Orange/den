import { describe, expect, it } from "@jest/globals";
import {
  buildReportPaneModel,
  getNextReportViewOnPillarChange,
  renderPerfReportHtml,
} from "../../../src/ui/server/public/perf-report.js";

describe("buildReportPaneModel", () => {
  it("defaults performance runs to the rendered report view", () => {
    expect(
      buildReportPaneModel({
        pillar: "performance",
        selectedView: "rendered",
        perfReportUrl: "/api/perf-report/current",
      }),
    ).toEqual({
      title: "Performance Report",
      activeView: "rendered",
      openUrl: "/api/perf-report/current",
      tabsVisible: true,
      emptyMessage: "Run performance tests to see the rendered report",
    });
  });

  it("gives journeys a raw-output pane instead of the Playwright report", () => {
    expect(
      buildReportPaneModel({
        pillar: "journeys",
        selectedView: "playwright",
      }),
    ).toEqual({
      title: "Journeys Output",
      activeView: "raw",
      openUrl: null,
      tabsVisible: false,
      emptyMessage:
        "Run journeys to see run output; per-run reports land under reports/journeys/",
    });
  });

  it("gives security a raw-output pane instead of the Playwright report", () => {
    expect(
      buildReportPaneModel({
        pillar: "security",
        selectedView: "playwright",
      }),
    ).toMatchObject({
      title: "Security Scan Output",
      activeView: "raw",
      openUrl: null,
      tabsVisible: false,
    });
  });

  it("keeps non-performance pillars on the Playwright report view", () => {
    expect(
      buildReportPaneModel({
        pillar: "smoke",
        selectedView: "raw",
      }),
    ).toEqual({
      title: "Playwright Report",
      activeView: "playwright",
      openUrl: "/report/",
      tabsVisible: false,
      emptyMessage: "Run tests to see the Playwright report",
    });
  });
});

describe("getNextReportViewOnPillarChange", () => {
  it("preserves the current perf view when switching away from performance", () => {
    expect(
      getNextReportViewOnPillarChange({
        currentPillar: "performance",
        nextPillar: "smoke",
        currentReportView: "rendered",
      }),
    ).toBe("rendered");
  });

  it("restores the rendered perf view when returning from a non-performance pillar", () => {
    expect(
      getNextReportViewOnPillarChange({
        currentPillar: "smoke",
        nextPillar: "performance",
        currentReportView: "playwright",
      }),
    ).toBe("rendered");
  });

  it("keeps the raw perf view selected when returning to performance", () => {
    expect(
      getNextReportViewOnPillarChange({
        currentPillar: "smoke",
        nextPillar: "performance",
        currentReportView: "raw",
      }),
    ).toBe("raw");
  });
});

describe("renderPerfReportHtml", () => {
  it("renders all requested performance report sections", () => {
    const html = renderPerfReportHtml({
      pillar: "performance",
      environment: "staging",
      status: "failed",
      startedAt: "2026-03-19T12:00:00.000Z",
      finishedAt: "2026-03-19T12:01:00.000Z",
      rawArtifacts: [],
      modules: [
        {
          module: "sample-service/search",
          status: "failed",
          thresholds: [
            {
              metric: "http_req_failed",
              name: "http_req_failed:rate<0.01",
              expression: "rate<0.01",
              passed: false,
              actualValue: 0.12,
            },
          ],
          coreMetrics: [{ label: "HTTP requests", value: 120 }],
          latencyMetrics: [{ label: "HTTP p95", value: 210, unit: "ms" }],
          throughputMetrics: [{ label: "Requests / sec", value: 4 }],
          scenarios: [
            {
              name: "search",
              executor: "constant-vus",
              options: { vus: 5, duration: "30s" },
            },
          ],
          checks: [
            {
              name: "status is 200",
              passes: 118,
              fails: 2,
              passRate: 118 / 120,
            },
          ],
          customMetrics: [
            {
              key: "search_duration",
              label: "search duration",
              values: { avg: 98.2, "p(95)": 150 },
              thresholds: [],
              isCustom: true,
            },
          ],
          rawArtifacts: [
            {
              kind: "k6-summary",
              path: ".perf-report/current/sample-service-search.summary.json",
            },
          ],
        },
      ],
    });

    expect(html).toContain("Summary");
    expect(html).toContain("Thresholds");
    expect(html).toContain("Latency");
    expect(html).toContain("Throughput &amp; Errors");
    expect(html).toContain("Scenarios");
    expect(html).toContain("Checks");
    expect(html).toContain("Custom Metrics");
    expect(html).toContain("sample-service/search");
    expect(html).toContain("http_req_failed");
    expect(html).toContain("search_duration");
    expect(html).toContain("avg: 98.2");
    expect(html).toContain("p(95): 150");
  });

  it("renders modules as collapsible details and expands failed modules by default", () => {
    const html = renderPerfReportHtml({
      pillar: "performance",
      environment: "local",
      status: "failed",
      rawArtifacts: [],
      modules: [
        {
          module: "sample-service/search",
          status: "failed",
          thresholds: [],
          coreMetrics: [],
          latencyMetrics: [],
          throughputMetrics: [],
          scenarios: [],
          checks: [],
          customMetrics: [],
          rawArtifacts: [],
        },
        {
          module: "api-health",
          status: "passed",
          thresholds: [],
          coreMetrics: [],
          latencyMetrics: [],
          throughputMetrics: [],
          scenarios: [],
          checks: [],
          customMetrics: [],
          rawArtifacts: [],
        },
      ],
    });

    expect(html).toContain('<details class="perf-module" open>');
    expect(html).toContain('<summary class="perf-module-header">');
    expect(html).toContain('class="perf-module-toggle"');
    expect(html).toContain("sample-service/search");
    expect(html).toContain("api-health");
  });

  it("renders friendly fallbacks for missing metric values", () => {
    const html = renderPerfReportHtml({
      pillar: "performance",
      environment: "local",
      status: "failed",
      rawArtifacts: [],
      modules: [
        {
          module: "sample-service/search",
          status: "failed",
          thresholds: [
            {
              metric: "search_duration",
              name: "search_duration:p(95)<2500",
              expression: "p(95)<2500",
              passed: false,
              actualValue: null,
            },
          ],
          coreMetrics: [],
          latencyMetrics: [],
          throughputMetrics: [],
          scenarios: [],
          checks: [],
          customMetrics: [
            {
              key: "search_duration",
              label: "search duration",
              values: {},
              thresholds: [],
              isCustom: true,
            },
          ],
          rawArtifacts: [],
        },
      ],
    });

    expect(html).toContain("No metric values captured");
    expect(html).toContain("—");
  });

  it("formats noisy decimals, rates, and custom metric chip order for readability", () => {
    const html = renderPerfReportHtml({
      pillar: "performance",
      environment: "local",
      status: "failed",
      rawArtifacts: [],
      modules: [
        {
          module: "sample-service/search",
          status: "failed",
          thresholds: [
            {
              metric: "http_req_failed",
              name: "http_req_failed:rate<0.01",
              expression: "rate<0.01",
              passed: false,
              actualValue: 0.123456,
            },
          ],
          coreMetrics: [{ label: "HTTP requests", value: 291 }],
          latencyMetrics: [
            { label: "HTTP avg", value: 66.51074226804126, unit: "ms" },
          ],
          throughputMetrics: [
            { label: "Requests / sec", value: 4.709674169493908 },
            { label: "Failure rate", value: 0.123456 },
          ],
          scenarios: [],
          checks: [],
          customMetrics: [
            {
              key: "search_duration",
              label: "search duration",
              values: {
                max: 224.144,
                avg: 89.988673,
                "p(95)": 179.23,
                min: 21.269,
                med: 79.9725,
              },
              thresholds: [],
              isCustom: true,
            },
          ],
          rawArtifacts: [],
        },
      ],
    });

    expect(html).toContain("66.51 ms");
    expect(html).toContain("4.71");
    expect(html).toContain("12.35%");
    expect(html).toContain("12.35%");

    const avgIndex = html.indexOf("avg: 89.99");
    const medIndex = html.indexOf("med: 79.97");
    const p95Index = html.indexOf("p(95): 179.23");
    const minIndex = html.indexOf("min: 21.27");
    const maxIndex = html.indexOf("max: 224.14");

    expect(avgIndex).toBeGreaterThan(-1);
    expect(medIndex).toBeGreaterThan(avgIndex);
    expect(p95Index).toBeGreaterThan(medIndex);
    expect(minIndex).toBeGreaterThan(p95Index);
    expect(maxIndex).toBeGreaterThan(minIndex);
  });
});
