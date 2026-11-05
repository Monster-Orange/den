/**
 * `doctor`: every strategy kind in the registry (secrets, tls), the
 * strategy this distribution selects for it, whether nothing chose it
 * (implicit), and its detect() result with the reason.
 *
 * Read-only: detect() is a PATH check, so doctor never spawns a backend
 * CLI, never prompts, and never prints a secret value. Exit 1 when a
 * strategy that will be used is unavailable or its config is invalid.
 */
import chalk from "chalk";
import { readBrand } from "../../shared/brand.js";
import { hasEdgeBlock, readEdgeConfig } from "../../shared/edge/config.js";
import { edgeTlsWarnings, tlsStrategyFor } from "../../shared/edge/tls.js";
import {
  readSecretsConfig,
  secretsStatus,
} from "../../shared/secrets/index.js";
import { strategyKinds } from "../../shared/strategies/registry.js";

export interface DoctorRow {
  kind: string;
  /** The selected strategy id ("" when the config could not be read). */
  selected: string;
  implicit: boolean;
  available: boolean;
  reason?: string;
  /** True when it will be used and cannot work: doctor exits 1. */
  problem: boolean;
  warnings: string[];
}

type Selector = (env: NodeJS.ProcessEnv) => DoctorRow;

const SELECTORS: Record<string, Selector> = {
  secrets(env) {
    const st = secretsStatus(readSecretsConfig(), env);
    return {
      kind: "secrets",
      selected: st.backend,
      implicit: st.implicit,
      available: st.detect.available,
      reason: st.detect.reason,
      // The implicit default is used only when a secret is asked for.
      problem: !st.detect.available && !st.implicit,
      warnings: [],
    };
  },
  tls(env) {
    if (!hasEdgeBlock())
      return {
        kind: "tls",
        selected: "none",
        implicit: false,
        available: true,
        reason: "no edge: block",
        problem: false,
        warnings: [],
      };
    try {
      const cfg = readEdgeConfig();
      const d = tlsStrategyFor(cfg).detect(env);
      return {
        kind: "tls",
        selected: cfg.tls.strategy,
        implicit: cfg.tlsFrom === "implicit",
        available: d.available,
        reason: d.reason,
        problem: !d.available,
        warnings: edgeTlsWarnings(cfg),
      };
    } catch (err) {
      return {
        kind: "tls",
        selected: "",
        implicit: false,
        available: false,
        reason: (err as Error).message,
        problem: true,
        warnings: [],
      };
    }
  },
};

/**
 * One row per registered kind (secrets, then tls, then any other kind in
 * registration order). Never spawns, never throws.
 */
export function doctorRows(env: NodeJS.ProcessEnv = process.env): DoctorRow[] {
  const kinds = strategyKinds();
  const ordered = [
    ...Object.keys(SELECTORS).filter((k) => kinds.includes(k)),
    ...kinds.filter((k) => !(k in SELECTORS)),
  ];
  return ordered.map(
    (kind) =>
      SELECTORS[kind]?.(env) ?? {
        kind,
        selected: "",
        implicit: false,
        available: false,
        reason: "no selector for this kind",
        problem: false,
        warnings: [],
      },
  );
}

export function formatDoctor(rows: DoctorRow[], title: string): string[] {
  const lines = [chalk.bold(`${title} doctor: strategies`), ""];
  const width = Math.max(...rows.map((r) => r.kind.length));
  for (const r of rows) {
    const sel = r.selected
      ? `${r.selected}${r.implicit ? " (implicit)" : ""}`
      : "(invalid config)";
    const state = r.available
      ? chalk.green("✓ available")
      : (r.problem ? chalk.red : chalk.yellow)("✗ unavailable");
    lines.push(
      `  ${r.kind.padEnd(width)}  ${sel.padEnd(20)} ${state}${r.reason ? `: ${r.reason}` : ""}`,
    );
    for (const w of r.warnings) lines.push(chalk.yellow(`    ⚠ ${w}`));
  }
  return lines;
}

export function cmdDoctor(_args: string[]): number {
  const rows = doctorRows();
  for (const l of formatDoctor(rows, readBrand().name)) console.log(l);
  return rows.some((r) => r.problem) ? 1 : 0;
}
