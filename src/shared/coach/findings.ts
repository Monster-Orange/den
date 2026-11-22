/**
 * Issue 52, Coach slice T-b (TUNE-3): the findings that need no judging,
 * read from a run's counts (breakdown.ts). Each names its agent, carries
 * its evidence (the numbers that tripped it) and a proposal for a person.
 * Nothing is applied in this phase: Apply comes with issue 110.
 *
 *   subagent_opus    most subagent calls on Opus, with enough calls to tell
 *   polling          polls a day at or over the threshold (den#5)
 *   no_rotation      its conversation is past its rotation limit (den#4)
 *   denials          permission denials a day at or over the threshold
 *   transcript_size  the window's transcripts at or over the size limit (D76)
 *
 * Slice T-c (TUNE-5, counted; asks.ts), each with up to three samples:
 *   ask_r12       too few of its asks to a person pass the plain-writing rule
 *   ask_wait      its asks wait long for a person's answer
 *   msg_repeat    it sends other agents the same text again and again
 *   msg_no_reply  most of its sends to other agents get no reply
 *
 * Thresholds are agents.coach.findings (settings.ts). Dismiss records the
 * reason, who and when (`coach/dismissed.json`, 0600); a dismissed
 * finding stays out of the open list on later runs. A finding's id is
 * `<kind>:<agent id>`, so a later run's finding of the same kind on the
 * same agent is the same finding.
 */
import * as fs from "fs";
import * as path from "path";
import { writePrivate } from "../agents/records.js";
import type { CoachAgentRow, CoachReport, CoachWindow } from "./breakdown.js";
import type { FindingThresholds } from "./settings.js";

export type FindingKind =
  | "subagent_opus"
  | "polling"
  | "no_rotation"
  | "denials"
  | "transcript_size"
  | "ask_r12"
  | "ask_wait"
  | "msg_repeat"
  | "msg_no_reply";

/** One instance a person can check: an ask or a message. */
export interface FindingSample {
  /** ISO 8601. */
  at: string;
  /** Its words, cut short, secrets out. */
  text: string;
  /** What was wrong with it (none: []). */
  problems: string[];
}

export interface CoachFinding {
  /** `<kind>:<agent id>`. */
  id: string;
  kind: FindingKind;
  agent: string;
  workspace: string;
  /** One plain sentence: what was found. */
  title: string;
  /** The numbers that tripped it. */
  evidence: Record<string, number>;
  /** What a person could do (never applied in this phase). */
  proposal: string;
  window: CoachWindow;
  /** Up to three instances, for the T-c findings. */
  samples?: FindingSample[];
}

const MB = 1024 * 1024;
const MAX_SAMPLES = 3;
const sample = (at: number, text: string, problems: string[] = []) => ({
  at: new Date(at).toISOString(),
  text,
  problems,
});

function findingsOf(
  a: CoachAgentRow,
  t: FindingThresholds,
  window: CoachWindow,
): CoachFinding[] {
  const who = `${a.agent} (${a.workspace})`;
  const out: CoachFinding[] = [];
  const add = (
    kind: FindingKind,
    title: string,
    evidence: Record<string, number>,
    proposal: string,
    samples?: FindingSample[],
  ) =>
    out.push({
      id: `${kind}:${a.agent}`,
      kind,
      agent: a.agent,
      workspace: a.workspace,
      title,
      evidence,
      proposal,
      window,
      ...(samples ? { samples: samples.slice(0, MAX_SAMPLES) } : {}),
    });
  asksFindings(a, t, who, add);
  if (!a.metrics) return out;
  const subCalls = Object.values(a.models?.subagent ?? {}).reduce(
    (n, c) => n + c,
    0,
  );
  const opus = a.metrics.subagent_opus_pct;
  if (subCalls >= t.min_subagent_calls && opus >= t.subagent_opus_pct)
    add(
      "subagent_opus",
      `${who} ran ${opus}% of its subagent calls on Opus.`,
      { subagent_opus_pct: opus, subagent_calls: subCalls },
      "Set its persona's subagent_model to Sonnet, so exploring and checking run on the cheaper model.",
    );
  const polls = a.perDay?.polls_per_day ?? 0;
  if (polls > 0 && polls >= t.polls_per_day)
    add(
      "polling",
      `${who} polls ${polls} times a day.`,
      { polls_per_day: polls },
      "Point it to running long work in the background and waiting to be told, instead of polling.",
    );
  if (
    a.current &&
    a.current.after > 0 &&
    a.current.compactions > a.current.after
  )
    add(
      "no_rotation",
      `${who} is at ${a.current.compactions} compactions, past its limit of ${a.current.after}, and hasn't rotated.`,
      { compactions: a.current.compactions, after: a.current.after },
      "Relaunch it from its handoff.",
    );
  const denials = a.perDay?.denials_per_day ?? 0;
  if (denials > 0 && denials >= t.denials_per_day)
    add(
      "denials",
      `${who} is refused ${denials} times a day.`,
      { denials_per_day: denials },
      "Check what it keeps asking for: an allow rule for the person to approve, or a change to how it works.",
    );
  const bytes = a.transcriptBytes ?? 0;
  if (t.transcript_mb > 0 && bytes >= t.transcript_mb * MB)
    add(
      "transcript_size",
      `${who}'s transcripts in the window take ${Math.round(bytes / MB)} MB.`,
      { transcript_mb: Math.round(bytes / MB) },
      "Rotate it, or have it save screenshots to files instead of keeping them in its conversation.",
    );
  return out;
}

type Add = (
  kind: FindingKind,
  title: string,
  evidence: Record<string, number>,
  proposal: string,
  samples?: FindingSample[],
) => void;

/** Slice T-c: its asks to a person and its messages to other agents. */
function asksFindings(
  a: CoachAgentRow,
  t: FindingThresholds,
  who: string,
  add: Add,
): void {
  if (!a.asks) return;
  const { metrics: m, stats } = a.asks;
  if (m.asks >= t.min_asks && m.ask_r12_pass_pct < t.ask_r12_pass_pct)
    add(
      "ask_r12",
      `${who}: ${m.ask_r12_pass_pct}% of its ${m.asks} asks to a person are plain (the plain-writing rule).`,
      { asks: m.asks, ask_r12_pass_pct: m.ask_r12_pass_pct },
      "Tighten its persona's ask rules: short sentences, every ID explained, each decision a numbered yes/no question.",
      stats.asks
        .filter((x) => x.problems.length)
        .map((x) => sample(x.at, x.text, x.problems)),
    );
  const answered = m.asks - m.asks_unanswered;
  if (answered >= t.min_asks && m.ask_wait_min >= t.ask_wait_min)
    add(
      "ask_wait",
      `${who}'s asks wait ${m.ask_wait_min} minutes for an answer, at the median.`,
      { asks: m.asks, ask_wait_min: m.ask_wait_min },
      "Check whether another agent owns these answers, so the person isn't asked; or batch the asks.",
      stats.asks
        .filter((x) => x.answeredAt !== undefined)
        .sort((x, y) => y.answeredAt! - y.at - (x.answeredAt! - x.at))
        .map((x) => sample(x.at, x.text)),
    );
  if (t.sends_repeated > 0 && m.sends_repeated >= t.sends_repeated) {
    const count = new Map<string, number>();
    for (const s of stats.sends) count.set(s.hash, (count.get(s.hash) ?? 0) + 1);
    const top = [...stats.sends]
      .filter((s, i, all) => all.findIndex((x) => x.hash === s.hash) === i)
      .filter((s) => (count.get(s.hash) ?? 0) > 1)
      .sort((x, y) => (count.get(y.hash) ?? 0) - (count.get(x.hash) ?? 0));
    add(
      "msg_repeat",
      `${who} sent other agents the same text again ${m.sends_repeated} times.`,
      { sends: m.sends, sends_repeated: m.sends_repeated },
      "Find out why it resends: a missed reply, or a loop. Say it once, and wait to be told.",
      top.map((s) => sample(s.at, s.text)),
    );
  }
  const noReplyPct = m.sends ? Math.round((m.sends_no_reply / m.sends) * 100) : 0;
  if (m.sends >= t.min_sends && noReplyPct >= t.sends_no_reply_pct)
    add(
      "msg_no_reply",
      `${who}: ${noReplyPct}% of its ${m.sends} messages to other agents got no reply.`,
      { sends: m.sends, sends_no_reply: m.sends_no_reply },
      "Check it sends to the agent that owns the answer, and that the other agent reads its messages.",
      stats.sends.map((s) => sample(s.at, `to ${s.to}: ${s.text}`)),
    );
}

/** Every counted finding in `report`, agent by agent. */
export function coachFindings(
  report: CoachReport,
  t: FindingThresholds,
): CoachFinding[] {
  return report.agents.flatMap((a) => findingsOf(a, t, report.window));
}

export interface Dismissal {
  id: string;
  reason: string;
  /** Who dismissed it (the audit trail's actor). */
  by: string;
  /** ISO 8601. */
  at: string;
}

const ID_RE = /^[a-z_]{1,32}:[A-Za-z0-9._-]{1,128}$/;
const MAX_REASON = 500;

function dismissedFile(stateDir: string): string {
  return path.join(stateDir, "coach", "dismissed.json");
}

/** The dismissals recorded, oldest first (none: []). */
export function readDismissals(stateDir: string): Dismissal[] {
  try {
    const v = JSON.parse(fs.readFileSync(dismissedFile(stateDir), "utf-8"));
    return Array.isArray(v)
      ? v.filter(
          (d): d is Dismissal =>
            !!d &&
            typeof d.id === "string" &&
            ID_RE.test(d.id) &&
            typeof d.reason === "string" &&
            typeof d.by === "string" &&
            typeof d.at === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export type DismissResult =
  | { ok: true }
  | {
      ok: false;
      code: "bad_id" | "reason_required" | "reason_too_long";
      error: string;
    };

/** Dismiss finding `id`, with the person's reason (it replaces an earlier one). */
export function dismissFinding(
  stateDir: string,
  id: string,
  reason: string,
  by: string,
  at: string = new Date().toISOString(),
): DismissResult {
  if (typeof id !== "string" || !ID_RE.test(id))
    return { ok: false, code: "bad_id", error: "That isn't a finding's id." };
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why)
    return {
      ok: false,
      code: "reason_required",
      error: "Say why it's dismissed: the reason is kept with it.",
    };
  if (why.length > MAX_REASON)
    return {
      ok: false,
      code: "reason_too_long",
      error: `Keep the reason to ${MAX_REASON} characters.`,
    };
  const list = readDismissals(stateDir).filter((d) => d.id !== id);
  list.push({ id, reason: why, by, at });
  writePrivate(dismissedFile(stateDir), JSON.stringify(list, null, 2) + "\n");
  return { ok: true };
}

/** `findings` less the dismissed ones. */
export function openFindings(
  stateDir: string,
  findings: readonly CoachFinding[],
): CoachFinding[] {
  const gone = new Set(readDismissals(stateDir).map((d) => d.id));
  return findings.filter((f) => !gone.has(f.id));
}
