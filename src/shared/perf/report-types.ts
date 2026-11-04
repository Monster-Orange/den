export interface PerfArtifactRef {
  kind: "k6-summary" | "normalized-report";
  path: string;
}

export interface PerfReportValue {
  label: string;
  value: number | string | null;
  unit?: string;
}

export interface PerfThresholdResult {
  metric: string;
  name: string;
  expression: string;
  passed: boolean;
  actualValue: number | string | null;
  unit?: string;
}

export interface PerfScenarioSummary {
  name: string;
  executor?: string;
  startTime?: string;
  gracefulStop?: string;
  env?: Record<string, string>;
  options?: Record<string, unknown>;
}

export interface PerfCheckResult {
  name: string;
  passes: number;
  fails: number;
  passRate: number | null;
}

export interface PerfMetricSummary {
  key: string;
  label: string;
  type?: string;
  contains?: string;
  values: Record<string, number | null>;
  thresholds: PerfThresholdResult[];
  isCustom?: boolean;
}

export interface PerfModuleRunReport {
  module: string;
  status: "passed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  thresholds: PerfThresholdResult[];
  coreMetrics: PerfReportValue[];
  latencyMetrics: PerfReportValue[];
  throughputMetrics: PerfReportValue[];
  scenarios: PerfScenarioSummary[];
  checks: PerfCheckResult[];
  customMetrics: PerfMetricSummary[];
  rawArtifacts: PerfArtifactRef[];
}

export interface PerfRunReport {
  pillar: "performance";
  environment: string;
  status: "passed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  modules: PerfModuleRunReport[];
  rawArtifacts: PerfArtifactRef[];
}
