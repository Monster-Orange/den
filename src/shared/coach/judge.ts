/**
 * Issue 52, Coach slice T-d (TUNE-5, the judged parts). Counted rules pick
 * the items; the cheap model judges them; each judgement keeps its
 * evidence and the model's reason, so a person can check it.
 *
 *   repeat_ask   a person's prompt with repeat words ("still", "again",
 *                "I asked") that restates an earlier prompt of theirs, to
 *                this agent or another; the context is their closest
 *                earlier prompts
 *   trivial_ask  an ask the agent should have decided itself
 *   relay        a message to another agent that passes a person's request
 *                on as if it were the agent's own
 *
 * Off unless agents.coach.judge.enabled: judging sends short samples to the
 * model provider, through the runtime's own CLI (print mode, no tools, no
 * MCP servers, no settings, no saved session). Every text is run through
 * redactSecrets again before it leaves. A run stops before a call that
 * would pass budget_tokens, and the report states what judging cost.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEN_CLAUDE_FIND, DEN_CLAUDE_ID } from "../agents/den-claude.js";
import { locateRuntime, type Located } from "../agents/runtime-search.js";
import { configuredRuntimeBin } from "../den-config.js";
import { redactSecrets } from "../redact.js";
import type { CoachReport } from "./breakdown.js";
import type { CoachFinding, FindingSample } from "./findings.js";
import type { JudgeSettings } from "./settings.js";

export type JudgeKind = "repeat_ask" | "trivial_ask" | "relay";

export interface JudgeItem {
  /** `<kind>:<agent>:<n>`. */
  id: string;
  kind: JudgeKind;
  agent: string;
  workspace: string;
  /** ms since the epoch. */
  at: number;
  text: string;
  /** What the model compares it with (earlier prompts, for a repeat). */
  context: string[];
}

export interface Verdict {
  id: string;
  yes: boolean;
  why: string;
}

/** A model call: the prompt in, its answer and the tokens it used out. */
export type ModelRun = (
  prompt: string,
  o: { model: string },
) => Promise<{ text: string; tokens: number }>;

const REPEAT =
  /\b(still|again|already (asked|told|said)|i (asked|told you|said)|as i said|once more)\b/i;
const RELAY =
  /\b(the (person|user)|my person|(they|he|she) asked|asked me to|wants you to)\b/i;

const words = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length >= 4),
  );

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

const clean = (t: string) => redactSecrets(String(t ?? "")).slice(0, 300);

/** The items the model judges, at most `max`: repeats, relays, then asks. */
export function judgeCandidates(report: CoachReport, max: number): JudgeItem[] {
  const prompts = report.agents.flatMap((a) =>
    (a.asks?.stats?.prompts ?? []).map((p) => ({ ...p, agent: a.agent })),
  );
  const repeats: JudgeItem[] = [];
  const relays: JudgeItem[] = [];
  const asks: JudgeItem[] = [];
  for (const a of report.agents) {
    const s = a.asks?.stats;
    if (!s) continue;
    const item = (
      kind: JudgeKind,
      n: number,
      at: number,
      text: string,
      context: string[] = [],
    ): JudgeItem => ({
      id: `${kind}:${a.agent}:${n}`,
      kind,
      agent: a.agent,
      workspace: a.workspace,
      at,
      text: clean(text),
      context: context.map(clean),
    });
    (s.prompts ?? []).forEach((p, n) => {
      if (!REPEAT.test(p.text)) return;
      const mine = words(p.text);
      const earlier = prompts
        .filter((q) => q.at < p.at)
        .map((q) => ({ q, score: overlap(mine, words(q.text)) }))
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 3)
        .map((x) => x.q.text);
      repeats.push(item("repeat_ask", n, p.at, p.text, earlier));
    });
    s.sends.forEach((m, n) => {
      if (RELAY.test(m.text))
        relays.push(item("relay", n, m.at, `to ${m.to}: ${m.text}`));
    });
    s.asks.forEach((q, n) => asks.push(item("trivial_ask", n, q.at, q.text)));
  }
  return [...repeats, ...relays, ...asks].slice(0, Math.max(0, max));
}

const ASK: Record<JudgeKind, string> = {
  repeat_ask:
    "Each item is a person's prompt to an AI agent, with their earlier prompts as context. yes: it restates an earlier ask (the person had to repeat themselves).",
  trivial_ask:
    "Each item is a question an AI agent asked a person. yes: the agent should have decided it itself (a small wording, layout or ordering call, or something it could check), not a decision that is the person's.",
  relay:
    "Each item is a message one AI agent sent another. yes: it passes on a person's request as if it were the agent's own, or asks the other agent to do what the person did not approve.",
};

/** The prompt for one batch. */
function promptFor(kind: JudgeKind, items: JudgeItem[]): string {
  return [
    ASK[kind],
    'Answer with only a JSON array, one entry per item: [{"id": "...", "yes": true|false, "why": "one short sentence"}].',
    JSON.stringify(
      items.map((i) => ({
        id: i.id,
        text: i.text,
        ...(i.context.length ? { context: i.context } : {}),
      })),
    ),
  ].join("\n\n");
}

/** The verdicts in `text` for `ids`; anything else is dropped. */
function verdictsOf(text: string, ids: Set<string>): Verdict[] {
  const a = text.indexOf("[");
  const b = text.lastIndexOf("]");
  if (a < 0 || b <= a) return [];
  let v: unknown;
  try {
    v = JSON.parse(text.slice(a, b + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): Verdict[] => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    if (
      typeof o.id !== "string" ||
      !ids.has(o.id) ||
      typeof o.yes !== "boolean"
    )
      return [];
    return [
      {
        id: o.id,
        yes: o.yes,
        why: typeof o.why === "string" ? o.why.slice(0, 300) : "",
      },
    ];
  });
}

/** Tokens a call is expected to use: its prompt, the CLI's own context (about 650 measured), and the answer. */
const estimate = (prompt: string) => Math.ceil(prompt.length / 4) + 1200;

const TITLE: Record<JudgeKind, (who: string, n: number) => string> = {
  repeat_ask: (who, n) =>
    `The person repeated themselves to ${who} ${n} times.`,
  trivial_ask: (who, n) =>
    `${who} asked the person ${n} things it could have decided itself.`,
  relay: (who, n) =>
    `${who} passed a person's request on as its own ${n} times.`,
};

const PROPOSAL: Record<JudgeKind, string> = {
  repeat_ask:
    "Find where the first ask went: record it as a task, or graduate a repeated correction to a rule, test or hook.",
  trivial_ask:
    "Tighten its persona's ask rules, so it decides small calls itself and asks only what is the person's.",
  relay:
    "Have it say whose request it is, and send the person's decision only after the person makes it.",
};

/**
 * Judge `report`'s items and add the judged findings to it, with the cost.
 * Calls no model when judging is off.
 */
export async function judgeReport(
  report: CoachReport,
  s: JudgeSettings,
  run: ModelRun = claudeRun,
  o: { spentToday?: number } = {},
): Promise<{ tokens: number; skipped: number }> {
  if (!s.enabled) return { tokens: 0, skipped: 0 };
  const items = judgeCandidates(report, s.max_items);
  const verdicts: Verdict[] = [];
  const why = new Set<string>();
  const today = Math.max(0, o.spentToday ?? 0);
  let tokens = 0;
  let skipped = 0;
  let calls = 0;
  for (const kind of ["repeat_ask", "relay", "trivial_ask"] as const) {
    const batch = items.filter((i) => i.kind === kind);
    if (!batch.length) continue;
    const prompt = promptFor(kind, batch);
    const need = estimate(prompt);
    if (today + tokens + need > s.budget_tokens_day) {
      skipped += batch.length;
      why.add(
        `the day's budget (agents.coach.judge.budget_tokens_day, ${s.budget_tokens_day}) is spent`,
      );
      continue;
    }
    if (tokens + need > s.budget_tokens) {
      skipped += batch.length;
      why.add(
        `the run's budget (agents.coach.judge.budget_tokens, ${s.budget_tokens}) is spent`,
      );
      continue;
    }
    calls++;
    try {
      const out = await run(prompt, { model: s.model });
      tokens += Math.max(0, out.tokens);
      verdicts.push(...verdictsOf(out.text, new Set(batch.map((i) => i.id))));
    } catch (e) {
      skipped += batch.length;
      why.add(String((e as Error)?.message ?? e).slice(0, 200));
    }
  }
  if (calls) report.cost = { model: s.model, tokens };
  if (items.length)
    report.judge = {
      model: s.model,
      tokens,
      items: items.length,
      skipped,
      ...(why.size ? { why: [...why].slice(0, 5) } : {}),
    };
  const byId = new Map(items.map((i) => [i.id, i]));
  const groups = new Map<
    string,
    { item: JudgeItem; samples: FindingSample[] }
  >();
  for (const v of verdicts) {
    if (!v.yes) continue;
    const it = byId.get(v.id)!;
    const key = `${it.kind}:${it.agent}`;
    const g = groups.get(key) ?? { item: it, samples: [] };
    g.samples.push({
      at: new Date(it.at).toISOString(),
      text: it.text,
      problems: v.why ? [v.why] : [],
    });
    groups.set(key, g);
  }
  const found: CoachFinding[] = [...groups.entries()].map(([id, g]) => {
    const who = `${g.item.agent} (${g.item.workspace})`;
    return {
      id,
      kind: g.item.kind,
      agent: g.item.agent,
      workspace: g.item.workspace,
      title: TITLE[g.item.kind](who, g.samples.length),
      evidence: { judged_yes: g.samples.length },
      proposal: PROPOSAL[g.item.kind],
      window: report.window,
      samples: g.samples.slice(0, 3),
    };
  });
  report.findings = [...(report.findings ?? []), ...found];
  return { tokens, skipped };
}

const SYSTEM =
  "You judge short samples for a report. Answer only with the JSON asked for.";

/** The runtime CLI's arguments: print mode, the prompt alone, nothing kept. */
export function claudeArgs(model: string): string[] {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--system-prompt",
    SYSTEM,
  ];
}

const CALL_MS = 120_000;

/** Where the runtime's CLI is: the way agent launches find it. */
export type LocateCli = () => Located;

/** Runs the CLI at `file` in `cwd` with the prompt on stdin; its stdout. */
export type SpawnCli = (
  file: string,
  args: string[],
  cwd: string,
  input: string,
) => Promise<string>;

const locateCli: LocateCli = () =>
  locateRuntime(
    DEN_CLAUDE_ID,
    DEN_CLAUDE_FIND,
    process.env,
    configuredRuntimeBin(DEN_CLAUDE_ID),
  );

const spawnCli: SpawnCli = (file, args, cwd, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), CALL_MS);
    child.stdout.on("data", (b: Buffer) => {
      if (out.length < 1_000_000) out += b.toString("utf-8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`the runtime's CLI exited ${code}`));
      else resolve(out);
    });
    child.stdin.end(input);
  });

/**
 * A model call through the runtime's CLI. It runs in a fresh empty folder
 * (removed after), so no project's CLAUDE.md is near it; a CLI it can't
 * find is a named reason, not a bare failure.
 */
export function makeClaudeRun(
  d: { locate?: LocateCli; spawn?: SpawnCli } = {},
): ModelRun {
  return async (prompt, o) => {
    const at = (d.locate ?? locateCli)();
    if (!at.available || !at.path)
      throw new Error(`the runtime's CLI: ${at.why ?? "not found"}`);
    if (at.quarantined)
      throw new Error(
        `the runtime's CLI at ${at.path} is quarantined, not run`,
      );
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "den-coach-judge-"));
    try {
      const raw = await (d.spawn ?? spawnCli)(
        at.path,
        claudeArgs(o.model),
        cwd,
        prompt,
      );
      const v = JSON.parse(raw) as {
        result?: unknown;
        usage?: Record<string, unknown>;
      };
      const u = v.usage ?? {};
      const n = (k: string) =>
        typeof u[k] === "number" ? (u[k] as number) : 0;
      return {
        text: typeof v.result === "string" ? v.result : "",
        tokens:
          n("input_tokens") +
          n("output_tokens") +
          n("cache_read_input_tokens") +
          n("cache_creation_input_tokens"),
      };
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  };
}

/** The default model call: the runtime's CLI, found as agent launches find it. */
export const claudeRun: ModelRun = makeClaudeRun();
