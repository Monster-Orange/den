/**
 * Issue 1131, item 3: doctor's row for agents' refused calls: each
 * agent's token used from a process Den couldn't place, or from outside
 * its own processes, counted over the last hour from the audit
 * (audit.jsonl, verb agent-token, outcome refused), with the last one
 * refused and what to do. A caller that had gone isn't counted: nothing
 * was refused. Never a token: anything shaped like one is cut out.
 */
import * as fs from "fs";
import * as path from "path";
import {
  AUDIT_FILE,
  AUDIT_SET_ASIDE_DIR,
  AUDIT_SET_ASIDE_MARK,
} from "../../shared/audit-file.js";
import { readTailLines } from "../../shared/dev-metrics/polling.js";
import type { OnboardCheck } from "./doctor-onboard.js";

export interface RefusalEntry {
  ts: string;
  verb: string;
  outcome?: "refused";
  principal?: string;
  reason?: string;
  detail: string;
}

const HOUR_MS = 60 * 60 * 1000;
/** Den's tokens (den_at_…, den_pt_…, …): never shown. */
const TOKEN = /\bden_[a-z]{2}_[A-Za-z0-9_-]+/g;
const noToken = (s: string) => s.replace(TOKEN, "[token]");

export function tokenRefusalLines(
  title: string,
  entries: readonly RefusalEntry[],
  now: Date = new Date(),
): { lines: string[]; check: OnboardCheck } {
  const since = now.getTime() - HOUR_MS;
  const counts = new Map<string, number>();
  let last: RefusalEntry | null = null;
  for (const e of entries) {
    if (e.verb !== "agent-token" || e.outcome !== "refused") continue;
    const at = Date.parse(e.ts);
    if (!Number.isFinite(at) || at < since || at > now.getTime()) continue;
    const agent = (e.principal ?? "").replace(/^agent:/, "") || "an agent";
    counts.set(agent, (counts.get(agent) ?? 0) + 1);
    if (!last || at >= Date.parse(last.ts)) last = e;
  }
  const heading = ["", `${title} doctor: agents' refused calls`, ""];
  if (!counts.size || !last) {
    const detail =
      "agents' calls refused as not from their own processes: none in the last hour";
    return {
      lines: [...heading, `  ✓  none in the last hour`],
      check: { id: "agent_token_refusals", status: "ok", detail },
    };
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const per = ranked.map(([a, n]) => `${noToken(a)}: ${n}`).join(", ");
  const lastLine = noToken(last.detail);
  const fix = `a call refused at a busy moment can be tried again; if one agent keeps being refused, restart it from Agents (it keeps its conversation)`;
  return {
    lines: [
      ...heading,
      `  !  in the last hour: ${per}`,
      `     last: ${lastLine}`,
      `     ${fix}`,
    ],
    check: {
      id: "agent_token_refusals",
      status: "warn",
      detail: `agents' calls refused in the last hour: ${per}; last: ${lastLine}`,
      fix,
    },
  };
}

/**
 * The audit's tail (at most `maxBytes`, 4 MB: far more than an hour of
 * entries), as entries; bad lines skipped. The audit only grows, so doctor
 * never reads the whole file.
 */
export function readRefusalEntries(
  file: string,
  maxBytes = 4 * 1024 * 1024,
): RefusalEntry[] {
  const out: RefusalEntry[] = [];
  for (const l of readTailLines(file, maxBytes)) {
    try {
      const e = JSON.parse(l) as RefusalEntry;
      if (e && typeof e.ts === "string" && typeof e.verb === "string")
        out.push(e);
    } catch {
      /* not an entry */
    }
  }
  return out;
}

/**
 * Issue 1509: the refusals doctor counts, from `stateDir`. The live trail;
 * and, for the hour after the first start that redacts the audit moved
 * the trail aside (issue 1391's marker says when), the set-aside trail
 * too, so a refusal written just before an update isn't lost from the
 * row. From that folder, which may hold values never redacted, only
 * refused agent tokens are kept, only from plain files (never a link).
 */
export function readRefusalTrail(
  stateDir: string,
  now: Date = new Date(),
): RefusalEntry[] {
  const out = readRefusalEntries(path.join(stateDir, AUDIT_FILE));
  const aside = path.join(stateDir, AUDIT_SET_ASIDE_DIR);
  let at = NaN;
  try {
    const mark = JSON.parse(
      fs.readFileSync(path.join(aside, AUDIT_SET_ASIDE_MARK), "utf-8"),
    ) as { at?: unknown };
    at = typeof mark.at === "string" ? Date.parse(mark.at) : NaN;
  } catch {
    return out;
  }
  if (!Number.isFinite(at) || now.getTime() - at > HOUR_MS) return out;
  let names: string[] = [];
  try {
    names = fs.readdirSync(aside).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (name !== AUDIT_FILE && !name.startsWith(`${AUDIT_FILE}.`)) continue;
    const file = path.join(aside, name);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    for (const e of readRefusalEntries(file))
      if (e.verb === "agent-token" && e.outcome === "refused") out.push(e);
  }
  return out;
}
