/**
 * Issue 212: a security scan's findings, from the SARIF it writes to
 * DEN_RESULTS_DIR (VERIFY-SPEC section 10: SARIF is the one result
 * adapter for scans). A finding at or above the threshold fails the scan;
 * one below it never does (S6, T13).
 *
 * Severity: the rule's or result's `security-severity` score (CVSS-style:
 * 9 and up critical, 7 high, 4 medium, above 0 low), else the result's
 * level (error high, warning medium, note low). Package, version and the
 * version that fixes it come from the result's properties when the tool
 * writes them.
 */
import * as fs from "fs";
import * as path from "path";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  severity: Severity;
  rule?: string;
  message: string;
  package?: string;
  version?: string;
  fixedIn?: string;
}

export interface Findings {
  counts: Record<Severity, number>;
  /** Worst first; at most {@link KEEP_FINDINGS}. */
  list: Finding[];
  /** The threshold it was judged at. */
  failOn?: Severity;
  /** The SARIF file, by name in the module's results folder. */
  report: string;
}

/** How many findings a record keeps (the counts cover them all). */
export const KEEP_FINDINGS = 200;

/** Whether `s` is at or above `threshold`. */
export function atOrAbove(s: Severity, threshold: Severity): boolean {
  return SEVERITIES.indexOf(s) <= SEVERITIES.indexOf(threshold);
}

/** The first finding at or above the threshold, worst first. */
export function firstFailing(
  f: Findings,
  threshold: Severity,
): Finding | undefined {
  return f.list.find((x) => atOrAbove(x.severity, threshold));
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

function fromScore(v: unknown): Severity | undefined {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n >= 9 ? "critical" : n >= 7 ? "high" : n >= 4 ? "medium" : "low";
}

const LEVEL: Record<string, Severity> = {
  error: "high",
  warning: "medium",
  note: "low",
};

function findingsOf(log: unknown): Finding[] {
  const out: Finding[] = [];
  const runs = obj(log).runs;
  for (const run of Array.isArray(runs) ? runs : []) {
    const rules = obj(obj(obj(run).tool).driver).rules;
    const ruleList = Array.isArray(rules) ? rules : [];
    const results = obj(run).results;
    for (const res of Array.isArray(results) ? results : []) {
      const r = obj(res);
      const rule = obj(
        typeof r.ruleIndex === "number"
          ? ruleList[r.ruleIndex]
          : ruleList.find((x) => obj(x).id === r.ruleId),
      );
      const props = obj(r.properties);
      const severity =
        fromScore(props["security-severity"]) ??
        fromScore(obj(rule.properties)["security-severity"]) ??
        LEVEL[String(r.level ?? "warning")] ??
        "medium";
      const message = str(obj(r.message).text) ?? str(r.ruleId) ?? "a finding";
      out.push({
        severity,
        message,
        ...(str(r.ruleId) ? { rule: str(r.ruleId) } : {}),
        ...(str(props.package) ? { package: str(props.package) } : {}),
        ...(str(props.version) ? { version: str(props.version) } : {}),
        ...(str(props.fixedIn) ? { fixedIn: str(props.fixedIn) } : {}),
      });
    }
  }
  return out;
}

const IS_SARIF = /\.sarif(\.json)?$/i;

/** The findings in a results folder's SARIF files; null when it has none. */
export function readFindings(dir: string): Findings | null {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => IS_SARIF.test(f))
      .sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const all: Finding[] = [];
  for (const f of files) {
    try {
      all.push(
        ...findingsOf(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))),
      );
    } catch {
      // An unreadable file adds nothing; the others still count.
    }
  }
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const x of all) counts[x.severity]++;
  const list = all
    .map((x, i) => ({ x, i }))
    .sort(
      (a, b) =>
        SEVERITIES.indexOf(a.x.severity) - SEVERITIES.indexOf(b.x.severity) ||
        a.i - b.i,
    )
    .slice(0, KEEP_FINDINGS)
    .map((y) => y.x);
  return { counts, list, report: files[0] };
}
