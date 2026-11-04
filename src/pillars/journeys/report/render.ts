/**
 * Journeys per-run markdown report (plan: jrn-reporting packet, Approach
 * §Browser snapshots in every report).
 *
 * Renders the human-facing run report: verdict summary, budget/usage
 * numbers, the embedded snapshot gallery (image links RELATIVE to the
 * report dir so the report stays portable), the friction section with
 * evidence references, assertion diagnostics, and teardown warnings.
 * Friction and teardown sections are informational — the verdict line
 * reflects the deterministic verifier only.
 */

import * as path from "path";
import type { JourneyEvent } from "../observability/events.js";
import type { TeardownReport } from "../teardown.js";
import type { SnapshotIndexEntry } from "../tools/snapshot-store.js";
import type { CollectedJourneyReport } from "./results.js";

function snapshotAlt(entry: SnapshotIndexEntry): string {
  return `${String(entry.seq).padStart(3, "0")}-${entry.action}`;
}

function renderGallery(collected: CollectedJourneyReport): string[] {
  if (collected.snapshotIndex.length === 0) {
    return ["_No snapshots captured (api-surface journey)._", ""];
  }
  const lines: string[] = [];
  for (const entry of collected.snapshotIndex) {
    if (entry.captureError !== undefined) {
      lines.push(
        `⚠️ _Snapshot ${String(entry.seq).padStart(3, "0")} ` +
          `(${entry.action}) capture FAILED — evidence missing: ` +
          `${entry.captureError}_`,
      );
    } else if (entry.path === null) {
      lines.push(
        `_Snapshot ${String(entry.seq).padStart(3, "0")} (${entry.action}) ` +
          `suppressed${entry.masked ? " — sensitive input masked" : ""}._`,
      );
    } else {
      const relative = path.relative(collected.reportDir, entry.path);
      lines.push(`![${snapshotAlt(entry)}](${relative})`);
    }
    lines.push("");
  }
  return lines;
}

function renderFriction(collected: CollectedJourneyReport): string[] {
  if (collected.frictionPoints.length === 0) {
    return ["_No friction points detected._", ""];
  }
  const lines: string[] = [];
  for (const point of collected.frictionPoints) {
    const snapshotSuffix =
      point.evidence.snapshotPath !== undefined
        ? ` (snapshot: ${path.relative(collected.reportDir, point.evidence.snapshotPath)})`
        : "";
    lines.push(
      `- **${point.severity}** \`${point.category}\` @ ` +
        `${point.evidence.transcriptRef} — ${point.description}${snapshotSuffix}`,
    );
  }
  lines.push("");
  return lines;
}

function renderAssertions(collected: CollectedJourneyReport): string[] {
  if (collected.assertionResults.length === 0) {
    return ["_No assertion diagnostics recorded._", ""];
  }
  const lines: string[] = [];
  for (const result of collected.assertionResults) {
    const marker = result.passed ? "✅" : "❌";
    const detail = result.passed
      ? ""
      : ` — ${result.message ?? `expected ${JSON.stringify(result.expected)}, actual ${JSON.stringify(result.actual)}`}`;
    lines.push(`- ${marker} \`${result.assertion.kind}\`${detail}`);
  }
  lines.push("");
  return lines;
}

function renderTeardown(teardown: TeardownReport | undefined): string[] {
  if (teardown === undefined) {
    return ["_No teardown report (teardown did not run)._", ""];
  }
  const lines: string[] = [
    `Attempted deletions: ${teardown.results.length}, ` +
      `failed: ${teardown.failures.length}.`,
    "",
  ];
  for (const failure of teardown.failures) {
    lines.push(
      `- ⚠️ delete failed for ${failure.entry.resourceType} ` +
        `${failure.entry.id}: ${failure.entry.cleanup.method} ` +
        `${failure.entry.cleanup.path}` +
        (failure.status !== undefined ? ` (${failure.status})` : "") +
        (failure.error !== undefined ? ` — ${failure.error}` : ""),
    );
  }
  for (const warning of teardown.unmanagedWarnings) {
    lines.push(
      `- ⚠️ unmanaged mutation (never guessed-deleted): ` +
        `${warning.method} ${warning.path} (${warning.status}, ` +
        `source: ${warning.source})`,
    );
  }
  for (const message of teardown.interceptionErrors) {
    lines.push(
      `- ⚠️ browser interception error (a creation may be untracked): ` +
        message,
    );
  }
  if (
    teardown.failures.length > 0 ||
    teardown.unmanagedWarnings.length > 0 ||
    teardown.interceptionErrors.length > 0
  ) {
    lines.push("");
  }
  return lines;
}

function ts(event: JourneyEvent): string {
  return `${(event.tMs / 1000).toFixed(1)}s`;
}

/**
 * Condensed chronological timeline of what the agent actually did —
 * tool calls (with results), bindings, denials, thinking/assistant text.
 * This is the section that turns a black-box run into a readable story.
 */
function renderTimeline(collected: CollectedJourneyReport): string[] {
  if (collected.events.length === 0) {
    return ["_No events recorded._", ""];
  }
  const lines: string[] = [];
  for (const event of collected.events) {
    switch (event.kind) {
      case "turn_started":
        lines.push(`- \`${ts(event)}\` **turn ${event.turn}**`);
        break;
      case "tool_call": {
        const icon =
          event.status === "completed"
            ? "✓"
            : event.status === "error"
              ? "✗"
              : "…";
        const summary = event.summary ? ` \`${event.summary}\`` : "";
        const result = event.result ? ` → ${event.result}` : "";
        lines.push(
          `- \`${ts(event)}\` ${icon} ${event.tool}${summary}${result}`,
        );
        break;
      }
      case "ledger_binding":
        lines.push(
          `- \`${ts(event)}\` 🔗 bound **${event.resourceType}** = ` +
            `\`${event.id}\` (${event.method} ${event.pathValue} → ${event.status})`,
        );
        break;
      case "unmanaged_mutation":
        lines.push(
          `- \`${ts(event)}\` ⚠️ unmanaged ${event.method} ` +
            `${event.pathValue} → ${event.status}`,
        );
        break;
      case "interception_error":
        lines.push(
          `- \`${ts(event)}\` ⚠️ interception error: ${event.message}`,
        );
        break;
      case "agent_error":
        lines.push(
          `- \`${ts(event)}\` ✗ **agent error**` +
            (event.code ? ` [${event.code}]` : "") +
            `: ${event.message}`,
        );
        break;
      case "assistant_text":
        lines.push(`- \`${ts(event)}\` 🗣 ${truncate(event.text, 160)}`);
        break;
      default:
        // thinking / turn_ended / run_started / run_ended are omitted from
        // the human timeline (they live in events.jsonl); keeps it readable.
        break;
    }
  }
  lines.push("");
  return lines;
}

/**
 * Resource bindings — the direct answer to "did {<type>_id} bind, and to
 * what?". Empty for a journey that created nothing (or failed before it).
 */
function renderBindings(collected: CollectedJourneyReport): string[] {
  const bindings = collected.events.filter(
    (e): e is Extract<JourneyEvent, { kind: "ledger_binding" }> =>
      e.kind === "ledger_binding",
  );
  if (bindings.length === 0) {
    return [
      "_No resources bound (nothing created, or created pre-binding)._",
      "",
    ];
  }
  const lines = bindings.map(
    (b) =>
      `- **${b.resourceType}** = \`${b.id}\` ` +
      `(${b.method} ${b.pathValue} → ${b.status}, via ${b.source})`,
  );
  lines.push("");
  return lines;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Render the full per-run markdown report. */
export function renderJourneyReportMarkdown(
  collected: CollectedJourneyReport,
  teardown?: TeardownReport,
): string {
  const verdictLine = collected.status === "passed" ? "✅ passed" : "❌ failed";

  return [
    `# Journey report — ${collected.journeyName}`,
    "",
    `- **Run id**: ${collected.runId}`,
    `- **Environment**: ${collected.environment}`,
    `- **Surface**: ${collected.surface}`,
    `- **Verdict**: ${verdictLine}` +
      (collected.failureKind !== undefined
        ? ` (failure_kind: ${collected.failureKind})`
        : ""),
    `- **Duration**: ${collected.durationMs}ms`,
    `- **Tokens used**: ${collected.usageTotalTokens ?? "unreported"} / ` +
      `${collected.budgetConsumption.maxTotalTokens} budgeted`,
    `- **Budgets**: max_turns=${collected.budgetConsumption.maxTurns}, ` +
      `timeout_s=${collected.budgetConsumption.timeoutS}`,
    `- **Transcript**: ${path.basename(collected.transcriptPath)}`,
    `- **Events**: ${collected.eventsFile}`,
    `- **Snapshots**: ${collected.snapshotCount} in ` +
      `${path.relative(collected.reportDir, collected.snapshotsDir) || "."}/`,
    ...(collected.agentError !== undefined
      ? [`- **Agent error**: ${collected.agentError}`]
      : []),
    "",
    "## Timeline",
    "",
    ...renderTimeline(collected),
    "## Bindings",
    "",
    ...renderBindings(collected),
    "## Assertions",
    "",
    ...renderAssertions(collected),
    "## Snapshots",
    "",
    ...renderGallery(collected),
    "## Friction",
    "",
    ...renderFriction(collected),
    "## Teardown",
    "",
    ...renderTeardown(teardown),
  ].join("\n");
}
