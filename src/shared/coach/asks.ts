/**
 * Issue 52, Coach slice T-c (TUNE-5, the counted parts): what an agent
 * asked a person, and how it talked to other agents, read from its own
 * transcript, read-only.
 *
 *   asks      each ask_human call (any MCP server's) and each AskUserQuestion
 *             call, with the plain-writing (R12) problems the hand-back
 *             check would find in it, and when the person answered: the
 *             next prompt of theirs for ask_human, the tool's result for
 *             AskUserQuestion
 *   sends     each SendMessage call: to whom, and a hash of its text with
 *             case and spacing folded, so the same thing sent twice shows
 *   received  each message from another agent (a `<cross-session-message>`
 *             prompt): from whom
 *
 * A subagent's transcript has no asks or messages of its own: its parent
 * makes them. Each text kept is cut to 300 characters with secrets taken
 * out; it stays in the Coach's own files on this machine (0600).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import { bareIds } from "../agents/handback.js";
import { redactSecrets } from "../redact.js";

export type AskTool = "ask_human" | "AskUserQuestion";

export interface AskSeen {
  /** ms since the epoch. */
  at: number;
  tool: AskTool;
  /** The ask's words, cut short, secrets out. */
  text: string;
  /** What R12 finds wrong with it (none: []). */
  problems: string[];
  /** When the person answered; unset when they haven't in the transcript. */
  answeredAt?: number;
}

export interface SendSeen {
  at: number;
  to: string;
  /** The text's hash, case and spacing folded. */
  hash: string;
  text: string;
}

export interface AskStats {
  asks: AskSeen[];
  sends: SendSeen[];
  received: { at: number; from: string }[];
}

export interface AskMetrics {
  asks: number;
  asks_per_day: number;
  /** Asks with no R12 problem, in percent (100 when there are none). */
  ask_r12_pass_pct: number;
  /** The median wait for an answer, in minutes (0 with none answered). */
  ask_wait_min: number;
  asks_unanswered: number;
  sends: number;
  /** Sends whose text the agent had already sent to the same agent. */
  sends_repeated: number;
  /** Sends that no message from that agent followed. */
  sends_no_reply: number;
}

export const MAX_TEXT = 300;
/** R12: a sentence of more words than this is long. */
export const SENTENCE_WORDS = 25;

const QUESTION_WORD = /^(what|which|how|why|when|where|who|whom|whose)\b/i;
const CAVEAT =
  /^\s*(?:#{1,6}\s*|\*\*)?(?:caveats?|risks?|limitations?|notes?)\s*:?\s*(?:\*\*)?\s*$/im;

/** Plain-writing (R12) problems in an ask; none: []. */
export function askProblems(
  text: string,
  maxWords: number = SENTENCE_WORDS,
): string[] {
  const out: string[] = [];
  const body = String(text ?? "");
  for (const id of bareIds(body)) out.push(`"${id}" is not explained.`);
  const sentences = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*+])\s+/, "").trim())
    .filter(Boolean);
  const longest = Math.max(0, ...sentences.map((s) => s.split(/\s+/).length));
  if (longest > maxWords)
    out.push(
      `A sentence is long (${longest} words; keep each to ${maxWords}).`,
    );
  const questions = body
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.endsWith("?"));
  const numbered = (l: string) => /^\d+[.)]\s+/.test(l);
  if (questions.length > 1 && questions.some((q) => !numbered(q)))
    out.push("It asks more than one thing: number each as a yes/no question.");
  for (const q of questions) {
    const words = q.replace(/^\d+[.)]\s+/, "");
    if (/\sor\s/i.test(words) || (numbered(q) && QUESTION_WORD.test(words))) {
      out.push("A decision is not a yes/no question.");
      break;
    }
  }
  if (CAVEAT.test(body)) out.push("It has a caveat section.");
  return out;
}

/** Cut short, secrets out, spacing folded. */
function keep(text: string): string {
  const t = redactSecrets(String(text ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

const hashOf = (text: string) =>
  crypto
    .createHash("sha256")
    .update(
      String(text ?? "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim(),
    )
    .digest("hex")
    .slice(0, 16);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && (c as { type?: unknown }).type === "text"
        ? String((c as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

/** The sender of a peer message: its from-name, else its from. */
function peerOf(text: string): string | null {
  if (!text.startsWith("<cross-session-message")) return null;
  const head = text.slice(0, text.indexOf(">") + 1 || 600);
  const m = /\bfrom-name="([^"]*)"/.exec(head) ?? /\bfrom="([^"]*)"/.exec(head);
  return m ? m[1] : "";
}

/** Mine `file` for asks and messages at or after `since`. */
export async function mineAsks(
  file: string,
  opts: { since?: number; maxWords?: number } = {},
): Promise<AskStats> {
  const r: AskStats = { asks: [], sends: [], received: [] };
  if (/[\\/]subagents[\\/]/.test(file)) return r;
  const since = opts.since ?? -Infinity;
  /** Asks waiting on the person's next prompt. */
  let pending: AskSeen[] = [];
  /** AskUserQuestion calls, by tool-use id, waiting on their result. */
  const byUse = new Map<string, AskSeen>();
  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
    let d: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      d = v as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = Date.parse(String(d.timestamp ?? ""));
    if (!Number.isFinite(at) || at < since) continue;
    if (d.isSidechain) continue;
    const m = (d.message ?? {}) as Record<string, unknown>;
    if (d.type === "assistant") {
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!c || typeof c !== "object") continue;
        const tu = c as Record<string, unknown>;
        if (tu.type !== "tool_use") continue;
        const name = typeof tu.name === "string" ? tu.name : "";
        const input = (tu.input ?? {}) as Record<string, unknown>;
        if (name === "ask_human" || name.endsWith("__ask_human")) {
          const q = String(input.question ?? "");
          const a: AskSeen = {
            at,
            tool: "ask_human",
            text: keep(q),
            problems: askProblems(q, opts.maxWords),
          };
          r.asks.push(a);
          pending.push(a);
        } else if (name === "AskUserQuestion") {
          const qs = Array.isArray(input.questions) ? input.questions : [];
          const words = qs
            .map((x) =>
              x && typeof x === "object"
                ? String((x as { question?: unknown }).question ?? "")
                : "",
            )
            .filter(Boolean);
          // Each is its own question in the tool's form: read each alone.
          const a: AskSeen = {
            at,
            tool: "AskUserQuestion",
            text: keep(words.join("\n")),
            problems: [
              ...new Set(words.flatMap((w) => askProblems(w, opts.maxWords))),
            ],
          };
          r.asks.push(a);
          if (typeof tu.id === "string") byUse.set(tu.id, a);
        } else if (name === "SendMessage") {
          const to = String(input.to ?? "").trim();
          const msg = String(input.message ?? "");
          if (to && msg)
            r.sends.push({ at, to, hash: hashOf(msg), text: keep(msg) });
        }
      }
      continue;
    }
    if (d.type !== "user") continue;
    const content = m.content;
    if (Array.isArray(content))
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        const tr = c as Record<string, unknown>;
        if (tr.type !== "tool_result") continue;
        const a = byUse.get(String(tr.tool_use_id ?? ""));
        if (a && tr.is_error !== true) a.answeredAt = at;
      }
    if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) continue;
    const text = textOf(content).trim();
    const peer = peerOf(text);
    if (peer !== null) {
      r.received.push({ at, from: peer });
      continue;
    }
    if (!text || text.startsWith("<") || text.startsWith("Caveat:")) continue;
    // A person's prompt answers every ask_human still waiting.
    for (const a of pending) a.answeredAt = at;
    pending = [];
  }
  return r;
}

/** An agent's name with its prefix (`<project>:`) and ` [ref]` taken off. */
const bare = (name: string) =>
  name
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/^.*:/, "")
    .trim()
    .toLowerCase();

const round2 = (n: number) => Math.round(n * 100) / 100;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The counts over `stats` (one agent's transcripts) for a window of `days`. */
export function askMetrics(
  stats: readonly AskStats[],
  days: number,
): AskMetrics {
  const asks = stats.flatMap((s) => s.asks);
  const sends = stats.flatMap((s) => s.sends).sort((a, b) => a.at - b.at);
  const received = stats.flatMap((s) => s.received);
  const waits = asks
    .filter((a) => a.answeredAt !== undefined)
    .map((a) => (a.answeredAt! - a.at) / 60_000);
  const seen = new Set<string>();
  let repeated = 0;
  let noReply = 0;
  for (const s of sends) {
    const key = `${bare(s.to)}\n${s.hash}`;
    if (seen.has(key)) repeated++;
    seen.add(key);
    const who = bare(s.to);
    if (!received.some((m) => m.at > s.at && bare(m.from) === who)) noReply++;
  }
  const pass = asks.filter((a) => !a.problems.length).length;
  return {
    asks: asks.length,
    asks_per_day: round2(asks.length / Math.max(1, days)),
    ask_r12_pass_pct: asks.length
      ? Math.round((pass / asks.length) * 100)
      : 100,
    ask_wait_min: Math.round(median(waits)),
    asks_unanswered: asks.length - waits.length,
    sends: sends.length,
    sends_repeated: repeated,
    sends_no_reply: noReply,
  };
}
