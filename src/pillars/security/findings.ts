/**
 * ZAP findings and the "latest run" record (security pillar).
 *
 * Each run writes summary-<mode>.json in its run directory and points
 * reports/security/<env>/latest-<mode>.json at it. The Tests page reads the
 * pointer (/api/security/latest), and the next run of the same env and mode
 * reads it to mark findings that are new since then.
 */

import * as fs from "fs";
import * as path from "path";
import { getDistRoot } from "../../shared/paths.js";
import type { SecurityMode } from "../../shared/types/index.js";

export type Risk = "High" | "Medium" | "Low" | "Informational";
const RISKS: Record<string, Risk> = {
  "3": "High",
  "2": "Medium",
  "1": "Low",
  "0": "Informational",
};
export const RISK_ORDER: Risk[] = ["High", "Medium", "Low", "Informational"];

export interface Finding {
  pluginId: string;
  name: string;
  risk: Risk;
  confidence: string;
  count: number;
  /** A few URLs where it was seen. */
  urls: string[];
  solution?: string;
}

interface ZapJson {
  site?: Array<{
    alerts?: Array<{
      pluginid?: string;
      alert?: string;
      name?: string;
      riskcode?: string;
      confidence?: string;
      count?: string;
      solution?: string;
      instances?: Array<{ uri?: string }>;
    }>;
  }>;
}

const stripTags = (s: string | undefined): string | undefined =>
  s
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim() || undefined;

/** Findings from a ZAP JSON report, most severe first. */
export function parseZapReport(json: unknown): Finding[] {
  const report = (json ?? {}) as ZapJson;
  const byPlugin = new Map<string, Finding>();
  for (const site of report.site ?? []) {
    for (const a of site.alerts ?? []) {
      const pluginId = String(a.pluginid ?? a.alert ?? "?");
      const risk = RISKS[String(a.riskcode ?? "0")] ?? "Informational";
      const urls = (a.instances ?? [])
        .map((i) => i.uri)
        .filter((u): u is string => Boolean(u));
      const prev = byPlugin.get(pluginId);
      if (prev) {
        prev.count += Number(a.count ?? urls.length) || 0;
        for (const u of urls)
          if (prev.urls.length < 5 && !prev.urls.includes(u)) prev.urls.push(u);
        continue;
      }
      byPlugin.set(pluginId, {
        pluginId,
        name: a.alert ?? a.name ?? pluginId,
        risk,
        confidence: a.confidence ?? "",
        count: Number(a.count ?? urls.length) || 0,
        urls: urls.slice(0, 5),
        solution: stripTags(a.solution),
      });
    }
  }
  return [...byPlugin.values()].sort(
    (x, y) =>
      RISK_ORDER.indexOf(x.risk) - RISK_ORDER.indexOf(y.risk) ||
      x.name.localeCompare(y.name),
  );
}

export interface TargetResult {
  id: string;
  repo: string;
  service: string;
  org: string;
  url: string;
  /** null when the scan itself failed. */
  findings: Finding[] | null;
  error?: string;
  /** pluginIds not present in the previous run of this target + mode + env. */
  newSince?: string[];
  report?: string;
}

export interface ScanSummary {
  id: string;
  env: string;
  mode: SecurityMode;
  startedAt: string;
  finishedAt: string;
  image?: string;
  results: TargetResult[];
}

/** pluginIds in `now` that the previous run of the same target did not have. */
export function newFindings(
  now: Finding[],
  previous: Finding[] | null | undefined,
): string[] {
  if (!previous) return [];
  const before = new Set(previous.map((f) => f.pluginId));
  return now.filter((f) => !before.has(f.pluginId)).map((f) => f.pluginId);
}

export function securityReportsDir(): string {
  return path.join(getDistRoot(), "reports", "security");
}

export function latestSummaryPath(
  reportsRoot: string,
  env: string,
  mode: string,
): string {
  return path.join(reportsRoot, env, `latest-${mode}.json`);
}

/** The newest run of `env` + `mode`, or null when there is none. */
export function readLatestSummary(
  env: string,
  mode: string,
  reportsRoot: string = securityReportsDir(),
): ScanSummary | null {
  try {
    return JSON.parse(
      fs.readFileSync(latestSummaryPath(reportsRoot, env, mode), "utf-8"),
    ) as ScanSummary;
  } catch {
    return null;
  }
}
