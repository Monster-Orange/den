import chalk from "chalk";
import type { ServiceHealthResult } from "../../shared/environment-manager/health.js";

import { product } from "../../shared/product.js";
type HealthState = ServiceHealthResult["health"];
type HealthReasonInput = Pick<ServiceHealthResult, "health" | "healthDetail">;

export function healthLabelText(health: HealthState): string {
  if (health === "error") return "down";
  return health;
}

export function formatHealthLabel(health: HealthState): string {
  if (health === "ok") return chalk.green("● ok");
  if (health === "error") return chalk.red("● down");
  if (health === "pending") return chalk.gray("● pending");
  return chalk.gray("● unknown");
}

export function formatHealthDot(health: HealthState): string {
  if (health === "ok") return chalk.green("●");
  if (health === "error") return chalk.red("●");
  return chalk.gray("●");
}

export function healthReasonText(result: HealthReasonInput): string {
  if (result.health === "ok") return "";

  const detail = result.healthDetail?.trim();
  if (!detail) return result.health === "error" ? "not running" : "";

  if (detail === "no health check configured") return "missing health check";
  if (detail === `no ${product().manifestYml}`)
    return `missing ${product().manifestYml}`;
  if (detail.startsWith("repo path does not exist")) return "repo path missing";
  if (detail === "timeout") return "health URL timeout";

  if (
    detail === "fetch failed" ||
    /^(connect )?ECONNREFUSED\b/i.test(detail) ||
    /^ENOTFOUND\b/i.test(detail) ||
    /^EAI_AGAIN\b/i.test(detail)
  ) {
    return "health URL unreachable";
  }

  const httpMatch = detail.match(/^http (\d{3})$/i);
  if (httpMatch) return `health URL returned HTTP ${httpMatch[1]}`;

  const exitMatch = detail.match(/^exit (\d+|null)$/);
  if (exitMatch) {
    if (exitMatch[1] === "127") {
      return "health command missing dependency (exit 127)";
    }
    return `health command failed: exit ${exitMatch[1]}`;
  }

  return detail;
}

export function formatHealthReason(result: HealthReasonInput): string {
  const reason = healthReasonText(result);
  return reason ? chalk.gray(reason.slice(0, 48)) : "";
}
