import { writeCurrentPerfRunReport } from "../../shared/perf/report-store.js";

function main(): void {
  const environment = process.env.PERF_ENVIRONMENT;
  const rawModules = process.env.PERF_MODULES ?? "";
  const modules = rawModules
    .split(",")
    .map((moduleName) => moduleName.trim())
    .filter(Boolean);

  if (!environment) {
    throw new Error("PERF_ENVIRONMENT is required");
  }

  if (modules.length === 0) {
    throw new Error("PERF_MODULES must include at least one module");
  }

  const report = writeCurrentPerfRunReport({
    environment,
    modules,
    finishedAt: new Date().toISOString(),
  });

  console.log(
    `Generated perf report for ${report.modules.length} module(s) in ${report.environment}`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to build perf report: ${message}`);
  process.exit(1);
}
