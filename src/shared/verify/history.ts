/**
 * Issue 212 (Verify 6): what the page's History (S5) and Security
 * findings (S6) read, from the kept run records.
 *
 *   moduleHistory      a module's last runs on one environment, oldest
 *                      first; the first failing range (the last good run
 *                      and the first bad one after it, while the latest
 *                      isn't a pass); and the flaky mark: passed after a
 *                      retry in at least `verify.flaky.min_retries` of the
 *                      last `verify.flaky.window` runs
 *   readSarifFindings  the findings a scan wrote to DEN_RESULTS_DIR as
 *                      SARIF, by severity
 *   scanVerdict        a scan's state: failed when any finding is at or
 *                      above the threshold (`verify.security.fail_on`),
 *                      passed below it, whatever the scanner's exit code
 */
import * as fs from "fs";
import * as path from "path";
import type { RunRecord } from "./records.js";
import type { ModuleState } from "./run.js";
import { SEVERITIES, type Severity, type VerifySettings } from "./settings.js";

export interface HistoryRun {
  runId: string;
  commit: string | null;
  state: ModuleState;
  /** Each attempt's state, when the module ran more than once. */
  attempts?: ModuleState[];
  /** Passed only after a retry (it counts toward the flaky mark). */
  retried?: true;
  /** Issue 441: an imported run's tag (its run id), the strip's label. */
  tag?: string;
  /** A scan's findings were kept for this run (S6 opens them). */
  findings?: true;
  endedAt: string;
}

export interface ModuleHistory {
  module: string;
  /** The module's name (`<layer>/<name>`), as the page shows it. */
  name: string;
  env: string;
  /** Oldest first, at most `verify.history.limit`. */
  runs: HistoryRun[];
  firstFailing: {
    lastGood: { runId: string; commit: string | null } | null;
    firstBad: { runId: string; commit: string | null };
  } | null;
  flaky: {
    flaky: boolean;
    retried: number;
    window: number;
    minRetries: number;
  };
}

const passedAfterRetry = (state: ModuleState, attempts?: ModuleState[]) =>
  state === "passed" && (attempts?.length ?? 0) > 1;

/** `records`: the project's runs, in any order. */
export function moduleHistory(
  records: readonly RunRecord[],
  module: string,
  env: string,
  s: Pick<VerifySettings, "historyLimit" | "flakyWindow" | "flakyMinRetries">,
): ModuleHistory {
  let name = module;
  const all: HistoryRun[] = [...records]
    .filter((r) => r.env === env)
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt))
    .flatMap((r) => {
      const m = r.modules.find((x) => x.name === module || x.id === module);
      if (!m) return [];
      name = m.name;
      return [
        {
          runId: r.runId,
          commit: r.commit ?? null,
          state: m.state,
          ...(m.attempts ? { attempts: m.attempts } : {}),
          ...(passedAfterRetry(m.state, m.attempts)
            ? { retried: true as const }
            : {}),
          ...(r.source === "import" ? { tag: r.runId } : {}),
          ...(m.findings ? { findings: true as const } : {}),
          endedAt: r.endedAt,
        },
      ];
    });
  const window = all.slice(-s.flakyWindow);
  const retried = window.filter((r) => r.retried).length;
  let firstFailing: ModuleHistory["firstFailing"] = null;
  const last = all.at(-1);
  if (last && last.state !== "passed") {
    let i = all.length - 1;
    while (i > 0 && all[i - 1].state !== "passed") i--;
    const bad = all[i];
    const good = i > 0 ? all[i - 1] : null;
    firstFailing = {
      lastGood: good ? { runId: good.runId, commit: good.commit } : null,
      firstBad: { runId: bad.runId, commit: bad.commit },
    };
  }
  return {
    module,
    name,
    env,
    runs: all.slice(-s.historyLimit),
    firstFailing,
    flaky: {
      flaky: retried >= s.flakyMinRetries,
      retried,
      window: s.flakyWindow,
      minRetries: s.flakyMinRetries,
    },
  };
}

export type SeverityCounts = Record<Severity, number>;

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** The first location's file, when the scan names one. */
  file?: string;
  /** A dependency scan's package, its version, and the one that fixes it. */
  package?: string;
  version?: string;
  fixedIn?: string;
}

export interface ScanFindings {
  counts: SeverityCounts;
  findings: Finding[];
}

/** The findings a page and a record keep, at most. */
export const KEEP_FINDINGS = 200;

const zero = (): SeverityCounts => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
});

/** A CVSS-style score (security-severity) as a severity; 0 or none: null. */
function fromScore(v: unknown): Severity | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 9 ? "critical" : n >= 7 ? "high" : n >= 4 ? "medium" : "low";
}

/** SARIF's level (default "warning"), as a severity; "none": null. */
function fromLevel(v: unknown): Severity | null {
  const l = typeof v === "string" ? v : "warning";
  return l === "error"
    ? "high"
    : l === "warning"
      ? "medium"
      : l === "note"
        ? "low"
        : null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The property names dependency scanners use for a finding's package, its
 * installed version and the version that fixes it (SARIF leaves these to
 * each tool). The first one present wins.
 */
const PACKAGE_KEYS = ["packageName", "package", "PkgName", "pkgName"];
const VERSION_KEYS = ["installedVersion", "InstalledVersion", "version"];
const FIXED_KEYS = ["fixedVersion", "FixedVersion", "fixedIn", "fixVersion"];

/** The first of `keys` that holds a short text, cut to 200 characters. */
function firstText(o: Obj, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return undefined;
}

/**
 * The findings in every SARIF file (`*.sarif`, `*.sarif.json`) in `dir`,
 * by severity: a result's `security-severity` (or its rule's), else its
 * level (error high, warning medium, note low; none is no finding). Null
 * when no SARIF file is there (the exit code decides then).
 */
export function readSarifFindings(dir: string): ScanFindings | null {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /\.sarif(\.json)?$/i.test(f))
      .sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const counts = zero();
  const findings: Finding[] = [];
  for (const f of files) {
    let doc: Obj;
    try {
      doc = obj(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
    } catch {
      continue;
    }
    for (const run of arr(doc.runs)) {
      const rules = new Map<string, Obj>();
      for (const r of arr(obj(obj(obj(run).tool).driver).rules)) {
        const id = obj(r).id;
        if (typeof id === "string") rules.set(id, obj(r));
      }
      for (const raw of arr(obj(run).results)) {
        const res = obj(raw);
        const rule = typeof res.ruleId === "string" ? res.ruleId : "";
        const sev =
          fromScore(obj(res.properties)["security-severity"]) ??
          fromScore(obj(rules.get(rule)?.properties)["security-severity"]) ??
          fromLevel(
            res.level ?? obj(rules.get(rule)?.defaultConfiguration).level,
          );
        if (!sev) continue;
        counts[sev]++;
        const file = obj(
          obj(obj(arr(res.locations)[0]).physicalLocation).artifactLocation,
        ).uri;
        const props = obj(res.properties);
        const pkg = firstText(props, PACKAGE_KEYS);
        const version = firstText(props, VERSION_KEYS);
        const fixedIn = firstText(props, FIXED_KEYS);
        findings.push({
          rule: rule || "(no rule)",
          severity: sev,
          message: String(obj(res.message).text ?? "").slice(0, 300),
          ...(typeof file === "string" ? { file } : {}),
          ...(pkg ? { package: pkg } : {}),
          ...(version ? { version } : {}),
          ...(fixedIn ? { fixedIn } : {}),
        });
      }
    }
  }
  findings.sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  return { counts, findings: findings.slice(0, KEEP_FINDINGS) };
}

/** A scan's state from its counts: failed at or above `failOn`. */
export function scanVerdict(
  counts: SeverityCounts,
  failOn: Severity,
): { state: "passed" | "failed"; atOrAbove: number } {
  const upTo = SEVERITIES.indexOf(failOn);
  const atOrAbove = SEVERITIES.slice(0, upTo + 1).reduce(
    (n, s) => n + counts[s],
    0,
  );
  return { state: atOrAbove > 0 ? "failed" : "passed", atOrAbove };
}
