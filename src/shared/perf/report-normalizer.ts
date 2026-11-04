import type {
  PerfCheckResult,
  PerfMetricSummary,
  PerfModuleRunReport,
  PerfReportValue,
  PerfRunReport,
  PerfScenarioSummary,
  PerfThresholdResult,
} from "./report-types.js";

interface K6Metric {
  type?: string;
  contains?: string;
  values?: Record<string, number>;
  thresholds?: Record<string, boolean | { ok?: boolean }>;
  [key: string]: unknown;
}

interface K6Check {
  name?: string;
  passes?: number;
  fails?: number;
}

export interface K6Summary {
  metrics?: Record<string, K6Metric>;
  root_group?: {
    checks?: K6Check[] | Record<string, Omit<K6Check, "name">>;
  };
  options?: {
    scenarios?: Record<string, Record<string, unknown>>;
  };
}

interface NormalizeSummaryInput {
  module: string;
  summary: K6Summary;
  artifactPath: string;
  startedAt?: string;
  finishedAt?: string;
}

interface BuildRunReportInput {
  environment: string;
  modules: NormalizeSummaryInput[];
  startedAt?: string;
  finishedAt?: string;
}

const CORE_METRIC_DEFS: Array<{
  key: string;
  source: string;
  label: string;
  unit?: string;
}> = [
  { key: "count", source: "http_reqs", label: "HTTP requests" },
  { key: "count", source: "iterations", label: "Iterations" },
  { key: "value", source: "vus", label: "Virtual users" },
];

const LATENCY_METRIC_DEFS: Array<{
  key: string;
  source: string;
  label: string;
}> = [
  { key: "avg", source: "http_req_duration", label: "HTTP avg" },
  { key: "med", source: "http_req_duration", label: "HTTP p50" },
  { key: "p(95)", source: "http_req_duration", label: "HTTP p95" },
  { key: "p(99)", source: "http_req_duration", label: "HTTP p99" },
  { key: "max", source: "http_req_duration", label: "HTTP max" },
];

const THROUGHPUT_METRIC_DEFS: Array<{
  key: string;
  source: string;
  label: string;
}> = [
  { key: "rate", source: "http_reqs", label: "Requests / sec" },
  { key: "rate", source: "iterations", label: "Iterations / sec" },
  { key: "rate", source: "http_req_failed", label: "Failure rate" },
];

export function normalizeK6Summary(
  input: NormalizeSummaryInput,
): PerfModuleRunReport {
  const metrics = input.summary.metrics ?? {};
  const thresholds = flattenThresholds(metrics);
  const checks = normalizeChecks(input.summary.root_group?.checks);
  const scenarios = normalizeScenarios(input.summary.options?.scenarios);
  const customMetrics = normalizeCustomMetrics(metrics);

  return {
    module: input.module,
    status: thresholds.some((threshold) => !threshold.passed)
      ? "failed"
      : "passed",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    thresholds,
    coreMetrics: selectReportValues(metrics, CORE_METRIC_DEFS),
    latencyMetrics: selectReportValues(metrics, LATENCY_METRIC_DEFS, "ms"),
    throughputMetrics: selectReportValues(metrics, THROUGHPUT_METRIC_DEFS),
    scenarios,
    checks,
    customMetrics,
    rawArtifacts: [
      {
        kind: "k6-summary",
        path: input.artifactPath,
      },
    ],
  };
}

export function buildPerfRunReport(input: BuildRunReportInput): PerfRunReport {
  const modules = input.modules.map((moduleInput) =>
    normalizeK6Summary(moduleInput),
  );

  return {
    pillar: "performance",
    environment: input.environment,
    status: modules.some((module) => module.status === "failed")
      ? "failed"
      : "passed",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    modules,
    rawArtifacts: modules.flatMap((module) => module.rawArtifacts),
  };
}

function flattenThresholds(
  metrics: Record<string, K6Metric>,
): PerfThresholdResult[] {
  return Object.entries(metrics).flatMap(([metricKey, metric]) => {
    const thresholdEntries = Object.entries(metric.thresholds ?? {});
    return thresholdEntries.map(([expression, passed]) => {
      const actualValue = deriveThresholdActualValue(metric, expression);
      return {
        metric: metricKey,
        name: `${metricKey}:${expression}`,
        expression,
        passed: normalizeThresholdPassed(actualValue, expression, passed),
        actualValue,
        unit: metric.contains === "time" ? "ms" : undefined,
      };
    });
  });
}

function deriveThresholdActualValue(
  metric: K6Metric,
  expression: string,
): number | string | null {
  const values = getMetricValues(metric);
  const percentile = expression.match(/^p\(([\d.]+)\)/);
  if (percentile) {
    return values[`p(${percentile[1]})`] ?? null;
  }

  if (expression.startsWith("rate")) {
    return firstDefinedNumber(values.rate, values.value) ?? null;
  }

  if (expression.startsWith("avg")) {
    return values.avg ?? null;
  }

  if (expression.startsWith("count")) {
    return values.count ?? null;
  }

  return values.value ?? values.avg ?? values.rate ?? values.count ?? null;
}

function selectReportValues(
  metrics: Record<string, K6Metric>,
  definitions: Array<{ key: string; source: string; label: string }>,
  unit?: string,
): PerfReportValue[] {
  return definitions.flatMap((definition) => {
    const value = getMetricDisplayValue(
      metrics[definition.source],
      definition.key,
    );
    if (typeof value !== "number") {
      return [];
    }

    return [
      {
        label: definition.label,
        value,
        unit,
      },
    ];
  });
}

function normalizeChecks(
  checks?: K6Check[] | Record<string, Omit<K6Check, "name">>,
): PerfCheckResult[] {
  const normalizedChecks = Array.isArray(checks)
    ? checks
    : Object.entries(checks ?? {}).map(([name, check]) => ({
        ...check,
        name,
      }));

  return normalizedChecks
    .filter(
      (check): check is Required<Pick<K6Check, "name">> & K6Check =>
        typeof check.name === "string",
    )
    .map((check) => {
      const passes = check.passes ?? 0;
      const fails = check.fails ?? 0;
      const total = passes + fails;
      return {
        name: check.name,
        passes,
        fails,
        passRate: total > 0 ? passes / total : null,
      };
    });
}

function normalizeScenarios(
  scenarios?: Record<string, Record<string, unknown>>,
): PerfScenarioSummary[] {
  return Object.entries(scenarios ?? {}).map(([name, scenario]) => ({
    name,
    executor:
      typeof scenario.executor === "string" ? scenario.executor : undefined,
    startTime:
      typeof scenario.startTime === "string" ? scenario.startTime : undefined,
    gracefulStop:
      typeof scenario.gracefulStop === "string"
        ? scenario.gracefulStop
        : undefined,
    options: scenario,
  }));
}

function normalizeCustomMetrics(
  metrics: Record<string, K6Metric>,
): PerfMetricSummary[] {
  const builtInMetrics = new Set([
    "http_reqs",
    "http_req_failed",
    "http_req_duration",
    "http_req_blocked",
    "http_req_connecting",
    "http_req_receiving",
    "http_req_sending",
    "http_req_tls_handshaking",
    "http_req_waiting",
    "iteration_duration",
    "iterations",
    "vus",
    "vus_max",
    "checks",
    "data_received",
    "data_sent",
    "group_duration",
  ]);

  return Object.entries(metrics)
    .filter(([metricKey]) => {
      const baseKey = metricKey.replace(/\{.*\}$/, "");
      return !builtInMetrics.has(baseKey);
    })
    .map(([metricKey, metric]) => ({
      key: metricKey,
      label: metricKey.replace(/_/g, " "),
      type: metric.type,
      contains: metric.contains,
      values: normalizeMetricValues(getMetricValues(metric)),
      thresholds: flattenThresholds({ [metricKey]: metric }),
      isCustom: true,
    }));
}

function normalizeMetricValues(
  values?: Record<string, number>,
): Record<string, number | null> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [
      key,
      typeof value === "number" ? value : null,
    ]),
  );
}

function getMetricValues(metric?: K6Metric): Record<string, number> {
  if (!metric) {
    return {};
  }

  if (metric.values && Object.keys(metric.values).length > 0) {
    return normalizeNumericEntries(metric.values);
  }

  const topLevelEntries = Object.entries(metric).filter(
    (entry): entry is [string, number] => {
      const [key, value] = entry;
      if (key === "type" || key === "contains" || key === "thresholds") {
        return false;
      }

      return typeof value === "number";
    },
  );

  return Object.fromEntries(topLevelEntries);
}

function getMetricDisplayValue(
  metric: K6Metric | undefined,
  preferredKey: string,
): number | undefined {
  const values = getMetricValues(metric);

  if (metric?.type === "gauge" && preferredKey === "value") {
    return firstDefinedNumber(values.max, values.value, values.min);
  }

  if (preferredKey === "rate") {
    return firstDefinedNumber(values.rate, values.value);
  }

  return values[preferredKey];
}

function firstDefinedNumber(
  ...candidates: Array<number | undefined>
): number | undefined {
  return candidates.find((candidate) => typeof candidate === "number");
}

function normalizeNumericEntries(
  values: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

function normalizeThresholdPassed(
  actualValue: number | string | null,
  expression: string,
  value: boolean | { ok?: boolean },
): boolean {
  const evaluated = evaluateThresholdExpression(actualValue, expression);
  if (typeof evaluated === "boolean") {
    return evaluated;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return value.ok ?? false;
}

function evaluateThresholdExpression(
  actualValue: number | string | null,
  expression: string,
): boolean | undefined {
  if (typeof actualValue !== "number") {
    return undefined;
  }

  const match = expression.match(
    /^[a-zA-Z0-9_.()]+\s*(<=|>=|<|>|==)\s*(-?\d+(?:\.\d+)?)$/,
  );
  if (!match) {
    return undefined;
  }

  const [, operator, targetRaw] = match;
  const target = Number(targetRaw);
  if (!Number.isFinite(target)) {
    return undefined;
  }

  switch (operator) {
    case "<":
      return actualValue < target;
    case "<=":
      return actualValue <= target;
    case ">":
      return actualValue > target;
    case ">=":
      return actualValue >= target;
    case "==":
      return actualValue === target;
    default:
      return undefined;
  }
}
