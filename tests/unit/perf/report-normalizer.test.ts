import { describe, expect, it } from "@jest/globals";
import {
  buildPerfRunReport,
  normalizeK6Summary,
} from "../../../src/shared/perf/report-normalizer.js";

describe("normalizeK6Summary", () => {
  const summary = {
    root_group: {
      checks: [
        { name: "status is 200", passes: 118, fails: 2 },
        { name: "body includes id", passes: 120, fails: 0 },
      ],
    },
    options: {
      scenarios: {
        smoke: {
          executor: "constant-vus",
          vus: 5,
          duration: "30s",
          gracefulStop: "5s",
        },
      },
    },
    metrics: {
      http_reqs: {
        type: "counter",
        contains: "default",
        values: { count: 120, rate: 4 },
      },
      http_req_failed: {
        type: "rate",
        contains: "default",
        values: { rate: 0.0167 },
        thresholds: { "rate<0.05": true },
      },
      http_req_duration: {
        type: "trend",
        contains: "time",
        values: {
          avg: 123.4,
          med: 110,
          "p(95)": 210,
          "p(99)": 280,
          max: 410,
        },
        thresholds: { "p(95)<300": true },
      },
      iterations: {
        type: "counter",
        contains: "default",
        values: { count: 60, rate: 2 },
      },
      vus: {
        type: "gauge",
        contains: "default",
        values: { min: 1, max: 5, value: 5 },
      },
      shared_module_duration: {
        type: "trend",
        contains: "time",
        values: { avg: 98.2, "p(95)": 150, max: 170 },
      },
      shared_module_errors: {
        type: "rate",
        contains: "default",
        values: { rate: 0.02 },
        thresholds: { "rate<0.01": false },
      },
    },
  };

  it("maps thresholds, core metrics, checks, scenarios, and custom metrics", () => {
    const report = normalizeK6Summary({
      module: "sample-service/shared-module",
      summary,
      artifactPath:
        ".perf-report/current/sample-service-shared-module.summary.json",
    });

    expect(report.module).toBe("sample-service/shared-module");
    expect(report.status).toBe("failed");
    expect(report.thresholds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "http_req_failed",
          expression: "rate<0.05",
          passed: true,
          actualValue: 0.0167,
        }),
        expect.objectContaining({
          metric: "shared_module_errors",
          expression: "rate<0.01",
          passed: false,
          actualValue: 0.02,
        }),
      ]),
    );
    expect(report.coreMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "HTTP requests", value: 120 }),
        expect.objectContaining({ label: "Iterations", value: 60 }),
        expect.objectContaining({ label: "Virtual users", value: 5 }),
      ]),
    );
    expect(report.latencyMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "HTTP avg",
          value: 123.4,
          unit: "ms",
        }),
        expect.objectContaining({ label: "HTTP p95", value: 210, unit: "ms" }),
      ]),
    );
    expect(report.throughputMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Requests / sec", value: 4 }),
        expect.objectContaining({ label: "Failure rate", value: 0.0167 }),
      ]),
    );
    expect(report.scenarios).toEqual([
      expect.objectContaining({
        name: "smoke",
        executor: "constant-vus",
      }),
    ]);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "status is 200",
          passRate: 118 / 120,
        }),
      ]),
    );
    expect(report.customMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "shared_module_duration",
          values: expect.objectContaining({ avg: 98.2, "p(95)": 150 }),
        }),
        expect.objectContaining({
          key: "shared_module_errors",
          thresholds: expect.arrayContaining([
            expect.objectContaining({ passed: false }),
          ]),
        }),
      ]),
    );
    expect(report.rawArtifacts).toEqual([
      {
        kind: "k6-summary",
        path: ".perf-report/current/sample-service-shared-module.summary.json",
      },
    ]);
  });

  it("accepts k6 check maps emitted by summary export", () => {
    const report = normalizeK6Summary({
      module: "sample-service/tree",
      summary: {
        ...summary,
        root_group: {
          checks: {
            "items-root status 200": { passes: 5, fails: 0 },
            "create-folder status 201": { passes: 4, fails: 1 },
          },
        },
      },
      artifactPath: ".perf-report/current/sample-service-tree.summary.json",
    });

    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "items-root status 200",
          passes: 5,
          fails: 0,
          passRate: 1,
        }),
        expect.objectContaining({
          name: "create-folder status 201",
          passes: 4,
          fails: 1,
          passRate: 0.8,
        }),
      ]),
    );
  });

  it("extracts metric values when k6 stats are present at the top level", () => {
    const report = normalizeK6Summary({
      module: "sample-service/search",
      summary: {
        root_group: { checks: [] },
        options: { scenarios: {} },
        metrics: {
          http_reqs: {
            type: "counter",
            contains: "default",
            count: 300,
            rate: 10,
          } as never,
          http_req_failed: {
            type: "rate",
            contains: "default",
            rate: 0,
            thresholds: { "rate<0.01": true },
          } as never,
          http_req_duration: {
            type: "trend",
            contains: "time",
            avg: 99.1,
            min: 8.62,
            med: 56.53,
            max: 329.92,
            "p(95)": 213.53,
          } as never,
          search_duration: {
            type: "trend",
            contains: "time",
            avg: 110.04,
            min: 21.46,
            med: 105.91,
            max: 331.97,
            "p(95)": 197.72,
            thresholds: { "p(95)<2500": false },
          } as never,
        },
      },
      artifactPath: ".perf-report/current/sample-service-search.summary.json",
    });

    expect(report.coreMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "HTTP requests", value: 300 }),
      ]),
    );
    expect(report.latencyMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "HTTP avg", value: 99.1, unit: "ms" }),
        expect.objectContaining({
          label: "HTTP p95",
          value: 213.53,
          unit: "ms",
        }),
      ]),
    );
    expect(report.customMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "search_duration",
          values: expect.objectContaining({
            avg: 110.04,
            "p(95)": 197.72,
          }),
        }),
      ]),
    );
    expect(report.thresholds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "search_duration",
          actualValue: 197.72,
        }),
      ]),
    );
  });

  it("uses meaningful gauge and rate fallbacks for VUs and threshold actuals", () => {
    const report = normalizeK6Summary({
      module: "sample-service/search",
      summary: {
        root_group: { checks: [] },
        options: { scenarios: {} },
        metrics: {
          vus: {
            type: "gauge",
            contains: "default",
            value: 0,
            min: 5,
            max: 5,
          } as never,
          http_req_failed: {
            type: "rate",
            contains: "default",
            value: 0,
            passes: 0,
            fails: 300,
            thresholds: { "rate<0.01": true },
          } as never,
          search_errors: {
            type: "rate",
            contains: "default",
            value: 0,
            passes: 0,
            fails: 281,
            thresholds: { "rate<0.01": false },
          } as never,
        },
      },
      artifactPath: ".perf-report/current/sample-service-search.summary.json",
    });

    expect(report.coreMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Virtual users", value: 5 }),
      ]),
    );
    expect(report.throughputMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Failure rate", value: 0 }),
      ]),
    );
    expect(report.thresholds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "http_req_failed",
          actualValue: 0,
        }),
        expect.objectContaining({
          metric: "search_errors",
          actualValue: 0,
        }),
      ]),
    );
  });

  it("reads threshold pass/fail from object-shaped k6 threshold results", () => {
    const report = normalizeK6Summary({
      module: "sample-service/search",
      summary: {
        root_group: { checks: [] },
        options: { scenarios: {} },
        metrics: {
          http_req_failed: {
            type: "rate",
            contains: "default",
            value: 0,
            thresholds: {
              "rate<0.01": { ok: true },
            },
          } as never,
          search_duration: {
            type: "trend",
            contains: "time",
            "p(95)": 103.36,
            thresholds: {
              "p(95)<2500": { ok: true },
            },
          } as never,
          search_errors: {
            type: "rate",
            contains: "default",
            value: 0,
            thresholds: {
              "rate<0.01": { ok: true },
            },
          } as never,
        },
      },
      artifactPath: ".perf-report/current/sample-service-search.summary.json",
    });

    expect(report.status).toBe("passed");
    expect(report.thresholds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "http_req_failed",
          passed: true,
        }),
        expect.objectContaining({
          metric: "search_duration",
          passed: true,
        }),
        expect.objectContaining({
          metric: "search_errors",
          passed: true,
        }),
      ]),
    );
  });

  it("evaluates threshold expressions from actual values when summary-export booleans are inverted", () => {
    const report = normalizeK6Summary({
      module: "sample-service/search",
      summary: {
        root_group: { checks: [] },
        options: { scenarios: {} },
        metrics: {
          http_req_failed: {
            type: "rate",
            contains: "default",
            value: 0,
            thresholds: {
              "rate<0.01": false,
            },
          } as never,
          search_duration: {
            type: "trend",
            contains: "time",
            "p(95)": 93.40249999999999,
            thresholds: {
              "p(95)<2500": false,
            },
          } as never,
          search_errors: {
            type: "rate",
            contains: "default",
            value: 0,
            thresholds: {
              "rate<0.01": false,
            },
          } as never,
        },
      },
      artifactPath: ".perf-report/current/sample-service-search.summary.json",
    });

    expect(report.status).toBe("passed");
    expect(report.thresholds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "http_req_failed",
          passed: true,
          actualValue: 0,
        }),
        expect.objectContaining({
          metric: "search_duration",
          passed: true,
          actualValue: 93.40249999999999,
        }),
        expect.objectContaining({
          metric: "search_errors",
          passed: true,
          actualValue: 0,
        }),
      ]),
    );
  });

  it("covers avg/count/default threshold actuals and comparison operators", () => {
    const report = normalizeK6Summary({
      module: "sample-service/operators",
      summary: {
        root_group: {
          checks: {
            "unnamed-check": { passes: 0, fails: 0 },
            "partial-pass-check": { passes: 1, fails: 1 },
          },
        },
        options: {
          scenarios: {
            avgCheck: {
              executor: 123,
              startTime: 42,
              gracefulStop: false,
              vus: 2,
            },
          },
        },
        metrics: {
          avg_metric: {
            type: "trend",
            avg: 10,
            thresholds: {
              "avg<=10": false,
            },
          } as never,
          count_metric: {
            type: "counter",
            count: 5,
            thresholds: {
              "count>=5": false,
            },
          } as never,
          default_metric: {
            type: "gauge",
            value: 7,
            thresholds: {
              "value>6": false,
              "value==7": false,
              "value>abc": { ok: true },
            },
          } as never,
          string_threshold_metric: {
            type: "rate",
            value: 0,
            thresholds: {
              "custom-expression": { ok: false },
            },
          } as never,
        },
      },
      artifactPath:
        ".perf-report/current/sample-service-operators.summary.json",
    });

    expect(report.status).toBe("failed");
    expect(report.thresholds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "avg_metric",
          expression: "avg<=10",
          actualValue: 10,
          passed: true,
        }),
        expect.objectContaining({
          metric: "count_metric",
          expression: "count>=5",
          actualValue: 5,
          passed: true,
        }),
        expect.objectContaining({
          metric: "default_metric",
          expression: "value>6",
          actualValue: 7,
          passed: true,
        }),
        expect.objectContaining({
          metric: "default_metric",
          expression: "value==7",
          actualValue: 7,
          passed: true,
        }),
        expect.objectContaining({
          metric: "default_metric",
          expression: "value>abc",
          actualValue: 7,
          passed: true,
        }),
        expect.objectContaining({
          metric: "string_threshold_metric",
          expression: "custom-expression",
          actualValue: 0,
          passed: false,
        }),
      ]),
    );
    expect(report.checks).toEqual([
      expect.objectContaining({
        name: "unnamed-check",
        passes: 0,
        fails: 0,
        passRate: null,
      }),
      expect.objectContaining({
        name: "partial-pass-check",
        passes: 1,
        fails: 1,
        passRate: 0.5,
      }),
    ]);
    expect(report.scenarios).toEqual([
      expect.objectContaining({
        name: "avgCheck",
        executor: undefined,
        startTime: undefined,
        gracefulStop: undefined,
      }),
    ]);
  });
});

describe("buildPerfRunReport", () => {
  it("aggregates module reports into a single performance run report", () => {
    const runReport = buildPerfRunReport({
      environment: "staging",
      modules: [
        {
          module: "api-health",
          summary: {
            metrics: {
              http_req_failed: {
                values: { rate: 0 },
                thresholds: { "rate<0.01": true },
              },
            },
            root_group: { checks: [] },
            options: { scenarios: {} },
          },
          artifactPath: ".perf-report/current/api-health.summary.json",
        },
        {
          module: "sample-service/search",
          summary: {
            metrics: {
              http_req_failed: {
                values: { rate: 0.12 },
                thresholds: { "rate<0.01": false },
              },
            },
            root_group: { checks: [] },
            options: { scenarios: {} },
          },
          artifactPath:
            ".perf-report/current/sample-service-search.summary.json",
        },
      ],
      startedAt: "2026-03-19T12:00:00.000Z",
      finishedAt: "2026-03-19T12:01:00.000Z",
    });

    expect(runReport.pillar).toBe("performance");
    expect(runReport.environment).toBe("staging");
    expect(runReport.status).toBe("failed");
    expect(runReport.modules).toHaveLength(2);
    expect(runReport.rawArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".perf-report/current/api-health.summary.json",
        }),
        expect.objectContaining({
          path: ".perf-report/current/sample-service-search.summary.json",
        }),
      ]),
    );
  });
});
