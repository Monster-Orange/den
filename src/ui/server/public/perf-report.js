/**
 * A word in the page's language (issue 171): shell.js's catalog, "perf.*".
 * Without the shell (a test that installs none) the key comes back. A
 * report's own names (metrics, modules, checks) are data, never translated.
 */
const t = (key, vars) => globalThis.window?.denShell?.t?.(key, vars) ?? key;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const METRIC_VALUE_ORDER = [
  "avg",
  "med",
  "p(50)",
  "p(90)",
  "p(95)",
  "p(99)",
  "min",
  "max",
  "rate",
  "count",
  "value",
  "passes",
  "fails",
];

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(value);
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  const abs = Math.abs(value);
  if (abs >= 100) {
    return value.toFixed(2).replace(/\.?0+$/, "");
  }

  if (abs >= 1) {
    return value.toFixed(2).replace(/\.?0+$/, "");
  }

  return value.toFixed(4).replace(/\.?0+$/, "");
}

function isRateLikeLabel(label) {
  return /rate|failure/i.test(label ?? "");
}

function isRateLikeKey(key) {
  return key === "rate" || /rate|error/i.test(key ?? "");
}

function formatRate(value) {
  if (typeof value !== "number") {
    return String(value);
  }

  return `${formatNumber(value * 100)}%`;
}

function formatDisplayValue(value, options = {}) {
  if (value == null) {
    return "—";
  }

  if (typeof value !== "number") {
    return String(value);
  }

  if (options.asPercent) {
    return formatRate(value);
  }

  const formatted = formatNumber(value);
  return options.unit ? `${formatted} ${options.unit}` : formatted;
}

function renderMetricList(metrics) {
  if (!metrics?.length) {
    return `<div class="perf-empty">${escapeHtml(t("perf.noMetrics"))}</div>`;
  }

  return metrics
    .map(
      (metric) => `
        <div class="perf-stat">
          <span class="perf-stat-label">${escapeHtml(metric.label)}</span>
          <strong>${escapeHtml(
            formatDisplayValue(metric.value, {
              unit: metric.unit,
              asPercent: isRateLikeLabel(metric.label),
            }),
          )}</strong>
        </div>`,
    )
    .join("");
}

function renderMetricValueMap(values, metricType, metricContains) {
  const entries = Object.entries(values ?? {}).sort(([left], [right]) => {
    const leftIndex = METRIC_VALUE_ORDER.indexOf(left);
    const rightIndex = METRIC_VALUE_ORDER.indexOf(right);

    if (leftIndex === -1 && rightIndex === -1) {
      return left.localeCompare(right);
    }
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
  if (!entries.length) {
    return `<span class="perf-muted">${escapeHtml(t("perf.noValues"))}</span>`;
  }

  const unit = metricContains === "time" ? "ms" : undefined;

  return entries
    .map(([key, value]) => {
      const usePercent = key === "rate" && metricType === "rate";
      const suffix = key === "rate" && !usePercent ? "/s" : undefined;
      return `<div class="perf-value-chip">${escapeHtml(key)}: ${escapeHtml(
        formatDisplayValue(value, {
          asPercent: usePercent,
          unit: suffix ?? unit,
        }),
      )}</div>`;
    })
    .join("");
}

function renderTable(headers, rows, emptyMessage = t("perf.noData")) {
  if (!rows.length) {
    return `<div class="perf-empty">${escapeHtml(emptyMessage)}</div>`;
  }

  return `
    <table class="perf-table">
      <thead>
        <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (cells) => `
            <tr>${cells
              .map((cell) => {
                if (cell == null) return "<td>—</td>";
                if (typeof cell === "object" && cell && "html" in cell) {
                  return `<td>${cell.html}</td>`;
                }
                return `<td>${escapeHtml(
                  typeof cell === "number" ? formatNumber(cell) : cell,
                )}</td>`;
              })
              .join("")}</tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

export function buildReportPaneModel({ pillar, selectedView, perfReportUrl }) {
  if (pillar === "journeys") {
    // Journeys produce per-run markdown reports + snapshot galleries under
    // reports/journeys/<run-id>/ (no Playwright HTML report); the pane
    // shows the raw run output which links to those artifacts.
    return {
      title: t("perf.pane.journeys"),
      activeView: "raw",
      openUrl: null,
      tabsVisible: false,
      emptyMessage: t("perf.pane.journeys.empty"),
    };
  }

  if (pillar === "security") {
    // ZAP writes report.json/report.html per scan under
    // reports/security/<env>/<run>/ (no Playwright HTML report).
    return {
      title: t("perf.pane.security"),
      activeView: "raw",
      openUrl: null,
      tabsVisible: false,
      emptyMessage: t("perf.pane.security.empty"),
    };
  }

  if (pillar === "suites") {
    return {
      title: t("perf.pane.suites"),
      activeView: "raw",
      openUrl: null,
      tabsVisible: false,
      emptyMessage: t("perf.pane.suites.empty"),
    };
  }

  if (pillar !== "performance") {
    return {
      title: t("perf.pane.playwright"),
      activeView: "playwright",
      openUrl: "/report/",
      tabsVisible: false,
      emptyMessage: t("perf.pane.playwright.empty"),
    };
  }

  return {
    title: t("perf.pane.perf"),
    activeView: selectedView === "raw" ? "raw" : "rendered",
    openUrl: perfReportUrl ?? null,
    tabsVisible: true,
    emptyMessage: t("perf.pane.perf.empty"),
  };
}

export function getNextReportViewOnPillarChange({
  currentPillar,
  nextPillar,
  currentReportView,
}) {
  if (currentPillar === nextPillar) {
    return currentReportView;
  }

  if (nextPillar === "performance") {
    return currentReportView === "playwright" ? "rendered" : currentReportView;
  }

  return currentReportView;
}

export function renderPerfReportHtml(report) {
  const moduleSections = (report.modules ?? [])
    .map((moduleReport) => {
      const thresholds = renderTable(
        [
          t("perf.col.metric"),
          t("perf.col.expression"),
          t("perf.col.actual"),
          t("perf.col.status"),
        ],
        (moduleReport.thresholds ?? []).map((threshold) => [
          threshold.metric,
          threshold.expression,
          formatDisplayValue(threshold.actualValue, {
            asPercent: /^rate/.test(threshold.expression),
            unit:
              threshold.unit && !/^rate/.test(threshold.expression)
                ? threshold.unit
                : undefined,
          }),
          threshold.passed ? t("perf.passed") : t("perf.failed"),
        ]),
        t("perf.noThresholds"),
      );

      const checks = renderTable(
        [
          t("perf.col.check"),
          t("perf.col.passes"),
          t("perf.col.fails"),
          t("perf.col.passRate"),
        ],
        (moduleReport.checks ?? []).map((check) => [
          check.name,
          check.passes,
          check.fails,
          check.passRate == null
            ? null
            : `${(check.passRate * 100).toFixed(1)}%`,
        ]),
        t("perf.noChecks"),
      );

      const scenarios = renderTable(
        [t("perf.col.scenario"), t("perf.col.executor"), t("perf.col.details")],
        (moduleReport.scenarios ?? []).map((scenario) => [
          scenario.name,
          scenario.executor ?? "—",
          JSON.stringify(scenario.options ?? {}),
        ]),
        t("perf.noScenarios"),
      );

      const customMetrics = renderTable(
        [t("perf.col.metric"), t("perf.col.values"), t("perf.thresholds")],
        (moduleReport.customMetrics ?? []).map((metric) => [
          metric.key,
          {
            html: renderMetricValueMap(
              metric.values,
              metric.type,
              metric.contains,
            ),
          },
          metric.thresholds?.length
            ? metric.thresholds
                .map(
                  (threshold) =>
                    `${threshold.expression} (${threshold.passed ? t("perf.pass") : t("perf.fail")})`,
                )
                .join(", ")
            : "—",
        ]),
        t("perf.noCustom"),
      );

      return `
        <details class="perf-module"${moduleReport.status === "failed" ? " open" : ""}>
          <summary class="perf-module-header">
            <span class="perf-module-title-wrap">
              <span class="perf-module-toggle" aria-hidden="true">▸</span>
              <span class="perf-module-title">${escapeHtml(moduleReport.module)}</span>
            </span>
            <span class="perf-badge ${moduleReport.status === "passed" ? "perf-ok" : "perf-fail"}">${escapeHtml(moduleReport.status)}</span>
          </summary>
          <div class="perf-section">
            <h4>${escapeHtml(t("perf.summary"))}</h4>
            <div class="perf-stat-grid">${renderMetricList(moduleReport.coreMetrics)}</div>
          </div>
          <div class="perf-section">
            <h4>${escapeHtml(t("perf.latency"))}</h4>
            <div class="perf-stat-grid">${renderMetricList(moduleReport.latencyMetrics)}</div>
          </div>
          <div class="perf-section">
            <h4>${escapeHtml(t("perf.throughput"))}</h4>
            <div class="perf-stat-grid">${renderMetricList(moduleReport.throughputMetrics)}</div>
          </div>
          <div class="perf-section">
            <h4>${escapeHtml(t("perf.thresholds"))}</h4>
            ${thresholds}
          </div>
          <div class="perf-section">
            <h4>${escapeHtml(t("perf.scenarios"))}</h4>
            ${scenarios}
          </div>
          <div class="perf-section">
            <h4>${escapeHtml(t("perf.checks"))}</h4>
            ${checks}
          </div>
          <div class="perf-section">
            <h4>${escapeHtml(t("perf.custom"))}</h4>
            ${customMetrics}
          </div>
        </details>`;
    })
    .join("");

  return `
    <article class="perf-report">
      <header class="perf-run-header">
        <div>
          <h2>${escapeHtml(t("perf.summary"))}</h2>
          <p>${escapeHtml(report.environment)} · ${escapeHtml(report.status)}</p>
        </div>
        <div class="perf-run-meta">
          <span>${escapeHtml(t("perf.modules", { n: String(report.modules?.length ?? 0) }))}</span>
          <span>${escapeHtml(t("perf.started", { at: report.startedAt ?? "—" }))}</span>
          <span>${escapeHtml(t("perf.finished", { at: report.finishedAt ?? "—" }))}</span>
        </div>
      </header>
      ${moduleSections}
    </article>`;
}
