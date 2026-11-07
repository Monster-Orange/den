/**
 * `<cli> usage` (den#6): how agents spend tokens and time, read from the
 * runtimes' own transcripts on this machine (usage sources, plugin kind
 * `usage`). Nothing is sent anywhere: it reads local files and writes
 * local files.
 *
 *   agents [-w <ws>] [--json]    each agent's tokens and outcome (PR opened
 *                                or merged, tests green, wall-clock), joined
 *                                on its record's resumeToken, and kept in its
 *                                record; the share attributed
 *   report [--days N] [--json]   the week's numbers (default 7 days), written
 *                                to <state dir>/usage/<date>.{json,md} and
 *                                compared with the last report there
 */
import * as fs from "fs";
import * as path from "path";
import {
  listRecords,
  readRecord,
  writeRecord,
} from "../../shared/agents/records.js";
import { getStateDir } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import {
  agentUsage,
  attributedPct,
  renderReport,
  weeklyMetrics,
  type AgentUsageRow,
  type UsageMetrics,
} from "../../shared/usage/report.js";
import { usageSources } from "../../shared/usage/sources.js";
import type { TranscriptStats } from "../../shared/usage/transcript.js";
import {
  columns,
  parseArgs,
  noExtra,
  UsageError,
  workspaceFlag,
} from "./sessions-command.js";

export const USAGE_HELP = {
  usage: "usage <agents|report> ...",
  lines: [
    "How agents spend tokens and time, from the runtimes' own transcripts on",
    "this machine (Claude Code's: ~/.claude/projects). Read locally; nothing",
    "is ever sent anywhere.",
    "",
    "{cli} usage agents [-w <ws>] [--json]",
    "    each agent's tokens and outcome (pull request opened or merged, tests",
    "    green, wall-clock), joined on its conversation id, and saved in its",
    "    record; then the share of agents with both",
    "{cli} usage report [--days <n>] [--json]",
    "    the last n days (default 7): tokens, context re-reads, polling, denials,",
    "    tool errors, corrections, subagents on Opus; written to",
    "    <state dir>/usage/<date>.json and .md, compared with the last report",
  ],
};

export interface UsageDeps {
  stateDir?: () => string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  out?: (line: string) => void;
  err?: (line: string) => void;
  cli?: string;
}

function resolve(d: UsageDeps) {
  return {
    stateDir: d.stateDir ?? (() => getStateDir()),
    env: d.env ?? process.env,
    now: d.now ?? (() => new Date()),
    out: d.out ?? ((l: string) => console.log(l)),
    err: d.err ?? ((l: string) => console.error(l)),
    cli: d.cli ?? product().cli,
  };
}

const k = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${Math.round(n / 1e3)}k`
        : String(n);
const mins = (ms?: number) =>
  ms === undefined
    ? "-"
    : ms < 3_600_000
      ? `${Math.round(ms / 60_000)}m`
      : `${(ms / 3_600_000).toFixed(1)}h`;

/** Save each attributed row's usage and outcome in its agent record. */
function save(stateDir: string, rows: readonly AgentUsageRow[]): void {
  for (const r of rows) {
    if (!r.usage) continue;
    const rec = readRecord(stateDir, r.agent);
    if (!rec) continue;
    writeRecord(stateDir, {
      ...rec,
      usage: r.usage,
      ...(r.outcome ? { outcome: r.outcome } : {}),
    });
  }
}

async function agents(
  args: string[],
  d: ReturnType<typeof resolve>,
): Promise<number> {
  const where = "usage agents";
  const p = parseArgs(where, args, { "--workspace": true, "--json": false });
  noExtra(where, p);
  const ws = workspaceFlag(where, p);
  const recs = listRecords(d.stateDir()).filter(
    (r) => !ws || r.workspace === ws,
  );
  const rows = await agentUsage(recs, { env: d.env });
  save(d.stateDir(), rows);
  const pct = attributedPct(rows);
  if (p.flags["--json"]) {
    d.out(JSON.stringify({ agents: rows, attributedPct: pct }, null, 2));
    return 0;
  }
  if (!rows.length) {
    d.out(`no agents${ws ? ` in ${ws}` : ""}`);
    return 0;
  }
  for (const l of columns([
    [
      "AGENT",
      "WORKSPACE",
      "CALLS",
      "OUTPUT",
      "CACHE READ",
      "WALL",
      "TESTS",
      "PR",
    ],
    ...rows.map((r) => [
      r.agent,
      r.workspace,
      r.usage ? String(r.usage.calls) : "-",
      r.usage ? k(r.usage.output) : "-",
      r.usage ? k(r.usage.cacheRead) : "-",
      mins(r.outcome?.wallClockMs),
      r.outcome?.testsGreen === undefined
        ? "-"
        : r.outcome.testsGreen
          ? "green"
          : "red",
      r.outcome?.prOpened
        ? `${r.outcome.prOpened}${r.outcome.prMerged ? " (merged)" : ""}`
        : "-",
    ]),
  ]))
    d.out(l);
  for (const r of rows) if (r.why) d.out(`  ${r.agent}: ${r.why}`);
  d.out("");
  d.out(
    `${pct}% of agents have their tokens and outcome (${rows.filter((r) => r.attributed).length} of ${rows.length}). Read locally; nothing was sent.`,
  );
  return 0;
}

/** The newest report in `dir` dated before `date`, if any. */
function previous(
  dir: string,
  date: string,
): { date: string; metrics: Partial<UsageMetrics> } | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const older = names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n < `${date}.json`)
    .sort();
  const last = older[older.length - 1];
  if (!last) return undefined;
  try {
    return {
      date: last.slice(0, -5),
      metrics: JSON.parse(
        fs.readFileSync(path.join(dir, last), "utf-8"),
      ) as Partial<UsageMetrics>,
    };
  } catch {
    return undefined;
  }
}

async function report(
  args: string[],
  d: ReturnType<typeof resolve>,
): Promise<number> {
  const where = "usage report";
  const p = parseArgs(where, args, { "--days": true, "--json": false });
  noExtra(where, p);
  const days = p.flags["--days"] === undefined ? 7 : Number(p.flags["--days"]);
  if (!Number.isFinite(days) || days <= 0 || days > 366)
    throw new UsageError(`${where}: --days must be a number of days, 1 to 366`);
  const now = d.now();
  const since = now.getTime() - days * 86_400_000;
  const stats: TranscriptStats[] = [];
  for (const src of usageSources())
    for (const f of src.files(since, d.env))
      stats.push(await src.mine(f, { since }));
  const rows = await agentUsage(listRecords(d.stateDir()), { env: d.env });
  save(d.stateDir(), rows);
  const m = weeklyMetrics(stats, rows);
  const date = now.toISOString().slice(0, 10);
  const dir = path.join(d.stateDir(), "usage");
  const prev = previous(dir, date);
  const md = renderReport(m, date, prev);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, `${date}.json`),
    JSON.stringify(m, null, 1) + "\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(dir, `${date}.md`), md, { mode: 0o600 });
  if (p.flags["--json"]) d.out(JSON.stringify(m, null, 2));
  else {
    for (const l of md.trimEnd().split("\n")) d.out(l);
    d.out("");
    d.out(
      `Written to ${path.join(dir, `${date}.md`)} (${stats.length} transcripts, ${days} days).`,
    );
  }
  return 0;
}

/** `<cli> usage ...`; returns the exit code. */
export async function cmdUsage(
  args: string[],
  deps: UsageDeps = {},
): Promise<number> {
  const d = resolve(deps);
  const sub = args[0] ?? "agents";
  try {
    if (sub === "agents") return await agents(args.slice(1), d);
    if (sub === "report") return await report(args.slice(1), d);
    throw new UsageError(`unknown usage command "${sub}"`);
  } catch (e) {
    if (e instanceof UsageError) {
      d.err(`✗ ${e.message}`);
      d.err(`Usage: ${d.cli} ${USAGE_HELP.usage}`);
      return 2;
    }
    throw e;
  }
}
